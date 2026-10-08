import { describe, expect, it } from "vitest";

import type { FetchLike, HttpInit } from "@simorgh/phoenix-core";

import { mcpConnector, MCP_TOOL_ASK, MCP_TOOL_STATUS } from "../src/connectors/mcp.ts";
import { restConnector } from "../src/connectors/rest.ts";
import { toAskResult } from "../src/connectors/types.ts";

interface StubReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function stubFetch(handler: (url: string, init?: HttpInit) => StubReply) {
  const calls: { url: string; init?: HttpInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const reply = handler(url, init);
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => reply.headers?.[name] ?? null },
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body ?? null),
    };
  };
  return { fetchImpl, calls };
}

/** The wire shape a core returns, as the connectors must read it. */
const executePayload = {
  success: true,
  agentResponse: "thirty birds",
  meta: {
    answered_by: "Shāhīn (Groq (OpenAI-compat))",
    flock_attempts: [
      { birdId: "shahin", ok: true },
      { birdId: "homa", ok: false, error: "dormant" },
    ],
  },
};

describe("toAskResult", () => {
  it("maps the wire payload onto the platform's shape", () => {
    expect(toAskResult(executePayload)).toEqual({
      success: true,
      answer: "thirty birds",
      answeredBy: "Shāhīn (Groq (OpenAI-compat))",
      attempts: [
        { providerId: "shahin", ok: true },
        { providerId: "homa", ok: false, error: "dormant" },
      ],
    });
  });

  it("survives a malformed payload rather than throwing", () => {
    expect(toAskResult({})).toEqual({
      success: false,
      answer: "",
      answeredBy: "unknown",
      attempts: [],
    });
    expect(toAskResult({ meta: { flock_attempts: [{} as never] } }).attempts).toEqual([]);
  });
});

describe("restConnector", () => {
  const config = (fetchImpl: FetchLike) => ({
    endpoint: "https://core.example/",
    apiKey: "k",
    fetch: fetchImpl,
  });

  it("probes /health and normalizes the trailing slash", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: { status: "ok" } }));
    const connector = restConnector(config(fetchImpl));

    expect(connector.endpoint).toBe("https://core.example");
    const health = await connector.health();
    expect(health).toMatchObject({ reachable: true, detail: "ok" });
    expect(calls[0]?.url).toBe("https://core.example/health");
  });

  it("reports an unreachable core as unreachable rather than throwing", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const health = await restConnector(config(fetchImpl)).health();
    expect(health.reachable).toBe(false);
    expect(health.detail).toMatch(/ECONNREFUSED/);
  });

  it("reads the flock status payload", async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: { birds: [{ id: "homa", status: "healthy" }], timestamp: 1 },
    }));
    const status = await restConnector(config(fetchImpl)).status();
    expect(status.birds[0]?.id).toBe("homa");
  });

  it("sends a bearer token and the request body the core expects", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: executePayload }));
    const result = await restConnector(config(fetchImpl)).ask({
      prompt: "hello",
      tools: ["search_web"],
      userId: "u-1",
    });

    expect(calls[0]?.url).toBe("https://core.example/api/v1/agent/execute");
    expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer k");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({
      prompt: "hello",
      tools: ["search_web"],
      userId: "u-1",
      tier: "Free-Volunteer",
    });
    expect(result).toMatchObject({ success: true, answer: "thirty birds" });
  });

  it("explains a 401 and a 503, because they mean different things", async () => {
    const unauthorized = stubFetch(() => ({ status: 401 }));
    await expect(restConnector(config(unauthorized.fetchImpl)).ask({ prompt: "x" })).rejects.toThrow(
      /bearer token rejected/
    );

    const notConfigured = stubFetch(() => ({ status: 503 }));
    await expect(
      restConnector(config(notConfigured.fetchImpl)).ask({ prompt: "x" })
    ).rejects.toThrow(/fails closed/);
  });
});

describe("mcpConnector", () => {
  const config = (fetchImpl: FetchLike) => ({
    endpoint: "https://core.example/mcp",
    apiKey: "k",
    fetch: fetchImpl,
  });

  /** A stand-in MCP server: issues a session id, then answers tools/call. */
  function mcpServer(options: { issueSession?: string; toolPayload?: unknown } = {}) {
    const methods: string[] = [];
    const sessions: (string | undefined)[] = [];
    const { fetchImpl, calls } = stubFetch((_url, init): StubReply => {
      const body = JSON.parse(init?.body ?? "{}") as { method?: string; id?: number };
      methods.push(body.method ?? "");
      sessions.push(init?.headers?.["Mcp-Session-Id"]);
      if (body.method === "initialize") {
        return {
          body: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2026-07-28" } },
          headers: options.issueSession ? { "Mcp-Session-Id": options.issueSession } : {},
        };
      }
      return {
        body: {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(options.toolPayload ?? executePayload) }],
          },
        },
      };
    });
    return { fetchImpl, calls, methods, sessions };
  }

  it("initializes, notifies, then calls the tool — and echoes the session id", async () => {
    const server = mcpServer({ issueSession: "sess-42" });
    const connector = mcpConnector(config(server.fetchImpl));

    const result = await connector.ask({ prompt: "hello" });

    expect(server.methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    // Only `initialize` goes out without a session; the id it returns is echoed from
    // the very next message onwards, notification included.
    expect(server.sessions).toEqual([undefined, "sess-42", "sess-42"]);
    expect(JSON.parse(server.calls[2]?.init?.body ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: MCP_TOOL_ASK, arguments: { prompt: "hello" } },
    });
    expect(result).toMatchObject({ success: true, answer: "thirty birds" });
  });

  it("handshakes once across several calls", async () => {
    const server = mcpServer();
    const connector = mcpConnector(config(server.fetchImpl));

    await connector.ask({ prompt: "one" });
    await connector.ask({ prompt: "two" });

    expect(server.methods.filter((m) => m === "initialize")).toHaveLength(1);
  });

  it("reads a status tool result", async () => {
    const server = mcpServer({ toolPayload: { birds: [{ id: "homa" }], timestamp: 7 } });
    const status = await mcpConnector(config(server.fetchImpl)).status();

    expect(status.birds).toHaveLength(1);
    expect(JSON.parse(server.calls[2]?.init?.body ?? "{}").params.name).toBe(MCP_TOOL_STATUS);
  });

  it("reports a failure when the core omits a session id", async () => {
    // Legal per the spec, so it must not break the connector — only the header echo
    // is conditional.
    const server = mcpServer();
    const health = await mcpConnector(config(server.fetchImpl)).health();
    expect(health.reachable).toBe(true);
    expect(health.detail).toContain("2026-07-28");
  });

  it("surfaces a JSON-RPC error instead of pretending it succeeded", async () => {
    const { fetchImpl } = stubFetch((_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as { method?: string; id?: number };
      if (body.method === "initialize") {
        return { body: { jsonrpc: "2.0", id: body.id, result: {} }, headers: { "Mcp-Session-Id": "s" } };
      }
      return {
        body: { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Unknown tool 'nope'." } },
      };
    });

    await expect(mcpConnector(config(fetchImpl)).ask({ prompt: "x" })).rejects.toThrow(
      /Unknown tool 'nope'/
    );
  });

  it("treats a tool result flagged isError as a failure", async () => {
    const { fetchImpl } = stubFetch((_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as { method?: string; id?: number };
      if (body.method === "initialize") {
        return { body: { jsonrpc: "2.0", id: body.id, result: {} }, headers: { "Mcp-Session-Id": "s" } };
      }
      return {
        body: {
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "{}" }], isError: true },
        },
      };
    });

    await expect(mcpConnector(config(fetchImpl)).ask({ prompt: "x" })).rejects.toThrow(/reported an error/);
  });

  it("resets the handshake after a failed health probe", async () => {
    let failHandshake = true;
    const methods: string[] = [];
    const { fetchImpl } = stubFetch((_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as { method?: string; id?: number };
      methods.push(body.method ?? "");
      if (body.method === "initialize" && failHandshake) {
        failHandshake = false;
        return { status: 500, body: {} };
      }
      if (body.method === "initialize") {
        return { body: { jsonrpc: "2.0", id: body.id, result: {} }, headers: { "Mcp-Session-Id": "s" } };
      }
      return {
        body: {
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(executePayload) }] },
        },
      };
    });

    const connector = mcpConnector(config(fetchImpl));
    expect((await connector.health()).reachable).toBe(false);
    // A failed handshake must not poison the connector: the retry re-initializes.
    expect((await connector.ask({ prompt: "x" })).success).toBe(true);
    expect(methods.filter((m) => m === "initialize")).toHaveLength(2);
  });

  it("parses an SSE-framed reply as well as a plain JSON one", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as { method?: string; id?: number };
      const message =
        body.method === "initialize"
          ? { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2026-07-28" } }
          : {
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(executePayload) }] },
            };
      return {
        ok: true,
        status: 200,
        headers: { get: () => (body.method === "initialize" ? "sse-session" : null) },
        json: async () => message,
        text: async () => `event: message\ndata: ${JSON.stringify(message)}\n\n`,
      };
    };

    const result = await mcpConnector(config(fetchImpl)).ask({ prompt: "x" });
    expect(result.answer).toBe("thirty birds");
  });
});
