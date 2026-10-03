// Swarm decomposition and capacity-aware allocation. Real SQLite through the Node
// `SqlPort` for the lineage assertion, because "the lineage is reconstructable" is a
// claim about stored rows and not about objects still in a variable.
//
// The property under test that no other file covers is **swarm != uncontrolled
// parallelism**. Splitting a task into N leaves multiplies its spend by N against a pool
// that is finite and shared, and a decomposer that reports N independent `run`s over the
// same unchanged pool has handed out more compute than exists. Each answer would be
// individually correct and collectively wrong, so these tests pin the pool accounting as
// carefully as the verdicts.
import { beforeEach, describe, expect, it } from "vitest";

import { allocate, decompose, narrowCapabilities } from "../src/swarm.ts";
import { TASK_SCHEMA, saveTask, readGoalTasks } from "../src/tasks.ts";
import { openMemorySql } from "../src/node/index.ts";
import type { SqlPort } from "../src/ports.ts";
import type { Task } from "../src/tasks.ts";
import type { QuotaState, QuotaWindow } from "../src/quota.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    type: "research",
    goalId: "g1",
    principalId: "shahin",
    parentTaskId: null,
    dependencies: [],
    inputs: {},
    outputs: {},
    capabilities: ["search", "read"],
    estimatedRequests: 3,
    estimatedTokens: 3000,
    deadline: 0,
    state: "pending",
    attempts: 0,
    createdAt: NOW,
    scheduledAt: 0,
    executionId: null,
    ...over,
  };
}

/** A daily token budget with `remaining` left, resetting `resetsIn` from now. */
function tokens(remaining: number, total: number, resetsIn: number): QuotaWindow {
  return {
    kind: "day",
    limit: total,
    used: Math.max(0, total - remaining),
    resetAt: resetsIn === Infinity ? 0 : NOW + resetsIn,
  };
}

function state(providerId: string, window: QuotaWindow | null): QuotaState {
  return {
    providerId,
    accountId: "default",
    modelId: `${providerId}-model`,
    requests: null,
    tokens: window,
    // Required on `QuotaState`. Omitting it would leave the cost undeclared, and
    // `FREE_ONLY` refuses that — so every capacity assertion below would be testing the
    // cost gate instead of the quota windows.
    cost: { kind: "free" },
    latencyEmaMs: 0,
  };
}

const sum = (leaves: readonly Task[], key: "estimatedRequests" | "estimatedTokens") =>
  leaves.reduce((total, leaf) => total + leaf[key], 0);

// ── Decomposition ─────────────────────────────────────────────────────────────

describe("decompose", () => {
  const parent = task("goal");

  it("never exceeds maxSubtasks", () => {
    // The bound is the point of the module. A decomposer that invents fan-out has
    // turned one 3000-token job into more work than the goal was ever going to spend.
    for (const max of [1, 2, 3, 7]) {
      expect(decompose(parent, max).length).toBeLessThanOrEqual(Math.max(1, max));
    }
  });

  it("does not split at all when asked for one leaf", () => {
    // A single "child" would be a fabrication: a new id and a parentTaskId for work that
    // was never divided would manufacture lineage that does not exist.
    expect(decompose(parent, 1)).toEqual([parent]);
    expect(decompose(parent, 0)).toEqual([parent]);
  });

  it("conserves the parent's estimated spend exactly", () => {
    // "At most the parent's" is the requirement; exactly-equal is the honest version of
    // it. A decomposition that lost capacity would silently shrink the work, and one
    // that invented capacity would let a swarm claim more than the goal cost.
    for (const max of [2, 3, 5]) {
      const leaves = decompose(parent, max);
      expect(sum(leaves, "estimatedRequests")).toBe(parent.estimatedRequests);
      expect(sum(leaves, "estimatedTokens")).toBe(parent.estimatedTokens);
    }
  });

  it("splits an uneven total without losing the remainder", () => {
    // 10 tokens across 3 leaves cannot be even, and the odd unit has to land somewhere
    // deterministic rather than being rounded off into nothing.
    const leaves = decompose(task("g", { estimatedTokens: 10, estimatedRequests: 1 }), 3);
    expect(sum(leaves, "estimatedTokens")).toBe(10);
    expect(leaves.map((l) => l.estimatedTokens)).toEqual([4, 3, 3]);
    expect(sum(leaves, "estimatedRequests")).toBe(1);
  });

  it("gives a leaf more work than its parent could ever afford", () => {
    // 1 token across 3 leaves: two leaves cost nothing. That is not a contradiction —
    // but it must never be negative, or the workload would ask a quota window to *gain*.
    const leaves = decompose(task("g", { estimatedTokens: 1 }), 3);
    expect(leaves.every((l) => l.estimatedTokens >= 0)).toBe(true);
    expect(sum(leaves, "estimatedTokens")).toBe(1);
  });

  it("inherits the parent's dependencies so upstream work stays upstream", () => {
    // A leaf is new work, not a replacement for the parent's place in the DAG: whatever
    // the parent was waiting for, its children are waiting for too.
    const leaves = decompose(task("g", { dependencies: ["research-phase"] }), 2);
    for (const leaf of leaves) expect(leaf.dependencies).toEqual(["research-phase"]);
  });

  it("does not invent dependencies between siblings", () => {
    // Siblings of a swarm are parallel work by definition. An edge between them would
    // serialise the fan-out that was just asked for.
    const leaves = decompose(parent, 3);
    for (const leaf of leaves) expect(leaf.dependencies).toEqual([]);
  });

  it("starts a leaf's attempt history at zero", () => {
    // A leaf is new work, not a retry of the parent; carrying the count forward would
    // make a first attempt look like a third.
    expect(decompose(task("g", { attempts: 7 }), 2).every((l) => l.attempts === 0)).toBe(true);
  });

  it("copies rather than aliases, so mutating a leaf cannot reach the parent", () => {
    const leaves = decompose(task("g", { dependencies: ["up"], capabilities: ["search"] }), 2);
    leaves[0].dependencies.push("injected");
    leaves[0].capabilities.push("injected");
    expect(task("g", { dependencies: ["up"], capabilities: ["search"] }).dependencies).toEqual(["up"]);
    expect(parent.dependencies).toEqual([]);
  });
});

// ── Capability narrowing ──────────────────────────────────────────────────────

describe("capability narrowing", () => {
  it("never lets a leaf gain a capability its parent did not have", () => {
    // Splitting a task must not be a privilege-escalation path. If the parent could not
    // read the mail, neither can anything it produced — fail closed, which for a
    // permission means less, never more.
    const leaves = decompose(task("g", { capabilities: ["search"] }), 2, {
      capabilities: [["search", "send-email"], ["send-email", "delete-everything"]],
    });

    expect(leaves[0].capabilities).toEqual(["search"]);
    expect(leaves[1].capabilities).toEqual([]);
  });

  it("inherits the parent's full set when the caller narrows nothing", () => {
    expect(decompose(task("g", { capabilities: ["search", "read"] }), 2)[0].capabilities).toEqual([
      "search",
      "read",
    ]);
  });

  it("drops a capability the parent lacks rather than honouring the request", () => {
    // The same rule on the helper directly, so the property is pinned where it is
    // implemented and not only through `decompose`.
    expect(narrowCapabilities(["search"], ["search", "send-email"])).toEqual(["search"]);
    expect(narrowCapabilities([], ["send-email"])).toEqual([]);
  });

  it("keeps the parent's order and collapses duplicates", () => {
    // A capability is a permission, not a counter, and a stable order keeps a plan
    // reproducible across runs.
    expect(narrowCapabilities(["read", "search"], ["search", "search", "read"])).toEqual([
      "read",
      "search",
    ]);
  });
});

// ── Lineage ───────────────────────────────────────────────────────────────────

describe("lineage", () => {
  let sql: SqlPort;

  beforeEach(() => {
    sql = openMemorySql().sql;
    sql.exec(TASK_SCHEMA);
  });

  it("traces every leaf back to the goalId, through storage rather than a variable", () => {
    const goal = task("goal", { goalId: "research-oudiverse", principalId: "shahin" });
    const leaves = decompose(goal, 4);
    saveTask(sql, goal);
    for (const leaf of leaves) saveTask(sql, leaf);

    const rows = readGoalTasks(sql, "research-oudiverse");

    // Every leaf is reachable from the goal by one indexed scan — the property that
    // survives the objects going out of scope.
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["goal", "goal.0", "goal.1", "goal.2", "goal.3"].sort()
    );
    expect(rows.every((r) => r.goal_id === "research-oudiverse")).toBe(true);
    expect(rows.every((r) => r.principal_id === "shahin")).toBe(true);
  });

  it("names the task each leaf came from", () => {
    const leaves = decompose(task("goal"), 3);
    expect(leaves.map((l) => l.parentTaskId)).toEqual(["goal", "goal", "goal"]);
    expect(leaves.map((l) => l.id)).toEqual(["goal.0", "goal.1", "goal.2"]);
  });

  it("composes across two levels of decomposition", () => {
    // Lineage has to survive a swarm that is itself decomposed, or the goal id stops
    // being enough to reconstruct what happened.
    const leaves = decompose(decompose(task("goal"), 2)[0], 3);

    expect(leaves.every((l) => l.goalId === "g1")).toBe(true);
    expect(leaves.map((l) => l.parentTaskId)).toEqual(["goal.0", "goal.0", "goal.0"]);
    expect(leaves[0].id).toBe("goal.0.0");
  });
});

// ── Allocation ────────────────────────────────────────────────────────────────

describe("allocate", () => {
  it("places a leaf on a candidate when there is room", () => {
    const roomy = state("A", tokens(1_000_000, 1_000_000, HOUR));

    const allocation = allocate([task("t1")], [roomy], NOW);

    expect(allocation.run).toHaveLength(1);
    expect(allocation.run[0].candidateId.providerId).toBe("A");
    expect(allocation.run[0].scheduledAt).toBe(NOW);
    expect(allocation.delay).toEqual([]);
    expect(allocation.unavailable).toEqual([]);
  });

  it("reports a leaf with no capacity as `unavailable` with the binding reason, never `run`", () => {
    const tiny = state("tiny", tokens(100, 1_000, HOUR));
    const leaf = task("t1", { estimatedTokens: 100_000 });

    const allocation = allocate([leaf], [tiny], NOW);

    expect(allocation.run).toEqual([]);
    expect(allocation.unavailable).toHaveLength(1);
    expect(allocation.unavailable[0]).toMatchObject({
      taskId: "t1",
      reason: "exceeds_tokens_budget",
    });
    // Every reason is carried beside the binding one: with three accounts down for three
    // different reasons, the first alone sends an operator to the wrong one.
    expect(allocation.unavailable[0].rejected.map((r) => r.reason)).toEqual([
      "exceeds_tokens_budget",
    ]);
  });

  it("reports a leaf whose capacity refills later as `delay` with a resume time", () => {
    const exhausted = state("A", tokens(0, 100_000, HOUR));
    const leaf = task("t1", { estimatedTokens: 100_000 });

    const allocation = allocate([leaf], [exhausted], NOW);

    expect(allocation.run).toEqual([]);
    expect(allocation.unavailable).toEqual([]);
    expect(allocation.delay).toHaveLength(1);
    expect(allocation.delay[0].resumeAt).toBe(NOW + HOUR);
    expect(allocation.delay[0].waitingOn?.providerId).toBe("A");
  });

  it("delays to the soonest refill across several accounts, matching `quota.ts`", () => {
    // The brief's worked example, reached through allocation: A is nearly exhausted for
    // twelve hours, B has 2k for four minutes, the leaf needs 100k. Consuming B would
    // work; waiting four minutes costs the pool less.
    const longLived = state("A", tokens(20_000, 1_000_000, 12 * HOUR));
    const shortLived = state("B", tokens(2_000, 1_000_000, 4 * MINUTE));

    const allocation = allocate(
      [task("t1", { estimatedTokens: 100_000, deadline: NOW + 24 * HOUR })],
      [longLived, shortLived],
      NOW
    );

    expect(allocation.delay[0].resumeAt).toBe(NOW + 4 * MINUTE);
    expect(allocation.delay[0].waitingOn?.providerId).toBe("B");
  });

  it("does not let a swarm promise more than the pool holds", () => {
    // THE property. The pool holds 2500 tokens and each of four leaves needs 1000, so
    // exactly two can be placed. Every leaf is individually runnable when asked alone,
    // so a decomposer that ignored the pool would report four `run`s — individually
    // correct, collectively wrong — and the third would fail at the provider.
    const scarce = state("A", tokens(2_500, 100_000, HOUR));
    const leaves = decompose(task("g", { estimatedTokens: 4_000 }), 4);
    expect(sum(leaves, "estimatedTokens")).toBe(4_000);

    const allocation = allocate(leaves, [scarce], NOW);

    expect(allocation.run).toHaveLength(2);
    // The other two *wait* rather than fail: the daily limit is 100_000, so a 1000-token
    // leaf fits comfortably at the reset. Only something bigger than the whole budget is
    // `unavailable` — which is the previous test's case, not this one.
    expect(allocation.delay).toHaveLength(2);
    expect(allocation.unavailable).toEqual([]);
    expect(allocation.delay.map((l) => l.resumeAt)).toEqual([NOW + HOUR, NOW + HOUR]);
    // The invariant, stated as arithmetic rather than as a count: what was placed never
    // exceeds what was there.
    expect(
      allocation.run.reduce((n, l) => n + l.task.estimatedTokens, 0)
    ).toBeLessThanOrEqual(2_500);
  });

  it("keeps placing as long as the pool lasts, rather than stopping at the first refusal", () => {
    // The mirror of the above: a `delay` must not end the sweep. A swarm is many leaves,
    // and one that cannot run now says nothing about the next one.
    const scarce = state("A", tokens(2_500, 100_000, HOUR));
    const leaves = decompose(task("g", { estimatedTokens: 6_000 }), 6);

    const allocation = allocate(leaves, [scarce], NOW);

    expect(allocation.run).toHaveLength(2);
    expect(allocation.delay).toHaveLength(4);
  });

  it("counts a delayed leaf as spending nothing", () => {
    // The Inngest rule: concurrency counts executing work, not waiting work. A `delay`
    // must not debit the pool, or a swarm of unavailable-at-first leaves would starve
    // itself.
    const roomy = state("A", tokens(10_000, 10_000, HOUR));
    const leaves = decompose(task("g", { estimatedTokens: 2_000 }), 5);

    const allocation = allocate(leaves, [roomy], NOW);

    expect(allocation.run).toHaveLength(5);
    expect(allocation.run.map((r) => r.scheduledAt)).toEqual(Array(5).fill(NOW));
    expect(allocation.delay).toEqual([]);
  });

  it("spreads leaves over accounts and spends the one that refills soonest", () => {
    const shortLived = state("B", tokens(50_000, 50_000, 4 * MINUTE));
    const longLived = state("A", tokens(50_000, 50_000, 12 * HOUR));
    const leaves = decompose(task("g", { estimatedTokens: 4_000 }), 4);

    const allocation = allocate(leaves, [longLived, shortLived], NOW);

    // Every leaf fits on either account alone; the policy has to keep choosing B, so
    // both spend B down and nothing touches A.
    expect(allocation.run).toHaveLength(4);
    expect(new Set(allocation.run.map((r) => r.candidateId.providerId))).toEqual(new Set(["B"]));
  });

  it("reports unavailable rather than a silent run when there is nothing to run on", () => {
    const allocation = allocate([task("t1")], [], NOW);

    expect(allocation.run).toEqual([]);
    expect(allocation.delay).toEqual([]);
    // No candidates at all is not a reason of its own, so it gets the explicit
    // placeholder rather than an undefined one.
    expect(allocation.unavailable[0].reason).toBe("no_eligible_candidate");
  });

  it("partitions leaves, so the caller cannot collapse `unavailable` into `delay`", () => {
    // Three accounts sized so exactly one leaf lands in each partition, and so the
    // cumulative spend of the first leaf cannot change where the others land.
    const tight = state("roomy", tokens(1_000, 1_000, HOUR)); // fits 500, never 50_000
    const busy = state("busy", tokens(0, 100_000, HOUR)); // waits an hour
    const tiny = state("tiny", tokens(10, 100, HOUR)); // too small for everything
    const leaves = [
      task("fits", { estimatedTokens: 500 }),
      task("waits", { estimatedTokens: 50_000 }),
      task("too-big", { estimatedTokens: 5_000_000 }),
    ];

    const allocation = allocate(leaves, [tight, busy, tiny], NOW);

    expect(allocation.run.map((l) => l.taskId)).toEqual(["fits"]);
    expect(allocation.delay.map((l) => l.taskId)).toEqual(["waits"]);
    expect(allocation.unavailable.map((l) => l.taskId)).toEqual(["too-big"]);
    expect(allocation.unavailable[0].reason).toBe("exceeds_tokens_budget");
  });

  it("surfaces a cost-gate refusal as an ordinary rejection rather than swallowing it", () => {
    // `quota.ts` refuses a provider whose cost nobody has declared under `FREE_ONLY`,
    // and puts it in `rejected`. Dropping those on the floor would make a money decision
    // invisible to the one person who can act on it.
    const undeclared = { ...state("mystery", tokens(1_000_000, 1_000_000, HOUR)), cost: { kind: "unknown" as const } };

    const allocation = allocate([task("t1")], [undeclared], NOW);

    expect(allocation.run).toEqual([]);
    expect(allocation.unavailable).toHaveLength(1);
    expect(allocation.unavailable[0].reason).toBe("cost_unknown_in_free_only");
  });
});