// ── The task graph: a GOAL as data, ordered, and scheduled ────────────────────
//
// `quota.ts` answers "can this account serve this *workload*, and if not, when?".
// That is the right last question and it is already asked in exactly one place. What
// was missing is the layer in front of it: nothing had a **task**. The gateway received
// one request, spent one request's worth of quota, and had no representation of "a goal
// made of several steps, some of which can run now and some of which must wait" — so
// `scheduled.ts` could delay exactly one opaque prompt at a time, and a hundred-step
// research job had to be one row with a string in it.
//
// This module supplies that representation, and it supplies nothing else:
//
//   * `Task` — a **data structure**, not a hard-coded agent. `type` says what kind of
//     work it is (`research`, `summarise`, …) and `capabilities` says what it may do;
//     the engine does not know either list. A task that cannot be described is not a
//     task, it is a wish.
//   * `taskGraph` — dependency validation plus a topological order. It **fails closed**:
//     a cycle and a missing dependency are both errors naming the offending node, never
//     a partial order silently truncated to the part that happened to be walkable.
//   * `planTaskRun` — the seam onto `quota.ts`. It converts a task into a `Workload` and
//     delegates, so there remains **one** place in the repository that decides
//     run/delay/unavailable. A second implementation would not merely duplicate the
//     temporal policy; it would disagree with it, and the disagreement would surface as
//     a task that ran onto an exhausted account.
//
// ── What this borrows, and from where ──────────────────────────────────────────
//
// A previous session rejected Temporal/Inngest as premature, and this module is the
// first chance to check whether that was right. It was. But the *modelling* is worth
// taking, and three pieces of it are load-bearing here:
//
//   * **Dagster** makes dependencies a *checked* relationship rather than a hint, and
//     rejects a cycle at graph-construction time instead of hanging at run time. That
//     is what `taskGraph` does, and its error names the cycle so an operator can see
//     which edge to cut.
//   * **Trigger.dev v3** splits a concurrency cap into a *total* and a *per-key* form
//     (`{ total: 10 }` vs `{ perKey: 10 }`) and, more importantly, has first-class
//     `concurrency.deadlock` / `concurrency.recursiveDeadlock` errors for a subtask
//     waiting on the queue its own parent already holds. Simorgh has the same hazard —
//     fanning a task across accounts when the parent is itself mid-flight on the only
//     account — and it does **not** get a detector here, because detecting it needs to
//     know which queue the host is occupying, which is runtime knowledge this engine
//     deliberately does not have. Recorded rather than guessed at.
//   * **BullMQ** teaches the distinction this module turns into a type: its `limiter`
//     is a *rate* limit ("how many jobs per window"), which the maintainer states
//     plainly is *not* a concurrency limit, and a rate-limited job must signal
//     `Worker.RateLimitError()` so it is moved back to *waiting* rather than recorded as
//     a *failure*. Hence `delay` and `unavailable` are distinct outcomes here, and a
//     delayed task is not a failed task.
//
// Not adopted: Temporal, Inngest, Trigger.dev, BullMQ, Dagster. Every one of them is a
// durable-execution *runtime* — a server, a queue, a worker fleet, or a hosted control
// plane — and this module has to bundle into a Cloudflare Worker with no bindings and
// run on bare Node. See the note at the top of `swarm.ts` for the full reasoning.
//
// ── The boundary that matters here ─────────────────────────────────────────────
//
// `state` is **`scheduled.ts`'s `TaskState`**, imported, not redefined. It is tempting
// to give a task a richer lifecycle (`blocked`, `deferred`, `waiting_for_quota`), and it
// would be a second vocabulary nobody compares against the first — the exact failure
// `ledger.ts` documents having already paid for once. Blocked-ness is *derived* from
// `dependencies` and capacity, not stored; `scheduled.ts` owns the transitions and its
// `claim`/`finish`/`fail` state machine already reconciles them after a restart.

import { planQuotaRun } from "./quota.ts";
import type { CandidateId, PlanOptions, QuotaState, Workload } from "./quota.ts";
import type { SqlPort, SqlRow } from "./ports.ts";
import type { TaskState } from "./scheduled.ts";

// ── Shape ─────────────────────────────────────────────────────────────────────

/**
 * One schedulable unit of work.
 *
 * An interface, unlike `TaskRow` below, because this is the in-memory shape and never
 * meets `SqlPort.exec<T>`; the SQL row is the one that needs an index signature.
 */
export interface Task {
  /** Caller-chosen, stable. Re-using an id never duplicates a row. */
  id: string;
  /** What kind of work this is. Free-form on purpose — see the module header. */
  type: string;
  /** The goal this belongs to. Every task traces back to one. */
  goalId: string;
  /** Who asked for it. Carried through decomposition unchanged. */
  principalId: string;
  /** The task this was split from, or `null` for a root. */
  parentTaskId: string | null;
  /** Ids that must reach `done` first. Absent ids are a graph error, not a warning. */
  dependencies: string[];
  inputs: Record<string, unknown>;
  /** What the task is expected to produce, as names this engine does not interpret. */
  outputs: Record<string, unknown>;
  /** What it may do. A child may narrow this and may never widen it. */
  capabilities: string[];
  /** Requests this task is expected to spend. Feeds `Workload.requests`. */
  estimatedRequests: number;
  /** Tokens this task is expected to spend. Feeds `Workload.tokens`. */
  estimatedTokens: number;
  /** Epoch ms this must finish by, or `0` for no deadline. */
  deadline: number;
  state: TaskState;
  attempts: number;
  createdAt: number;
  /** Epoch ms this becomes runnable; `0` = no known time (see `TaskPlan`). */
  scheduledAt: number;
  /** The host's id for the execution that claimed it, or `null`. */
  executionId: string | null;
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * One task row.
 *
 * `dependencies`, `inputs`, `outputs` and `capabilities` are JSON text columns, the same
 * choice `scheduled.ts` makes for `tools`, and for the same reason: they arrive as one
 * value from one caller and are validated against the *in-memory* graph either way, so
 * an edge table would add a second place to keep in sync without changing a single
 * decision. `recordUsage`'s argument applies to schemas: a second representation of the
 * same graph is a second truth unless something compares them.
 *
 * A `type` alias rather than an `interface` so it keeps the implicit index signature
 * `SqlPort.exec<T>` requires; interfaces get none.
 */
export type TaskRow = {
  id: string;
  type: string;
  goal_id: string;
  principal_id: string;
  parent_task_id: string | null;
  dependencies: string;
  inputs: string;
  outputs: string;
  capabilities: string;
  est_requests: number;
  est_tokens: number;
  deadline: number;
  state: TaskState;
  attempts: number;
  created_at: number;
  scheduled_at: number;
  execution_id: string | null;
};

export const TASK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task (
    id              TEXT    NOT NULL PRIMARY KEY,
    type            TEXT    NOT NULL,
    goal_id         TEXT    NOT NULL,
    principal_id    TEXT    NOT NULL DEFAULT '',
    parent_task_id  TEXT,
    dependencies    TEXT    NOT NULL DEFAULT '[]',
    inputs          TEXT    NOT NULL DEFAULT '{}',
    outputs         TEXT    NOT NULL DEFAULT '{}',
    capabilities    TEXT    NOT NULL DEFAULT '[]',
    est_requests    INTEGER NOT NULL DEFAULT 0,
    est_tokens      INTEGER NOT NULL DEFAULT 0,
    deadline        INTEGER NOT NULL DEFAULT 0,
    state           TEXT    NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    scheduled_at    INTEGER NOT NULL DEFAULT 0,
    execution_id    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_goal ON task(goal_id);
  CREATE INDEX IF NOT EXISTS idx_task_runnable ON task(state, scheduled_at);
`;

const SELECT_ALL = `
  SELECT id, type, goal_id, principal_id, parent_task_id,
         dependencies, inputs, outputs, capabilities,
         est_requests, est_tokens, deadline,
         state, attempts, created_at, scheduled_at, execution_id
    FROM task
`;

/** Insert a task, or replace it outright. Ids are the caller's, and stable. */
export function saveTask(sql: SqlPort, task: Task): void {
  sql.exec(
    `INSERT INTO task
       (id, type, goal_id, principal_id, parent_task_id,
        dependencies, inputs, outputs, capabilities,
        est_requests, est_tokens, deadline, state, attempts,
        created_at, scheduled_at, execution_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type           = excluded.type,
       goal_id        = excluded.goal_id,
       principal_id   = excluded.principal_id,
       parent_task_id = excluded.parent_task_id,
       dependencies   = excluded.dependencies,
       inputs         = excluded.inputs,
       outputs        = excluded.outputs,
       capabilities   = excluded.capabilities,
       est_requests   = excluded.est_requests,
       est_tokens     = excluded.est_tokens,
       deadline       = excluded.deadline,
       state          = excluded.state,
       attempts       = excluded.attempts,
       scheduled_at   = excluded.scheduled_at,
       execution_id   = excluded.execution_id`,
    task.id,
    task.type,
    task.goalId,
    task.principalId,
    task.parentTaskId,
    JSON.stringify(task.dependencies),
    JSON.stringify(task.inputs),
    JSON.stringify(task.outputs),
    JSON.stringify(task.capabilities),
    task.estimatedRequests,
    task.estimatedTokens,
    task.deadline,
    task.state,
    task.attempts,
    task.createdAt,
    task.scheduledAt,
    task.executionId
  );
}

/** One task, or `undefined` when there is no such id. */
export function readTask(sql: SqlPort, id: string): TaskRow | undefined {
  return sql.exec<TaskRow & SqlRow>(SELECT_ALL + " WHERE id = ?", id).toArray()[0];
}

/**
 * Every task of one goal, oldest first.
 *
 * This is the lineage query. It reads the flat `task` table rather than walking
 * `parent_task_id`, so "what did this goal become" is one indexed scan — and because
 * every leaf is written with its goal, it is the same answer whether the goal was
 * decomposed once or twenty times.
 */
export function readGoalTasks(sql: SqlPort, goalId: string): TaskRow[] {
  return [
    ...sql
      .exec<TaskRow & SqlRow>(
        SELECT_ALL + " WHERE goal_id = ? ORDER BY created_at ASC",
        goalId
      )
      .toArray(),
  ];
}

/** Row → the pure shape. */
export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type,
    goalId: row.goal_id,
    principalId: row.principal_id,
    parentTaskId: row.parent_task_id,
    dependencies: JSON.parse(row.dependencies) as string[],
    inputs: JSON.parse(row.inputs) as Record<string, unknown>,
    outputs: JSON.parse(row.outputs) as Record<string, unknown>,
    capabilities: JSON.parse(row.capabilities) as string[],
    estimatedRequests: row.est_requests,
    estimatedTokens: row.est_tokens,
    deadline: row.deadline,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
    scheduledAt: row.scheduled_at,
    executionId: row.execution_id,
  };
}

// ── The graph ─────────────────────────────────────────────────────────────────

/** Why a graph is not executable. Both are hard errors, never warnings. */
export type GraphRejection =
  /** Two or more tasks depend on each other, however indirectly. */
  | { ok: false; code: "cycle"; cycle: string[]; message: string }
  /** A task names a dependency no task in the graph provides. */
  | { ok: false; code: "missing_dependency"; taskId: string; missing: string[]; message: string }
  /** Two tasks claim the same id, so an edge could resolve to either. */
  | { ok: false; code: "duplicate_id"; taskId: string; message: string };

/** A validated graph: an order in which every dependency precedes its dependants. */
export type ValidTaskGraph = { ok: true; order: string[]; byId: Map<string, Task> };

export type TaskGraph = ValidTaskGraph | GraphRejection;

/**
 * Walk the un-emitted remainder to name the cycle, e.g. `["a", "b", "c", "a"]`.
 *
 * A node is still un-emitted only while one of its dependencies is un-emitted, so every
 * node reachable here has an edge to another one and the walk always closes. The final
 * fallback is therefore unreachable — it exists so that a future change to the
 * eligibility rule degrades to "here are the tasks that did not resolve" instead of
 * inventing a cycle that is not there.
 */
function findCycle(remaining: readonly string[], deps: Map<string, readonly string[]>): string[] {
  const open = new Set(remaining);
  const path: string[] = [];
  const seen = new Set<string>();
  let current = remaining[0];
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    const next = (deps.get(current) ?? []).find((d) => open.has(d));
    if (next === undefined) return [...remaining];
    current = next;
  }
  const at = path.indexOf(current);
  return at === -1 ? [...remaining] : [...path.slice(at), current];
}

/**
 * Validate `tasks` and order them so every task follows its dependencies.
 *
 * Fails closed, and says which node is at fault. Both rejections are deliberately
 * distinguishable because they have different fixes: a cycle needs an edge removed, a
 * missing dependency needs a task written (or a name corrected). A single "invalid
 * graph" would force the operator to diff two sets of ids by hand.
 *
 * Kahn's algorithm, with ties broken by **declaration order** — two independent tasks
 * come out in the order they were written, so the plan is a pure function of its input
 * and two runs of the engine produce the same order.
 */
export function taskGraph(tasks: readonly Task[]): TaskGraph {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      return {
        ok: false,
        code: "duplicate_id",
        taskId: task.id,
        message: `duplicate task id: ${task.id}`,
      };
    }
    byId.set(task.id, task);
  }

  const deps = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const missing = task.dependencies.filter((d) => !byId.has(d));
    if (missing.length > 0) {
      return {
        ok: false,
        code: "missing_dependency",
        taskId: task.id,
        missing,
        message: `${task.id} depends on ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in the graph`,
      };
    }
    deps.set(task.id, task.dependencies);
  }

  // In-degree counts unmet dependencies, and a cursor walks the ready set so the scan is
  // linear in nodes+edges rather than quadratic.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, task.dependencies.length);
    for (const dep of task.dependencies) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
    }
  }

  const ready = tasks.filter((t) => t.dependencies.length === 0).map((t) => t.id);
  const order: string[] = [];
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor];
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (order.length !== tasks.length) {
    const remaining = tasks.map((t) => t.id).filter((id) => !order.includes(id));
    const cycle = findCycle(remaining, deps);
    return {
      ok: false,
      code: "cycle",
      cycle,
      message: `dependency cycle: ${cycle.join(" -> ")}`,
    };
  }

  return { ok: true, order, byId };
}

// ── Scheduling ────────────────────────────────────────────────────────────────

/** The task-facing scheduling verdict. One decision, taken by `planQuotaRun`. */
export interface TaskPlan {
  taskId: string;
  action: "run" | "delay" | "unavailable";
  /** The account chosen. Set for `run`, and for `delay` as the one being waited for. */
  run?: CandidateId;
  /** Set when `action === "delay"`: the epoch ms to resume at. */
  resumeAt?: number;
  /**
   * The epoch ms to write back to `scheduledAt`, ready to hand to `scheduled.ts`.
   *
   * `0` for `unavailable`, meaning **no such time**. A task that no account could ever
   * serve has no resume time, and inventing one is the fabrication `quota.ts` refuses to
   * commit anywhere else — an honest "there is no time at which this works" is a
   * different statement from "later". `0` is this repo's existing sentinel for "unknown"
   * (`QuotaWindow.resetAt`), so the column needs no new convention.
   */
  scheduledAt: number;
  /** Every account not chosen, with the reason. Not decoration — see `SchedulePlan`. */
  rejected: { candidateId: CandidateId; reason: string }[];
}

/**
 * Decide what to do with `task` right now, by asking `planQuotaRun` and adding nothing.
 *
 * All this does is translate a task into the `Workload` the quota module already
 * understands, and translate its answer back onto task fields. The estimates are the
 * caller's, the account choice is `quota.ts`'s, and the deadline is passed through
 * untouched — which matters, because `planQuotaRun` switches objectives when a task is
 * close to its deadline, and a plan that dropped the deadline would silently never
 * become urgent.
 *
 * `options` is `quota.ts`'s own `PlanOptions`, forwarded as-is: two places that accept
 * independent urgency/horizon values are two places that will disagree about one.
 *
 * State transitions are **not** here. A `done` task still gets a capacity verdict,
 * because "can this work be served" and "should this work be considered" are different
 * questions, and `scheduled.ts` already answers the second one with a state machine that
 * survives a restart.
 */
export function planTaskRun(
  task: Task,
  states: readonly QuotaState[],
  now: number,
  options?: PlanOptions
): TaskPlan {
  const workload: Workload = {
    requests: task.estimatedRequests,
    tokens: task.estimatedTokens,
    // `0` is the "no deadline" sentinel on the row; `Workload` wants it absent rather
    // than zero, because a deadline of `0` is already in the past and would make every
    // task urgent.
    ...(task.deadline > 0 ? { deadline: task.deadline } : {}),
  };

  const plan = planQuotaRun(states, workload, now, options ?? {});

  return {
    taskId: task.id,
    action: plan.action,
    ...(plan.run ? { run: plan.run } : {}),
    ...(plan.resumeAt !== undefined ? { resumeAt: plan.resumeAt } : {}),
    scheduledAt:
      plan.action === "delay"
        ? (plan.resumeAt ?? 0)
        : plan.action === "run"
          ? now
          : 0,
    rejected: plan.rejected,
  };
}

/**
 * Write a plan's scheduling decision back onto the task row.
 *
 * `scheduledAt` is the load-bearing column: `scheduled.ts`'s `nextDueTasks` selects
 * `state = 'pending' AND resume_at <= ?`, so a delayed task that is not persisted is a
 * delayed task that does not exist. `executionId` is recorded on `run` only — a delayed
 * task has no execution, and writing one would let `finishTask` close a task that never
 * ran.
 *
 * `state` is deliberately **not** touched. Claiming is `scheduled.ts`'s job, keyed on the
 * expected current state so a duplicate alarm loses the race.
 */
export function recordPlan(sql: SqlPort, plan: TaskPlan): void {
  sql.exec(
    "UPDATE task SET scheduled_at = ?, execution_id = ? WHERE id = ?",
    plan.scheduledAt,
    plan.action === "run" ? (plan.run?.providerId ?? null) : null,
    plan.taskId
  );
}