// Durable delay, at the engine level. Real SQLite through the Node `SqlPort` — the
// same statements the Worker runs against Durable Object storage — and no Durable
// Object, no alarm, and no runtime binding required.
//
// The behaviour under test is *state-machine* behaviour: what makes "delay until a
// quota reset" survive a restart, and what stops an alarm that fires twice (or after
// a host was evicted mid-run) from running the work twice. Both properties live in the
// SQL transitions, so that is where they are pinned.
//
// `test/durable-scheduled.test.ts` covers the other half — that a real Durable Object
// alarm actually arms, fires, and runs the row. Neither file subsumes the other.
import { beforeEach, describe, expect, it } from "vitest";

import {
  SCHEDULED_LEASE_MS,
  SCHEDULED_SCHEMA,
  claimTask,
  failTask,
  finishTask,
  listTasks,
  nextDueTasks,
  nextWakeAt,
  scheduleTask,
  type ScheduledTaskInput,
} from "../src/scheduled.ts";
import { openMemorySql } from "../src/node/index.ts";
import type { SqlPort } from "../src/ports.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

/** A short lease, so a test can cross one without arithmetic noise. */
const LEASE = 5_000;

let sql: SqlPort;

beforeEach(() => {
  sql = openMemorySql().sql;
  sql.exec(SCHEDULED_SCHEMA);
});

function task(id: string, resumeAt: number, prompt = `prompt:${id}`): ScheduledTaskInput {
  return { id, prompt, tools: ["search"], resumeAt };
}

function rowOf(id: string) {
  return listTasks(sql).find((t) => t.id === id);
}

// ── The delay persists ─────────────────────────────────────────────────────────
//
// "Persist" is the whole claim, so these run against a real database and a *second
// handle* on it: a value that only exists in a variable has not survived anything.

describe("scheduleTask", () => {
  it("persists the delay as a row, not as a value the caller is holding", () => {
    // Hermetic scope: this proves the state was *written to the database* rather than
    // merely returned to the caller — every later test reads it back through an
    // unrelated function. The stronger claim, that it survives a host restart, is
    // proven against real Durable Object storage in `test/durable-scheduled.test.ts`;
    // it cannot be proven here because `openMemorySql` is per-handle and in-memory.
    scheduleTask(sql, task("t1", NOW + 4 * MINUTE), NOW);

    expect(rowOf("t1")).toMatchObject({
      id: "t1",
      prompt: "prompt:t1",
      state: "pending",
      resume_at: NOW + 4 * MINUTE,
      attempts: 0,
      result: null,
      error: null,
    });
  });

  it("round-trips tools as JSON rather than as a joined string", () => {
    scheduleTask(sql, { ...task("t1", NOW + MINUTE), tools: ["alpha", "beta"] }, NOW);

    expect(JSON.parse(rowOf("t1")!.tools)).toEqual(["alpha", "beta"]);
  });

  it("rewrites a row that is still pending", () => {
    scheduleTask(sql, task("t1", NOW + MINUTE, "first"), NOW);
    scheduleTask(sql, task("t1", NOW + 9 * MINUTE, "second"), NOW);

    expect(rowOf("t1")).toMatchObject({
      prompt: "second",
      resume_at: NOW + 9 * MINUTE,
      state: "pending",
    });
    // Same id, same row: a reschedule is an edit, not a second task.
    expect(listTasks(sql)).toHaveLength(1);
  });

  it("leaves a finished row alone — a run that happened cannot be un-happened", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);
    finishTask(sql, "t1", "answered");

    scheduleTask(sql, task("t1", NOW + MINUTE, "second"), NOW);

    expect(rowOf("t1")).toMatchObject({
      prompt: "prompt:t1",
      state: "done",
      result: "answered",
    });
  });

  it("leaves a *running* row alone — the executor must not be edited underneath", () => {
    // The lost-update this pins: an earlier ON CONFLICT rewrote `prompt` and
    // `resume_at` for every non-pending row, so rescheduling a task mid-flight
    // changed the row out from under the flight already dialling it. `running` is now
    // as immutable as `done`.
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);

    scheduleTask(sql, task("t1", NOW + MINUTE, "second"), NOW);

    expect(rowOf("t1")).toMatchObject({ prompt: "prompt:t1", state: "running" });
  });

  it("does not create a second row for a repeated id", () => {
    scheduleTask(sql, task("t1", NOW + MINUTE), NOW);
    scheduleTask(sql, task("t1", NOW + MINUTE), NOW);
    scheduleTask(sql, task("t1", NOW + MINUTE), NOW);

    expect(listTasks(sql)).toHaveLength(1);
  });
});

// ── What is runnable right now ─────────────────────────────────────────────────

describe("nextDueTasks", () => {
  it("returns a pending row only once its time has come", () => {
    scheduleTask(sql, task("t1", NOW + MINUTE), NOW);

    expect(nextDueTasks(sql, NOW, LEASE)).toEqual([]);
    expect(nextDueTasks(sql, NOW + MINUTE, LEASE).map((t) => t.id)).toEqual(["t1"]);
  });

  it("orders by resume time, so the earliest reset is served first", () => {
    scheduleTask(sql, task("late", NOW + 9 * MINUTE), NOW);
    scheduleTask(sql, task("soon", NOW + MINUTE), NOW);
    scheduleTask(sql, task("mid", NOW + 4 * MINUTE), NOW);

    expect(nextDueTasks(sql, NOW + 10 * MINUTE, LEASE).map((t) => t.id)).toEqual([
      "soon",
      "mid",
      "late",
    ]);
  });

  it("never returns a finished or failed row, however overdue", () => {
    scheduleTask(sql, task("done-task", NOW), NOW);
    scheduleTask(sql, task("failed-task", NOW), NOW);
    claimTask(sql, "done-task", NOW);
    finishTask(sql, "done-task", "answered");
    claimTask(sql, "failed-task", NOW);
    failTask(sql, "failed-task", "boom");

    expect(nextDueTasks(sql, NOW + 10 * MINUTE, LEASE)).toEqual([]);
  });

  it("does not return a running row that is still inside its lease", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);

    expect(nextDueTasks(sql, NOW + LEASE - 1, LEASE)).toEqual([]);
  });

  it("returns a running row whose lease expired — the host that claimed it is presumed dead", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);

    expect(nextDueTasks(sql, NOW + LEASE, LEASE).map((t) => t.id)).toEqual(["t1"]);
  });

  it("includes a stale running row alongside a due pending row", () => {
    scheduleTask(sql, task("stale", NOW), NOW);
    claimTask(sql, "stale", NOW);
    scheduleTask(sql, task("fresh", NOW + MINUTE), NOW);

    expect(nextDueTasks(sql, NOW + MINUTE + LEASE, LEASE).map((t) => t.id).sort()).toEqual([
      "fresh",
      "stale",
    ]);
  });
});

// ── Claiming ──────────────────────────────────────────────────────────────────

describe("claimTask", () => {
  it("transitions pending to running and counts the attempt", () => {
    scheduleTask(sql, task("t1", NOW), NOW);

    expect(claimTask(sql, "t1", NOW)).toBe(true);
    expect(rowOf("t1")).toMatchObject({ state: "running", attempts: 1, claimed_at: NOW });
  });

  it("counts every reclaim, so the retry figure is trustworthy", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    expect(claimTask(sql, "t1", NOW, LEASE)).toBe(true);
    expect(claimTask(sql, "t1", NOW + LEASE, LEASE)).toBe(true);
    expect(claimTask(sql, "t1", NOW + 2 * LEASE, LEASE)).toBe(true);

    expect(rowOf("t1")?.attempts).toBe(3);
  });

  it("refuses a finished row — this is what makes double execution impossible", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);
    finishTask(sql, "t1", "answered");

    expect(claimTask(sql, "t1", NOW + LEASE)).toBe(false);
    expect(rowOf("t1")).toMatchObject({ state: "done", attempts: 1, result: "answered" });
  });

  it("refuses a failed row", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);
    failTask(sql, "t1", "boom");

    expect(claimTask(sql, "t1", NOW + LEASE)).toBe(false);
    expect(rowOf("t1")).toMatchObject({ state: "failed", error: "boom" });
  });

  it("refuses a running row that is still leased, so a live run is not doubled", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);

    expect(claimTask(sql, "t1", NOW + LEASE - 1)).toBe(false);
    expect(rowOf("t1")?.attempts).toBe(1);
  });

  it("reports false for an id that does not exist", () => {
    expect(claimTask(sql, "ghost", NOW)).toBe(false);
  });

  it("uses the lease it is given, not a hidden constant", () => {
    // The mismatch this pins: `nextDueTasks` takes a lease and `claimTask` used to
    // read `SCHEDULED_LEASE_MS` internally. A caller scanning with a short lease and
    // then claiming with the long default would have `claimTask` refuse rows
    // `nextDueTasks` had just selected — recovery that silently does nothing.
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);

    expect(nextDueTasks(sql, NOW + LEASE, LEASE)).toHaveLength(1);
    expect(claimTask(sql, "t1", NOW + LEASE, LEASE)).toBe(true);

    scheduleTask(sql, task("t2", NOW), NOW);
    claimTask(sql, "t2", NOW);
    // With a lease the caller did *not* pass, the row is still inside its 5s lease.
    expect(claimTask(sql, "t2", NOW + LEASE, SCHEDULED_LEASE_MS)).toBe(false);
  });
});

// ── When should the host next look? ───────────────────────────────────────────
//
// `nextWakeAt` is the recovery mechanism, so its behaviour on a `running` row is the
// single most important thing in this file.

describe("nextWakeAt", () => {
  it("is null on an empty table, which is how a host knows to drop its alarm", () => {
    expect(nextWakeAt(sql, NOW, LEASE)).toBeNull();
  });

  it("is null when everything is finished", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);
    finishTask(sql, "t1", "answered");

    expect(nextWakeAt(sql, NOW, LEASE)).toBeNull();
  });

  it("names the earliest pending resume time", () => {
    scheduleTask(sql, task("late", NOW + 9 * MINUTE), NOW);
    scheduleTask(sql, task("soon", NOW + 4 * MINUTE), NOW);

    expect(nextWakeAt(sql, NOW, LEASE)).toBe(NOW + 4 * MINUTE);
  });

  it("is already due, clamped to now, when the pending time has passed", () => {
    scheduleTask(sql, task("t1", NOW - MINUTE), NOW);

    expect(nextWakeAt(sql, NOW, LEASE)).toBe(NOW);
  });

  it("names a RUNNING row's lease expiry — the recovery a pending-only query cannot do", () => {
    // The defect this pins, stated as a test because a comment would not survive the
    // next refactor. An earlier re-arm asked only for the earliest *pending* row. A
    // host evicted mid-run leaves the row `running`; a `running` row is invisible to a
    // pending-only query; so the Durable Object cleared its alarm and the task sat
    // there forever. Nothing else can wake a Durable Object — an alarm is the only
    // thing that does. This assertion fails if `nextWakeAt` is narrowed to `pending`.
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);

    expect(nextWakeAt(sql, NOW, LEASE)).toBe(NOW + LEASE);
  });

  it("wakes immediately for a running row whose lease has already expired", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);

    expect(nextWakeAt(sql, NOW + LEASE + MINUTE, LEASE)).toBe(NOW + LEASE + MINUTE);
  });

  it("takes the earlier of a pending row and a running row's lease", () => {
    scheduleTask(sql, task("pending-task", NOW + 4 * MINUTE), NOW);
    scheduleTask(sql, task("running-task", NOW), NOW);
    claimTask(sql, "running-task", NOW, LEASE);

    // A 5s lease expires well before the 4-minute pending row, so the lease wins.
    expect(nextWakeAt(sql, NOW, LEASE)).toBe(NOW + LEASE);
  });

  it("prefers the pending row when the lease outlives it", () => {
    scheduleTask(sql, task("pending-task", NOW + 4 * MINUTE), NOW);
    scheduleTask(sql, task("running-task", NOW), NOW);
    claimTask(sql, "running-task", NOW, 10 * MINUTE);

    // Same two rows, a lease that now runs past the pending resume time: the pending
    // row becomes the earlier wake. Both cases come from one `Math.min`, and pinning
    // both directions is what stops a future edit from always returning the lease.
    expect(nextWakeAt(sql, NOW, 10 * MINUTE)).toBe(NOW + 4 * MINUTE);
  });

  it("never returns a terminal row's wake, even with an old timestamp", () => {
    scheduleTask(sql, task("t1", NOW - 10 * MINUTE), NOW);
    claimTask(sql, "t1", NOW - 10 * MINUTE);
    finishTask(sql, "t1", "answered");

    expect(nextWakeAt(sql, NOW, LEASE)).toBeNull();
  });
});

// ── Closing a row ─────────────────────────────────────────────────────────────

describe("finishTask / failTask", () => {
  it("records the result and clears any previous error", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);
    finishTask(sql, "t1", '{"answer":"42"}');

    expect(rowOf("t1")).toMatchObject({ state: "done", result: '{"answer":"42"}', error: null });
  });

  it("records the reason a task failed", () => {
    scheduleTask(sql, task("t1", NOW), NOW);
    claimTask(sql, "t1", NOW);
    failTask(sql, "t1", "Error: host died");

    expect(rowOf("t1")).toMatchObject({ state: "failed", error: "Error: host died" });
  });

  it("is a no-op on a row that does not exist", () => {
    expect(() => finishTask(sql, "ghost", "x")).not.toThrow();
    expect(rowOf("ghost")).toBeUndefined();
  });
});

describe("listTasks", () => {
  it("returns every row, oldest first", () => {
    // Distinct `created_at` values on purpose: `second` and `third` originally shared
    // one, and the order between two rows with equal keys is not something the query
    // promises. A test that asserts an unspecified order passes by luck and then fails
    // on a different SQLite build.
    scheduleTask(sql, task("third", NOW + 3 * MINUTE), NOW + 2 * MINUTE);
    scheduleTask(sql, task("first", NOW + 1 * MINUTE), NOW);
    scheduleTask(sql, task("second", NOW + 2 * MINUTE), NOW + MINUTE);

    // Ordered by `created_at`, not by resume time: this is an audit view, and the
    // scheduler has its own ordering in `nextDueTasks`.
    expect(listTasks(sql).map((t) => t.id)).toEqual(["first", "second", "third"]);
  });
});