import { describe, expect, it } from "vitest";

import type { FetchLike, HttpLike, HttpInit } from "@simorgh/phoenix-core";

import { mcpConnector, MCP_PROTOCOL_VERSION } from "../src/connectors/mcp.ts";
import { platformMcpHandler } from "../src/mcp/server.ts";

/** Simulate a core's MCP endpoint for the platform server's use. */
function coreMcpStub(
  statusResponse: unknown,
): FetchLike {
  let sessionId: string | undefined;
  return async (url: string, init?: HttpInit): Promise<HttpLike> => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const req = body as { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> } | null;
    const id = req?.id ?? null;

    if (req?.method === "initialize") {
      const sid = "core-session-" + (url ?? "");
      sessionId = sid;
      const payload = { jsonrpc: "2.0", id, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "core", version: "0.1.0" } } };
      return {
        ok: true, status: 200,
        headers: { get: (n: string) => n === "Mcp-Session-Id" ? sid : null },
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    }

    if (req?.method === "notifications/initialized") {
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => "", json: async () => undefined };
    }

    if (req?.method === "tools/call") {
      const name = req.params?.name as string;
      const result = name === "simorgh_status"
        ? { content: [{ type: "text" as const, text: JSON.stringify(statusResponse) }] }
        : name === "simorgh_ask"
          ? {
              content: [
                {
                  type: "text" as const,
                  // The *real* wire shape: a core answers with `agentResponse`, and reports
                  // provenance in `meta.answered_by` / `meta.flock_attempts[].birdId`.
                  // This stub used to emit `answer`/`answeredBy`, which is the platform-side
                  // `AskResult` vocabulary — so it agreed with `toAskResult`'s output while
                  // disagreeing with every actual core. The test only asserted `status.birds`,
                  // so nothing noticed. `test/support/fake-core.ts` is the wire-accurate
                  // double to reach for next time.
                  text: JSON.stringify({
                    success: true,
                    agentResponse: "core answer",
                    meta: {
                      answered_by: "core",
                      flock_attempts: [{ birdId: "shahin", ok: true }],
                    },
                  }),
                },
              ],
            }
          : { error: { code: -32602, message: `Unknown tool '${name}'.` } };
      const payload = { jsonrpc: "2.0", id, result };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload };
    }

    const payload = { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload };
  };
}

/** Simulate an instance's MCP endpoint that answers platform_ask. */
function mcpInstanceStub(
  response: unknown,
): FetchLike {
  let sessionId: string | undefined;
  return async (url: string, init?: HttpInit): Promise<HttpLike> => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const req = body as { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> } | null;
    const id = req?.id ?? null;

    if (req?.method === "initialize") {
      const sid = "inst-session-" + (url ?? "");
      sessionId = sid;
      const payload = { jsonrpc: "2.0", id, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "instance", version: "0.1.0" } } };
      return {
        ok: true, status: 200,
        headers: { get: (n: string) => n === "Mcp-Session-Id" ? sid : null },
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    }

    if (req?.method === "notifications/initialized") {
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => "", json: async () => undefined };
    }

    if (req?.method === "tools/call") {
      const name = req.params?.name as string;
      const result = name === "simorgh_ask"
        ? { content: [{ type: "text" as const, text: JSON.stringify(response) }] }
        : name === "simorgh_status"
          ? { content: [{ type: "text" as const, text: JSON.stringify({ birds: [], timestamp: 0 }) }] }
          : { error: { code: -32602, message: `Unknown tool '${name}'.` } };
      const payload = { jsonrpc: "2.0", id, result };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload };
    }

    const payload = { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload), json: async () => payload };
  };
}

function instanceStubDown(): FetchLike {
  return async (_url: string, _init?: HttpInit): Promise<HttpLike> => {
    throw new TypeError("connect ECONNREFUSED instance");
  };
}

/** Unwrap a tool result from MCP content blocks. */
function unwrapToolResult(json: { result?: unknown }): unknown {
  const result = json.result as { content?: { type: string; text?: string }[] } | undefined;
  if (!result?.content) return json.result;
  const text = result.content.find((b) => b.type === "text")?.text;
  if (text === undefined) return json.result;
  return JSON.parse(text);
}

/** Send an MCP request directly to the server handler, returning {json, headers}. */
async function serverCall(
  server: FetchLike,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) {
  const response = await server("http://platform.local", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  });
  const json = (await response.json()) as {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
    /**
     * The MCP-level tool-failure flag, captured **before** unwrapping.
     *
     * Per the MCP spec `isError` belongs on the tool *result*, not inside the JSON payload,
     * so unwrapping alone would erase the difference between "the tool failed" and "the
     * tool succeeded and returned a body mentioning an error". Asserting this field is what
     * pins the flag to the right layer — the server used to put it in the payload, and the
     * tests could not tell.
     */
    toolError?: boolean;
  };
  if (method === "tools/call") {
    const raw = json.result as { content?: unknown; isError?: boolean } | undefined;
    json.toolError = raw?.isError === true;
    json.result = unwrapToolResult(json);
  }
  return { json, headers: response.headers };
}

describe("platform MCP server", () => {
  // ── 1. initialize ──

  it("initialize returns the shared protocol version constant", async () => {
    const server = platformMcpHandler();
    const { json } = await serverCall(server, "initialize");
    expect(json.result).toEqual(
      expect.objectContaining({ protocolVersion: MCP_PROTOCOL_VERSION }),
    );
  });

  it("initialize returns serverInfo and capabilities", async () => {
    const server = platformMcpHandler({ serverName: "test", serverVersion: "1.0" });
    const { json } = await serverCall(server, "initialize");
    expect(json.result).toEqual(
      expect.objectContaining({
        serverInfo: { name: "test", version: "1.0" },
        capabilities: { tools: {} },
      }),
    );
  });

  // ── 2. tools/list ──

  it("tools/list advertises all three platform tools with schemas", async () => {
    const server = platformMcpHandler();
    const { json } = await serverCall(server, "tools/list");
    const tools = (json.result as { tools: unknown[] }).tools;
    const names = tools.map((t) => (t as { name: string }).name);
    expect(names).toContain("platform_targets");
    expect(names).toContain("platform_fleet");
    expect(names).toContain("platform_ask");
    // Exactly three — an exact count, not just `toContain`. The first revision also
    // published `simorgh_status`/`simorgh_ask` as aliases, which meant an agent host
    // reaching both a platform and a core would see one name with two meanings (the
    // platform's "ask the whole fleet" vs the core's "ask me"). `toContain` let that
    // through; the count does not.
    for (const tool of tools) {
      expect(tool).toHaveProperty("inputSchema");
      expect((tool as { name: string; inputSchema: unknown }).inputSchema).toBeDefined();
    }
    expect(json.error).toBeUndefined();
  });

  // ── 3. Round trip ──

  it("our own client reaches it — and is refused when it tries to speak core", async () => {
    const mockStatus = {
      birds: [
        {
          id: "bird",
          name: "Homa",
          provider: "homa",
          model: "x",
          priority: 1,
          dormant: false,
          status: "healthy",
          consecutiveFailures: 0,
          cooldownUntil: 0,
          totalCalls: 1,
          totalFailures: 0,
        },
      ],
      timestamp: 123,
    };
    const server = platformMcpHandler({
      instances: [
        {
          id: "node:localhost",
          targetId: "node",
          endpoint: "http://localhost:8788",
          connector: "mcp" as const,
        },
      ],
      fetch: coreMcpStub(mockStatus),
    });

    // 1. Transport interop, with the *same client the platform uses to reach cores*:
    //    initialize, the session id, the notifications, the JSON-RPC envelope. Nothing
    //    about the tool surface is involved, which is the point — the transport is shared
    //    and that is what has to keep working.
    const connector = mcpConnector({ endpoint: "http://platform.local", fetch: server });
    const health = await connector.health();
    expect(health.reachable).toBe(true);

    // 2. And a *core-specific* call does **not** work against the platform — by design.
    //    The platform publishes `platform_*` and never `simorgh_*`, so an agent host can
    //    always tell the platform's `ask` (the whole fleet) from a core's `ask` (that one
    //    core). This assertion is what makes that naming rule load-bearing rather than
    //    cosmetic, and it is exactly the property the old `simorgh_status` aliases made
    //    impossible to state.
    //
    //    Note it fails at the *tool* level with a named error, not with a crash: an agent
    //    host can read "that tool does not exist here" and adapt.
    await expect(connector.status()).rejects.toThrow(/simorgh_status|Unknown tool/i);

    // 3. What an agent host actually reads: the tool result, in the platform's own
    //    vocabulary. Asserted through the raw call because `connector.ask()` maps a
    //    *core's* wire shape (`agentResponse` / `meta.answered_by`) and the platform's
    //    server returns the platform's (`answer` / `answeredBy`) — deliberately, since the
    //    consumer here is an agent, not another core.
    const initRes = await serverCall(server, "initialize");
    const session = initRes.headers!.get("Mcp-Session-Id");
    const { json } = await serverCall(
      server,
      "tools/call",
      { name: "platform_ask", arguments: { prompt: "who is simorgh" } },
      session!
    );
    const result = json.result as {
      success: boolean;
      answer: string;
      answeredBy: string;
      instanceId: string;
    };
    expect(result.success).toBe(true);
    expect(result.answer).toBe("core answer");
    expect(result.answeredBy).toBe("core");
    // Which instance answered is platform-level information the caller cannot get from
    // the answer alone, so the server reports it explicitly.
    expect(result.instanceId).toBe("node:localhost");
  });

  // ── 4. Session enforcement ──

  it("tools/call without Mcp-Session-Id fails", async () => {
    const server = platformMcpHandler();
    const { json } = await serverCall(server, "tools/call", { name: "platform_targets" });
    expect(json.error).toBeDefined();
    expect(json.error!.code).toBe(-32600);
    expect(json.error!.message).toContain("Mcp-Session-Id");
  });

  it("tools/call with Mcp-Session-Id succeeds", async () => {
    const server = platformMcpHandler();
    const initRes = await serverCall(server, "initialize");
    const session = initRes.headers!.get("Mcp-Session-Id");
    const { json } = await serverCall(server, "tools/call", { name: "platform_targets" }, session!);
    expect(json.error).toBeUndefined();
    expect(json.result).toBeDefined();
  });

  // ── 5. Unknown method ──

  it("unknown method returns JSON-RPC error without throwing", async () => {
    const server = platformMcpHandler();
    const { json } = await serverCall(server, "clearly_not_a_method");
    expect(json.error).toBeDefined();
    expect(json.error!.code).toBe(-32601);
  });

  // ── 6. Unknown tool ──

  it("unknown tool reports a tool failure without throwing", async () => {
    const server = platformMcpHandler();
    const initRes = await serverCall(server, "initialize");
    const session = initRes.headers!.get("Mcp-Session-Id");
    const { json } = await serverCall(server, "tools/call", { name: "nonexistent_tool" }, session!);
    // Asserted at the *MCP result* level, where the spec puts it — see `serverCall`.
    expect(json.toolError).toBe(true);
    expect(json.result).toEqual(expect.objectContaining({ message: expect.stringMatching(/Unknown tool/) }));
  });

  // ── 7. platform_targets ──

  it("platform_targets omits steps and secrets", async () => {
    const server = platformMcpHandler();
    const initRes = await serverCall(server, "initialize");
    const session = initRes.headers!.get("Mcp-Session-Id");
    const { json } = await serverCall(server, "tools/call", { name: "platform_targets" }, session!);
    const targets = json.result as Array<Record<string, unknown>>;
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(t).not.toHaveProperty("steps");
      expect(t).not.toHaveProperty("secrets");
      expect(t).toHaveProperty("id");
      expect(t).toHaveProperty("label");
      expect(t).toHaveProperty("runtime");
      expect(t).toHaveProperty("connectors");
      expect(t).toHaveProperty("modes");
      expect(t).toHaveProperty("endpoint");
    }
  });

  // ── 8. platform_fleet ──

  it("platform_fleet with no instances returns clean empty result", async () => {
    const server = platformMcpHandler({ instances: [] });
    const initRes = await serverCall(server, "initialize");
    const session = initRes.headers!.get("Mcp-Session-Id");
    const { json } = await serverCall(server, "tools/call", { name: "platform_fleet" }, session!);
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual([]);
  });

  it("platform_fleet with unknown instanceId says so", async () => {
    const server = platformMcpHandler({ instances: [] });
    const initRes = await serverCall(server, "initialize");
    const session = initRes.headers!.get("Mcp-Session-Id");
    const { json } = await serverCall(server, "tools/call", {
      name: "platform_fleet",
      arguments: { instanceId: "does:not:exist" },
    }, session!);
    expect(json.toolError).toBe(true);
    expect(json.result).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/Unknown instance/) })
    );
  });

  // ── 9. platform_ask ──

  it("platform_ask against a dead fleet reports a tool failure rather than throwing", async () => {
    const server = platformMcpHandler({ instances: [] });
    const initRes = await serverCall(server, "initialize");
    const session = initRes.headers!.get("Mcp-Session-Id");
    const { json } = await serverCall(server, "tools/call", {
      name: "platform_ask",
      arguments: { prompt: "hi" },
    }, session!);
    // A dead fleet is a *value* an agent can reason about, not a transport error and not a
    // HTTP 500 — which is why this is `isError` on the tool result rather than a JSON-RPC
    // `error` (that is reserved for protocol faults, like an unknown method).
    expect(json.toolError).toBe(true);
    expect(json.error).toBeUndefined();
  });

  it("platform_ask fails over to the second instance", async () => {
    const mockAnswer = {
      success: true,
      answer: "second instance answered",
      answeredBy: "second",
      attempts: [{ providerId: "homa", ok: true }],
    };
    const server = platformMcpHandler({
      instances: [
        {
          id: "first",
          targetId: "node",
          endpoint: "http://first.local",
          connector: "mcp" as const,
        },
        {
          id: "second",
          targetId: "node",
          endpoint: "http://second.local",
          connector: "mcp" as const,
        },
      ],
      fetch: async (url: string, _init?: HttpInit): Promise<HttpLike> => {
        if (url.includes("first.local")) return instanceStubDown()(url, _init);
        return mcpInstanceStub(mockAnswer)(url, _init);
      },
    });

    const initRes = await serverCall(server, "initialize");
    const session = initRes.headers!.get("Mcp-Session-Id");
    const { json } = await serverCall(server, "tools/call", {
      name: "platform_ask",
      arguments: { prompt: "hi" },
    }, session!);
    expect(json.result).not.toHaveProperty("error");
    expect((json.result as { success: boolean }).success).toBe(true);
  });
});
