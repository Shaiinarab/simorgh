// ── The platform MCP server ──────────────────────────
//
// So an agent host can ask the platform anything — where cores can live,
// which cores are mine, what the fleet is doing — over the same protocol
// the platform already speaks.
//
// Exposes exactly three tools, all `platform_*`:
//
//   platform_targets   where a core can live
//   platform_fleet     which cores are mine, and their health
//   platform_ask       ask the fleet, with failover
//
// ── On the `platform_*` prefix ──
//
// The prefix is deliberate and load-bearing. An agent host can easily have both a core
// and the platform in its tool list at once, and a core already publishes `simorgh_status`
// and `simorgh_ask`. A platform tool named `simorgh_ask` would mean *ask this deployment's
// whole fleet* while the core's means *ask me* — one name, two meanings, on the surface an
// agent reads. So this server publishes nothing under `simorgh_*`. (An earlier revision
// shipped both as aliases; two names for one handler is redundancy, and this particular
// redundancy is a trap.)
//
// ── Why every handler goes through `fleet.ts` ──
//
// The first revision built its own connector per instance — and hardcoded `mcpConnector`
// while doing it, so an instance recorded as `rest` was dialled over MCP anyway, ignoring
// the `connector` field the fleet file exists to carry. It also re-implemented ask-failover
// that `Fleet.ask` already owns. Both are now delegated: `connectorFor` reads the recorded
// connector, and `createFleet(...).status()/ask()` supply the health probe and the failover.
//
// Reuses the JSON-RPC framing and session style from `runtimes/node.ts`
// (the core's own MCP server). Accepts `application/json` requests and
// replies with `application/json`.
//
// Content encoding: `application/json` — the server accepts JSON requests
// and returns JSON responses (not SSE). The MCP client tolerates both;
// JSON is simpler and sufficient for a server that always responds inline.

import {
  AGENT_TOOLS,
  type AgentTool,
  type FetchLike,
  type HttpLike,
  type HeaderAccessor,
  type HttpInit,
} from "@simorgh/phoenix-core";

import { MCP_PROTOCOL_VERSION } from "../connectors/mcp.ts";
import { connectorFor, createFleet, type CoreInstance } from "../fleet.ts";
import { listTargets } from "../targets.ts";

export interface PlatformMcpOptions {
  /** Instances to operate on. Defaults to the loaded fleet. */
  instances?: readonly CoreInstance[];
  /** Injected so the server is testable and never reaches for a global. */
  fetch?: FetchLike;
  /** Sent in `initialize`'s result. */
  serverName?: string;
  serverVersion?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Wrap a tool result in MCP content blocks so the client can extract it. */
function asToolContent(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * A tool result that *failed*, per the MCP spec: same content block, plus the result-level
 * `isError` flag. The payload still describes what went wrong for a human or an agent
 * reading it, but the authoritative signal is the flag.
 */
function asToolError(payload: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { ...asToolContent(payload), isError: true };
}

function targetSummary(
  t: {
    id: string;
    label: string;
    runtime: string;
    connectors: unknown;
    modes: unknown;
    endpoint: string;
  },
) {
  return {
    id: t.id,
    label: t.label,
    runtime: t.runtime,
    connectors: t.connectors,
    modes: t.modes,
    endpoint: t.endpoint,
  };
}

function sessionHeaders(session: string): HeaderAccessor {
  return {
    get: (name: string) =>
      name.toLowerCase() === "mcp-session-id" ? session : null,
  };
}

function toHttpLike(body: unknown): HttpLike {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

export function platformMcpHandler(options?: PlatformMcpOptions): FetchLike {
  const instances = options?.instances ?? [];
  const fetchImpl: FetchLike =
    options?.fetch ??
    ((url: string, init?: HttpInit) =>
      fetch(url, init as any));
  const serverName = options?.serverName ?? "simorgh-platform";
  const serverVersion = options?.serverVersion ?? "0.1.0";
  let sessionId: string | undefined;

  return async (
    _url: string,
    init?: HttpInit,
  ): Promise<HttpLike> => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const req = body as JsonRpcRequest | null;
    const id = req?.id ?? null;

    const hasSession =
      init?.headers?.["Mcp-Session-Id"] ??
      init?.headers?.["x-mcp-session-id"] ??
      sessionId;
    if (req?.method === "tools/call" && !hasSession) {
      return toHttpLike(rpcError(
        id,
        -32600,
        "Mcp-Session-Id required: this server is session-oriented. Call initialize first.",
      ));
    }

    if (!req || !req.method) {
      return toHttpLike(rpcError(id, -32600, "Invalid request: method required."));
    }

    switch (req.method) {
      case "initialize": {
        const newSession = crypto.randomUUID();
        sessionId = newSession;
        return {
          ok: true,
          status: 200,
          headers: sessionHeaders(newSession),
          text: async () => JSON.stringify(ok(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: serverVersion },
          })),
          json: async () => ok(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: serverVersion },
          }),
        };
      }

      case "notifications/initialized":
        return {
          ok: true,
          status: 202,
          headers: { get: () => null },
          text: async () => "",
          json: async () => undefined,
        };

      case "tools/list": {
        const tools = [
          {
            name: "platform_targets",
            description:
              "Every registered deployment target: id, label, runtime, connectors, modes, endpoint. No steps or secrets.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "platform_fleet",
            description:
              "The platform's fleet. With no argument: one entry per recorded instance (id, endpoint, kind, reachable, latencyMs, detail). With an instanceId: that instance's full FlockStatus.",
            inputSchema: {
              type: "object",
              properties: {
                instanceId: {
                  type: "string",
                  description: "A specific instance id to query.",
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "platform_ask",
            description:
              "Ask the fleet. With no instanceId, asks instances in order and fails over; reports which instance answered.",
            inputSchema: {
              type: "object",
              properties: {
                prompt: {
                  type: "string",
                  description: "The request to answer.",
                },
                instanceId: {
                  type: "string",
                  description: "Ask a specific instance instead of the fleet.",
                },
                tools: {
                  type: "array",
                  items: { type: "string" },
                  description: "Tools to allow.",
                },
                userId: { type: "string" },
                tier: { type: "string" },
              },
              required: ["prompt"],
              additionalProperties: false,
            },
          },
        ];
        return toHttpLike(ok(id, { tools }));
      }

      case "tools/call": {
        const name = req.params?.name as string | undefined;
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

        switch (name) {
          case "platform_targets": {
            const targets = listTargets().map(targetSummary);
            return toHttpLike(ok(id, asToolContent(targets)));
          }

          case "platform_fleet": {
            return handleFleetCall(id, args, instances, fetchImpl);
          }

          case "platform_ask": {
            return handleAskCall(id, args, instances, fetchImpl);
          }

          default:
            return toolError(id, `Unknown tool '${String(name)}'.`);
        }
      }

      default:
        return toHttpLike(rpcError(id, -32601, `Method not found: ${String(req.method)}`));
    }
  };
}

/**
 * A failed tool: a readable message, and `isError: true` **at the tool-result level**.
 *
 * Where that flag goes is not cosmetic. MCP puts `isError` on the tool *result*, and it is
 * the only thing a client may use to decide that a tool failed — our own connector is a
 * case in point: `mcpConnector.callTool` throws on `result.isError`, and knows nothing
 * about the payload's contents.
 *
 * This server originally put `isError` *inside* the JSON payload instead, which meant every
 * compliant client read a failed tool as a **success** carrying a body that happened to
 * mention an error. Our own client was the only thing that noticed, and only once a
 * core-specific method was pointed at this server. A tool failure must be a value the
 * transport reports, never a detail the caller has to parse for.
 */
function toolError(id: number | string | null, message: string) {
  return toHttpLike(ok(id, asToolError({ message })));
}

async function handleFleetCall(
  id: number | string | null,
  args: Record<string, unknown>,
  instances: readonly CoreInstance[],
  fetchImpl: FetchLike,
) {
  const instanceId = typeof args.instanceId === "string" ? args.instanceId : undefined;

  if (instanceId !== undefined) {
    const inst = instances.find((i) => i.id === instanceId);
    if (!inst) return toolError(id, `Unknown instance '${instanceId}'.`);
    try {
      // `connectorFor` reads `inst.connector` — so a REST instance is dialled over REST.
      const flockStatus = await connectorFor(inst, { fetch: fetchImpl }).status();
      return toHttpLike(ok(id, asToolContent(flockStatus)));
    } catch (e) {
      return toolError(id, `Instance '${instanceId}' unreachable: ${String(e)}`);
    }
  }

  // One fleet, and it owns the health probe. The report shape the brief pinned is a
  // projection of `InstanceReport`, not a second implementation of it.
  const reports = await createFleet(instances, { fetch: fetchImpl }).status();
  return toHttpLike(
    ok(
      id,
      asToolContent(
        reports.map((report) => ({
          id: report.instance.id,
          endpoint: report.instance.endpoint,
          kind: report.instance.connector,
          reachable: report.health.reachable,
          ...(report.health.latencyMs !== undefined
            ? { latencyMs: report.health.latencyMs }
            : {}),
          detail: report.error ?? report.health.detail,
        }))
      )
    )
  );
}

async function handleAskCall(
  id: number | string | null,
  args: Record<string, unknown>,
  instances: readonly CoreInstance[],
  fetchImpl: FetchLike,
) {
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const instanceId = typeof args.instanceId === "string" ? args.instanceId : undefined;

  if (!prompt.trim()) return toolError(id, "prompt is required");

  // An unknown id is still an explicit error rather than a `prefer` hint that silently
  // falls through to some other instance — the caller asked for *that* core.
  if (instanceId !== undefined && !instances.some((i) => i.id === instanceId)) {
    return toolError(id, `Unknown instance '${instanceId}'.`);
  }

  // Tools are filtered against the engine's registry rather than cast. A client's typo
  // used to arrive at the core as a `rawTools as any`; now an unknown tool is simply not
  // forwarded, and the core's own validation remains the final gate.
  const tools = (Array.isArray(args.tools) ? args.tools.map(String) : []).filter(
    (candidate): candidate is AgentTool => (AGENT_TOOLS as readonly string[]).includes(candidate)
  );

  try {
    // `Fleet.ask` owns the ordering, the failover, and the every-failure message — and it
    // goes through `connectorFor`, so each instance is dialled the way it was recorded.
    const outcome = await createFleet(instances, { fetch: fetchImpl }).ask(
      {
        prompt,
        ...(tools.length > 0 ? { tools } : {}),
        ...(typeof args.userId === "string" ? { userId: args.userId } : {}),
        ...(typeof args.tier === "string" ? { tier: args.tier } : {}),
      },
      instanceId !== undefined ? { prefer: [instanceId] } : {}
    );
    // Which instance answered is platform-level information the caller cannot get from
    // the `AskResult` alone, so it is added rather than dropped.
    return toHttpLike(
      ok(id, asToolContent({ ...outcome.result, instanceId: outcome.instance.id }))
    );
  } catch (e) {
    return toolError(id, String(e));
  }
}
