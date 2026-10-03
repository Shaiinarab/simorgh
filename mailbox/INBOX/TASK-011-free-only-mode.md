# TASK-011 — make FREE_ONLY a real, enforced resource mode in the quota engine

- Owner: fb3
- Status: open
- Depends on: nothing · Estimate: 90–120 min · Runner: freebuff CLI agent (podman)

## Why this exists

Simorgh's stated strategic goal is `monetary cost = 0`. `phoenix-core/src/quota.ts` is the first slice
that takes that goal seriously — it decides *whether work should run at all, on this account, now*. But
it models **quota only**. Read the `QuotaState` interface again:

```ts
export interface QuotaState {
  providerId: string; accountId: string; modelId: string;
  requests: QuotaWindow | null; tokens: QuotaWindow | null;
  latencyEmaMs: number;
}
```

There is **no cost anywhere in it**. So a paid-only provider with a generous quota is indistinguishable
from a free one with a tight one, and `planQuotaRun` will happily route onto the paid provider — which
silently converts "free-first" into "whatever is cheapest to schedule". The mode is documented as the
product's strategic centre and is not implemented. That is the gap.

This is also a **compliance** boundary, not only a product one. Simorgh federates free tiers; an
operator who believes they are on free capacity must never be silently billed. The failure mode we are
closing is "unknown cost was treated as free".

## Read first

- `phoenix-core/src/quota.ts` — the whole file. `windowRemaining`, `capacityFor`, `postSpendValue`,
  `planQuotaRun`, `QUOTA_SCHEMA`, `toQuotaState`. Match its comment style: it explains *why*, and
  several of those comments are load-bearing.
- `phoenix-core/test/quota.test.ts` — 27 existing tests. Your additions join them; **do not delete or
  weaken any of the 27**. Read their style before writing yours.
- `docs/adr/ADR-0003-free-compute-capacity.md` — the ADR you are amending. Its "Alternatives" section
  is the bar this repo holds work to.
- `phoenix-core/src/ports.ts:16-20` — `SqlValue` / `SqlRow`. Every row type in this package is a `type`
  alias rather than an `interface` **on purpose**, because `SqlPort.exec<T>` restricts `T` to `SqlRow`
  and interfaces get no implicit index signature. Follow that or typecheck will fail on your rows.

## What to build

A resource **mode** on the capacity model, and eligibility enforced by it. Concretely:

1. **Cost is a fact with three states, not a boolean.** Free (0) / paid (>0) / **unknown**. The critical
   rule: **unknown is not free.** In `FREE_ONLY` an unknown-cost provider is ineligible. This single
   decision is the whole task — get it right and the rest is plumbing.
2. **A mode value** passed to `planQuotaRun` via `PlanOptions` (default `FREE_ONLY`, so an unconfigured
   deployment fails *closed* — the safe direction, and consistent with this repo's doctrine that
   unconfigured auth is `503`, never anonymous-allowed).
3. **Rejection reasons that name the binding.** `planQuotaRun` already returns
   `rejected: {candidateId, reason}[]` and its comment says why: *"a scheduler that silently drops
   candidates is indistinguishable from one that lost them."* A paid provider must appear there with
   something like `paid_tier_in_free_only` or `cost_unknown_in_free_only`. **Add the fields, do not
   silently drop rows.**
4. **Persistence.** Extend `QUOTA_SCHEMA` with cost columns and add the read/write path beside
   `declareQuota` / `toQuotaState`. A `0` cost limit must mean **unknown**, matching the file's existing
   convention that `limit <= 0` means *not published* — reuse that idea rather than inventing a
   competing one, and say so in the comment.
5. **Paid fallback must not happen accidentally.** If `FREE_ONLY` yields no candidate, the answer is
   `unavailable` — never "run anyway". Test it.

## Allowlist — these files are yours exclusively

```
phoenix-core/src/quota.ts            (modify)
phoenix-core/test/quota.test.ts      (modify — add, never remove)
docs/adr/ADR-0004-free-only-mode.md  (new)
```

## Do NOT touch — these belong to other lanes in this same run

- `phoenix-core/src/scheduled.ts`, `phoenix-core/test/scheduled.test.ts` — durable-delay lane
- `src/flock.ts`, `test/durable-*.test.ts` — Durable Object host
- `bench/**`, `docs/research/NATIVE-COMPUTE-AUDIT.md` — audit lane
- `docs/research/ROUTING-CONVERGENCE.md`, `docs/research/GO-QUOTA-FINDINGS.md` — convergence lane
- `phoenix-core/src/ports.ts`, `phoenix-core/src/index.ts` — shared; the Lead owns them

**A `typecheck` failure is not automatically yours.** Three lanes share one worktree and one
`npm run typecheck`. If it fails in a file outside your allowlist, that is another lane mid-write: report
it, do not fix it. Only fix errors in your own files.

## Constraints that are not negotiable

- `phoenix-core` stays **runtime-agnostic**. No `cloudflare:`, no `node:`, no bare runtime global.
  `phoenix-core/test/boundary.test.ts` fails the build on a violation, and you must not weaken it.
- No new dependency. This is a scheduling decision; it is arithmetic.
- Do **not** run `git commit`, `git push`, or `git rebase`. The Lead integrates.
- No `npm audit`/`npm install` churn; `node_modules` is already installed.

## Acceptance — run these and paste the output verbatim

```bash
cd /home/shai/personal/projects/projects/simorgh

npm run typecheck
npx vitest run --config vitest.node.config.ts phoenix-core/test/quota.test.ts
npx vitest run --config vitest.node.config.ts phoenix-core/test/boundary.test.ts
npx vitest run --config vitest.node.config.ts phoenix-core/test/scheduled.test.ts
```

Every command must exit `0`. **If you cannot run one, say which and why** — silence reads as a pass,
and this repo has three documented cases of a green suite hiding a real defect.

## Required tests — name the test that covers each claim

1. a paid provider is rejected in `FREE_ONLY`, with the binding reason in `rejected`
2. an **unknown-cost** provider is rejected in `FREE_ONLY` ← *the important one*
3. the same unknown-cost provider is **eligible** when the mode allows paid (proves the mode is a real
   switch, not a constant rejection)
4. `FREE_ONLY` with no eligible candidate returns `unavailable`, never `run`
5. cost survives a `declareQuota` → `readQuota` → `toQuotaState` round trip through real SQL
6. a `0` cost column reads back as unknown, not free
7. **negative control, required**: temporarily make unknown cost eligible, confirm test 2 goes red, then
   restore. Report the red output. A detector that has never fired is not evidence.

## Report

Write `mailbox/OUTBOX/TASK-011-REPORT.md`. **The last non-empty line must be exactly `TASK-011-END`** —
that marker, not your process exiting, is the completion signal.

Include: what you implemented, what you found but did **not** fix, your negative-control output, the
verbatim acceptance output, and anything you believe the Lead got wrong. That last part is the most
valuable part of the report and you are not penalised for it.

If you are blocked, write `mailbox/NAGS/open-TASK-011-<slug>.md` — do not silently stall.

TASK-011-BRIEF-END