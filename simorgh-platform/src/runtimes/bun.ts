// ── The self-hosted Bun core ──────────────────
//
// Same phoenix-core, same SQL, same wire contracts, no Cloudflare. Third host
// that proves the portability claim: workerd, Node, now Bun.
//
// What differs from the node target:
//   http       Bun.serve instead of node:http
//   storage    bun:sqlite's Database (not DatabaseSync — it is just Database)
//   sql dialect db.query(sql).all() / .run() instead of prepare().all() / .run()
//   crypto     node:crypto works in Bun — createNodePorts is reused as-is
//
// bun:sqlite is synchronous: db.query().all() and db.query().run() both
// return synchronously. So SqlPort.exec (synchronous cursor + synchronous
// toArray()) is satisfied without a single engine change. The RETURNS_ROWS
// sniff from node/index.ts is reused verbatim because bun:sqlite splits
// reads (all()) from writes (run()) exactly like node:sqlite does.
//
// Bun.serve has no setInterval prohibition, so the hourly sweep survives.
// On a serverless host that would not be the case (see HOST-PORTABILITY.md §3a).
//
// Everything the caller sees — routes, error shapes, request ids, the flock
// status payload, the ledger — is identical on purpose. A client should not
// be able to tell which target it is talking to.

// bun:sqlite and the Bun global carry no bundled @types — they are
// runtime-only. The declarations below are the minimum surface this
// adapter needs and stay local to this file; no new dependency is added.
declare const Bun: {
  serve(options: {
    port?: number;
    hostname?: string;
    fetch: (req: Request) => Promise<Response>;
  }): {
    url: URL;
    stop: (callback?: () => void) => void;
  };
};

// @ts-ignore: bun:sqlite ships no type declarations; runtime import works under Bun 1.4+.
import { Database } from "bun:sqlite";

import {
  AGENT_TOOLS,
  HEALTH_SCHEMA,
  MAX_EXECUTE_BODY_CHARS,
  RATE_LIMIT_SCHEMA,
  RequestValidationError,
  authenticateServiceRequest,
  consumeRateLimit,
  createToolExecutor,
  describeFlock,
  executeAgent,
  isAllowedOrigin,
  parseExecuteBody,
  readAllHealth,
  readCooldown,
  recordObservation,
  sweepStale,
  type AgentTool,
  type FetchLike,
  type HeaderAccessor,
  type Provider,
  type SqlCursor,
  type SqlPort,
  type SqlRow,
  type SqlValue,
} from "@simorgh/phoenix-core";
import {
  LEDGER_SCHEMA,
  createNodePorts,
  memoryContextStore,
  sqlLedger,
} from "@simorgh/phoenix-core/node";

import { MCP_PROTOCOL_VERSION, MCP_TOOL_ASK, MCP_TOOL_STATUS } from "../connectors/mcp.ts";
import { defaultProviders } from "./providers.ts";

const RUNTIME_VERSION = "0.1.0";
const DEFAULT_RATE_LIMIT = { limit: 20, windowMs: 60_000 };
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;

export interface BunRuntimeOptions {
  port?: number;
  host?: string;
  /** Bearer token callers must present. Absent ⇒ every authed route returns 503. */
  apiKey?: string;
  secrets?: Record<string, string | undefined>;
  providers?: readonly Provider[];
  /** SQLite path. `:memory:` (the default) keeps a smoke run from leaving state behind. */
  sqlPath?: string;
  corsOrigins?: string;
  rateLimit?: { limit: number; windowMs: number };
}

export interface BunRuntime {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly server: ReturnType<typeof Bun.serve>;
  close(): Promise<void>;
}

// ── SqlPort over bun:sqlite ──────────────
//
// `bun:sqlite` has no `DatabaseSync` — it is `import { Database } from
// "bun:sqlite"` and `new Database(path)`. Whether it is synchronous is
// the finding this runtime was built to prove. The answer: **yes, it is
// synchronous**. `db.query()` returns a query object whose `.all()`
// and `.run()` are both synchronous:
//
//   db.query("SELECT * FROM t WHERE id = ?").all(42)     → T[]       (sync)
//   db.query("INSERT INTO t VALUES (?)").run(42)               → {changes, lastInsertRowid} (sync)
//
// So the engine's `SqlPort.exec`, which returns a cursor synchronously
// with a synchronous `toArray()`, is satisfied without changing the
// engine. The only dialect difference from `node:sqlite` is the query
// API (`prepare().all()` vs `db.query().all()`). That lives here, in
// this adapter — not in the engine.
//
// The `RETURNS_ROWS` sniff from `phoenix-core/src/node/index.ts` is
// reused verbatim because `bun:sqlite` splits reads (`all()`) from
// writes (`run()`) exactly like `node:sqlite` does.

const RETURNS_ROWS = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i;

type BunDB = InstanceType<typeof Database>;

function bunSqlPort(db: BunDB): SqlPort {
  return {
    exec<T extends SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      // ArrayBuffer is a legal SqlValue but bun:sqlite expects
      // Uint8Array for binary bindings, so convert rather than cast away.
      const args = bindings.map((b) =>
        b instanceof ArrayBuffer ? new Uint8Array(b) : b
      ) as never[];

      if (RETURNS_ROWS.test(query)) {
        const rows = db.query(query).all(...args) as T[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const result = db.query(query).run(...args);
      return { toArray: () => [], rowsWritten: result.changes };
    },
  };
}

export async function startBunRuntime(
  options: BunRuntimeOptions = {}
): Promise<BunRuntime> {
  const secrets = options.secrets ?? {};
  const host = options.host ?? DEFAULT_HOST;
  const sqlPath = options.sqlPath ?? ":memory:";
  const providers = options.providers ?? defaultProviders({ env: secrets });
  const ports = createNodePorts();

  // @ts-ignore — Database is a runtime binding from bun:sqlite with no types
  const db: BunDB = new Database(":memory:");
  const sql: SqlPort = bunSqlPort(db);
  sql.exec(HEALTH_SCHEMA);
  sql.exec(RATE_LIMIT_SCHEMA);
  sql.exec(LEDGER_SCHEMA);

  const ledger = sqlLedger(sql);
  const contextStore = memoryContextStore(() => ports.now());
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;

  const secretOf = (name: string): string | undefined => secrets[name];

  const executeTool = createToolExecutor({
    fetch: ports.fetch,
    now: () => ports.now(),
  });

  interface ExecuteResult {
    status: number;
    payload: unknown;
    headers: Record<string, string>;
  }

  async function runExecute(body: ExecuteArgs, requestId: string): Promise<ExecuteResult> {
    const parsed = parseExecuteBody(body.raw, AGENT_TOOLS, body.headerUserId);
    const decision = consumeRateLimit(
      sql,
      "execute:" + parsed.userId,
      rateLimit.limit,
      rateLimit.windowMs,
      ports.now()
    );

    const baseRateHeaders: Record<string, string> = {
      "X-RateLimit-Limit": String(decision.limit),
      "X-RateLimit-Remaining": String(decision.remaining),
      "X-RateLimit-Reset": String(Math.ceil(decision.resetAt / 1000)),
    };

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
          ...baseRateHeaders,
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
        record: (id, isOk, error) =>
          recordObservation(sql, id, isOk, error === "rate_limit", ports.now()),
        executeTool,
      }
    );

    return {
      status: 200,
      payload: result,
      headers: baseRateHeaders,
    };
  }

  // ── request handler ──────────

  async function handleRequest(req: Request): Promise<Response> {
    const requestId = ports.randomUUID();

    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get("origin");

    const baseH: Record<string, string> = {
      "X-Request-Id": requestId,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };

    if (origin) {
      if (!isAllowedOrigin(origin, options.corsOrigins)) {
        return send(403, {
          success: false,
          error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allow-listed.", requestId },
        }, requestId, {
          "Access-Control-Allow-Origin": origin,
          "Vary": "Origin",
        });
      }
      baseH["Access-Control-Allow-Origin"] = origin;
      baseH["Vary"] = "Origin";
      baseH["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Simorgh-User-Id";
      baseH["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      baseH["Access-Control-Expose-Headers"] = "X-Request-Id, Retry-After, Mcp-Session-Id";
    }
    if (req.method === "OPTIONS") {
      return send(204, null, requestId);
    }

    try {
      if (path === "/" && req.method === "GET") {
        return send(200, "Simorgh phoenix-core (bun) — the flock is awake.", requestId);
      }

      if (path === "/health" && req.method === "GET") {
        return send(200, { status: "ok", timestamp: new Date(ports.now()).toISOString() }, requestId, {
          "Cache-Control": "no-store",
        });
      }

      if (path === "/api/v1/flock/status" && req.method === "GET") {
        return send(200, describeFlock(providers, {
          secret: secretOf,
          health: readAllHealth(sql),
          now: ports.now(),
        }), requestId);
      }

      if (path === "/api/v1/agent/execute" && req.method === "POST") {
        const deny = await requireAuth(req, requestId);
        if (deny) return deny;

        const raw = await readBody(req);
        if (raw === null) {
          return send(413, {
            success: false,
            error: {
              code: "request_too_large",
              message: "Request body exceeds " + MAX_EXECUTE_BODY_CHARS + " characters.",
              requestId,
            },
          }, requestId);
        }
        const outcome = await runExecute(
          { raw, headerUserId: req.headers.get("x-simorgh-user-id") ?? undefined },
          requestId
        );
        return send(outcome.status, outcome.payload, requestId, outcome.headers);
      }

      if (path.startsWith("/api/v1/user/") && path.endsWith("/logs") && req.method === "GET") {
        const deny = await requireAuth(req, requestId);
        if (deny) return deny;

        const userId = decodeURIComponent(path.slice("/api/v1/user/".length, -"/logs".length));
        if (!/^[A-Za-z0-9:_-]{1,128}$/.test(userId)) {
          return send(400, {
            success: false,
            error: { code: "INVALID_USER_ID", message: "Invalid user ID.", requestId },
          }, requestId);
        }
        return send(200, await ledger.getUserLogs(userId), requestId);
      }

      if (path.startsWith("/api/v1/context/") && req.method === "GET") {
        const deny = await requireAuth(req, requestId);
        if (deny) return deny;

        const refId = path.slice("/api/v1/context/".length);
        if (!/^[0-9a-f]{36}$/i.test(refId)) {
          return send(400, {
            success: false,
            error: { code: "INVALID_CONTEXT_REF", message: "Invalid context reference.", requestId },
          }, requestId);
        }
        const stored = await contextStore.get("ctx_" + refId);
        if (!stored) {
          return send(404, { error: "not_found" }, requestId);
        }
        return send(200, stored, requestId, { "Content-Type": "application/json; charset=utf-8" });
      }

      if (path === "/mcp" && req.method === "POST") {
        return await handleMcpRequest(req, requestId);
      }

      return send(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "Route not found.", requestId },
      }, requestId);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return send(error.status, {
          success: false,
          error: { code: error.code, message: error.message, requestId },
        }, requestId);
      }
      process.stderr.write(
        JSON.stringify({ event: "request_error", requestId, path, error: String(error) }) + "\n"
      );
      return send(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "The request could not be completed.", requestId },
      }, requestId);
    }
  }

  function send(
    status: number,
    payload: unknown,
    requestId: string,
    extraHeaders: Record<string, string> = {}
  ): Response {
    const headers: Record<string, string> = {
      "X-Request-Id": requestId,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    };
    const body = payload === null ? null : typeof payload === "string" ? payload : JSON.stringify(payload);
    return new Response(body, { status, headers });
  }

  // ── MCP over Streamable HTTP ───────────────

  interface McpMessage {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  }

  async function handleMcpRequest(req: Request, requestId: string): Promise<Response> {
    const deny = await requireAuth(req, requestId);
    if (deny) return deny;

    const raw = await readBody(req);
    if (raw === null) {
      return send(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, requestId);
    }

    let message: McpMessage;
    try {
      message = JSON.parse(raw) as McpMessage;
    } catch {
      return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, requestId);
    }

    const ok = (result: unknown): Response => {
      const h: Record<string, string> = {
        "X-Request-Id": requestId,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Type": "application/json; charset=utf-8",
      };
      if (message.method === "initialize") {
        h["Mcp-Session-Id"] = requestId;
      }
      return send(200, { jsonrpc: "2.0", id: message.id ?? null, result }, requestId, h);
    };
    const fail = (code: number, text: string): Response =>
      send(200, { jsonrpc: "2.0", id: message.id ?? null, error: { code, message: text } }, requestId);

    const asToolContent = (payload: unknown) => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });

    switch (message.method) {
      case "initialize":
        return ok({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "phoenix-core", version: RUNTIME_VERSION },
        });

      case "notifications/initialized":
        return send(202, null, requestId);

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
          return ok(asToolContent(
            describeFlock(providers, {
              secret: secretOf,
              health: readAllHealth(sql),
              now: ports.now(),
            })
          ));
        }

        if (name === MCP_TOOL_ASK) {
          const prompt = typeof args.prompt === "string" ? args.prompt : "";
          const requested: string[] = Array.isArray(args.tools) ? (args.tools as string[]) : [];
          const available = new Set<string>(AGENT_TOOLS);
          const tools = requested.filter((t) => available.has(t));
          const blockedTools = requested.filter((t) => !available.has(t));
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

  async function requireAuth(req: Request, requestId: string): Promise<Response | null> {
    const headerAccessor: HeaderAccessor = { get: (name: string) => req.headers.get(name) };
    const auth = await authenticateServiceRequest(headerAccessor, {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      sha256: ports.sha256,
    });
    if (auth.ok) return null;

    const extra: Record<string, string> = {};
    if (auth.status === 401) {
      extra["WWW-Authenticate"] = "Bearer";
    }
    return send(auth.status, {
      success: false,
      error: {
        code: auth.code,
        message:
          auth.code === "AUTH_NOT_CONFIGURED"
            ? "Simorgh API authentication is not configured."
            : "A valid Bearer token is required.",
        requestId,
      },
    }, requestId, extra);
  }

  const server = Bun.serve({
    port: options.port ?? DEFAULT_PORT,
    hostname: host,
    fetch: async (req: Request) => {
      return handleRequest(req);
    },
  });

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

  const address = server.url;
  const port = Number(address.port);
  const runtimeUrl = `http://${host}:${port}`;

  return {
    host,
    port,
    url: runtimeUrl,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweepTimer);
        server.stop(resolve);
      }),
  };
}

// ── helpers ────────────────────────────────────────

interface ExecuteArgs {
  raw: string;
  headerUserId?: string;
}

/** Read a body, or `null` when it exceeds the engine's cap. */
async function readBody(req: Request): Promise<string | null> {
  const text = await req.text();
  if (text.length > MAX_EXECUTE_BODY_CHARS) {
    return null;
  }
  return text;
}

/** Run the runtime as a script: `bun run simorgh-platform/src/runtimes/bun.ts`. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const portFlag = argv.indexOf("--port");
  const port = portFlag === -1 ? undefined : Number(argv[portFlag + 1]);
  const runtime = await startBunRuntime({
    ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
    apiKey: process.env.SIMORGH_API_KEY,
    secrets: process.env,
    corsOrigins: process.env.CORS_ORIGINS,
  });
  process.stdout.write(`phoenix-core (bun) listening on ${runtime.url}\n`);
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
if (process.argv[1]?.endsWith("bun.ts")) {
  await main();
}
