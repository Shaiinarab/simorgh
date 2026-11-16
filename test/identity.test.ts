// ── A3 / AUTH-004: the credential is the only identity ────────────────────────
//
// The Workers twin of the cross-principal suite in
// `simorgh-platform/test/integration.test.ts`. The seam under test is the *route*:
// parse+auth happen here, and the questions this file answers are (1) does a valid
// token that *names* another user in the header or the body get refused before any
// quota or ledger write, and (2) do the rate-limit key and the ledger row carry the
// principal the credential resolved, never the name the request carried.
//
// What is pinned one layer down and deliberately *not* re-pinned here: bucket
// isolation semantics (`test/rate-limit.test.ts`, engine) and claim-checking
// semantics (`phoenix-core/test/security.test.ts`). Here the flock stand-in records
// the *key string* the route asks the limiter about — which is exactly the wire the
// finding was about.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";

const TOKEN = "a3-token-alice";
const OTHER_TOKEN = "a3-token-bob";

/** Rate-limit keys the route asked the coordinator to check, in order. */
const rateKeys: string[] = [];

function recordingFlock() {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      async runFlock(prompt: string, tools: string[]) {
        void prompt;
        void tools;
        return {
          meta: { answered_by: "Stub (test)", flock_attempts: [{ birdId: "stub", ok: true }] },
          answer: "stub-answer",
        };
      },
      async getFlockStatus() {
        return { birds: [], timestamp: 0 };
      },
      async checkRateLimit(key: string, limit: number, windowMs: number) {
        rateKeys.push(key);
        return { allowed: true, limit, remaining: limit - 1, resetAt: Date.now() + windowMs };
      },
    }),
  };
}

function testEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    AI: env.AI,
    CONTEXT_STORE: env.CONTEXT_STORE,
    DATA_TRUST_VAULT: env.DATA_TRUST_VAULT,
    FLOCK_COORDINATOR: recordingFlock(),
    ENVIRONMENT: env.ENVIRONMENT,
    SIMORGH_API_KEY: TOKEN,
    // Two callers: "alice" (the deployment key *and* a map entry) and "bob" (map only).
    // The overlap is the realistic shape — `SIMORGH_API_KEYS` may also contain the
    // service key — and it is what makes "which subject does this request resolve to"
    // observable rather than assumed.
    SIMORGH_API_KEYS: JSON.stringify({ [TOKEN]: "alice", [OTHER_TOKEN]: "bob" }),
    ...overrides,
  } as unknown as Env;
}

const execute = (
  body: unknown,
  opts: { token?: string; headerUser?: string; env?: Env } = {}
) =>
  app.request(
    "/api/v1/agent/execute",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token ?? TOKEN}`,
        ...(opts.headerUser ? { "X-Simorgh-User-Id": opts.headerUser } : {}),
      },
      body: JSON.stringify(body),
    },
    opts.env ?? testEnv()
  );

const getJson = async (res: Response) => (await res.json()) as { error?: { code?: string } };

describe("cross-principal execute (A3, Workers)", () => {
  it("403s a header spoof and touches nothing", async () => {
    rateKeys.length = 0;
    const res = await execute({ prompt: "as bob?", tools: [] }, { headerUser: "bob" });
    expect(res.status).toBe(403);
    expect((await getJson(res)).error?.code).toBe("FORBIDDEN");
    // The refusal happens *before* the limiter is consulted: a rejected claim cannot
    // even spend the attacker's own budget, and it never reaches another user's.
    expect(rateKeys).toEqual([]);
  });

  it("403s a body spoof from bob's own token, with one flat message", async () => {
    rateKeys.length = 0;
    const messages: unknown[] = [];
    for (const claimed of ["alice", "does-not-exist", "anonymous"]) {
      const res = await execute(
        { prompt: "spoof", tools: [], userId: claimed },
        { token: OTHER_TOKEN }
      );
      expect(res.status).toBe(403);
      const body = (await getJson(res)) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe("FORBIDDEN");
      messages.push(body.error?.message);
    }
    // Non-enumeration: the message is identical whether the claimed name is real,
    // fictional, or the forbidden anonymous fallback — this response cannot be used
    // to learn which subjects the deployment knows.
    expect(messages).toEqual([
      "The claimed user id does not match the authenticated principal.",
      "The claimed user id does not match the authenticated principal.",
      "The claimed user id does not match the authenticated principal.",
    ]);
    // And none of the refusals ever consulted the limiter — zero budget spend, own or
    // borrowed.
    expect(rateKeys).toEqual([]);
  });

  it("rates and ledger-writes under the credential's subject — never the claim", async () => {
    // A *matching* claim is accepted and still changes nothing about attribution; the
    // no-claim path lands in the same place, which is the point.
    rateKeys.length = 0;
    const matching = await execute({ prompt: "agrees", tools: [], userId: "alice" });
    expect(matching.status).toBe(200);
    expect(rateKeys).toEqual(["execute:alice"]);

    rateKeys.length = 0;
    const bare = await execute({ prompt: "no claim", tools: [] }, { token: OTHER_TOKEN });
    expect(bare.status).toBe(200);
    expect(rateKeys).toEqual(["execute:bob"]);
  });

  it("401s an unknown token with no fallback identity of any kind", async () => {
    rateKeys.length = 0;
    const res = await execute({ prompt: "who dis", tools: [] }, { token: "not-in-any-config" });
    expect(res.status).toBe(401);
    expect(rateKeys).toEqual([]);
  });
});

describe("the service principal on a solo deployment (Workers)", () => {
  const solo = () => testEnv({ SIMORGH_API_KEYS: undefined });

  it("executes as the named `service` subject and never as a claim", async () => {
    rateKeys.length = 0;
    const res = await execute({ prompt: "solo flight", tools: [] }, { env: solo() });
    expect(res.status).toBe(200);
    // Not `execute:anonymous`, not `execute:<whatever the body said>`: one visible,
    // singular principal for the deployment's single credential.
    expect(rateKeys).toEqual(["execute:service"]);

    const claim = await execute({ prompt: "agreeing claim", tools: [], userId: "service" }, { env: solo() });
    expect(claim.status).toBe(200);

    const invent = await execute({ prompt: "make me root", tools: [], userId: "root" }, { env: solo() });
    expect(invent.status).toBe(403);
  });

  it("writes under `service`, and the service token may not read per-user history", async () => {
    const res = await execute({ prompt: "ledger under service", tools: [] }, { env: solo() });
    expect(res.status).toBe(200);
    const { meta } = (await res.json()) as { meta: { contextRefId: string } };
    expect(meta.contextRefId).toMatch(/^[0-9a-f-]{36}$/);

    // The documented asymmetry: `service` is an executing principal, and per-user
    // reads stay unattributable on a mapless deployment. Including the service's own
    // bucket — which is what makes it *not* a fake user with a read surface.
    const read = await app.request(
      "/api/v1/user/service/logs",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      solo()
    );
    expect(read.status).toBe(503);
    expect((await getJson(read)).error?.code).toBe("IDENTITY_UNRESOLVED");
  });
});

describe("schedule ownership at the route (A3, real Durable Object)", () => {
  // These run against the *real* FLOCK_COORDINATOR — the schedule routes read and write
  // DO SQLite only, no provider dial, and the migration the constructor runs is part of
  // what deserves pinning. A stand-in cannot prove an `ALTER TABLE` landed.
  const realEnv = testEnv({ FLOCK_COORDINATOR: env.FLOCK_COORDINATOR });

  const schedule = (body: unknown, token: string, e: Env = realEnv) =>
    app.request(
      "/api/v1/schedule",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      },
      e
    );

  const list = (token: string, e: Env = realEnv) =>
    app.request("/api/v1/schedule", { headers: { Authorization: `Bearer ${token}` } }, e);

  it("one principal cannot re-take another's schedule id, and listings are scoped", async () => {
    const id = "a3-owned-" + crypto.randomUUID().slice(0, 8);
    const resumeAt = Date.now() + 20 * 60_000;

    const first = await schedule({ id, prompt: "alice's job", resumeAt }, TOKEN);
    expect(first.status).toBe(201);

    const clash = await schedule({ id, prompt: "actually bob's", resumeAt }, OTHER_TOKEN);
    expect(clash.status).toBe(409);
    expect((await getJson(clash)).error?.code).toBe("SCHEDULE_CONFLICT");

    // Scoping: alice sees her row; bob sees nothing — not even a hint of alice's id.
    const aliceList = (await (await list(TOKEN)).json()) as { id: string }[];
    expect(aliceList.some((r) => r.id === id)).toBe(true);
    const bobList = (await (await list(OTHER_TOKEN)).json()) as { id: string }[];
    expect(bobList.some((r) => r.id === id)).toBe(false);

    // The same principal may still rewrite its own pending row (the pre-A3 behaviour,
    // kept for the owner — this is *ownership*, not a freeze).
    const rewrite = await schedule({ id, prompt: "alice's job, v2", resumeAt }, TOKEN);
    expect(rewrite.status).toBe(201);
  });

  it("a solo deployment schedules and lists as `service`", async () => {
    const e = testEnv({ FLOCK_COORDINATOR: env.FLOCK_COORDINATOR, SIMORGH_API_KEYS: undefined });
    const id = "a3-solo-" + crypto.randomUUID().slice(0, 8);
    const resumeAt = Date.now() + 20 * 60_000;

    const created = await schedule({ id, prompt: "solo job", resumeAt }, TOKEN, e);
    expect(created.status).toBe(201);

    const rows = (await (await list(TOKEN, e)).json()) as { id: string }[];
    expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it("refuses schedule writes with an unknown token", async () => {
    const res = await schedule(
      { id: "a3-nope", prompt: "x", resumeAt: Date.now() + 60_000 },
      "not-a-token"
    );
    expect(res.status).toBe(401);
  });
});
