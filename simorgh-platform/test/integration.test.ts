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
    // No `userId` since A3: this connector holds the token for `u-ledger`, so the ask
    // *is* u-ledger's. The old version passed `userId: "u-rest"` and the core believed it.
    const result = await rest().ask({ prompt: "who are you?" });
    expect(result.success).toBe(true);
    expect(result.answer).toBe("canned: who are you?");
    expect(result.answeredBy).toBe("Canned (Test double)");
  });

  it("runs a local tool without reaching the network", async () => {
    const result = await rest().ask({
      prompt: "what time is it?",
      tools: ["get_server_time"],
    });
    // The synthesis prompt — not the raw prompt — is what the provider saw, which is
    // how the tool result reaches the answer.
    expect(result.answer).toContain("Request: what time is it?");
    expect(result.answer).toContain("[get_server_time]");
  });

  it("records the call on the transparency ledger under the token's principal", async () => {
    await rest().ask({ prompt: "ledger me" });
    const response = await fetch(`${runtime.url}/api/v1/user/u-ledger/logs`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = (await response.json()) as { count: number; entries: { action: string }[] };
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.entries.some((e) => e.action === "execute")).toBe(true);

    // A3: rows land under the *credential's* subject. The name an earlier test used to
    // pick from the body ("u-rest") never owns a row here — and this caller cannot even
    // ask whether it does; that question is the non-owner's 403.
    const orphan = await fetch(`${runtime.url}/api/v1/user/u-rest/logs`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(orphan.status).toBe(403);
  });

  // AUTH-002 / AUTH-003 again, but on the *self-hosted* host. The two hosts serve the
  // same routes over the same engine, so a fix that landed on only one of them would
  // leave the other reachable — and the workers suite cannot see this runtime at all.
  it("refuses to read another user's ledger on the node host (AUTH-002)", async () => {
    await rest().ask({ prompt: "identify me" });

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
    // Executed with u-other's *own* token. Before A3 this test wrote the body name
    // `u-other` while holding the service key — because the execute seam took ownership
    // from the body — and the comment had to say so. Now the credential is the only
    // authority: a *matching* claim is accepted as a claim, and ownership lands the same
    // place either way, which is the point of the A3 seam.
    const executed = await fetch(`${runtime.url}/api/v1/agent/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OTHER_KEY}` },
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
      rest().ask({ prompt: "who are you?" }),
      mcp().ask({ prompt: "who are you?" }),
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

// ── Cross-principal execution (A3 / AUTH-004) ──────────────────────────────────
//
// The security gate, asserted over a *real* core on a real port — not a fixture. The
// claim under test is the narrow one: with two valid tokens, neither can make the
// core do anything in the other's name. Every spoof here goes through both doors the
// old seam had (the header and the body), on this host; the Workers twin is
// `test/identity.test.ts`.

const postExecute = (token: string, body: unknown, headerUser?: string) =>
  fetch(`${runtime.url}/api/v1/agent/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(headerUser ? { "X-Simorgh-User-Id": headerUser } : {}),
    },
    body: JSON.stringify(body),
  });

const logsCount = async (userId: string, token: string): Promise<number | string> => {
  const res = await fetch(`${runtime.url}/api/v1/user/${userId}/logs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return res.status;
  return ((await res.json()) as { count: number }).count;
};

describe("cross-principal execution (A3)", () => {
  it("refuses a header spoof: a valid token cannot execute as another user by naming them", async () => {
    const before = await logsCount("u-other", OTHER_KEY);
    expect(typeof before).toBe("number");

    const res = await postExecute(API_KEY, { prompt: "spoof the header", tools: [] }, "u-other");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    // Zero side effects: u-other's ledger is untouched by somebody else's refusal.
    expect(await logsCount("u-other", OTHER_KEY)).toBe(before);
  });

  it("refuses a body spoof: `userId` is a claim, not an identity", async () => {
    const res = await postExecute(OTHER_KEY, { prompt: "spoof the body", tools: [], userId: "u-ledger" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    // One flat message for every mismatch, whether or not the claimed name is real:
    // this response cannot enumerate the token map.
    expect(body.error.message).toBe("The claimed user id does not match the authenticated principal.");
  });

  it("accepts a *matching* claim and still attributes by the credential, not the claim", async () => {
    const mine = await logsCount("u-ledger", API_KEY);
    const theirs = await logsCount("u-other", OTHER_KEY);

    const res = await postExecute(API_KEY, { prompt: "agrees with me", tools: [], userId: "u-ledger" });
    expect(res.status).toBe(200);

    expect(await logsCount("u-ledger", API_KEY)).toBe((mine as number) + 1);
    expect(await logsCount("u-other", OTHER_KEY)).toBe(theirs);
  });

  it("isolates the rate-limit budget: exhausting one principal does not touch another", async () => {
    // 20 per minute by default. Loop until the fourth wall appears — the *count* to
    // get there is a property of shared state this suite mutates, so the claim pinned
    // here is "OTHER_KEY hits 429 while API_KEY keeps answering", not "exactly 21".
    let exhausted: Response | undefined;
    for (let i = 0; i < 25; i += 1) {
      const res = await postExecute(OTHER_KEY, { prompt: `spend ${i}`, tools: [] });
      if (res.status === 429) {
        exhausted = res;
        break;
      }
    }
    expect(exhausted?.status).toBe(429);
    expect(((await exhausted!.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    // The isolation itself: the other principal is entirely uninvolved.
    const untouched = await postExecute(API_KEY, { prompt: "still mine", tools: [] });
    expect(untouched.status).toBe(200);
  });

  it("401s an unknown token — no fallback identity executes anything", async () => {
    // The acceptance line "a valid bearer token with an unknown principal cannot fall
    // back to anonymous user ownership": an *unknown* token is refused outright, and a
    // valid one never needed a fallback because it always resolves to a named subject.
    const res = await postExecute("not-a-token", { prompt: "who am i", tools: [] });
    expect(res.status).toBe(401);
    const anonymous = await postExecute("", { prompt: "who am i", tools: [] });
    expect(anonymous.status).toBe(401);
  });

  it("MCP `ask` applies the same claim rule as REST", async () => {
    const call = async (token: string, args: Record<string, unknown>) => {
      const res = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "simorgh_ask", arguments: args },
        }),
      });
      return ((await res.json()) as {
        result?: { isError?: boolean; content?: { text: string }[] };
      }).result;
    };

    const spoof = await call(API_KEY, { prompt: "mcp spoof", userId: "u-other" });
    expect(spoof?.isError).toBe(true);
    expect(spoof?.content?.[0]?.text).toContain("FORBIDDEN");

    const clean = await call(API_KEY, { prompt: "mcp as myself" });
    expect(clean?.isError).not.toBe(true);
    expect(clean?.content?.[0]?.text).toContain("mcp as myself");
  });
});

describe("a solo deployment still flies (service principal)", () => {
  // The other half of the A3 decision: `SIMORGH_API_KEY`-only configuration keeps
  // working, and executes under the named `service` principal — explicit in the
  // ledger, never a fake user, never anonymous.
  it("executes as `service` and refuses to splinter into named users", async () => {
    const SOLO = "solo-deploy-key";
    const solo = await startNodeRuntime({ port: 0, apiKey: SOLO, secrets: {}, providers: [canned] });
    try {
      const fly = await fetch(`${solo.url}/api/v1/agent/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SOLO}` },
        body: JSON.stringify({ prompt: "solo flight", tools: [] }),
      });
      expect(fly.status).toBe(200);

      const agree = await fetch(`${solo.url}/api/v1/agent/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SOLO}` },
        body: JSON.stringify({ prompt: "i agree", tools: [], userId: "service" }),
      });
      expect(agree.status).toBe(200);

      // The solo operator cannot invent users by naming them — every request here is
      // the one service principal, whoever it claims to be.
      const invent = await fetch(`${solo.url}/api/v1/agent/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SOLO}` },
        body: JSON.stringify({ prompt: "make me admin", tools: [], userId: "admin" }),
      });
      expect(invent.status).toBe(403);

      // The documented asymmetry: `service` may *write*; reading per-user history
      // stays on the map, where the service token is `IDENTITY_UNRESOLVED` — including
      // for its own `service` rows, so no single-key deployment ever has a user-read
      // surface by accident.
      const read = await fetch(`${solo.url}/api/v1/user/service/logs`, {
        headers: { Authorization: `Bearer ${SOLO}` },
      });
      expect(read.status).toBe(503);
      expect(((await read.json()) as { error: { code: string } }).error.code).toBe(
        "IDENTITY_UNRESOLVED"
      );
    } finally {
      await solo.close();
    }
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
