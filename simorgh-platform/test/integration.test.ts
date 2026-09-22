// ── End to end, over real HTTP ────────────────────────────────────────────────
//
// Boots an actual phoenix-core and reaches it with both connectors. This is the test
// that covers the claim the whole design rests on: the same engine, deployed by the
// platform, answers identically whether a caller arrives over REST or over MCP.
//
// The transport is real — a real `node:http` server on a real ephemeral port, real
// JSON, real SQLite. The only stand-in is the inference provider, which returns a
// canned answer so the suite never needs a key or the internet. Everything the
// connectors and the runtime do *between* the caller and that provider is the
// production code path.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Provider } from "@simorgh/phoenix-core";

import { mcpConnector } from "../src/connectors/mcp.ts";
import { restConnector } from "../src/connectors/rest.ts";
import { startNodeRuntime, type NodeRuntime } from "../src/runtimes/node.ts";

const API_KEY = "integration-token";

/** Answers without touching the network, so the suite is hermetic. */
const canned: Provider = {
  id: "canned",
  name: "Canned",
  provider: "Test double",
  model: "canned-1",
  priority: 10,
  async call(prompt) {
    return { ok: true, answer: `canned: ${prompt}` };
  },
};

let runtime: NodeRuntime;

const rest = () =>
  restConnector({ endpoint: runtime.url, apiKey: API_KEY, fetch: (u, i) => fetch(u, i as RequestInit) });

const mcp = () =>
  mcpConnector({ endpoint: `${runtime.url}/mcp`, apiKey: API_KEY, fetch: (u, i) => fetch(u, i as RequestInit) });

beforeAll(async () => {
  runtime = await startNodeRuntime({
    port: 0,
    apiKey: API_KEY,
    secrets: {},
    providers: [canned],
  });
});

afterAll(async () => {
  await runtime.close();
});

describe("a live core reached over REST", () => {
  it("answers a health probe", async () => {
    const health = await rest().health();
    expect(health.reachable).toBe(true);
    expect(health.detail).toBe("ok");
  });

  it("reports its flock, with the provider neither dormant nor unreachable", async () => {
    const status = await rest().status();
    expect(status.birds.map((b) => [b.id, b.status, b.dormant])).toEqual([
      ["canned", "healthy", false],
    ]);
  });

  it("answers an ask through the real engine", async () => {
    const result = await rest().ask({ prompt: "who are you?", userId: "u-rest" });
    expect(result.success).toBe(true);
    expect(result.answer).toBe("canned: who are you?");
    expect(result.answeredBy).toBe("Canned (Test double)");
  });

  it("runs a local tool without reaching the network", async () => {
    const result = await rest().ask({
      prompt: "what time is it?",
      tools: ["get_server_time"],
      userId: "u-tools",
    });
    // The synthesis prompt — not the raw prompt — is what the provider saw, which is
    // how the tool result reaches the answer.
    expect(result.answer).toContain("Request: what time is it?");
    expect(result.answer).toContain("[get_server_time]");
  });

  it("records the call on the transparency ledger", async () => {
    await rest().ask({ prompt: "ledger me", userId: "u-ledger" });
    const response = await fetch(`${runtime.url}/api/v1/user/u-ledger/logs`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await response.json()) as { count: number; entries: { action: string }[] };
    expect(body.count).toBe(1);
    expect(body.entries[0]?.action).toBe("execute");
  });

  it("refuses a caller with no token", async () => {
    const anonymous = restConnector({
      endpoint: runtime.url,
      fetch: (u, i) => fetch(u, i as RequestInit),
    });
    await expect(anonymous.ask({ prompt: "x" })).rejects.toThrow(/bearer token rejected/);
  });
});

describe("the same core reached over MCP", () => {
  it("completes the handshake", async () => {
    const health = await mcp().health();
    expect(health.reachable).toBe(true);
    expect(health.detail).toContain("mcp 2026-07-28");
  });

  it("returns the same flock status as REST", async () => {
    const [overRest, overMcp] = await Promise.all([rest().status(), mcp().status()]);
    expect(overMcp.birds.map((b) => b.id)).toEqual(overRest.birds.map((b) => b.id));
    expect(overMcp.birds[0]?.status).toBe(overRest.birds[0]?.status);
  });

  it("returns the same answer as REST", async () => {
    // The parity claim, asserted directly: two transports, one core, one answer.
    const [overRest, overMcp] = await Promise.all([
      rest().ask({ prompt: "who are you?", userId: "u-parity" }),
      mcp().ask({ prompt: "who are you?", userId: "u-parity" }),
    ]);

    expect(overMcp.answer).toBe(overRest.answer);
    expect(overMcp.answeredBy).toBe(overRest.answeredBy);
    expect(overMcp.success).toBe(overRest.success);
  });

  it("refuses a caller with no token", async () => {
    const anonymous = mcpConnector({
      endpoint: `${runtime.url}/mcp`,
      fetch: (u, i) => fetch(u, i as RequestInit),
    });
    expect((await anonymous.health()).reachable).toBe(false);
  });
});

describe("the runtime itself", () => {
  it("binds an ephemeral port when asked for port 0", () => {
    expect(runtime.port).toBeGreaterThan(0);
    expect(runtime.url).toContain(`:${runtime.port}`);
  });

  it("does not let a malformed body become a 500", async () => {
    const response = await fetch(`${runtime.url}/api/v1/agent/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: "{ not json",
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_json" },
    });
  });

  it("404s an unknown route rather than hanging", async () => {
    const response = await fetch(`${runtime.url}/nope`);
    expect(response.status).toBe(404);
  });
});
