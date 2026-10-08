// Durable Object integration tests. These run inside workerd, against the real
// bindings from wrangler.toml, and every call goes through the actual RPC boundary —
// so they also pin the property that broke the build earlier: the methods must accept
// and return *structured-cloneable* values only.
//
// A method taking `env` as a parameter, or returning `Record<string, unknown>`, makes
// the generated stub type collapse to `never`. `npm run typecheck` catches that; these
// tests catch the runtime half, and the distinct-name-per-test pattern keeps each case
// on a fresh object rather than a recycled one.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const freshName = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

function coordinator() {
  const ns = env.FLOCK_COORDINATOR;
  return ns.get(ns.idFromName(freshName("flock")));
}

function vault() {
  const ns = env.DATA_TRUST_VAULT;
  return ns.get(ns.idFromName(freshName("vault")));
}

describe("FlockCoordinator", () => {
  it("reports every bird over RPC, with nested objects surviving the boundary", async () => {
    // If the return type were not structured-cloneable this call would not compile,
    // and if the schema had not been created before the first request it would throw
    // "no such table: bird_health" — so this single assertion covers both.
    const status = await coordinator().getFlockStatus();

    // The one place the roster is pinned literally, and deliberately so. `/api/v1/flock/status`
    // is a published contract and `docs/ARCHITECTURE.md` invariant #9 makes the wire field
    // names one too, so *completeness* is the property here: `toEqual`, not `toContain`.
    // Five birds since Gemini and OpenRouter joined — both keyed, both slotted ahead of Homā
    // so the key-free bird stays reachable. The priority list is pinned exactly for the same
    // reason: priorities must be unique and ascending, and only the whole list says that.
    expect(status.birds).toHaveLength(5);
    expect(status.birds.map((b) => b.id)).toEqual([
      "shahin",
      "gemini",
      "bulbul",
      "openrouter",
      "homa",
    ]);
    expect(status.birds.map((b) => b.priority)).toEqual([10, 15, 20, 25, 30]);
    expect(status.timestamp).toBeGreaterThan(0);
  });

  it("derives dormancy from the live env, not from whether a bird declares a secret", async () => {
    // The test env has no GROQ_API_KEY or HF_TOKEN, so the two keyed birds are dormant
    // and Homā — which needs nothing — is not. This is the zero-KYC guarantee, read
    // back off the status endpoint the dashboard uses.
    const birds = (await coordinator().getFlockStatus()).birds;
    const byId = Object.fromEntries(birds.map((b) => [b.id, b]));

    expect(byId.shahin.dormant).toBe(true);
    expect(byId.shahin.status).toBe("dormant");
    expect(byId.bulbul.dormant).toBe(true);
    expect(byId.homa.dormant).toBe(false);
    expect(byId.homa.status).toBe("healthy");
  });

  it("offers exactly one bird that answers with no key at all, and it is Homā", async () => {
    // The zero-KYC guarantee, asserted directly instead of implied by a roster literal.
    //
    // Every other assertion about the roster says *which* birds exist; this one says what
    // they are for. With an empty environment, `dormant` is derived from the live secret
    // reader, so a bird declares itself unavailable iff it needs a key it was not given.
    // That makes the count of non-dormant birds the machine-readable form of the promise:
    // whatever else is registered, exactly one thing can answer on a fresh deploy, and it
    // is the one that needs nothing.
    //
    // Not a tautology, and here is what catches it: registering a second key-free bird —
    // or moving Homā behind a keyed one — turns this red, and so does
    // `test/flock-routing.test.ts`'s attempt log. A roster pin alone would not, because a
    // roster pin is happy to accept an unreachable flock as long as the ids line up.
    const birds = (await coordinator().getFlockStatus()).birds;

    const answerable = birds.filter((b) => !b.dormant);

    expect(answerable.map((b) => b.id)).toEqual(["homa"]);
    expect(birds.filter((b) => b.dormant).every((b) => b.status === "dormant")).toBe(true);
  });

  it("starts with clean counters", async () => {
    for (const bird of (await coordinator().getFlockStatus()).birds) {
      expect(bird.consecutiveFailures).toBe(0);
      expect(bird.cooldownUntil).toBe(0);
      expect(bird.totalCalls).toBe(0);
      expect(bird.totalFailures).toBe(0);
    }
  });

  it("runs the daily sweep over RPC and reports zero changes on an untouched object", async () => {
    // Also the cron-trigger contract: `scheduled()` calls exactly this, so if the
    // method stopped being RPC-callable the daily sweep would fail silently at 06:15.
    expect(await coordinator().sweepStale(Date.now())).toBe(0);
  });
});

describe("DataTrustVault", () => {
  it("logs an entry and reads it back", async () => {
    const v = vault();
    const ack = await v.logEntry({
      userId: "u-1",
      tier: "Free-Volunteer",
      refId: "ctx_a",
      timestamp: 1_000,
    });

    expect(ack).toEqual({ logged: true });

    const logs = await v.getUserLogs("u-1");
    expect(logs.userId).toBe("u-1");
    expect(logs.count).toBe(1);
    expect(logs.entries[0]).toMatchObject({
      user_id: "u-1",
      tier: "Free-Volunteer",
      ref_id: "ctx_a",
      timestamp: 1_000,
      action: "execute",
      details: "{}",
    });
  });

  it("returns the newest entries first", async () => {
    const v = vault();
    for (const ts of [100, 300, 200]) {
      await v.logEntry({ userId: "u-order", tier: "Pro-Paid", refId: `ctx_${ts}`, timestamp: ts });
    }

    const logs = await v.getUserLogs("u-order");
    expect(logs.entries.map((e) => e.timestamp)).toEqual([300, 200, 100]);
  });

  it("keeps users' ledgers separate", async () => {
    // The transparency ledger is per-user; a missing WHERE clause here would leak one
    // user's activity into another's view.
    const v = vault();
    await v.logEntry({ userId: "u-a", tier: "Free-Volunteer", refId: "ctx_a", timestamp: 1 });
    await v.logEntry({ userId: "u-b", tier: "Free-Volunteer", refId: "ctx_b", timestamp: 1 });

    expect((await v.getUserLogs("u-a")).count).toBe(1);
    expect((await v.getUserLogs("u-a")).entries[0].ref_id).toBe("ctx_a");
    expect((await v.getUserLogs("u-b")).entries[0].ref_id).toBe("ctx_b");
    expect((await v.getUserLogs("u-absent")).count).toBe(0);
  });

  it("created the capacity table before the first request, and it crosses RPC", async () => {
    // "Verify against reality, not against your own fixture." A fresh Durable Object
    // has applied QUOTA_SCHEMA in its constructor; if it had not, this throws
    // "no such table: quota_state" exactly as the bird_health assertion above does
    // for the health table. An empty array — not a throw — is the proof, and the
    // declared-cloneability of `QuotaRow` over the boundary is the second thing it
    // pins: an `unknown` or an index signature here would collapse the generated stub
    // to `never` and fail typecheck instead.
    expect(await coordinator().getQuotaState()).toEqual([]);
  });

  it("honours explicit action and details over the defaults", async () => {
    const v = vault();
    await v.logEntry({
      userId: "u-x",
      tier: "Pro-Data-Pact",
      refId: "ctx_x",
      timestamp: 5,
      action: "tool_call",
      details: '{"tool":"search_web"}',
    });

    const entry = (await v.getUserLogs("u-x")).entries[0];
    expect(entry.action).toBe("tool_call");
    expect(entry.details).toBe('{"tool":"search_web"}');
  });
});
