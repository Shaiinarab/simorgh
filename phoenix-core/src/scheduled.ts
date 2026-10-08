// ── Scheduled execution: durable delay over the existing SqlPort ─────────────
//
// A routing decision can already be "delay until a quota reset". The gap this fills is
// that the delay is only a number: if the process restarts tomorrow, nothing survives,
// and "delay until T" is lost. This module makes that delay a durable, idempotent unit
// of work on the same synchronous `SqlPort` the engine already uses.
//
// The split mirrors every other module here: a *pure* decision-maker
// (`nextDueTasks`, `claim`) that the engine can compute on, plus host-specific
// scheduling (a Durable Object alarm, a cron, an `setInterval`) the host owns. The
// engine never sets an alarm; it only decides which rows are runnable and transitions
// their state — so the whole policy is testable with no runtime, and a second host can
// schedule the same table without any of this code being duplicated.
//
// ── Idempotency is the whole point ──
//
// A host alarm can fire twice, and a Durable Object can be evicted mid-run. Every
// writer moves a row through a state machine keyed on the *expected current state*:
//
//   pending  --claim-->  running  --finish-->  done        (terminal)
//      \                                              \
//       \--claim-->  running  --fail (retry later)-->  running(stale, after lease)
//      \                                                       \--claim (reclaim)--> running
//
// A row never transitions backward out of `done`/`failed`, so a second wakeup that
// finds the row terminal runs nothing. A row stuck in `running` past the lease is
// assumed abandoned by an evicted host and reclaimed — at-least-once, never
// never-forgetting.

import type { SqlPort, SqlRow } from "./ports.ts";

/** The state a scheduled unit of work is in. */
export type TaskState = "pending" | "running" | "done" | "failed";

/** What the scheduler is asked to do later. */
export interface ScheduledTaskInput {
  /** Stable id chosen by the caller. Re-using an id never duplicates the row. */
  id: string;
  /** The prompt to fly through the flock when the time comes. */
  prompt: string;
  /**
   * The tools the caller asked for, recorded verbatim.
   *
   * **Not an allow-list, and not applied at flight time.** The agent loop runs *before*
   * the flight and has already folded every tool *result* into `prompt`
   * (`execute.ts` says so at the `fly` seam). The array travels with the row because the
   * flight signature is `(prompt, tools)` and hosts publish it that way — a deployment
   * records what was asked for from it — not because anything filters on it here. An
   * earlier version of this comment called these "allowed tools", which is false and
   * dangerous to believe: a scheduled task replays the *flight*, so its tool loop is not
   * re-run and cannot be re-authorised by this column.
   */
  tools: string[];
  /** Epoch ms the task becomes runnable. */
  resumeAt: number;
}

/** A row of `scheduled_task`. */
export type ScheduledTaskRow = {
  id: string;
  prompt: string;
  tools: string;
  state: TaskState;
  resume_at: number;
  claimed_at: number;
  created_at: number;
  attempts: number;
  result: string | null;
  error: string | null;
};

export const SCHEDULED_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduled_task (
    id          TEXT    NOT NULL PRIMARY KEY,
    prompt      TEXT    NOT NULL,
    tools       TEXT    NOT NULL DEFAULT '[]',
    state       TEXT    NOT NULL DEFAULT 'pending',
    resume_at   INTEGER NOT NULL,
    claimed_at  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    result      TEXT,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_state ON scheduled_task(state, resume_at);
`;

/**
 * How long a claimed (`running`) row may go unfinished before it is assumed the host
 * died mid-run and the row is reclaimed. This is the whole recovery story for a
 * crashed executor, so it is a constant the operator can reason about rather than a
 * magic number in a statement.
 */
export const SCHEDULED_LEASE_MS = 300_000;

/**
 * Insert a pending task, or replace nothing if the id already exists in a terminal state.
 *
 * The conflict clause only rewrites a row that is still `pending`. Two reasons, and the
 * second is the one that was wrong before:
 *
 *   - a `done`/`failed` row is terminal, and the run that produced it cannot be
 *     un-happened by editing the prompt;
 *   - a **`running` row is in flight**. Rewriting its `prompt`/`resume_at` under the
 *     executor's feet is a lost update — the row says one thing while the flight is
 *     already dialling another — so `running` is left alone too, exactly like `done`.
 *
 * To change a task that has already started, schedule a **new** id.
 */
export function scheduleTask(
  sql: SqlPort,
  input: ScheduledTaskInput,
  now: number
): void {
  sql.exec(
    `INSERT INTO scheduled_task (id, prompt, tools, state, resume_at, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       prompt    = excluded.prompt,
       tools     = excluded.tools,
       resume_at = excluded.resume_at
     WHERE scheduled_task.state = 'pending'`,
    input.id,
    input.prompt,
    JSON.stringify(input.tools ?? []),
    input.resumeAt,
    now
  );
}

/**
 * Which rows are runnable *right now*.
 *
 * Two kinds: `pending` rows whose time has come, and `running` rows whose lease has
 * expired — the host that claimed them is presumed dead, so they are work again. A
 * `done`/`failed` row is terminal and can never reappear.
 */
export function nextDueTasks(
  sql: SqlPort,
  now: number,
  leaseMs: number = SCHEDULED_LEASE_MS
): ScheduledTaskRow[] {
  return [
    ...sql.exec<ScheduledTaskRow & SqlRow>(
      `SELECT * FROM scheduled_task
        WHERE (state = 'pending' AND resume_at <= ?)
           OR (state = 'running' AND claimed_at <= ?)
        ORDER BY resume_at ASC`,
      now,
      now - leaseMs
    ).toArray(),
  ];
}

/**
 * Take a row from `pending`/`running`(stale) into `running`.
 *
 * Returns `true` only if this call performed the transition, so a duplicate alarm firing at
 * the same instant loses the race and runs nothing. The auto-incrementing `attempts` makes the
 * retry counter trustworthy across reclaims.
 *
 * `leaseMs` is a parameter rather than a hidden read of `SCHEDULED_LEASE_MS`: `nextDueTasks`
 * takes one too, and when the two disagreed — a caller scanning with a short lease and then
 * claiming with the long default — `claimTask` would refuse rows `nextDueTasks` had just
 * selected as reclaimable, and the recovery would silently do nothing. The lease is one
 * policy value, so both halves of the state machine take it from the caller.
 */
export function claimTask(
  sql: SqlPort,
  id: string,
  now: number,
  leaseMs: number = SCHEDULED_LEASE_MS
): boolean {
  const rows = sql.exec(
    `UPDATE scheduled_task
        SET state = 'running', claimed_at = ?, attempts = attempts + 1
      WHERE id = ? AND state IN ('pending', 'running') AND (state = 'pending' OR claimed_at <= ?)`,
    now,
    id,
    now - leaseMs
  ).rowsWritten;
  return rows === 1;
}

/**
 * When this table next needs a host to look at it, or `null` when nothing is outstanding.
 *
 * **This is the whole recovery story, and it is why it exists.** An earlier version asked
 * only for the earliest `pending` row, which is correct until a host dies mid-run: the row
 * is left in `running`, and a `running` row is invisible to a `pending`-only query, so the
 * Durable Object would clear its alarm and the task would sit there forever. Nothing would
 * ever wake it, because the only thing that *can* wake a Durable Object is an alarm.
 *
 * So a `running` row contributes a wake at `claimed_at + leaseMs` — the moment it becomes
 * reclaimable. The cost is honest and worth stating: a row that is executing *right now*
 * still schedules a wake at its lease expiry, so a live task makes the host wake once more
 * to find the row `done` and do nothing. That is one wasted wake per completed task, and it
 * buys recovery from eviction, which is not optional. The engine does not clear the row
 * early because it cannot know the host is still alive — only the lease can say that.
 *
 * Returns a time no earlier than `now`: a row that is already overdue is due immediately,
 * and "immediately" has to be a real timestamp, not the past.
 */
export function nextWakeAt(
  sql: SqlPort,
  now: number,
  leaseMs: number = SCHEDULED_LEASE_MS
): number | null {
  // Two queries rather than one over a UNION, because a derived table is a dialect
  // question and this table has to run on three SQLite dialects already (workerd, node:sqlite,
  // bun:sqlite). MIN over two scalars is the most portable arithmetic there is.
  const pending = sql
    .exec<{ t: number | null } & SqlRow>("SELECT MIN(resume_at) AS t FROM scheduled_task WHERE state = 'pending'")
    .toArray()[0]?.t;
  const running = sql
    .exec<{ t: number | null } & SqlRow>("SELECT MIN(claimed_at) AS t FROM scheduled_task WHERE state = 'running'")
    .toArray()[0]?.t;

  const candidates: number[] = [];
  if (typeof pending === "number") candidates.push(pending);
  if (typeof running === "number") candidates.push(running + leaseMs);
  if (candidates.length === 0) return null;
  return Math.max(now, Math.min(...candidates));
}

/** Record a successful run and close the row. */
export function finishTask(sql: SqlPort, id: string, result: string): void {
  sql.exec(
    "UPDATE scheduled_task SET state = 'done', result = ?, error = NULL WHERE id = ?",
    result,
    id
  );
}

/** Record a failure and close the row. A retry would mean another schedule, not a revive. */
export function failTask(sql: SqlPort, id: string, error: string): void {
  sql.exec(
    "UPDATE scheduled_task SET state = 'failed', error = ? WHERE id = ?",
    error,
    id
  );
}

/** Read every row. */
export function listTasks(sql: SqlPort): ScheduledTaskRow[] {
  return [...sql.exec<ScheduledTaskRow & SqlRow>("SELECT * FROM scheduled_task ORDER BY created_at").toArray()];
}
