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

    expect(status.birds).toHaveLength(3);
    expect(status.birds.map((b) => b.id)).toEqual(["shahin", "bulbul", "homa"]);
    expect(status.birds.map((b) => b.priority)).toEqual([10, 20, 30]);
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
