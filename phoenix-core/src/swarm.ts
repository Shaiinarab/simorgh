// ── The swarm: decompose a goal, then place what came out ─────────────────────
//
// A task is a data structure (`tasks.ts`). This module is the two operations that turn
// one into several and then find capacity for them — and, deliberately, very little
// else. Every capacity decision is delegated to `quota.ts` through `planTaskRun`, so
// there is still exactly one place in this repository that knows how to answer "can
// this run, and if not when".
//
// ── `swarm` is not uncontrolled parallelism ───────────────────────────────────
//
// Fanning a task into N leaves multiplies the spend N times against a pool that is
// *finite and shared*. A decomposer that hands out N leaves without bounding N has
// converted one 100k-token job into N jobs the pool cannot serve, and the failure looks
// like a provider outage rather than like an over-commitment. Three bounds, all enforced
// here rather than left to a caller:
//
//   1. **`maxSubtasks` caps the fan-out**, and the cap is checked by a test rather than
//      assumed. This is Trigger.dev v3's `{ total: N }` form — a cap on the whole unit
//      of work, as distinct from its `{ perKey: N }` form, which is the per-account
//      bound and is `quota.ts`'s business rather than this module's.
//   2. **A child may narrow its capabilities and may never widen them.** Splitting a
//      task must not be a privilege-escalation path: if the parent could not read the
//      mail, neither can any leaf it produced. The narrowing is an intersection, so an
//      over-broad request is *dropped*, not honoured — fail closed, which for a
//      permission means less, never more.
//   3. **Allocation is sequential, not independent.** The naive version asks
//      `planQuotaRun` about each leaf against the same unchanged pool and reports N
//      `run`s that together exceed it. Each answer would be individually correct and
//      collectively wrong, so a placement is folded back into the pool before the next
//      leaf is considered — the same accounting `recordUsage` performs, and the reason
//      Trigger.dev models a concurrency *slot* as consumed rather than as merely
//      checked.
//
// Inngest's distinction is the reason (3) is stated as it is: their docs are explicit
// that a concurrency limit counts *steps executing code*, not runs in progress, so a
// delayed task consumes nothing. That is why only a `run` placement advances the pool
// here; a `delay` is waiting, and waiting spends nothing.
//
// ── What is deliberately NOT here ──────────────────────────────────────────────
//
// **Trigger.dev's `concurrency.recursiveDeadlock` detector.** Their error is for a
// subtask waiting on the queue its own parent already holds — the single most relevant
// finding in this research, and the exact hazard this module could hit: fanning a task
// across accounts while the parent is itself in flight on the only account. It is not
// implemented because detecting it requires knowing which account or queue the *host* is
// currently occupying, which is runtime knowledge (`scheduled.ts`'s claim state joined to
// `quota_state`) that a pure function over `(leaves, states, now)` cannot see. Inventing
// a heuristic here would be a guess with a confident shape, which is worse than the
// absence. The correct home is `scheduled.ts`, where a claim is already a row.
//
// **No library.** Temporal, Inngest, Trigger.dev, BullMQ and Dagster were all read before
// writing this, and none is adopted:
//
//   - Temporal and Inngest and Trigger.dev are **durable-execution runtimes**: a server,
//     a matching service, a hosted control plane, or a worker fleet. `phoenix-core` has
//     to bundle into a Cloudflare Worker with zero bindings and also run on bare Node;
//     a dependency on any of them either breaks `boundary.test.ts` or buys a distributed
//     system this gateway has no use for. Temporal additionally has no DAG at all — a
//     workflow is a sequential program whose own text order *is* the execution order, so
//     there is nothing there to topologically sort and no cycle to detect.
//   - BullMQ's `limiter` is a **rate** limit, not a concurrency limit — the maintainer
//     says so directly, and the feature that *is* a global group concurrency cap is
//     BullMQ **Pro**. Its rate-limiting lesson (signal "wait" separately from "failed")
//     is taken above; the library is not.
//   - Dagster is Python, and this engine is TypeScript that has to run unbuilt.
//
// The borrowed ideas are the ones a 300-line module can actually carry: dependency
// validation that fails closed and names the offending node (Dagster), a total-versus-
// per-key cap with consumed-not-merely-checked slots (Trigger.dev), and the separation
// of run / delay / unavailable (BullMQ's `Worker.RateLimitError`).

import { planTaskRun } from "./tasks.ts";
import type { Task, TaskPlan } from "./tasks.ts";
import type { CandidateId, PlanOptions, QuotaState, QuotaWindow } from "./quota.ts";

// ── Decomposition ─────────────────────────────────────────────────────────────

/**
 * The subset of `requested` the parent actually holds, in the parent's order.
 *
 * `requested === undefined` means "inherit", which is the common case: a split of a task
 * that could read the mail is a set of tasks that may read the mail, and narrowing is
 * opt-in because a caller should have to say so.
 *
 * Anything requested that the parent does not hold is **dropped**, not added. That is
 * the whole safety property: the returned set is a subset of `parentCapabilities`
 * always, so a leaf can never hold a capability its parent lacked. Duplicates collapse
 * because a capability is a permission, not a counter.
 */
export function narrowCapabilities(
  parentCapabilities: readonly string[],
  requested: readonly string[] | undefined
): string[] {
  if (requested === undefined) return [...new Set(parentCapabilities)];
  const held = new Set(parentCapabilities);
  return parentCapabilities.filter((cap) => held.has(cap) && requested.includes(cap));
}

/**
 * Split `total` into `parts` shares that sum to exactly `total`.
 *
 * Exactly, not approximately. A decomposition that invented capacity would let a swarm
 * claim more than the goal was ever going to spend, and one that lost capacity would
 * quietly shrink the work; the integer remainder is paid out one unit at a time to the
 * earliest leaves, which is deterministic and costs nothing. A `total` smaller than
 * `parts` yields zero shares, which is correct — a leaf that costs nothing is not a
 * contradiction.
 */
function share(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

export interface DecomposeOptions {
  /**
   * Per-leaf capability sets, positionally matched to the leaves: index `i` describes
   * leaf `i`. A leaf with no entry inherits the parent's full set. Every entry is
   * intersected with the parent's, so this can only ever *narrow*.
   */
  capabilities?: readonly (readonly string[])[];
}

/**
 * Split `task` into at most `maxSubtasks` leaf tasks.
 *
 * Four properties, each of which is a decision rather than an implementation detail:
 *
 *   - **The fan-out is bounded by the caller.** `maxSubtasks < 2` returns the task
 *     unchanged: no split happened, and inventing a child id for it would manufacture
 *     lineage that does not exist.
 *   - **Spending is conserved.** The leaves' `estimatedRequests` and `estimatedTokens`
 *     sum to the parent's exactly, so a swarm costs what its goal cost.
 *   - **Capabilities are inherited, possibly narrowed, never widened** — see
 *     `narrowCapabilities`.
 *   - **Lineage is preserved on every leaf.** `goalId` and `principalId` carry through
 *     unchanged and `parentTaskId` names the task they came from, so a leaf is traceable
 *     to its goal by one indexed scan of `task` (see `readGoalTasks`) rather than by
 *     walking the tree. The leaves carry no dependencies *among themselves*: siblings of
 *     a swarm are parallel work by definition, and inventing an edge between them would
 *     serialise the fan-out that was just asked for. A leaf **inherits the parent's
 *     own** dependencies, because the upstream work the parent was waiting for is still
 *     upstream work for anything it was split into.
 *
 * Deterministic throughout: leaf `i` is `<parent id>.<i>`, with `i` counting from zero,
 * and nothing here reads a clock, a random source, or a runtime binding.
 */
export function decompose(
  task: Task,
  maxSubtasks: number,
  options: DecomposeOptions = {}
): Task[] {
  if (maxSubtasks < 2) return [task];

  const requests = share(task.estimatedRequests, maxSubtasks);
  const tokens = share(task.estimatedTokens, maxSubtasks);

  return Array.from({ length: maxSubtasks }, (_, i) => {
    const leaf: Task = {
      ...task,
      id: `${task.id}.${i}`,
      parentTaskId: task.id,
      dependencies: [...task.dependencies],
      inputs: { ...task.inputs },
      outputs: { ...task.outputs },
      capabilities: narrowCapabilities(
        task.capabilities,
        options.capabilities?.[i]
      ),
      estimatedRequests: requests[i],
      estimatedTokens: tokens[i],
      // A child inherits the attempt history of nothing. It is new work, not a retry of
      // the parent, so carrying the parent's count forward would make a first attempt
      // look like a third.
      attempts: 0,
      executionId: null,
      scheduledAt: 0,
    };
    return leaf;
  });
}

// ── Allocation ────────────────────────────────────────────────────────────────

/** A leaf with somewhere to run. */
export interface PlacedLeaf {
  taskId: string;
  task: Task;
  candidateId: CandidateId;
  scheduledAt: number;
}

/** A leaf that can run later, with the account it is waiting for. */
export interface DelayedLeaf {
  taskId: string;
  task: Task;
  /** Epoch ms to resume at. Always set — a delay without a time is a failure. */
  resumeAt: number;
  waitingOn: CandidateId | undefined;
  rejected: TaskPlan["rejected"];
}

/** A leaf no account could ever serve, with the reason that bound it. */
export interface UnavailableLeaf {
  taskId: string;
  task: Task;
  /** The binding rejection reason, e.g. `exceeds_tokens_budget`. */
  reason: string;
  rejected: TaskPlan["rejected"];
}

/**
 * Where every leaf landed, partitioned by verdict.
 *
 * Partitioned rather than merged because the three answers oblige the caller to do
 * different things: run it, persist a resume time (`recordPlan` → `scheduled.ts`), or
 * stop and tell a human. A caller that has to re-derive the partition from the shape of
 * the fields will eventually collapse `unavailable` into `delay` and queue a task that
 * can never be placed.
 */
export interface Allocation {
  run: PlacedLeaf[];
  delay: DelayedLeaf[];
  unavailable: UnavailableLeaf[];
}

/** Stable per-account key, matching `quota.ts`'s candidate identity exactly. */
function candidateKey(candidate: CandidateId): string {
  return `${candidate.providerId} ${candidate.accountId} ${candidate.modelId}`;
}

/**
 * Fold one known placement into an account's counters.
 *
 * Mirrors `recordUsage`'s period roll exactly — a window whose period has already
 * elapsed restarts at the spend, not at the previous total — because a stale `used` here
 * would under-count the next leaf and place work the pool cannot serve. This is *not* a
 * second capacity decision: the next leaf's run/delay/unavailable verdict still comes
 * wholly from `planQuotaRun`, on a state that is now more accurate than the one it was
 * given.
 */
function advanceState(
  state: QuotaState,
  requests: number,
  tokens: number,
  now: number
): QuotaState {
  const spend = (window: QuotaWindow | null, cost: number): QuotaWindow | null => {
    if (window === null) return null;
    const rolled = window.resetAt !== 0 && now >= window.resetAt;
    return { ...window, used: (rolled ? 0 : window.used) + cost };
  };
  return {
    ...state,
    requests: spend(state.requests, requests),
    tokens: spend(state.tokens, tokens),
  };
}

/**
 * Place every leaf against the pool, in order, spending as it goes.
 *
 * Each leaf is asked about through `planTaskRun`, and only a `run` is then charged to
 * the winning account before the next leaf is asked — so the third leaf of a 4-leaf swarm
 * that the pool cannot actually serve comes back `delay` or `unavailable` rather than a
 * fourth `run` that fails at the provider. A `delay` is waiting and consumes nothing,
 * which is the Inngest rule that concurrency counts executing work and not waiting work.
 *
 * `options` is forwarded to `planTaskRun` untouched, so urgency and horizon are
 * `quota.ts`'s single pair of values rather than a second set defined here.
 *
 * Leaf order decides who wins contested capacity, and the caller controls it. Leaves are
 * returned in the order supplied for exactly that reason: a swarm whose leaves have
 * different deadlines should hand the tight ones over first, and this function has no
 * opinion about which those are.
 */
export function allocate(
  leaves: readonly Task[],
  states: readonly QuotaState[],
  now: number,
  options?: PlanOptions
): Allocation {
  const pool = new Map<string, QuotaState>();
  for (const state of states) pool.set(candidateKey(state), state);

  const allocation: Allocation = { run: [], delay: [], unavailable: [] };

  for (const task of leaves) {
    const plan = planTaskRun(task, [...pool.values()], now, options);

    if (plan.action === "run" && plan.run) {
      const key = candidateKey(plan.run);
      const chosen = pool.get(key);
      if (chosen) {
        pool.set(
          key,
          advanceState(chosen, task.estimatedRequests, task.estimatedTokens, now)
        );
      }
      allocation.run.push({
        taskId: task.id,
        task,
        candidateId: plan.run,
        scheduledAt: plan.scheduledAt,
      });
      continue;
    }

    if (plan.action === "delay") {
      allocation.delay.push({
        taskId: task.id,
        task,
        // A `delay` without a resume time is not a delay, it is a decision this module
        // failed to make. `planQuotaRun` only returns one together, so the fallback is a
        // guard against a future change rather than a path that can be taken today.
        resumeAt: plan.resumeAt ?? now,
        waitingOn: plan.run,
        rejected: plan.rejected,
      });
      continue;
    }

    allocation.unavailable.push({
      taskId: task.id,
      task,
      // Every account was rejected for this leaf, so the first reason is the binding
      // one, and the full list is carried beside it because "why was my task refused"
      // is an operator question with more than one right answer.
      reason: plan.rejected[0]?.reason ?? "no_eligible_candidate",
      rejected: plan.rejected,
    });
  }

  return allocation;
}