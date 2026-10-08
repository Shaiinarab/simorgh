// Story 5.1 — "FlockCoordinator supports concurrent `pickRoute()` calls without race
// conditions; tested with 10 concurrent requests."
//
// This story is a *verification* story, and the reason it matters is that the property it
// asks for is currently held by something invisible. `checkRateLimit` is declared `async`
// but contains **no `await`**: `consumeRateLimit` is fully synchronous, so each call's
// read-modify-write runs to completion inside one turn of the object's single thread. That
// is what makes the fixed-window counter correct under concurrency.
//
// Nobody would know that from reading the code, and nothing would stop it changing. Add one
// `await` to that path — a cache lookup, a metrics write, anything — and the window counter
// silently starts losing updates: two callers read the same `count`, both write `count + 1`,
// and the limiter permits more requests than its limit. It would not throw, would not log,
// and would fail only as "the rate limit is a bit leaky", which is exactly the kind of
// defect `AGENTS.md` records happening three times in this repository already.
//
// So these tests exist to be a tripwire. The limit-5 case is the sharp one: with a lost
// update, more than five calls are admitted, and that is unambiguous.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const CONCURRENCY = 10;
const WINDOW_MS = 60_000;

function coordinator() {
  const ns = env.FLOCK_COORDINATOR;
  return ns.get(ns.idFromName(`conc-${crypto.randomUUID()}`));
}

/** Read a counter row directly, so the assertion is on stored state and not on a return value. */
function readCount<T>(stub: ReturnType<typeof coordinator>, table: string, key: string) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ count: number } & Record<string, never>>(
        `SELECT count FROM ${table} WHERE key = ?`,
        key
      )
      .toArray()[0]?.count ?? 0
  ) as Promise<number>;
}

describe("Story 5.1 — 10 concurrent requests against one Durable Object", () => {
  it("admits exactly the limit, not more, when all calls race the same key", async () => {
    // The sharp case. A lost update here shows up as more than 5 allowed.
    const stub = coordinator();
    const limit = 5;

    const decisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        stub.checkRateLimit("shared-key", limit, WINDOW_MS)
      )
    );

    const allowed = decisions.filter((d) => d.allowed).length;
    expect(allowed).toBe(limit);
    expect(await readCount(stub, "rate_limits", "shared-key")).toBe(limit);
  });

  it("loses no updates when every call is under the limit", async () => {
    // The same property where a lost update shows as a *low* number rather than a high one:
    // two callers reading `count = 3` both writing `4` makes the stored counter stall below
    // the true request count, so the limit silently never triggers.
    const stub = coordinator();

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        stub.checkRateLimit("under-limit", CONCURRENCY, WINDOW_MS)
      )
    );

    expect(await readCount(stub, "rate_limits", "under-limit")).toBe(CONCURRENCY);
  });

  it("keeps distinct keys independent under concurrency", async () => {
    // Per-key isolation must survive a batch too: a shared table means one key's writes can
    // bleed into another's.
    const stub = coordinator();

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        stub.checkRateLimit(`key-${i}`, 3, WINDOW_MS)
      )
    );

    expect(results.every((d) => d.allowed)).toBe(true);
    expect(results.every((d) => d.remaining === 2)).toBe(true);

    const counts = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        readCount(stub, "rate_limits", `key-${i}`)
      )
    );
    expect(counts).toEqual(Array.from({ length: CONCURRENCY }, () => 1));
  });

  it("accumulates every concurrent health observation", async () => {
    // The health row is the other read-modify-write on the hot path: a provider's totals are
    // what both the dashboard and the cooldown logic read. `recordObservation` is an upsert
    // precisely because the original plain UPDATE dropped a first failure, which let a dead
    // provider be retried forever while its counters stayed at zero.
    const stub = coordinator();
    const bird = "concurrent-bird";

    // Half succeed, half fail: both counters must move. A batch that only recorded failures
    // would still satisfy a failure-only assertion, and vice versa.
    const writes = Array.from({ length: CONCURRENCY }, (_, i) =>
      runInDurableObject(stub, async (_instance, state) => {
        const { HEALTH_SCHEMA, recordObservation } = await import("../phoenix-core/src/health");
        state.storage.sql.exec(HEALTH_SCHEMA);
        recordObservation(state.storage.sql as never, bird, i % 2 === 0, false, 1_700_000_000_000 + i);
      })
    );
    await Promise.all(writes);

    const row = (await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ total_calls: number; total_failures: number } & Record<string, never>>(
          "SELECT total_calls, total_failures FROM bird_health WHERE bird_id = ?",
          bird
        )
        .toArray()[0]
    )) as { total_calls: number; total_failures: number } | undefined;

    expect(row).toBeDefined();
    // No lost updates in either direction: every one of the ten must be counted.
    expect(row!.total_calls).toBe(CONCURRENCY);
    expect(row!.total_failures).toBe(CONCURRENCY / 2);
  });

  it("admits exactly one winner when several callers claim the same task", async () => {
    // The compare-and-set at the heart of `scheduled.ts`. Duplicate wake-ups are normal
    // (alarm redelivery, eviction mid-run), and "the task ran twice" is the defect this
    // guards. If `claimTask` were not a CAS, every caller would win.
    const stub = coordinator();
    await stub.scheduleDelayed({
      id: "contended",
      prompt: "hello",
      resumeAt: Date.now() - 60_000,
    });

    // Fire the alarm several times concurrently rather than trusting one delivery.
    const alarms = await Promise.allSettled([
      import("cloudflare:test").then((m) => m.runDurableObjectAlarm(stub)),
      import("cloudflare:test").then((m) => m.runDurableObjectAlarm(stub)),
      import("cloudflare:test").then((m) => m.runDurableObjectAlarm(stub)),
    ]);
    void alarms;

    const rows = (await stub.listScheduled()) as { id: string; attempts: number }[];
    expect(rows).toHaveLength(1);
    // attempts is incremented inside the same compare-and-set that claims the row, so a
    // value of 1 is the proof that only one caller transitioned it.
    expect(rows[0].attempts).toBe(1);
  });

  it("does not interleave two scheduled tasks into one another's row", async () => {
    const stub = coordinator();
    const ids = Array.from({ length: CONCURRENCY }, (_, i) => `task-${i}`);

    await Promise.all(
      ids.map((id) =>
        stub.scheduleDelayed({ id, prompt: `prompt-${id}`, resumeAt: Date.now() - 1_000 })
      )
    );

    const rows = (await stub.listScheduled()) as { id: string }[];
    expect(rows).toHaveLength(CONCURRENCY);

    // Read the stored prompts, not the RPC projection: `listScheduled` deliberately returns
    // only id/state/timing, so asserting on it would have been asserting a field that does
    // not exist. Each row must hold ITS OWN prompt — a shared-buffer or last-write-wins bug
    // shows up here as several rows carrying the same one, which a length check alone passes.
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ id: string; prompt: string } & Record<string, never>>(
          "SELECT id, prompt FROM scheduled_task ORDER BY id"
        )
        .toArray()
    );

    expect(stored).toHaveLength(CONCURRENCY);
    for (const row of stored as { id: string; prompt: string }[]) {
      expect(row.prompt).toBe(`prompt-${row.id}`);
    }
  });
});