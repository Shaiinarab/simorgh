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
/** A second, equally valid token belonging to a *different* user. */
const OTHER_KEY = "integration-other-token";

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
    // The per-user routes resolve their caller from the token map rather than from the
    // URL, so the runtime needs one. Two entries, because the ownership check is only
    // observable when there is somebody to be refused.
    apiKeys: JSON.stringify({ [API_KEY]: "u-ledger", [OTHER_KEY]: "u-other" }),
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

  // AUTH-002 / AUTH-003 again, but on the *self-hosted* host. The two hosts serve the
  // same routes over the same engine, so a fix that landed on only one of them would
  // leave the other reachable — and the workers suite cannot see this runtime at all.
  it("refuses to read another user's ledger on the node host (AUTH-002)", async () => {
    await rest().ask({ prompt: "identify me", userId: "u-ledger" });

    // Positive control: the owner still reads their own ledger.
    const owner = await fetch(`${runtime.url}/api/v1/user/u-ledger/logs`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(owner.status).toBe(200);

    // The finding: a valid token for a different user must not.
    const intruder = await fetch(`${runtime.url}/api/v1/user/u-ledger/logs`, {
      headers: { Authorization: `Bearer ${OTHER_KEY}` },
    });
    expect(intruder.status).toBe(403);
    expect(((await intruder.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("refuses to serve another user's offloaded context on the node host (AUTH-003)", async () => {
    // Executed with the *service* key, because `/api/v1/agent/execute` still authenticates
    // against `SIMORGH_API_KEY` alone — a token from the `SIMORGH_API_KEYS` map cannot call
    // it (see the note on `NodeRuntimeOptions.apiKeys`). Ownership, which is what this test
    // is about, comes from the `userId` in the body, not from the token that executed.
    const executed = await fetch(`${runtime.url}/api/v1/agent/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ prompt: "private context", tools: [], userId: "u-other" }),
    });
    expect(executed.status).toBe(200);
    const { meta } = (await executed.json()) as { meta: { contextRefId: string } };

    const owner = await fetch(`${runtime.url}/api/v1/context/${meta.contextRefId}`, {
      headers: { Authorization: `Bearer ${OTHER_KEY}` },
    });
    expect(owner.status).toBe(200);

    const intruder = await fetch(`${runtime.url}/api/v1/context/${meta.contextRefId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(intruder.status).toBe(404);
    expect(await intruder.json()).toEqual({ error: "not_found" });
  });

  it("serves the same capability matrix the edge does, from this host's own roster", async () => {
    const res = await fetch(`${runtime.url}/api/v1/capabilities`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      capabilities: {
        capability: string;
        available: string[];
        degraded: boolean;
        considered: { adapter: string; cost: string; keyFree: boolean; reason?: string }[];
      }[];
      summary: string[];
    };

    const byCapability = Object.fromEntries(
      body.capabilities.map((entry) => [entry.capability, entry])
    );
    expect(Object.keys(byCapability).sort()).toEqual([
      "embeddings",
      "inference",
      "scheduler",
      "sync",
      "vector",
    ]);

    // The matrix describes the roster this runtime was *given* — `providers: [canned]` —
    // not a catalogue compiled into the engine. That is the whole point of probing rather
    // than enumerating, so the assertion is about the injected double's id.
    const inference = byCapability.inference;
    expect(inference?.considered.map((v) => v.adapter)).toEqual(["canned"]);
    expect(inference?.available).toEqual(["canned"]);
    expect(inference?.considered[0]?.keyFree).toBe(true);

    // An adapter nobody classified reports `unknown`, never `free` — ADR-0005's default is
    // the direction that fails closed, and a test double is exactly the unclassified case.
    expect(inference?.considered[0]?.cost).toBe("unknown");

    for (const name of ["embeddings", "vector", "sync", "scheduler"]) {
      expect(byCapability[name]?.degraded).toBe(true);
      expect(byCapability[name]?.considered.map((v) => v.reason)).toEqual([
        "no_adapter_registered",
      ]);
    }

    // The rendered summary is part of the contract, not a debugging aid: it is the line an
    // operator reads. A capability that quietly vanished from it would be the failure the
    // whole module exists to prevent.
    expect(body.summary.at(-1)).toBe("4 of 5 capabilities degraded");
  });

  it("gates the capability matrix on this host too", async () => {
    const res = await fetch(`${runtime.url}/api/v1/capabilities`);
    expect(res.status).toBe(401);
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
