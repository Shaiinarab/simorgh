// Story 5.2 — "If DO is unavailable, fall back to KV-cached bird health with
// eventual consistency."
//
// This is a resilience story, so the weight sits on the failure paths, and every
// failure path here is planted deliberately:
//
//   - the DO is made to throw by handing the helper a reader that throws — a test
//     that only exercised the happy path would pass even if the fallback did not
//     exist at all (the fallback-not-firing case IS the bug this guards);
//   - the no-snapshot case must rethrow the DO's own error, which is the negative
//     control for fabrication: a fallback that invented an empty flock from nothing
//     would "pass" every availability assertion while lying to the operator;
//   - the write-failure case pins the direction of degradation — freshness gives
//     way, availability does not.
//
// The last two tests drive `readFlockStatus` through the real bindings so the
// wiring the route actually uses is covered, not only the pure helper.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { app } from "../src/index";
import {
  FLOCK_STATUS_SNAPSHOT_KEY,
  flockStatusWithFallback,
  readFlockStatus,
  type FlockStatus,
  type SnapshotStore,
} from "../src/flock";

const CAPTURED_AT = 1_700_000_000_000;

function bird(id: string): FlockStatus["birds"][number] {
  return {
    id,
    name: id,
    provider: "test",
    model: "test-model",
    priority: 10,
    dormant: false,
    status: "healthy",
    consecutiveFailures: 0,
    cooldownUntil: 0,
    totalCalls: 3,
    totalFailures: 1,
  };
}

const LIVE: FlockStatus = {
  birds: [bird("shahin"), bird("homa")],
  timestamp: CAPTURED_AT,
};

/** Map-backed stand-in for the KV namespace: get("json") parses, put stores raw. */
function memoryStore(): SnapshotStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    get: async (key: string) => {
      const raw = rows.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    put: async (key: string, value: string) => {
      rows.set(key, value);
    },
  };
}

const DO_DOWN = new Error("durable object unreachable");

async function alwaysDown(): Promise<FlockStatus> {
  throw DO_DOWN;
}

describe("Story 5.2 — flock status KV fallback", () => {
  it("returns the live flock untouched and leaves a snapshot behind", async () => {
    const store = memoryStore();

    const result = await flockStatusWithFallback(async () => LIVE, store);

    // The live answer must be byte-identical to what it was before this story: no
    // marker field, nothing for existing consumers to trip over.
    expect(result).toEqual(LIVE);
    expect(result).not.toHaveProperty("source");

    const cached = store.rows.get(FLOCK_STATUS_SNAPSHOT_KEY);
    expect(cached).toBeDefined();
    expect(JSON.parse(cached as string)).toEqual(LIVE);
  });

  it("serves the snapshot, marked and with its original timestamp, when the DO is down", async () => {
    const store = memoryStore();
    await store.put(FLOCK_STATUS_SNAPSHOT_KEY, JSON.stringify(LIVE));

    const result = await flockStatusWithFallback(alwaysDown, store);

    expect(result.source).toBe("kv-cache");
    expect(result.birds).toEqual(LIVE.birds);
    // Eventual consistency must be *visible*: the timestamp is when the picture was
    // true, not when it was served, so a caller can always tell how stale it is.
    expect(result.timestamp).toBe(CAPTURED_AT);
  });

  it("rethrows the DO's own error when there is no snapshot — no flock invented from nothing", async () => {
    // The negative control. A fallback that returned `{ birds: [], timestamp: now }`
    // would answer 200 with a lie (every bird gone) and still satisfy a
    // "the route did not crash" assertion.
    const store = memoryStore();

    await expect(flockStatusWithFallback(alwaysDown, store)).rejects.toThrow(
      "durable object unreachable"
    );
  });

  it("reports the DO error, not the cache's, when reading the snapshot itself fails", async () => {
    // Both layers are down; the operator needs the root cause. A thrown
    // "kv read failed" would send them to the wrong system.
    const store: SnapshotStore = {
      get: async () => {
        throw new Error("kv read failed");
      },
      put: async () => {},
    };

    await expect(flockStatusWithFallback(alwaysDown, store)).rejects.toThrow(
      "durable object unreachable"
    );
  });

  it("still answers live when the snapshot cannot be written", async () => {
    // Degradation direction: a broken cache costs freshness, never availability.
    const store: SnapshotStore = {
      get: async () => null,
      put: async () => {
        throw new Error("kv write failed");
      },
    };

    const result = await flockStatusWithFallback(async () => LIVE, store);

    expect(result).toEqual(LIVE);
    expect(result).not.toHaveProperty("source");
  });
});

describe("readFlockStatus — the wiring the route and the Telegram command use", () => {
  it("reads live through the real bindings and leaves a KV snapshot", async () => {
    const status = await readFlockStatus(env);

    // Incidental mention of the roster, not a roster pin — this story is the KV fallback,
    // and the roster is pinned exactly in test/durable-objects.test.ts. What has to hold
    // here is that the *live* DO read succeeded and carried the key-free bird. Note that
    // the stale-snapshot path would also contain "homa", so the live-vs-cached property is
    // asserted by the missing `source` marker below, not by the ids.
    expect(status.birds.map((b) => b.id)).toContain("homa");
    expect(status).not.toHaveProperty("source");

    const cached = (await env.CONTEXT_STORE.get(
      FLOCK_STATUS_SNAPSHOT_KEY,
      "json"
    )) as FlockStatus | null;
    expect(cached).not.toBeNull();
    // Derived from the read just made, not a second literal: the snapshot's value is that
    // it is a faithful copy of the live answer, and a copied literal stops saying that the
    // moment the roster changes.
    expect(cached?.birds.map((b) => b.id)).toEqual(status.birds.map((b) => b.id));
  });

  it("falls back to that snapshot when the namespace throws", async () => {
    // Seed the cache through the real path first — a hand-planted snapshot would
    // let a broken writer pass — then point the helper at a namespace whose DO is
    // unreachable. Same two bindings the route passes; only the DO is doomed.
    const live = await readFlockStatus(env);
    const doomed = {
      FLOCK_COORDINATOR: {
        idFromName: (name: string) => name,
        get: () => ({
          async getFlockStatus(): Promise<FlockStatus> {
            throw DO_DOWN;
          },
        }),
      },
      CONTEXT_STORE: env.CONTEXT_STORE,
    } as unknown as Env;

    const result = await readFlockStatus(doomed);

    expect(result.source).toBe("kv-cache");
    expect(result.birds).toEqual(live.birds);
    expect(result.timestamp).toBe(live.timestamp);
  });

  it("answers the HTTP route live, and the payload keeps its published shape", async () => {
    const res = await app.request("/api/v1/flock/status", undefined, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as FlockStatus & { source?: string };
    // The wire contract is `{ birds, timestamp }` — a live answer must not grow a
    // marker field, because consumers parse this shape by contract (connectors,
    // doctor, dashboard).
    expect(body).toEqual({
      birds: expect.any(Array),
      timestamp: expect.any(Number),
    });
    expect(body.source).toBeUndefined();
    // Again incidental to this story: the shape above is the published contract, and the
    // exact roster is pinned in test/durable-objects.test.ts. Over the wire, what this test
    // owes the operator is that a zero-KYC deploy still shows an answerable bird.
    expect(body.birds.map((b) => b.id)).toContain("homa");
  });
});
