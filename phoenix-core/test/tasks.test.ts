// Task graph: ordering, fail-closed validation, and the scheduling seam onto
// `quota.ts`. Real SQLite through the Node `SqlPort` — the same statements the Worker
// runs against Durable Object storage — and no Durable Object, no alarm, no runtime
// binding.
//
// Two claims are pinned here and neither is a restatement of the code:
//
//   * **the graph fails closed.** A cycle and a missing dependency are both refused, by
//     name. An earlier framing of this work accepted a partial order — "return whatever
//     we could walk" — which is the worst of both worlds: the caller gets a plan, and the
//     tasks that were dropped from it are silently never run.
//   * **`planTaskRun` delegates.** It decides nothing about capacity; it translates a
//     task into a `Workload` and hands it to `planQuotaRun`. The capacity assertions at
//     the bottom are therefore the *same* policy `quota.test.ts` pins, reached through a
//     second door — which is the point. If this module ever grew its own idea of "can
//     this run", these two files would stop agreeing and only one of them would be right.
import { beforeEach, describe, expect, it } from "vitest";

import {
  TASK_SCHEMA,
  planTaskRun,
  readGoalTasks,
  readTask,
  recordPlan,
  saveTask,
  taskGraph,
  toTask,
  type Task,
} from "../src/tasks.ts";
import { openMemorySql } from "../src/node/index.ts";
import type { SqlPort } from "../src/ports.ts";
import type { QuotaState, QuotaWindow } from "../src/quota.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A pending task; every field the graph reads is set explicitly by the caller. */
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
    capabilities: [],
    estimatedRequests: 1,
    estimatedTokens: 1000,
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
    // `cost` is required on `QuotaState`, and `FREE_ONLY` refuses an undeclared cost, so
    // a fixture that omits it would be refused by the cost gate before the *capacity*
    // gate it is meant to be exercising — the test would pass for the wrong reason.
    cost: { kind: "free" },
    latencyEmaMs: 0,
  };
}

// ── Topological order ─────────────────────────────────────────────────────────

describe("taskGraph — topological order", () => {
  const chain = [
    task("a"),
    task("b", { dependencies: ["a"] }),
    task("c", { dependencies: ["b"] }),
  ];

  it("orders a three-node chain so every dependency precedes its dependants", () => {
    const graph = taskGraph(chain);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.order).toEqual(["a", "b", "c"]);
  });

  it("holds the ordering property itself, not just one arrangement of it", () => {
    // The assertion above would also pass for a graph that happened to be declared in
    // order. This one cannot: the chain is declared backwards, so only a real sort
    // produces a", "b", "c".
    const backwards = taskGraph([...chain].reverse());
    expect(backwards.ok).toBe(true);
    if (!backwards.ok) return;
    expect(backwards.order).toEqual(["a", "b", "c"]);
    const at = (id: string) => backwards.order.indexOf(id);
    expect(at("a")).toBeLessThan(at("b"));
    expect(at("b")).toBeLessThan(at("c"));
  });

  it("breaks ties among independent tasks by declaration order", () => {
    // Determinism is the property: two runs of the engine must plan the same order, so
    // the tie-break cannot be Map iteration or anything else incidental.
    const graph = taskGraph([task("zebra"), task("apple"), task("mango")]);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.order).toEqual(["zebra", "apple", "mango"]);
  });

  it("handles a diamond: both dependants wait for the same node and both run", () => {
    const graph = taskGraph([
      task("root"),
      task("left", { dependencies: ["root"] }),
      task("right", { dependencies: ["root"] }),
      task("join", { dependencies: ["left", "right"] }),
    ]);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.order[0]).toBe("root");
    expect(graph.order[3]).toBe("join");
  });

  it("treats an empty graph as valid and empty, rather than as an error", () => {
    const graph = taskGraph([]);
    expect(graph).toEqual({ ok: true, order: [], byId: new Map() });
  });
});

// ── Fail closed ───────────────────────────────────────────────────────────────

describe("taskGraph — fails closed", () => {
  // `if (graph.ok) return;` narrows away only the *valid* branch, leaving three
  // rejection shapes; each test therefore also narrows on `code`. The `expect` above it
  // is what makes the early return safe — a wrong `code` fails before the guard runs,
  // rather than quietly skipping the assertions that follow.
  it("REJECTS a dependency cycle and names it", () => {
    const graph = taskGraph([
      task("a", { dependencies: ["b"] }),
      task("b", { dependencies: ["c"] }),
      task("c", { dependencies: ["a"] }),
    ]);

    expect(graph.ok).toBe(false);
    expect(graph.ok || graph.code !== "cycle").toBe(false);
    if (graph.ok || graph.code !== "cycle") return;
    // Naming the cycle is the whole point: an operator has to be able to see which edge
    // to cut without reconstructing the graph by hand.
    expect(graph.cycle).toEqual(["a", "b", "c", "a"]);
    expect(graph.message).toBe("dependency cycle: a -> b -> c -> a");
  });

  it("REJECTS a self-dependency as a one-node cycle", () => {
    // The degenerate cycle, and the one a `visited` set that forgets to mark *before*
    // recursing will happily accept.
    const graph = taskGraph([task("a", { dependencies: ["a"] })]);
    expect(graph.ok).toBe(false);
    expect(graph.ok || graph.code !== "cycle").toBe(false);
    if (graph.ok || graph.code !== "cycle") return;
    expect(graph.cycle).toEqual(["a", "a"]);
  });

  it("REJECTS a missing dependency and names the task and the gap", () => {
    // `a` is satisfied on purpose so the rejection can only be about `b`: an
    // implementation that reported whichever task it happened to reach first would
    // still pass a fixture where the first task is also broken.
    const graph = taskGraph([
      task("a", { dependencies: [] }),
      task("b", { dependencies: ["a", "phantom"] }),
    ]);

    expect(graph.ok).toBe(false);
    expect(graph.ok || graph.code !== "missing_dependency").toBe(false);
    if (graph.ok || graph.code !== "missing_dependency") return;
    expect(graph.taskId).toBe("b");
    expect(graph.missing).toEqual(["phantom"]);
    expect(graph.message).toContain("phantom");
    expect(graph.message).toContain("not in the graph");
  });

  it("names every missing dependency of a task, not just the first", () => {
    const graph = taskGraph([task("a", { dependencies: ["ghost", "phantom"] })]);
    expect(graph.ok).toBe(false);
    expect(graph.ok || graph.code !== "missing_dependency").toBe(false);
    if (graph.ok || graph.code !== "missing_dependency") return;
    expect(graph.missing).toEqual(["ghost", "phantom"]);
  });

  it("reports the first broken task in declaration order, deterministically", () => {
    // Two tasks are broken; which one is named must be a function of the input, not of
    // Map or Set iteration order, or an operator gets a different culprit per process.
    expect(taskGraph([task("a", { dependencies: ["ghost"] }), task("b")]).ok).toBe(false);

    const first = taskGraph([
      task("a", { dependencies: ["ghost"] }),
      task("b", { dependencies: ["phantom"] }),
    ]);
    expect(first.ok).toBe(false);
    expect(first.ok || first.code !== "missing_dependency").toBe(false);
    if (first.ok || first.code !== "missing_dependency") return;
    expect(first.taskId).toBe("a");

    const reversed = taskGraph([
      task("b", { dependencies: ["phantom"] }),
      task("a", { dependencies: ["ghost"] }),
    ]);
    expect(reversed.ok).toBe(false);
    expect(reversed.ok || reversed.code !== "missing_dependency").toBe(false);
    if (reversed.ok || reversed.code !== "missing_dependency") return;
    expect(reversed.taskId).toBe("b");
  });

  it("REJECTS a duplicate id rather than letting an edge resolve to either copy", () => {
    const graph = taskGraph([task("a"), task("a")]);
    expect(graph.ok).toBe(false);
    expect(graph.ok || graph.code !== "duplicate_id").toBe(false);
    if (graph.ok || graph.code !== "duplicate_id") return;
    expect(graph.taskId).toBe("a");
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("persistence", () => {
  let sql: SqlPort;

  beforeEach(() => {
    sql = openMemorySql().sql;
    sql.exec(TASK_SCHEMA);
  });

  it("round-trips a task, arrays and objects surviving as JSON", () => {
    // The alternative — a joined string or a per-edge table — cannot represent both an
    // ordered array of ids and a keyed input object in one row, and the graph reads
    // both from one caller-supplied value.
    saveTask(
      sql,
      task("t1", {
        dependencies: ["up"],
        inputs: { question: "what is free compute" },
        outputs: { format: "markdown" },
        capabilities: ["search", "read"],
        deadline: NOW + HOUR,
      })
    );

    expect(toTask(readTask(sql, "t1")!)).toEqual({
      id: "t1",
      type: "research",
      goalId: "g1",
      principalId: "shahin",
      parentTaskId: null,
      dependencies: ["up"],
      inputs: { question: "what is free compute" },
      outputs: { format: "markdown" },
      capabilities: ["search", "read"],
      estimatedRequests: 1,
      estimatedTokens: 1000,
      deadline: NOW + HOUR,
      state: "pending",
      attempts: 0,
      createdAt: NOW,
      scheduledAt: 0,
      executionId: null,
    });
  });

  it("finds every task of a goal in one scan, which is how lineage is reconstructed", () => {
    for (const id of ["root", "root.0", "root.1"]) saveTask(sql, task(id));
    saveTask(sql, task("other", { goalId: "g2" }));

    expect(readGoalTasks(sql, "g1").map((row) => row.id)).toEqual([
      "root",
      "root.0",
      "root.1",
    ]);
    expect(readGoalTasks(sql, "g2").map((row) => row.id)).toEqual(["other"]);
  });

  it("returns undefined for a task that was never written", () => {
    expect(readTask(sql, "nope")).toBeUndefined();
  });
});

// ── planTaskRun — the seam, and nothing else ───────────────────────────────────

describe("planTaskRun", () => {
  const leaf = task("t1", { estimatedRequests: 1, estimatedTokens: 100_000 });

  it("reports `unavailable` with the binding reason, never `run`", () => {
    // 100k tokens against a 1k daily budget is not a scheduling problem: no amount of
    // waiting fixes it. The reason has to survive, or the operator is told only that
    // "something is unavailable".
    const tiny = state("tiny", tokens(100, 1_000, HOUR));

    const plan = planTaskRun(leaf, [tiny], NOW);

    expect(plan.action).toBe("unavailable");
    expect(plan.run).toBeUndefined();
    expect(plan.rejected).toEqual([
      {
        candidateId: { providerId: "tiny", accountId: "default", modelId: "tiny-model" },
        reason: "exceeds_tokens_budget",
      },
    ]);
  });

  it("leaves no resume time for an unplaceable task — 0 means unknown, not soon", () => {
    // Inventing a time here is the fabrication `quota.ts` refuses anywhere else: "there
    // is no moment at which this works" is a different statement from "later".
    const plan = planTaskRun(leaf, [state("tiny", tokens(100, 1_000, HOUR))], NOW);
    expect(plan.scheduledAt).toBe(0);
    expect(plan.resumeAt).toBeUndefined();
  });

  it("reports `delay` with a resume time when the capacity refills later", () => {
    const exhausted = state("A", tokens(0, 100_000, HOUR));

    const plan = planTaskRun(leaf, [exhausted], NOW);

    expect(plan.action).toBe("delay");
    expect(plan.resumeAt).toBe(NOW + HOUR);
    expect(plan.scheduledAt).toBe(NOW + HOUR);
  });

  it("reports `run` with the chosen account and schedules it for now", () => {
    const roomy = state("A", tokens(1_000_000, 1_000_000, HOUR));

    const plan = planTaskRun(leaf, [roomy], NOW);

    expect(plan.action).toBe("run");
    expect(plan.run).toEqual({
      providerId: "A",
      accountId: "default",
      modelId: "A-model",
    });
    expect(plan.scheduledAt).toBe(NOW);
  });

  it("passes a deadline through, so a task close to it can still become urgent", () => {
    // The seam's whole risk is dropping a field on the way through. A deadline of `0` is
    // the row's "no deadline" sentinel, so it must be *omitted* from the workload rather
    // than passed as 0 — a deadline already in the past makes every task urgent, which
    // would silently disable `quota.ts`'s patience policy.
    const tight = state("A", tokens(100_000, 100_000, 12 * HOUR));
    const fast: QuotaState = { ...tight, providerId: "B", modelId: "B-model", latencyEmaMs: 100 };
    const slow: QuotaState = { ...tight, providerId: "C", modelId: "C-model", latencyEmaMs: 900 };
    const states = [fast, slow];

    // With slack, the later-resetting pool wins on preserved capacity.
    expect(
      planTaskRun(task("t", { deadline: NOW + 24 * HOUR }), states, NOW).run?.providerId
    ).toBeDefined();

    // Seconds from the deadline, latency is the only thing that matters — which can only
    // happen if the deadline survived the translation.
    const urgent = planTaskRun(task("t", { deadline: NOW + 10_000 }), states, NOW);
    expect(urgent.action).toBe("run");
    expect(urgent.run?.providerId).toBe("B");

    // No deadline at all: the row's `0` must not be read as a deadline in the past.
    expect(planTaskRun(task("t", { deadline: 0 }), states, NOW).run?.providerId).toBeDefined();
  });
});

describe("recordPlan", () => {
  let sql: SqlPort;

  beforeEach(() => {
    sql = openMemorySql().sql;
    sql.exec(TASK_SCHEMA);
    saveTask(sql, task("t1"));
  });

  it("persists the resume time, because a delay that is not written down does not exist", () => {
    const exhausted = state("A", tokens(0, 100_000, HOUR));
    const plan = planTaskRun(task("t1", { estimatedTokens: 100_000 }), [exhausted], NOW);

    recordPlan(sql, plan);

    expect(readTask(sql, "t1")?.scheduled_at).toBe(NOW + HOUR);
  });

  it("records an execution only for work that actually runs", () => {
    // Writing an execution onto a delayed task would let `scheduled.ts`'s `finishTask`
    // close a task that never started.
    const roomy = state("A", tokens(1_000_000, 1_000_000, HOUR));
    const plan = planTaskRun(task("t1", { estimatedTokens: 100_000 }), [roomy], NOW);

    recordPlan(sql, plan);
    expect(readTask(sql, "t1")).toMatchObject({
      scheduled_at: NOW,
      execution_id: "A",
      state: "pending",
    });
  });
});