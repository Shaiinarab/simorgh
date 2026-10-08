// Durable delay, at the *host* level: a real Durable Object, real storage, a real alarm.
//
// `phoenix-core/test/scheduled.test.ts` proves the state machine and nothing here repeats it.
// What only exists here is the **binding** — that `scheduleDelayed` arms an actual alarm,
// that firing it actually claims the work, and that a second delivery does not claim it
// again. A pure-function suite would pass identically with no alarm ever set, and a delay
// that is never woken is a delay that never runs.
//
// ── What this file deliberately does NOT claim ──
//
// It does **not** assert that a fired alarm drives a row to `done`. That flight cannot be
// proved hermetically here, and pretending otherwise would be exactly the failure mode this
// repo has already hit three times — a test that agrees with the implementation's
// assumption instead of the outside world's contract:
//
//   * `alarm()` awaits `this.runFlock(...)`, which dials every configured provider.
//   * In this environment Shahin and Bulbul are dormant (no secrets) and Homā's AI
//     binding is remote. With `remoteBindings: false` the pool replaces it with a stub
//     that **throws** `Error: Binding AI needs to be run remotely`.
//   * Observed, not assumed: after a firing the row is left in `running` with
//     `attempts: 1`, unchanged across +2 s. The claim persists; the completion does not.
//
// So the completion of a scheduled flight is **unverified**, not verified. Closing it needs
// either a hermetic provider stub on the Durable Object (a host change, not a test change)
// or a real deployment. The flight *policy* is already covered by `test/flock-routing.test.ts`
// at the engine level; what is missing is the round trip through a real alarm.
//
// Every assertion below is about state the alarm is responsible for, read back over the RPC
// boundary or from the object's own storage.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const MINUTE = 60_000;
/** `SCHEDULED_LEASE_MS`, restated so this file cannot silently follow a wrong value. */
const LEASE_MS = 300_000;

function coordinator() {
  const ns = env.FLOCK_COORDINATOR;
  return ns.get(ns.idFromName(`sched-${crypto.randomUUID()}`));
}

/** A resume time in the past, so a row is due the moment the alarm fires. */
const due = () => Date.now() - MINUTE;

/** Read the object's alarm time and its rows, without going through the public RPC. */
function inspect<T>(stub: ReturnType<typeof coordinator>) {
  return runInDurableObject(stub, async (_instance, state) => ({
    alarm: await state.storage.getAlarm(),
    rows: state.storage.sql
      .exec("SELECT id, state, attempts FROM scheduled_task ORDER BY id")
      .toArray() as unknown as T[],
  }));
}

/** Write a row directly, to arrange a state the public surface cannot honestly reach. */
function seed<T>(stub: ReturnType<typeof coordinator>, fn: (sql: SqlStorage) => T) {
  return runInDurableObject(stub, (_instance, state) => fn(state.storage.sql));
}

describe("FlockCoordinator — durable delay", () => {
  it("arms a real alarm when a task is scheduled", async () => {
    const stub = coordinator();
    const resumeAt = Date.now() + 30 * MINUTE;
    await stub.scheduleDelayed({ id: "t1", prompt: "later", resumeAt });

    const { alarm } = await inspect(stub);
    // This is the assertion the whole slice rests on. Before `rearmAlarm` existed the
    // row was written and nothing was ever armed — a delay nothing wakes.
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(resumeAt);
  });

  it("firing the alarm claims the row exactly once", async () => {
    const stub = coordinator();
    await stub.scheduleDelayed({ id: "t1", prompt: "hello", resumeAt: due() });

    // Not asserted: whether this helper reports `true`. An alarm due in the past is
    // fired by the runtime itself, so by the time we ask there may be nothing left to
    // run — a race in the *harness*, not in the code under test. The effect is asserted
    // instead, and it is the thing that matters.
    await runDurableObjectAlarm(stub);

    // `attempts` is the observable. It is incremented inside the same compare-and-set that
    // moves the row out of `pending`, so a value above 1 can only come from a re-claim.
    const rows = (await stub.listScheduled()) as { id: string; state: string; attempts: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "t1", attempts: 1 });
    expect(rows[0].state).not.toBe("pending");
  });

  it("does not claim a completed task again — the double-execution property", async () => {
    // The property the repo most wants pinned: an alarm can be redelivered, a Durable
    // Object can be evicted mid-run, a clock can move. None of that may run the work twice,
    // and the guarantee has to come from the state machine rather than from the scheduler
    // happening to be careful. Two deliveries, one claim.
    const stub = coordinator();
    await stub.scheduleDelayed({ id: "t1", prompt: "hello", resumeAt: due() });

    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);

    const rows = (await stub.listScheduled()) as { state: string; attempts: number }[];
    expect(rows[0].attempts).toBe(1);
  });

  it("never claims a terminal row, however many alarms arrive", async () => {
    const stub = coordinator();
    await seed(stub, (sql) => {
      sql.exec(
        `INSERT INTO scheduled_task (id, prompt, tools, state, resume_at, claimed_at, created_at, attempts, result)
         VALUES ('done', 'hi', '[]', 'done', ?, 0, 1, 1, '{"answer":"already answered"}')`,
        Date.now() - MINUTE
      );
      return true;
    });
    // No schedule call, so no alarm is armed — and none is needed: a terminal row is not
    // work, and the engine-level suite already pins that `claimTask` refuses it.
    const armed = await inspect(stub);
    expect(armed.alarm).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    const rows = (await stub.listScheduled()) as { state: string; attempts: number; result: string }[];
    expect(rows[0]).toMatchObject({ state: "done", attempts: 1 });
    expect(JSON.parse(rows[0].result)).toEqual({ answer: "already answered" });
  });

  it("reclaims a row a dead host left mid-run", async () => {
    // Recovery, through the real alarm. No `schedule` call and no newly-armed alarm: the
    // row was claimed and abandoned, and the only thing that can bring it back is the lease
    // expiry. This is the case an earlier pending-only re-arm lost silently and forever.
    const stub = coordinator();
    await seed(stub, (sql) => {
      sql.exec(
        `INSERT INTO scheduled_task (id, prompt, tools, state, resume_at, claimed_at, created_at, attempts)
         VALUES ('t1', 'hello', '[]', 'running', ?, 1, 1, 1)`,
        Date.now() - MINUTE
      );
      return true;
    });

    // Seeding bypassed `rearmAlarm`, so nothing is armed yet. Re-scheduling the same id
    // is the realistic next step a client would take, and it is exactly the moment the
    // bug appears: `scheduleTask` correctly refuses to touch the running row, and
    // `rearmAlarm` is what has to notice the abandoned claim and arm the sweep. A
    // pending-only re-arm returns null here and deletes the alarm, and the row is
    // stranded for good.
    await stub.scheduleDelayed({ id: "t1", prompt: "hello", resumeAt: due() });
    // No alarm assertion here: `claimed_at` is 1ms after the epoch, so the lease is long
    // expired, `nextWakeAt` clamps it to `now`, and the runtime fires the alarm on its own
    // before the next statement runs. Reading `getAlarm()` back is therefore a race. What
    // matters is the sweep below.
    await runDurableObjectAlarm(stub);

    const rows = (await stub.listScheduled()) as { state: string; attempts: number }[];
    // attempts 1 → 2 is the reclaim. Without the `running` branch in `nextWakeAt` nothing
    // would have woken this object at all.
    expect(rows[0].attempts).toBe(2);
  });

  it("keeps the delay across a second request over the RPC boundary", async () => {
    // Stands in for a restarted host: nothing is carried in-process, only what Durable
    // Object storage holds. The engine-level suite cannot make this claim at all —
    // `openMemorySql` is per-handle and in-memory.
    const stub = coordinator();
    const resumeAt = Date.now() + 30 * MINUTE;
    await stub.scheduleDelayed({ id: "keep", prompt: "later", resumeAt });

    const rows = (await stub.listScheduled()) as { id: string; state: string; resume_at: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "keep", state: "pending", resume_at: resumeAt });
  });

  it("keeps separate tasks in separate rows", async () => {
    // A `toContain`-is-not-`toEqual` case from this repo's own history: completeness is the
    // property, so it is asserted as a length and as a set, not by looking for one id.
    const stub = coordinator();
    await stub.scheduleDelayed({ id: "a", prompt: "one", resumeAt: due() });
    await stub.scheduleDelayed({ id: "b", prompt: "two", resumeAt: due() });
    await stub.scheduleDelayed({ id: "a", prompt: "one-again", resumeAt: due() });

    const rows = (await stub.listScheduled()) as { id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores a re-schedule of a row that has already been claimed", async () => {
    // The lost-update this pins, over RPC: an earlier `ON CONFLICT` rewrote `prompt` for
    // every non-pending row, so rescheduling a task mid-flight changed the row out from
    // under the flight already dialling it.
    const stub = coordinator();
    await stub.scheduleDelayed({ id: "t1", prompt: "original", resumeAt: due() });
    await runDurableObjectAlarm(stub);

    await stub.scheduleDelayed({ id: "t1", prompt: "replacement", resumeAt: Date.now() + 60 * MINUTE });

    const rows = (await stub.listScheduled()) as { attempts: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(1);
  });
});

describe("FlockCoordinator — the lease the alarm assumes", () => {
  it("is re-armed at a running row's lease expiry, not dropped", async () => {
    // The mechanism behind the reclaim above, observed directly. After a claim the only
    // outstanding row is `running`, so the re-arm can only be correct if it consults the
    // lease — a `pending`-only query returns null and the alarm is deleted.
    const stub = coordinator();
    await stub.scheduleDelayed({ id: "t1", prompt: "hello", resumeAt: due() });
    await runDurableObjectAlarm(stub);

    const { alarm } = await inspect(stub);
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThan(Date.now());
    // And it is within a lease of now, not scheduled at some arbitrary future moment.
    expect(alarm!).toBeLessThanOrEqual(Date.now() + LEASE_MS);
  });

  it("arms nothing at all when the table is empty", async () => {
    // The cheap case, and the one that keeps a Durable Object from holding an alarm for
    // nothing: an armed alarm is a wake-up nobody asked for.
    const stub = coordinator();
    await stub.listScheduled();

    const { alarm } = await inspect(stub);
    expect(alarm).toBeNull();
  });
});