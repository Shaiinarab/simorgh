// ── The self-hosted Node core ─────────────────────────────────────────────────
//
// A complete phoenix-core on Node: the same engine, the same SQL, the same wire
// contracts, no Cloudflare. This is what makes the `node` target real rather than a
// promise, and it is the second implementation that proves phoenix-core is actually
// portable — if the engine had a Workers dependency, this file could not exist.
//
// It is runnable *unbuilt*: `node simorgh-platform/src/runtimes/node.ts`. Node strips
// types natively, and every relative import in the workspace carries an explicit
// `.ts` extension so resolution works without a bundler.
//
// ── What differs from the edge ──
//
//   storage    one SQLite file (or `:memory:`) instead of Durable Objects
//   secrets    process env instead of `wrangler secret`
//   rate limit the same SQL counter, on the same database
//   workers AI unavailable — see providers.ts
//
// Everything the caller sees — routes, error shapes, request ids, the flock status
// payload, the ledger — is identical on purpose. A client should not be able to tell
// which target it is talking to.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

import {
  AGENT_TOOLS,
  HEALTH_SCHEMA,
  MAX_EXECUTE_BODY_CHARS,
  QUOTA_SCHEMA,
  RATE_LIMIT_SCHEMA,
  RequestValidationError,
  authenticateServiceIdentity,
  authenticateServiceRequest,
  consumeRateLimit,
  createToolExecutor,
  describeFlock,
  executeAgent,
  isAllowedOrigin,
  parseExecuteBody,
  parseTokenSubjects,
  readAllHealth,
  readCooldown,
  recordObservation,
  subjectMatches,
  sweepStale,
  type AgentTool,
  type FetchLike,
  type Provider,
  type SqlPort,
  rateLimitHeaders,
} from "@simorgh/phoenix-core";
import {
  LEDGER_SCHEMA,
  createNodePorts,
  memoryContextStore,
  nodeSqlPort,
  sqlLedger,
} from "@simorgh/phoenix-core/node";

import { MCP_PROTOCOL_VERSION, MCP_TOOL_ASK, MCP_TOOL_STATUS } from "../connectors/mcp.ts";
import { defaultProviders } from "./providers.ts";

const RUNTIME_VERSION = "0.1.0";
const DEFAULT_RATE_LIMIT = { limit: 20, windowMs: 60_000 };
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;

export interface NodeRuntimeOptions {
  port?: number;
  host?: string;
  /** Bearer token callers must present. Absent ⇒ every authed route returns 503. */
  apiKey?: string;
  /**
   * JSON map of `token → userId` (`SIMORGH_API_KEYS`).
   *
   * The per-user routes (`/api/v1/user/:userId/logs`, `/api/v1/context/:refId`) resolve
   * their caller from this map rather than from the URL. Absent, they refuse with
   * `IDENTITY_UNRESOLVED` instead of guessing which user a token speaks for — guessing is
   * precisely the vulnerability they carried until 2026-10-08.
   *
   * **Known gap, deliberate not accidental:** a token that is only in this map can *read*
   * its own data but cannot call `/api/v1/agent/execute`, which still authenticates against
   * `apiKey` alone. So a multi-caller deployment must hand each caller both. Fixing that is
   * not a one-line change: letting a map token execute means the `userId` must come from
   * the token rather than from `X-Simorgh-User-Id`, or a caller can spend another caller's
   * rate-limit budget and write ledger rows in their name (AUTH-004). Until that lands, the
   * map's job is strictly "who is reading", and this comment is the reason a reader is not
   * left to rediscover it.
   */
  apiKeys?: string;
  secrets?: Record<string, string | undefined>;
  providers?: readonly Provider[];
  /** SQLite path. `:memory:` (the default) keeps a smoke run from leaving state behind. */
  sqlPath?: string;
  corsOrigins?: string;
  rateLimit?: { limit: number; windowMs: number };
}

export interface NodeRuntime {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startNodeRuntime(
  options: NodeRuntimeOptions = {}
): Promise<NodeRuntime> {
  const secrets = options.secrets ?? {};
  const host = options.host ?? DEFAULT_HOST;
  const sqlPath = options.sqlPath ?? ":memory:";
  const providers = options.providers ?? defaultProviders({ env: secrets });
  const ports = createNodePorts();

  const db = sqlPath === ":memory:" ? new DatabaseSync(":memory:") : new DatabaseSync(sqlPath);
  const sql: SqlPort = nodeSqlPort(db);
  sql.exec(HEALTH_SCHEMA);
  sql.exec(RATE_LIMIT_SCHEMA);
  sql.exec(LEDGER_SCHEMA);
  sql.exec(QUOTA_SCHEMA);

  const ledger = sqlLedger(sql);
  const contextStore = memoryContextStore(() => ports.now());
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;

  const secretOf = (name: string): string | undefined => secrets[name];

  // The tool *bodies* live in the engine, not here. They used to exist twice — once in this
  // runtime and once in the Cloudflare request path — with nothing comparing the two. The
  // engine owns what a tool does; this host only supplies the fetch port it does it through.
  const executeTool = createToolExecutor({
    fetch: ports.fetch,
    now: () => ports.now(),
  });

  async function runExecute(body: ExecuteArgs, requestId: string) {
    const parsed = parseExecuteBody(body.raw, AGENT_TOOLS, body.headerUserId);
    const decision = consumeRateLimit(
      sql,
      "execute:" + parsed.userId,
      rateLimit.limit,
      rateLimit.windowMs,
      ports.now()
    );
    if (!decision.allowed) {
      return {
        status: 429,
        payload: {
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: "Execution rate limit reached.",
            requestId,
          },
        },
        headers: {
        ...rateLimitHeaders(decision),
          "Retry-After": String(
            Math.max(1, Math.ceil((decision.resetAt - ports.now()) / 1000))
          ),
        },
      };
    }

    const result = await executeAgent(
      {
        prompt: parsed.prompt,
        tools: parsed.tools,
        userId: parsed.userId,
        tier: parsed.tier,
        blockedTools: parsed.blockedTools,
        ...(requestId ? { requestId } : {}),
      },
      {
        ports,
        providers,
        secret: secretOf,
        contextStore,
        ledger,
        cooldownUntil: (id) => readCooldown(sql, id),
        record: (id, ok, error) =>
          recordObservation(sql, id, ok, error === "rate_limit", ports.now()),
        executeTool,
      }
    );

    return {
      status: 200,
      payload: result,
      headers: {
      ...rateLimitHeaders(decision),
      },
    };
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = ports.randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const origin = header(req, "origin");

    if (origin) {
      if (!isAllowedOrigin(origin, options.corsOrigins)) {
        return send(res, 403, {
          success: false,
          error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allow-listed.", requestId },
        });
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Simorgh-User-Id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Retry-After, Mcp-Session-Id");
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return void res.end();
    }

    try {
      if (path === "/" && req.method === "GET") {
        return sendText(res, 200, "Simorgh phoenix-core (node) — the flock is awake.");
      }

      if (path === "/health" && req.method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        return send(res, 200, { status: "ok", timestamp: new Date(ports.now()).toISOString() });
      }

      // Not authenticated, matching the edge: it reports which providers are awake,
      // and an operator watching a deploy needs it before the key is in place.
      if (path === "/api/v1/flock/status" && req.method === "GET") {
        return send(
          res,
          200,
          describeFlock(providers, {
            secret: secretOf,
            health: readAllHealth(sql),
            now: ports.now(),
          })
        );
      }

      if (path === "/api/v1/agent/execute" && req.method === "POST") {
        const denied = await requireAuth(req, res, requestId);
        if (denied) return;
        const raw = await readBody(req);
        if (raw === null) {
          return send(res, 413, {
            success: false,
            error: {
              code: "request_too_large",
              message: "Request body exceeds " + MAX_EXECUTE_BODY_CHARS + " characters.",
              requestId,
            },
          });
        }
        const outcome = await runExecute(
          { raw, headerUserId: header(req, "x-simorgh-user-id") ?? undefined },
          requestId
        );
        for (const [key, value] of Object.entries(outcome.headers)) res.setHeader(key, value);
        return send(res, outcome.status, outcome.payload);
      }

      if (path.startsWith("/api/v1/user/") && path.endsWith("/logs") && req.method === "GET") {
        const subject = await requireIdentity(req, res, requestId);
        if (subject === null) return;
        const userId = decodeURIComponent(path.slice("/api/v1/user/".length, -"/logs".length));
        if (!/^[A-Za-z0-9:_-]{1,128}$/.test(userId)) {
          return send(res, 400, {
            success: false,
            error: { code: "INVALID_USER_ID", message: "Invalid user ID.", requestId },
          });
        }
        // The token names the caller; the URL names the data. They must agree. `403` for
        // *every* non-matching userId, existing or not, so this cannot be used to probe
        // which user ids are real (AUTH-002).
        if (!subjectMatches(subject, userId)) {
          return send(res, 403, {
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "This token may not read another user's logs.",
              requestId,
            },
          });
        }
        return send(res, 200, await ledger.getUserLogs(userId));
      }

      if (path.startsWith("/api/v1/context/") && req.method === "GET") {
        const subject = await requireIdentity(req, res, requestId);
        if (subject === null) return;
        const refId = path.slice("/api/v1/context/".length);
        if (!/^[0-9a-f-]{36}$/i.test(refId)) {
          return send(res, 400, {
            success: false,
            error: {
              code: "INVALID_CONTEXT_REF",
              message: "Invalid context reference.",
              requestId,
            },
          });
        }
        // Ownership from the ledger, which is what binds a `refId` to a principal. A
        // missing row is "not yours", never "unowned, therefore allowed" (AUTH-003).
        const owner = await ledger.findByRef(refId);
        if (!owner || !subjectMatches(subject, owner.user_id)) {
          // Same 404 as a genuinely absent context, so this cannot be used to enumerate
          // which references exist. The stored payload is not read on this path.
          return send(res, 404, { error: "not_found" });
        }
        const stored = await contextStore.get("ctx_" + refId);
        if (!stored) return send(res, 404, { error: "not_found" });
        return send(res, 200, JSON.parse(stored));
      }

      if (path === "/mcp" && req.method === "POST") {
        return await handleMcpRequest(req, res, requestId);
      }

      return send(res, 404, {
        success: false,
        error: { code: "NOT_FOUND", message: "Route not found.", requestId },
      });
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return send(res, error.status, {
          success: false,
          error: { code: error.code, message: error.message, requestId },
        });
      }
      process.stderr.write(
        JSON.stringify({ event: "request_error", requestId, path, error: String(error) }) + "\n"
      );
      return send(res, 500, {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "The request could not be completed.",
          requestId,
        },
      });
    }
  }

  // ── MCP over Streamable HTTP ──
  interface McpMessage {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  }

  async function handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string
  ): Promise<void> {
    const denied = await requireAuth(req, res, requestId);
    if (denied) return;

    const raw = await readBody(req);
    if (raw === null) {
      return send(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
    }

    let message: McpMessage;
    try {
      message = JSON.parse(raw) as McpMessage;
    } catch {
      return send(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }

    const ok = (result: unknown) => send(res, 200, { jsonrpc: "2.0", id: message.id ?? null, result });
    const fail = (code: number, text: string) =>
      send(res, 200, { jsonrpc: "2.0", id: message.id ?? null, error: { code, message: text } });

    // A tool result is a list of typed content blocks; JSON travels in one text block.
    const asToolContent = (payload: unknown) => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    switch (message.method) {
      case "initialize":
        res.setHeader("Mcp-Session-Id", requestId);
        return ok({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "phoenix-core", version: RUNTIME_VERSION },
        });

      case "notifications/initialized":
        // A notification has no id and gets no reply.
        res.statusCode = 202;
        return void res.end();

      case "tools/list":
        return ok({
          tools: [
            {
              name: MCP_TOOL_STATUS,
              description: "Live Simorgh flock status: which providers are healthy, tired, or dormant.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: MCP_TOOL_ASK,
              description:
                "Ask the flock. Runs the vetted tools and returns the answering provider's synthesis.",
              inputSchema: {
                type: "object",
                properties: {
                  prompt: { type: "string", description: "The request to answer." },
                  tools: {
                    type: "array",
                    items: { type: "string", enum: [...AGENT_TOOLS] },
                    description: "Tools to allow. Unknown names are dropped and reported.",
                  },
                  userId: { type: "string" },
                  tier: { type: "string" },
                },
                required: ["prompt"],
                additionalProperties: false,
              },
            },
          ],
        });

      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};

        if (name === MCP_TOOL_STATUS) {
          return ok(
            asToolContent(
              describeFlock(providers, {
                secret: secretOf,
                health: readAllHealth(sql),
                now: ports.now(),
              })
            )
          );
        }

        if (name === MCP_TOOL_ASK) {
          const prompt = typeof args.prompt === "string" ? args.prompt : "";
          const requested: string[] = Array.isArray(args.tools) ? (args.tools as string[]) : [];
          const available = new Set<string>(AGENT_TOOLS);
          const tools = requested.filter((tool) => available.has(tool));
          const blockedTools = requested.filter((tool) => !available.has(tool));
          const userId = typeof args.userId === "string" ? args.userId : `mcp:${requestId}`;
          const tier = typeof args.tier === "string" ? args.tier : "Free-Volunteer";

          if (!prompt.trim()) {
            return ok({
              ...asToolContent({ success: false, error: "prompt is required" }),
              isError: true,
            });
          }

          const result = await executeAgent(
            {
              prompt,
              tools: tools as AgentTool[],
              userId,
              tier,
              blockedTools,
              requestId,
            },
            {
              ports,
              providers,
              secret: secretOf,
              contextStore,
              ledger,
              cooldownUntil: (id) => readCooldown(sql, id),
              record: (id, isOk, error) =>
                recordObservation(sql, id, isOk, error === "rate_limit", ports.now()),
              executeTool,
            }
          );
          return ok(asToolContent(result));
        }

        return fail(-32602, `Unknown tool '${String(name)}'.`);
      }

      default:
        return fail(-32601, `Method not found: ${String(message.method)}`);
    }
  }

  /**
   * Parsed once per runtime, not once per request: `options` is fixed at boot.
   * A malformed map parses to `undefined`, which degrades these routes to refusing with
   * `503 IDENTITY_UNRESOLVED` — never to an empty map that would let every token through.
   */
  const tokenSubjects = parseTokenSubjects(options.apiKeys);

  /**
   * Auth *and* identity, for routes that name the resource they return in the URL.
   *
   * Returns the resolved subject, or `null` after having sent the refusal — the same
   * shape as `requireAuth` below, so the call sites read identically.
   */
  async function requireIdentity(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string
  ): Promise<string | null> {
    const auth = await authenticateServiceIdentity(headerAccessor(req), {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(tokenSubjects ? { tokenSubjects } : {}),
      sha256: ports.sha256,
    });
    if (auth.ok) return auth.subject;

    if (auth.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
    send(res, auth.status, {
      success: false,
      error: {
        code: auth.code,
        message:
          auth.code === "AUTH_NOT_CONFIGURED"
            ? "Simorgh API authentication is not configured."
            : auth.code === "IDENTITY_UNRESOLVED"
              ? "This deployment cannot attribute the token to a user. Set SIMORGH_API_KEYS to a JSON map of token to user id."
              : "A valid Bearer token is required.",
        requestId,
      },
    });
    return null;
  }

  async function requireAuth(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string
  ): Promise<boolean> {
    const auth = await authenticateServiceRequest(headerAccessor(req), {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      sha256: ports.sha256,
    });
    if (auth.ok) return false;

    if (auth.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
    send(res, auth.status, {
      success: false,
      error: {
        code: auth.code,
        message:
          auth.code === "AUTH_NOT_CONFIGURED"
            ? "Simorgh API authentication is not configured."
            : "A valid Bearer token is required.",
        requestId,
      },
    });
    return true;
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? DEFAULT_PORT, host, resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  // A background sweep, mirroring the edge's cron trigger. Without it a provider that
  // failed once and was never dialled again reads "tired" forever.
  const sweepTimer = setInterval(() => {
    try {
      sweepStale(sql, ports.now());
    } catch {
      // A sweep failure must never take the listener down.
    }
  }, 60 * 60 * 1_000);
  sweepTimer.unref();

  return {
    host,
    port: address.port,
    url,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweepTimer);
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

// ── helpers ──

interface ExecuteArgs {
  raw: string;
  headerUserId?: string;
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function headerAccessor(req: IncomingMessage): { get(name: string): string | null } {
  return { get: (name: string) => header(req, name) };
}

/** Read a body, or `null` when it exceeds the engine's cap. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Bounded before parsing: an unbounded body is a memory-exhaustion vector, and
      // the engine would reject it anyway once parsed.
      if (size > MAX_EXECUTE_BODY_CHARS) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/** Satisfies the `FetchLike` shape for direct use; kept for parity with the edge host. */
export type NodeFetch = FetchLike;

/** Run the runtime as a script: `node simorgh-platform/src/runtimes/node.ts`. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const portFlag = argv.indexOf("--port");
  const port = portFlag === -1 ? undefined : Number(argv[portFlag + 1]);
  const runtime = await startNodeRuntime({
    ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
    apiKey: process.env.SIMORGH_API_KEY,
    apiKeys: process.env.SIMORGH_API_KEYS,
    secrets: process.env,
    corsOrigins: process.env.CORS_ORIGINS,
  });
  process.stdout.write(`phoenix-core (node) listening on ${runtime.url}\n`);
  process.stdout.write(`  GET  ${runtime.url}/health\n`);
  process.stdout.write(`  GET  ${runtime.url}/api/v1/flock/status\n`);
  process.stdout.write(`  POST ${runtime.url}/api/v1/agent/execute\n`);
  process.stdout.write(`  POST ${runtime.url}/mcp\n`);

  const shutdown = () => {
    void runtime.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only self-start when executed directly, so tests can import and drive the runtime.
if (process.argv[1]?.endsWith("node.ts")) {
  await main();
}
