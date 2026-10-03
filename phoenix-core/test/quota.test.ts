// Capacity tests. No network, no Durable Object, no runtime bindings: every function
// under test is pure over `(state, workload, now)`, and the statements run against
// real SQLite through the Node `SqlPort` — the same code the Worker runs against
// Durable Object storage.
//
// These exist because the policy they pin is the one the brief calls the core
// differentiator, and because "it looked right in review" is exactly how the Go
// ledger's daily cap shipped with no reset horizon and no caller at all.
import { beforeEach, describe, expect, it } from "vitest";

import {
  QUOTA_SCHEMA,
  capacityFor,
  declareQuota,
  nextLatencyEma,
  planQuotaRun,
  postSpendValue,
  readAllQuota,
  readQuota,
  recordUsage,
  toQuotaState,
  totalRemaining,
  windowCanEverFit,
  windowReadyAt,
  windowRemaining,
  type QuotaState,
  type QuotaWindow,
} from "../src/quota.ts";
import { openMemorySql } from "../src/node/index.ts";
import type { SqlPort } from "../src/ports.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A daily token budget with `remaining` left, resetting `resetsIn` from now. */
function tokens(remaining: number, total: number, resetsIn: number): QuotaWindow {
  return {
    kind: "day",
    limit: total,
    used: Math.max(0, total - remaining),
    resetAt: resetsIn === Infinity ? 0 : NOW + resetsIn,
  };
}

function state(
  providerId: string,
  accountId: string,
  windows: { requests?: QuotaWindow | null; tokens?: QuotaWindow | null } = {},
  latencyEmaMs = 0
): QuotaState {
  return {
    providerId,
    accountId,
    modelId: `${providerId}-model`,
    requests: windows.requests ?? null,
    tokens: windows.tokens ?? null,
    latencyEmaMs,
  };
}

describe("window arithmetic", () => {
  it("treats an unpublished limit as unconstrained, not as zero", () => {
    // The decision that keeps the scheduler honest: a provider that does not publish
    // a limit has not told us there is one. Reading it as zero would refuse work.
    expect(windowRemaining({ kind: "day", limit: 0, used: 0, resetAt: 0 }, NOW)).toBe(
      Number.POSITIVE_INFINITY
    );
    expect(windowCanEverFit({ kind: "day", limit: 0, used: 0, resetAt: 0 }, 1e9)).toBe(true);
  });

  it("subtracts usage while the period is open", () => {
    expect(windowRemaining(tokens(2_000, 14_400, HOUR), NOW)).toBe(2_000);
  });

  it("reads a closed period as a fresh one — this is the reset horizon", () => {
    // 1.8M seconds after NOW the daily window has rolled: `used` described the day
    // that just ended, so the answer is the full budget again, not zero forever.
    const rolled = tokens(0, 14_400, HOUR);
    expect(windowRemaining(rolled, NOW + HOUR)).toBe(14_400);
  });

  it("knows a cost larger than the whole budget can never fit", () => {
    expect(windowCanEverFit(tokens(0, 14_400, HOUR), 100_000)).toBe(false);
    expect(windowReadyAt(tokens(0, 14_400, HOUR), 100_000, NOW)).toBeNull();
  });

  it("will not invent a reset time it was not given", () => {
    // Short now, no known reset: waiting is not something this window can promise.
    const blind = { kind: "day" as const, limit: 100, used: 100, resetAt: 0 };
    expect(windowReadyAt(blind, 50, NOW)).toBeNull();
  });
});

describe("capacityFor", () => {
  it("reports ready when both budgets can cover the work", () => {
    const s = state("a", "default", { tokens: tokens(50_000, 100_000, HOUR) });
    expect(capacityFor(s, { requests: 1, tokens: 10_000 }, NOW)).toEqual({
      kind: "ready",
    });
  });

  it("waits for the *later* of two budgets, not the earlier", () => {
    // Requests free up in a minute, tokens in an hour. Resuming at the minute mark
    // would walk straight back into the token constraint — which is the bug this
    // ordering exists to prevent.
    const s = state("a", "default", {
      requests: { kind: "minute", limit: 60, used: 60, resetAt: NOW + MINUTE },
      tokens: { kind: "day", limit: 100_000, used: 100_000, resetAt: NOW + HOUR },
    });
    expect(capacityFor(s, { requests: 1, tokens: 1 }, NOW)).toEqual({
      kind: "wait",
      until: NOW + HOUR,
      binding: "tokens",
    });
  });

  it("distinguishes a busy account from a too-small one", () => {
    const tooSmall = state("a", "default", { tokens: tokens(0, 1_000, HOUR) });
    expect(capacityFor(tooSmall, { requests: 1, tokens: 100_000 }, NOW)).toEqual({
      kind: "impossible",
      binding: "tokens",
    });

    const busy = state("b", "default", { tokens: tokens(0, 500_000, 4 * MINUTE) });
    expect(capacityFor(busy, { requests: 1, tokens: 100_000 }, NOW)).toEqual({
      kind: "wait",
      until: NOW + 4 * MINUTE,
      binding: "tokens",
    });
  });
});

describe("planQuotaRun — the worked example", () => {
  // The brief's scenario, verbatim, as an executable specification:
  //   Provider A: remaining 20k, reset in 12h
  //   Provider B: remaining 2k,  reset in 4 minutes
  //   Task:      100k tokens, deadline 24h
  //   Decision:  WAIT → B resets → consume B
  const a = state("A", "default", { tokens: tokens(20_000, 1_000_000, 12 * HOUR) });
  const b = state("B", "default", { tokens: tokens(2_000, 1_000_000, 4 * MINUTE) });
  const workload = { requests: 1, tokens: 100_000, deadline: NOW + 24 * HOUR };

  it("delays to the soonest reset instead of burning the larger, longer-lived pool", () => {
    const plan = planQuotaRun([a, b], workload, NOW);

    expect(plan.action).toBe("delay");
    expect(plan.resumeAt).toBe(NOW + 4 * MINUTE);
    expect(plan.run).toEqual({
      providerId: "B",
      accountId: "default",
      modelId: "B-model",
    });
  });

  it("can then place the task on B once B has reset", () => {
    const afterReset = state("B", "default", {
      tokens: tokens(1_000_000, 1_000_000, 5 * HOUR),
    });
    const plan = planQuotaRun([a, afterReset], workload, NOW + 5 * MINUTE);

    expect(plan.action).toBe("run");
    expect(plan.run?.providerId).toBe("B");
  });
});

describe("planQuotaRun — capacity preservation", () => {
  const workload = { requests: 1, tokens: 10_000 };

  it("spends the account that refills soonest, because that is the cheapest", () => {
    // Both can serve the task, but they are not equally worth consuming. A is nearly
    // exhausted and stays that way for twelve hours; B has room to spare and refills
    // in four minutes. Spending B costs the pool a four-minute dip and leaves A's last
    // 20k intact for the rest of the day. "Use the biggest pile" would pick B here by
    // luck, not by reasoning — and would pick A in the next test.
    const longLived = state("A", "default", {
      tokens: { kind: "day", limit: 1_000_000, used: 980_000, resetAt: NOW + 12 * HOUR },
    });
    const shortLived = state("B", "default", {
      tokens: { kind: "day", limit: 1_000_000, used: 10_000, resetAt: NOW + 4 * MINUTE },
    });

    const plan = planQuotaRun([longLived, shortLived], workload, NOW);
    expect(plan.action).toBe("run");
    expect(plan.run?.providerId).toBe("B");
    expect(plan.rejected).toEqual([
      {
        candidateId: {
          providerId: "A",
          accountId: "default",
          modelId: "A-model",
        },
        reason: "leaves_more_capacity",
      },
    ]);
  });

  it("prefers the sooner refill even when it has *less* remaining", () => {
    // The case that "use the biggest pile" gets wrong. A has more than twice B's
    // capacity, but A is stuck at that level for twelve hours while B is whole again
    // in four minutes. Consuming B leaves the pool far healthier afterwards, so B is
    // the right answer even though it is the smaller pile.
    const plentifulButStuck = state("A", "default", {
      tokens: { kind: "day", limit: 100_000, used: 30_000, resetAt: NOW + 12 * HOUR },
    });
    const leanButSoon = state("B", "default", {
      tokens: { kind: "day", limit: 100_000, used: 70_000, resetAt: NOW + 4 * MINUTE },
    });

    expect(totalRemaining(plentifulButStuck, NOW)).toBeGreaterThan(
      totalRemaining(leanButSoon, NOW)
    );

    const plan = planQuotaRun([plentifulButStuck, leanButSoon], workload, NOW);
    expect(plan.run?.providerId).toBe("B");
  });

  it("spends the roomier account when both refill at the same time", () => {
    // No time asymmetry, so the only thing that matters is what is left afterwards.
    const scarce = state("A", "default", {
      tokens: { kind: "day", limit: 100_000, used: 99_000, resetAt: NOW + 12 * HOUR },
    });
    const abundant = state("B", "default", {
      tokens: { kind: "day", limit: 100_000, used: 1_000, resetAt: NOW + 12 * HOUR },
    });

    const plan = planQuotaRun([scarce, abundant], workload, NOW);
    expect(plan.run?.providerId).toBe("B");
  });

  it("switches objective once the task is about to miss its deadline", () => {
    // Slack means "optimise the pool". Urgency means "optimise me" — so the account
    // with the better measured latency wins even though it leaves less behind.
    // A has exactly enough for the job, so it is a real candidate, not a rejected one.
    const fast = state("A", "default", {
      tokens: { kind: "day", limit: 100_000, used: 90_000, resetAt: NOW + 12 * HOUR },
    }, 120);
    const slowButRoomy = state("B", "default", {
      tokens: { kind: "day", limit: 1_000_000, used: 10_000, resetAt: NOW + 12 * HOUR },
    }, 900);

    // With slack, the roomy account wins: preserving B's 980k beats B's latency.
    expect(
      planQuotaRun([fast, slowButRoomy], workload, NOW).run?.providerId
    ).toBe("B");

    // Ten seconds from the deadline, latency is the only thing that matters.
    const urgent = planQuotaRun(
      [fast, slowButRoomy],
      { ...workload, deadline: NOW + 10_000 },
      NOW
    );
    expect(urgent.action).toBe("run");
    expect(urgent.run?.providerId).toBe("A");
    expect(urgent.rejected).toEqual([
      {
        candidateId: {
          providerId: "B",
          accountId: "default",
          modelId: "B-model",
        },
        reason: "slower_or_smaller",
      },
    ]);
  });

  it("does not treat an unmeasured account as the fastest one", () => {
    // Absence of measurement is not evidence of speed; otherwise a freshly-declared
    // account wins every urgent task forever.
    const unmeasured = state("A", "default", {
      tokens: { kind: "day", limit: 100_000, used: 1_000, resetAt: NOW + 12 * HOUR },
    }, 0);
    const measured = state("B", "default", {
      tokens: { kind: "day", limit: 100_000, used: 1_000, resetAt: NOW + 12 * HOUR },
    }, 800);

    const plan = planQuotaRun(
      [unmeasured, measured],
      { ...workload, deadline: NOW },
      NOW
    );
    expect(plan.run?.providerId).toBe("B");
  });

  it("rejects a too-small account rather than queueing on it forever", () => {
    const tiny = state("tiny", "default", { tokens: tokens(100, 1_000, HOUR) });
    const plan = planQuotaRun([tiny], workload, NOW);

    expect(plan.action).toBe("unavailable");
    expect(plan.rejected).toEqual([
      {
        candidateId: {
          providerId: "tiny",
          accountId: "default",
          modelId: "tiny-model",
        },
        reason: "exceeds_tokens_budget",
      },
    ]);
  });

  it("reports unavailable, not a silent run, when there is nothing to run on", () => {
    expect(planQuotaRun([], workload, NOW)).toEqual({
      action: "unavailable",
      rejected: [],
    });
  });
});

describe("postSpendValue", () => {
  it("rates a soon-refilling account's capacity as nearly free to consume", () => {
    // High value means "cheap to spend". Capacity that refills in a minute is worth
    // holding almost as much after the job as before it, because a minute later it is
    // whole again. Capacity that does not refill for twelve hours is the only thing
    // the pool has for twelve hours, so consuming any of it is expensive — hence the
    // small number, not the large one.
    const aboutToExpire = state("b", "default", {
      tokens: { kind: "day", limit: 100_000, used: 50_000, resetAt: NOW + MINUTE },
    });
    const lastsAllDay = state("a", "default", {
      tokens: { kind: "day", limit: 100_000, used: 50_000, resetAt: NOW + 12 * HOUR },
    });
    const nothing = { requests: 1, tokens: 0 };

    expect(postSpendValue(aboutToExpire, nothing, NOW, HOUR)).toBeGreaterThan(
      50 * postSpendValue(lastsAllDay, nothing, NOW, HOUR)
    );
  });

  it("drops to zero once the spend exhausts what is left", () => {
    const account = state("a", "default", {
      tokens: { kind: "day", limit: 100_000, used: 95_000, resetAt: NOW + 12 * HOUR },
    });
    // Serving this costs everything remaining, so nothing is left for tomorrow.
    expect(postSpendValue(account, { requests: 1, tokens: 5_000 }, NOW, HOUR)).toBe(0);
  });
});

describe("latency", () => {
  it("seeds the average on the first sample instead of decaying from zero", () => {
    expect(nextLatencyEma(0, 500)).toBe(500);
  });

  it("uses the Go registry's 0.7/0.3 smoothing so both runtimes agree", () => {
    expect(nextLatencyEma(100, 200)).toBeCloseTo(0.7 * 100 + 0.3 * 200, 6);
  });
});

describe("persistence", () => {
  let sql: SqlPort;

  beforeEach(() => {
    sql = openMemorySql().sql;
    sql.exec(QUOTA_SCHEMA);
  });

  const groq: QuotaState = {
    providerId: "shahin",
    accountId: "default",
    modelId: "llama-3.3-70b-versatile",
    requests: { kind: "day", limit: 14_400, used: 0, resetAt: NOW + HOUR },
    tokens: { kind: "day", limit: 1_000_000, used: 0, resetAt: NOW + HOUR },
    latencyEmaMs: 0,
  };

  it("round-trips a declared account", () => {
    declareQuota(sql, groq);
    expect(readQuota(sql, groq)).toMatchObject({
      provider_id: "shahin",
      account_id: "default",
      req_limit: 14_400,
      tok_limit: 1_000_000,
    });
  });

  it("keeps three accounts of one provider as three rows — the compute pool", () => {
    // §13: the account is a schema fact, not a naming convention. Nothing in this
    // table knows or cares that these share a vendor.
    for (const accountId of ["work", "personal", "backup"]) {
      declareQuota(sql, { ...groq, accountId });
    }
    const rows = readAllQuota(sql);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.account_id).sort()).toEqual([
      "backup",
      "personal",
      "work",
    ]);
  });

  it("accumulates usage and latency", () => {
    declareQuota(sql, groq);
    recordUsage(sql, groq, { requests: 1, tokens: 500 }, 200, NOW);
    recordUsage(sql, groq, { requests: 1, tokens: 500 }, 400, NOW + 1_000);

    const row = readQuota(sql, groq);
    expect(row?.req_used).toBe(2);
    expect(row?.tok_used).toBe(1_000);
    expect(row?.last_latency_ms).toBe(400);
    expect(row?.latency_ema_ms).toBeCloseTo(nextLatencyEma(200, 400), 6);
  });

  it("starts a new period on the first request after a reset", () => {
    // The defect the Go ledger has today: `Remaining` is `cap - used-since-boot`, so
    // a "daily" budget never comes back. Here the roll is explicit and persisted.
    declareQuota(sql, groq);
    recordUsage(sql, groq, { requests: 1, tokens: 900_000 }, 200, NOW);
    expect(readQuota(sql, groq)?.tok_used).toBe(900_000);

    recordUsage(sql, groq, { requests: 1, tokens: 10 }, 200, NOW + 2 * HOUR);
    expect(readQuota(sql, groq)?.tok_used).toBe(10);
    expect(readQuota(sql, groq)?.req_used).toBe(1);
  });

  it("ignores usage for an account that was never declared", () => {
    expect(() =>
      recordUsage(sql, { ...groq, accountId: "ghost" }, { tokens: 1 }, 1, NOW)
    ).not.toThrow();
    expect(readAllQuota(sql)).toEqual([]);
  });

  it("hands stored state to the scheduler with the caller's window kinds", () => {
    declareQuota(sql, groq);
    const recovered = toQuotaState(readQuota(sql, groq)!, {
      requests: "day",
      tokens: "day",
    });
    expect(recovered.requests).toEqual({
      kind: "day",
      limit: 14_400,
      used: 0,
      resetAt: NOW + HOUR,
    });
    expect(capacityFor(recovered, { requests: 1, tokens: 500 }, NOW)).toEqual({
      kind: "ready",
    });
  });
});
