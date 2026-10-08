// ── The MCP connector ─────────────────────────────────────────────────────────
//
// Speaks MCP over the Streamable HTTP transport: JSON-RPC 2.0 in a POST body, with
// the server handing back a session id in `Mcp-Session-Id` that every later call has
// to echo. That session id is the whole reason the connector is stateful, and the
// whole reason `HttpLike` had to expose response headers.
//
// Only three methods are used — `initialize`, `notifications/initialized`, and
// `tools/call` — because the core exposes two tools and no resources or prompts.
// There is deliberately no `tools/list` call in the request path: the platform knows
// which tools it means, and a listing would be a round trip on every request.
//
// `simorgh_ask` is treated as an *action*, not a data read, so its content is parsed
// back into the same `AskResult` the REST connector returns. A caller cannot tell
// which connector answered, and should not have to.

import type { FetchLike, FlockStatus } from "@simorgh/phoenix-core";

import {
  toAskResult,
  type AskRequest,
  type AskResult,
  type CoreConnector,
  type CoreHealth,
} from "./types.ts";

/** The MCP revision the PRD pins. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Tool names a phoenix-core exposes over MCP. Shared with the server impl. */
export const MCP_TOOL_STATUS = "simorgh_status";
export const MCP_TOOL_ASK = "simorgh_ask";

export interface McpConnectorConfig {
  endpoint: string;
  apiKey?: string;
  fetch: FetchLike;
  clientName?: string;
}

interface McpToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/**
 * Pull the JSON payload out of an MCP tool result.
 *
 * MCP tool output is a list of typed content blocks; the convention for structured
 * data is a single `text` block holding JSON. Asserting the block exists is better
 * than guessing: an empty content list means the server answered with nothing, which
 * is a failure worth naming.
 */
function toolPayload(result: unknown): unknown {
  const content = (result as McpToolResult).content;
  const text = content?.find((block) => block.type === "text")?.text;
  if (text === undefined) throw new Error("mcp_tool_returned_no_text_content");
  return JSON.parse(text);
}

/**
 * Read a JSON-RPC reply, tolerating both encodings the transport allows.
 *
 * A server may answer `application/json` or an `text/event-stream` whose final
 * `data:` frame carries the message. Both are legal, so both are read rather than
 * assuming the one our own server happens to use.
 */
function parseRpcPayload(text: string): { result?: unknown; error?: { message?: string } } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as { result?: unknown };

  const frames = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  const last = frames[frames.length - 1];
  if (!last) throw new Error("mcp_empty_response");
  return JSON.parse(last) as { result?: unknown };
}

export function mcpConnector(config: McpConnectorConfig): CoreConnector {
  let sessionId: string | undefined;
  let nextId = 0;
  let initialized = false;

  async function rpc(
    method: string,
    params?: unknown,
    options: { notify?: boolean } = {}
  ): Promise<unknown> {
    const id = ++nextId;
    const body = options.notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id, method, params };

    const response = await config.fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

    // The session id arrives on `initialize` and must be echoed from then on.
    const issued = response.headers?.get("Mcp-Session-Id");
    if (issued) sessionId = issued;

    if (!response.ok) throw new Error(`mcp ${method} → http_${response.status}`);

    const text = response.text ? await response.text() : "";
    // A notification's reply carries no message; 202 with an empty body is normal.
    if (!text.trim()) return undefined;

    const payload = parseRpcPayload(text);
    if (payload.error) throw new Error(`mcp ${method}: ${payload.error.message ?? "unknown error"}`);
    return payload.result;
  }

  /** Initialize once per connector; later calls reuse the session. */
  async function handshake(): Promise<void> {
    if (initialized) return;
    await rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: config.clientName ?? "simorgh-platform", version: "0.1.0" },
    });
    await rpc("notifications/initialized", {}, { notify: true });
    initialized = true;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await handshake();
    const result = await rpc("tools/call", { name, arguments: args });
    if ((result as McpToolResult).isError === true) {
      throw new Error(`mcp tool '${name}' reported an error`);
    }
    return toolPayload(result);
  }

  return {
    kind: "mcp",
    endpoint: config.endpoint,

    async health(): Promise<CoreHealth> {
      const started = Date.now();
      try {
        await handshake();
        return {
          reachable: true,
          endpoint: config.endpoint,
          latencyMs: Date.now() - started,
          detail: `mcp ${MCP_PROTOCOL_VERSION} session open`,
        };
      } catch (e) {
        // A failed handshake must not poison the connector: the next call retries
        // from scratch rather than replaying a session the server has forgotten.
        initialized = false;
        sessionId = undefined;
        return {
          reachable: false,
          endpoint: config.endpoint,
          latencyMs: Date.now() - started,
          detail: String(e),
        };
      }
    },

    async status(): Promise<FlockStatus> {
      return (await callTool(MCP_TOOL_STATUS, {})) as FlockStatus;
    },

    async ask(request: AskRequest): Promise<AskResult> {
      const payload = await callTool(MCP_TOOL_ASK, {
        prompt: request.prompt,
        ...(request.tools ? { tools: [...request.tools] } : {}),
        ...(request.userId ? { userId: request.userId } : {}),
        ...(request.tier ? { tier: request.tier } : {}),
      });
      return toAskResult(payload as Parameters<typeof toAskResult>[0]);
    },
  };
}
