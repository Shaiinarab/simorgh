// ── Free-compute capacity: quota windows, reset horizons, and the schedule ─────
//
// Everything above this module — `flyFlock`, the agent loop, the request pipeline —
// decides *which provider answers this request*. This module decides something the
// flock cannot: **whether this work should run at all, on this account, now.**
//
// The gap it closes is not theoretical. The gateway counts failures and cools
// providers down, but it has never asked how much of a provider's daily budget is
// left, or when that budget comes back. So a 100k-token research job and a 200-token
// "what time is it" both burn the same last 2k tokens, and the 2k is gone. The Go
// side counts tokens too (`packages/ledger`) and then feeds the number to `/status`
// and nothing else — the data is collected, displayed, and never acted on. Its
// `dailyCap` is operator-configured, has no reset horizon, and `groq.go` discards it
// outright.
//
// Three decisions worth stating, because each one is easy to get wrong:
//
//   1. **An unpublished limit is unconstrained, never zero.** `limit <= 0` means the
//      provider has not told us there is a cap. Treating that as "no capacity" would
//      make the scheduler refuse work it could have done; the repo's own doctrine —
//      degrade honestly rather than fabricate — applies to quota exactly as it does
//      to answers. Unknown is a real state here, and it has its own answer: fall back
//      to watching for a 429, which is the engine's existing discovery mechanism for
//      an undeclared limit (`COOLDOWN_RATE_LIMIT_MS` in `health.ts`).
//
//   2. **Spend the capacity that refills soonest, because that is the cheapest
//      capacity there is.** The intuitive move — "use whichever account has the most
//      left" — happens to agree here, but for the wrong reason, and it fails on the
//      case that matters. Consuming an account that refills in four minutes costs the
//      pool a four-minute dip; consuming one that refills in twelve hours costs it
//      twelve. So the objective is not "biggest pile" but **"most usable capacity
//      left over"**, scored after the spend — `postSpendValue`, which is §10's
//      "maximize useful computation within the actual free quotas" written down.
//
//   3. **No provider coupling.** This module knows about quota windows and nothing
//      else — not `Provider`, not credentials, not HTTP. That is what makes the whole
//      schedule testable with no network, no runtime, and no Durable Object, and it
//      is why multi-account support (§13) needed no change to this file: an account is
//      simply a second value in a row's key.
//
// It deliberately does **not** own call or failure counters — `health.ts` does, and
// duplicating them would recreate the exact "two definitions, nothing comparing them"
// bug that `ledger.ts` documents having already been paid for once. It owns latency
// because `health.ts` does not, and `docs/OBSERVABILITY.md` names provider latency as
// the one real gap on this side.

import type { SqlPort, SqlRow } from "./ports.ts";

// ── Shape ─────────────────────────────────────────────────────────────────────

/** The periods a free tier actually meters. A model has one of each, at most. */
export type QuotaWindowKind = "minute" | "hour" | "day" | "month";

/** Which budget a window meters. */
export type BudgetKind = "requests" | "tokens";

/**
 * One budget the provider enforces, over one period.
 *
 * `limit <= 0` — never 0, never negative — means **not published**, and is treated
 * as unconstrained. `resetAt === 0` means the reset time is unknown, in which case
 * the window never appears to roll over on its own and the engine's 429 cooldown is
 * the only discovery mechanism left.
 */
export interface QuotaWindow {
  kind: QuotaWindowKind;
  limit: number;
  used: number;
  /** Epoch ms. `0` = unknown. */
  resetAt: number;
}

/**
 * One account's budget for one model.
 *
 * `accountId` defaults to `"default"`, so a single-credential deployment is the
 * degenerate case of the multi-account model rather than a special case of it.
 */
export interface QuotaState {
  providerId: string;
  accountId: string;
  modelId: string;
  /** `null` when the provider publishes no request-rate limit. */
  requests: QuotaWindow | null;
  /** `null` when the provider publishes no token budget. */
  tokens: QuotaWindow | null;
  /**
   * Observed round-trip latency in ms; `0` when nothing has been measured yet.
   *
   * Carried on the state rather than looked up separately so the scheduler has one
   * complete picture of an account. It only decides the *urgent* path — see
   * `planQuotaRun` — and it is here because `health.ts` never recorded it and
   * `docs/OBSERVABILITY.md` names that as the one real measurement gap on this side.
   */
  latencyEmaMs: number;
}

/** Identity of one schedulable account+model. */
export interface CandidateId {
  providerId: string;
  accountId: string;
  modelId: string;
}

/** What a task needs, and how patient it is. */
export interface Workload {
  requests: number;
  tokens: number;
  /**
   * Epoch ms the work must be finished by. Omitted means no deadline — the task can
   * wait for the cheapest capacity rather than the nearest.
   */
  deadline?: number;
}

/** A state paired with the part of the workload its windows meter. */
interface Budget {
  kind: BudgetKind;
  window: QuotaWindow;
  cost: number;
}

function budgetsFor(state: QuotaState, workload: Workload): Budget[] {
  const budgets: Budget[] = [];
  if (state.requests) {
    budgets.push({ kind: "requests", window: state.requests, cost: workload.requests });
  }
  if (state.tokens) {
    budgets.push({ kind: "tokens", window: state.tokens, cost: workload.tokens });
  }
  return budgets;
}

// ── Window arithmetic ─────────────────────────────────────────────────────────

/** What is left in one window, at `now`. */
export function windowRemaining(window: QuotaWindow, now: number): number {
  if (window.limit <= 0) return Number.POSITIVE_INFINITY;
  // A window whose period has elapsed is a fresh window: `used` describes the period
  // that just closed. This is the reset horizon, and it is the whole reason a "daily"
  // budget is not a running total since boot — which is exactly what the Go ledger
  // computes today.
  if (window.resetAt !== 0 && now >= window.resetAt) return window.limit;
  return Math.max(0, window.limit - window.used);
}

/**
 * Whether this window could *ever* hold the cost — in any period, ever.
 *
 * Separated from "does it hold it now" because a task larger than an account's total
 * daily budget is not a scheduling problem: no amount of waiting fixes it, and a
 * scheduler that queues such a task forever is worse than one that fails it fast.
 */
export function windowCanEverFit(window: QuotaWindow, cost: number): boolean {
  return window.limit <= 0 || window.limit >= cost;
}

/**
 * When this window could first hold `cost`.
 *
 * `null` = never: either the cost exceeds the window's whole budget, or the window is
 * short now with no known reset to wait for.
 */
export function windowReadyAt(
  window: QuotaWindow,
  cost: number,
  now: number
): number | null {
  if (!windowCanEverFit(window, cost)) return null;
  if (windowRemaining(window, now) >= cost) return now;
  if (window.resetAt === 0) return null;
  return window.resetAt;
}

// ── Can this account serve the work, and when? ────────────────────────────────

/** The verdict for one account against one workload. */
export type Capacity =
  /** It can run now. */
  | { kind: "ready" }
  /** It can run, but not until a window resets. */
  | { kind: "wait"; until: number; binding: BudgetKind }
  /**
   * No period of this account could ever hold the work — the cost exceeds a window's
   * total budget, so this is the wrong account, not a busy one.
   */
  | { kind: "impossible"; binding: BudgetKind };

/**
 * The single question this module exists to answer: can `state` serve `workload`,
 * and if not, when?
 *
 * "When" is the **latest** of the windows' ready times, not the earliest. The task
 * needs both a request slot and a token budget, so it waits for whichever is later —
 * resuming at the earlier one would walk straight back into the binding constraint.
 * And "impossible" outranks "wait": if any window can never hold the cost, there is
 * nothing to wait for.
 */
export function capacityFor(
  state: QuotaState,
  workload: Workload,
  now: number
): Capacity {
  let readyAt = now;
  let binding: BudgetKind | null = null;

  for (const budget of budgetsFor(state, workload)) {
    const at = windowReadyAt(budget.window, budget.cost, now);
    if (at === null) return { kind: "impossible", binding: budget.kind };
    if (at > readyAt) {
      readyAt = at;
      binding = budget.kind;
    }
  }

  return binding === null
    ? { kind: "ready" }
    : { kind: "wait", until: readyAt, binding };
}

/**
 * How much usable capacity this account would still hold for *future* work if the
 * job ran on it now. Higher is better, and the scheduler maximises it.
 *
 * Two factors, and the second is the one that makes this more than a counter:
 *
 *   - **what is left after the spend** — `remaining - cost`. An account that still has
 *     room after serving the job was not really consumed by it.
 *   - **persistence** — `exp(-untilReset / horizonMs)`, so capacity that refills soon
 *     is nearly free to hold and capacity that does not is precious. Spending an
 *     account that refills in four minutes costs the pool a four-minute dip; spending
 *     one that refills in twelve hours costs it twelve hours.
 *
 * Both test cases in the suite below fall out of that one line, and neither falls out
 * of "use the biggest pile": the account with *more* remaining is sometimes the wrong
 * answer, and so is the account with the *soonest* reset.
 */
export function postSpendValue(
  state: QuotaState,
  workload: Workload,
  now: number,
  horizonMs: number
): number {
  let value = 0;
  for (const budget of budgetsFor(state, workload)) {
    const window = budget.window;
    if (window.limit <= 0) continue; // unpublished: not scarce by anything we know
    const left = Math.max(0, windowRemaining(window, now) - budget.cost);
    const untilReset =
      window.resetAt === 0 ? Number.POSITIVE_INFINITY : window.resetAt - now;
    const persistence = horizonMs > 0 ? Math.exp(-untilReset / horizonMs) : 1;
    value += left * persistence;
  }
  return value;
}

/**
 * Total known remaining capacity, ignoring time. The urgent path's tiebreak.
 */
export function totalRemaining(state: QuotaState, now: number): number {
  let total = 0;
  for (const budget of budgetsFor(state, { requests: 0, tokens: 0 })) {
    const remaining = windowRemaining(budget.window, now);
    if (Number.isFinite(remaining)) total += remaining;
  }
  return total;
}

// ── The schedule ──────────────────────────────────────────────────────────────

/** What the scheduler decided. */
export interface SchedulePlan {
  action: "run" | "delay" | "unavailable";
  /** The winning account. Set for `run`, and for `delay` as the one it is waiting for. */
  run?: CandidateId;
  /** Set when `action === "delay"`: the epoch ms to resume at. */
  resumeAt?: number;
  /**
   * Every account not chosen, with the reason.
   *
   * Not decoration. A scheduler that silently drops candidates is indistinguishable
   * from one that lost them, and "why did my task wait four minutes" is the first
   * question an operator asks.
   */
  rejected: { candidateId: CandidateId; reason: string }[];
}

export interface PlanOptions {
  /**
   * How close to its deadline a task must be before it stops being allowed to wait.
   * Defaults to a minute. Past that point the scheduler spends whatever capacity
   * exists rather than preserving any of it — a task already going to miss its
   * deadline gains nothing by being polite to a future one.
   */
  urgencyMs?: number;
  /** Decay scale for `futureValue`. Defaults to an hour. */
  horizonMs?: number;
}

const DEFAULT_URGENCY_MS = 60_000;
const DEFAULT_HORIZON_MS = 3_600_000;

function candidateId(state: QuotaState): CandidateId {
  return {
    providerId: state.providerId,
    accountId: state.accountId,
    modelId: state.modelId,
  };
}

function sameCandidate(a: CandidateId, b: CandidateId): boolean {
  return (
    a.providerId === b.providerId &&
    a.accountId === b.accountId &&
    a.modelId === b.modelId
  );
}

/**
 * Decide what to do with `workload` right now.
 *
 * Pure over `(states, workload, now)`, so the entire temporal policy — including the
 * four-minute-reset case that motivates it — is driven by frozen clocks in tests with
 * no runtime at all.
 *
 * Callers pass only *eligible* accounts: configured credentials, not cooling down,
 * not already known-tired. That filter is `flyFlock`'s job and `health.ts`'s; this
 * module answers a different question and stays single-purpose.
 *
 * The policy, in order:
 *
 *   1. Any account that can run now wins, and which one depends on patience:
 *        - a task with **slack** maximises `postSpendValue` — it leaves the pool in
 *          the best state, which is what "maximize useful computation within the
 *          actual free quotas" means once you account for time;
 *        - an **urgent** task stops optimising the pool and optimises itself: least
 *          observed latency, breaking ties on most remaining capacity. A task about
 *          to miss its deadline gains nothing from being polite to a future one, and
 *          latency is the only thing that makes it on time.
 *   2. Otherwise every eligible account is waiting on a reset, so resume at the
 *      earliest of them. That is the whole of "wait, let B reset, consume B".
 *   3. Otherwise the work cannot be placed, and saying so plainly is the honest
 *      answer — `flock_exhausted` is already this repo's word for it.
 */
export function planQuotaRun(
  states: readonly QuotaState[],
  workload: Workload,
  now: number,
  options: PlanOptions = {}
): SchedulePlan {
  const urgencyMs = options.urgencyMs ?? DEFAULT_URGENCY_MS;
  const horizonMs = options.horizonMs ?? DEFAULT_HORIZON_MS;

  const rejected: { candidateId: CandidateId; reason: string }[] = [];
  const ready: QuotaState[] = [];
  let resumeAt: number | null = null;
  let resumeCandidate: QuotaState | null = null;

  for (const state of states) {
    const capacity = capacityFor(state, workload, now);

    if (capacity.kind === "ready") {
      ready.push(state);
      continue;
    }

    if (capacity.kind === "impossible") {
      rejected.push({
        candidateId: candidateId(state),
        reason: "exceeds_" + capacity.binding + "_budget",
      });
      continue;
    }

    rejected.push({
      candidateId: candidateId(state),
      reason: "waits_for_" + capacity.binding + "_reset",
    });
    if (resumeAt === null || capacity.until < resumeAt) {
      resumeAt = capacity.until;
      resumeCandidate = state;
    }
  }

  if (ready.length > 0) {
    const urgent =
      workload.deadline !== undefined && workload.deadline - now <= urgencyMs;

    const chosen = urgent ? pickUrgent(ready, now) : pickMax(ready, (state) =>
      postSpendValue(state, workload, now, horizonMs)
    );

    return {
      action: "run",
      run: candidateId(chosen),
      rejected: [
        ...rejected,
        ...ready
          .filter((state) => !sameCandidate(candidateId(state), candidateId(chosen)))
          .map((state) => ({
            candidateId: candidateId(state),
            reason: urgent ? "slower_or_smaller" : "leaves_more_capacity",
          })),
      ],
    };
  }

  if (resumeAt !== null && resumeCandidate !== null) {
    return {
      action: "delay",
      resumeAt,
      run: candidateId(resumeCandidate),
      rejected,
    };
  }

  return { action: "unavailable", rejected };
}

/**
 * Least latency first, most remaining second.
 *
 * An unmeasured account (`latencyEmaMs === 0`) sorts last rather than first: an
 * absence of measurement is not evidence of speed, and preferring unknowns would make
 * a freshly-added account win every urgent task forever.
 */
function pickUrgent(states: readonly QuotaState[], now: number): QuotaState {
  const ranked = [...states].sort((a, b) => {
    const latencyA = a.latencyEmaMs > 0 ? a.latencyEmaMs : Number.POSITIVE_INFINITY;
    const latencyB = b.latencyEmaMs > 0 ? b.latencyEmaMs : Number.POSITIVE_INFINITY;
    if (latencyA !== latencyB) return latencyA - latencyB;
    return totalRemaining(b, now) - totalRemaining(a, now);
  });
  return ranked[0];
}

function pickMin<T>(items: readonly T[], score: (item: T) => number): T {
  let best = items[0];
  let bestScore = score(best);
  for (const item of items.slice(1)) {
    const candidate = score(item);
    if (candidate < bestScore) {
      best = item;
      bestScore = candidate;
    }
  }
  return best;
}

function pickMax<T>(items: readonly T[], score: (item: T) => number): T {
  let best = items[0];
  let bestScore = score(best);
  for (const item of items.slice(1)) {
    const candidate = score(item);
    if (candidate > bestScore) {
      best = item;
      bestScore = candidate;
    }
  }
  return best;
}

// ── Latency ───────────────────────────────────────────────────────────────────

/**
 * Latency EMA, on the policy the Go registry already uses.
 *
 * `0.7·old + 0.3·new`, and a first sample seeds the average rather than decaying
 * toward zero. Reusing the Go constants instead of inventing a second smoothing
 * factor is the point: the two runtimes already disagree about routing policy, and
 * "which provider is actually fast right now" ought to have one answer.
 */
export const LATENCY_EMA_ALPHA = 0.3;

export function nextLatencyEma(previous: number, sample: number): number {
  if (!(previous > 0)) return sample;
  return (1 - LATENCY_EMA_ALPHA) * previous + LATENCY_EMA_ALPHA * sample;
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * One row per provider/account/model.
 *
 * The primary key is the whole account model in one column triple, which is what
 * makes `Provider → Account → Credential → Model → Quota` a schema fact rather than
 * a naming convention. An operator with three legitimate accounts on one provider has
 * three rows, and the scheduler sees one pool.
 *
 * There are no call or failure counters here on purpose: `bird_health` owns those,
 * and a second copy is a second truth. `ledger.ts` records in detail what happens
 * when two definitions of the same thing exist with nothing comparing them.
 */
export const QUOTA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS quota_state (
    provider_id      TEXT    NOT NULL,
    account_id       TEXT    NOT NULL,
    model_id         TEXT    NOT NULL,
    req_limit        INTEGER NOT NULL DEFAULT 0,
    req_used         INTEGER NOT NULL DEFAULT 0,
    req_reset_at     INTEGER NOT NULL DEFAULT 0,
    tok_limit        INTEGER NOT NULL DEFAULT 0,
    tok_used         INTEGER NOT NULL DEFAULT 0,
    tok_reset_at     INTEGER NOT NULL DEFAULT 0,
    latency_ema_ms   REAL    NOT NULL DEFAULT 0,
    last_latency_ms  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_id, account_id, model_id)
  );
`;

/** The row as stored. A `type` alias keeps the implicit index signature `SqlPort` needs. */
export type QuotaRow = {
  provider_id: string;
  account_id: string;
  model_id: string;
  req_limit: number;
  req_used: number;
  req_reset_at: number;
  tok_limit: number;
  tok_used: number;
  tok_reset_at: number;
  latency_ema_ms: number;
  last_latency_ms: number;
};

const SELECT_ALL = `
  SELECT provider_id, account_id, model_id,
         req_limit, req_used, req_reset_at,
         tok_limit, tok_used, tok_reset_at,
         latency_ema_ms, last_latency_ms
    FROM quota_state
`;

/** Declare or update an account's published limits. A `0` limit means unknown. */
export function declareQuota(sql: SqlPort, state: QuotaState): void {
  sql.exec(
    `INSERT INTO quota_state
       (provider_id, account_id, model_id, req_limit, req_reset_at, tok_limit, tok_reset_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, account_id, model_id) DO UPDATE SET
       req_limit    = excluded.req_limit,
       req_reset_at = excluded.req_reset_at,
       tok_limit    = excluded.tok_limit,
       tok_reset_at = excluded.tok_reset_at`,
    state.providerId,
    state.accountId,
    state.modelId,
    state.requests?.limit ?? 0,
    state.requests?.resetAt ?? 0,
    state.tokens?.limit ?? 0,
    state.tokens?.resetAt ?? 0
  );
}

/**
 * Fold one real request into an account's counters.
 *
 * The period roll is applied *here* — by zeroing the counter — rather than only at
 * read time, because the observation and the counter have to move together: a Durable
 * Object nobody called for a week must not keep adding to a week-old period, and the
 * next scheduling decision must not be made on a number that was already wrong.
 * `windowRemaining` still applies the same roll at read time, so a scheduler reading
 * stored state sees exactly what the pure arithmetic would have computed.
 */
export function recordUsage(
  sql: SqlPort,
  candidate: CandidateId,
  usage: { requests?: number; tokens?: number },
  latencyMs: number,
  now: number
): void {
  const row = readQuota(sql, candidate);
  if (!row) return; // undeclared account: nothing to account against

  const addRequests = usage.requests ?? 1;
  const addTokens = usage.tokens ?? 0;

  const hasRolled = (resetAt: number): boolean => resetAt !== 0 && now >= resetAt;

  sql.exec(
    `UPDATE quota_state
        SET req_used = ?, tok_used = ?, latency_ema_ms = ?, last_latency_ms = ?
      WHERE provider_id = ? AND account_id = ? AND model_id = ?`,
    hasRolled(row.req_reset_at) ? addRequests : row.req_used + addRequests,
    hasRolled(row.tok_reset_at) ? addTokens : row.tok_used + addTokens,
    nextLatencyEma(row.latency_ema_ms, latencyMs),
    Math.round(latencyMs),
    candidate.providerId,
    candidate.accountId,
    candidate.modelId
  );
}

/** One account's stored row, or `undefined` when the account was never declared. */
export function readQuota(sql: SqlPort, candidate: CandidateId): QuotaRow | undefined {
  return sql
    .exec<QuotaRow & SqlRow>(
      SELECT_ALL + " WHERE provider_id = ? AND account_id = ? AND model_id = ?",
      candidate.providerId,
      candidate.accountId,
      candidate.modelId
    )
    .toArray()[0];
}

/** Every declared account. Accounts never declared are absent, not zeroed. */
export function readAllQuota(sql: SqlPort): QuotaRow[] {
  return [...sql.exec<QuotaRow & SqlRow>(SELECT_ALL).toArray()];
}

/**
 * Row → the pure type, for handing stored state to the scheduler.
 *
 * The window `kind` is not stored: the table carries one request budget and one token
 * budget, and the period is a property of the *provider's* published limits, which
 * the caller knows. Inventing a default here would silently mislabel a per-minute
 * limit as a per-day one in every report that reads the label.
 */
export function toQuotaState(
  row: QuotaRow,
  kinds: { requests: QuotaWindowKind; tokens: QuotaWindowKind }
): QuotaState {
  return {
    providerId: row.provider_id,
    accountId: row.account_id,
    modelId: row.model_id,
    requests: {
      kind: kinds.requests,
      limit: row.req_limit,
      used: row.req_used,
      resetAt: row.req_reset_at,
    },
    tokens: {
      kind: kinds.tokens,
      limit: row.tok_limit,
      used: row.tok_used,
      resetAt: row.tok_reset_at,
    },
    latencyEmaMs: row.latency_ema_ms,
  };
}
