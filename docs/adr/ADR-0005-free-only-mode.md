# ADR-0005 — `FREE_ONLY` is the default, and unknown cost is not free

- **Status:** accepted
- **Date:** 2026-10-03
- **Decides:** whether the quota scheduler may route onto a paid provider, and how an
  *unclassified* provider is treated
- **Amends:** [`ADR-0003`](ADR-0003-free-compute-capacity.md) — extends its `QuotaState` and
  `planQuotaRun`. Its §"The scheduling rule" is untouched.
- **Numbering note:** the brief asked for `ADR-0004-free-only-mode.md`. `ADR-0004` was taken by
  [`toolchain-upm`](ADR-0004-toolchain-upm.md) three commits earlier, and two ADRs sharing a number
  is the same "two definitions, nothing comparing them" trap `ledger.ts` documents. This is 0005.

## Context

The project's stated strategic goal is **`monetary cost = 0`**. `QuotaState` had no field for money
at all:

```ts
export interface QuotaState {
  providerId: string; accountId: string; modelId: string;
  requests: QuotaWindow | null; tokens: QuotaWindow | null; latencyEmaMs: number;
}
```

So a paid-only provider with a generous quota was byte-for-byte indistinguishable from a free one,
and `planQuotaRun` would route onto it and `recordUsage` would bill for it. Two defects in one:

1. **Correctness.** The scheduler optimises the wrong objective for the stated goal. Its whole
   argument in `ADR-0003` is that free capacity that refills soon is the cheapest capacity there
   is — an argument that is silently false for a paid account, and that the code had no way to
   know.
2. **Compliance.** An operator who believes they are on free capacity must never be silently
   billed. A missing field is not a safe default here; it is an unauthorised charge waiting for a
   request.

## Decision

**Cost is a three-state fact on the row, gated by a mode that defaults to closed.**

```ts
export type ProviderCost =
  | { kind: "free" }
  | { kind: "paid"; usdPerMTokens: number }
  | { kind: "unknown" };

export type CostMode = "FREE_ONLY" | "PAID_ALLOWED";
export const DEFAULT_COST_MODE: CostMode = "FREE_ONLY";
```

### Rule 1 — unknown is not free

Under `FREE_ONLY`, `paid` **and** `unknown` are both ineligible. Absence of evidence is not evidence
of cost zero, and an unclassified provider is exactly the case that would otherwise produce the
invoice. Each refusal is reported in `SchedulePlan.rejected` under a stable reason —
`paid_tier_in_free_only`, `cost_unknown_in_free_only` — because `planQuotaRun` already argues that
a scheduler which silently drops candidates is indistinguishable from one that lost them, and a
money decision is the last decision to hide.

`QuotaState.cost` is **required**, not optional. A type that permits the omission permits the bill;
the compiler is the cheapest place to make the safe answer the only expressible one.

### Rule 2 — the default fails closed

`mode` defaults to `FREE_ONLY`, so a deployment that configures nothing refuses rather than routes.
This is the repo's existing auth rule applied to money: unconfigured credentials are a `503`,
never anonymous-allowed. Defaulting the other way would turn a missing configuration into a
charge. `FREE_ONLY` with nothing eligible answers `unavailable`, never "run anyway" — the caller
can turn that into a refusal the operator sees; it cannot un-spend the money.

### Rule 3 — `<= 0` means *not published*, and the asymmetry with `limit` is deliberate

Two columns, because `0` cannot carry both "free" and "nobody said":

| `cost_usd` | `cost_class` | reads as |
|---|---|---|
| `> 0` | anything | `paid` |
| `<= 0` | `"free"` | `free` |
| `<= 0` | anything else (incl. `""`, the default) | `unknown` |

This is the same convention as a quota `limit` and the same intent — *the column records what we
were told, nothing more* — but it resolves in the **opposite direction**, and that is not an
inconsistency:

> An unpublished **limit** is unconstrained, because guessing a cap low would refuse work the fleet
> could have done. An unpublished **cost** is not free, because guessing it low spends somebody's
> money.

The two failures have different costs, so the two defaults differ. A contradictory row
(`cost_usd > 0` with `cost_class = 'free'`) resolves to `paid`: a typo must never be a way to buy
capacity for nothing. `toProviderCost` is exported and resolves every combination, so a host that
reads the table directly cannot get a different answer from the scheduler's.

### Non-decision — `PAID_ALLOWED` gates, it does not rank

Cost is an eligibility gate under `PAID_ALLOWED` and is **not** part of the objective.
`postSpendValue` is unchanged: no free-over-paid preference. An operator who has set
`PAID_ALLOWED` has already said capacity preservation is what they want, and a second objective
competing with `postSpendValue` is a policy change that deserves its own decision. Pinned by
`does not rank free above paid — free only wins by being eligible`.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A `isFree: boolean`** | Two states cannot express "nobody has classified this", which is precisely the dangerous case. A boolean's `false` would have to mean both "paid" and "unknown", and the first rule would be unimplementable. |
| **Default `PAID_ALLOWED`, configure closed** | Inverted the failure. The unconfigured deployment — the common one, and the one nobody is watching — is exactly the one that must not bill. |
| **Reject only `paid`, allow `unknown`** | This is the "optimise for availability" reading, and it is the bug. A fresh deployment has *no* classified providers, so every row is `unknown`, so the whole fleet is paid. Fail-closed is the only reading that makes the gate mean anything before someone has done the classification work. |
| **Cost as a soft term in `postSpendValue`** | Rejected now, kept open. It changes what the scheduler maximises, which is `ADR-0003`'s headline decision. It would also need a price scale (per token? per request?) and a discount factor, and neither exists. The gate satisfies the compliance requirement with none of that. |
| **`cost_usd REAL NULL`, `NULL` = unknown** | Cleaner — SQL three-valued logic does this natively, in one column. Rejected because it contradicts the repo's established `<= 0` convention, and a second convention for "we were not told" in the same table is the trap this repo keeps documenting. |
| **No persisted cost; the caller filters before calling** | Then the gate lives in whichever host remembered to write it, and `rejected` cannot name it — so the decision becomes invisible exactly where `planQuotaRun`'s own comment says invisibility is unacceptable. |

## Consequences

**What it costs**

- One required field, `QuotaState.cost`, and two columns. Every construction site must state cost —
  which is the point, but it means adding a provider is now a two-line change rather than a
  one-liner. There were three call sites when this landed.
- `usdPerMTokens` is a **reported** figure. The scheduler consumes only `kind`, so an
  operator who gets the unit wrong loses a number in a status line, never a routing decision. That
  is deliberate, and it is the reason the field can exist at all before the project has decided what
  a "request" costs across providers.

**What it prevents**

- The silent bill. An operator on a free fleet cannot be routed onto paid capacity without
  passing `{ mode: "PAID_ALLOWED" }`, which is a visible, greppable act.
- A second eligibility policy in a host. `costVerdict` is exported so the reason strings have one
  definition; a host that pre-filters must not re-derive them.

**Known gap — the fleet is now unrunnable until someone classifies it.** This is the honest cost of
fail-closed. Every row in a fresh database reads back `unknown`, and under the default mode every
one of them is refused, so `planQuotaRun` returns `unavailable` until an operator calls
`declareQuota` with `cost: { kind: "free" }`. That is the intended behaviour, but it is a real
operational step: whoever wires providers up must classify them, and a `FREE_ONLY` deployment that
reports `unavailable` with a wall of `cost_unknown_in_free_only` is a *misconfiguration* signal, not
a capacity signal. Making that distinction legible in `/status` is the natural next slice and is not
in this one.

**How it can be replaced later**

The gate is three lines in one exported function. Dropping the `unknown` state means deleting one
union member and one branch. Widening the price model means changing `paid`'s payload; the read
path already resolves on `cost_usd > 0` and does not care what a unit means.

## Verification

`phoenix-core/test/quota.test.ts` — 38 tests (27 pre-existing, 11 added), Node suite, no runtime
bindings:

| Claim | Test |
|---|---|
| paid rejected under `FREE_ONLY`, by name | `rejects a paid provider under FREE_ONLY, by name` |
| **unknown rejected under `FREE_ONLY`** | `rejects an unclassified provider under FREE_ONLY — unknown is not free` |
| the same unknown row is eligible when paid is allowed | `routes onto that same unclassified provider once the mode allows paid` |
| no eligible candidate ⇒ `unavailable`, never `run` | `answers unavailable, never run, when FREE_ONLY has nothing eligible` |
| the default is closed | `defaults to FREE_ONLY when the caller configures nothing` |
| cost is a gate, not a ranking term | `does not rank free above paid — free only wins by being eligible` |
| the cost refusal outranks a capacity reason | `reports the cost refusal instead of a capacity reason` |
| cost survives `declareQuota → readQuota → toQuotaState` on real SQLite, and reaches the scheduler | `carries a declared cost through declareQuota → readQuota → toQuotaState` |
| usage accounting does not restate cost | `re-declaring an account updates its cost without touching its usage` |
| **a `0` cost column reads back as unknown** | `reads a bare 0 cost column back as unknown, never as free` |
| a contradictory row bills rather than sneaks | `resolves a contradictory cost row to paid, so a typo cannot buy capacity free` |

**Negative control, run and reverted.** `costVerdict`'s `unknown` branch was changed to return
`{ eligible: true }`. The suite went red on exactly the two tests that claim the rule —
`rejects an unclassified provider under FREE_ONLY — unknown is not free` and
`answers unavailable, never run, when FREE_ONLY has nothing eligible` — the second failing with
`expected 'run' to be 'unavailable'`, which is the real-world symptom the feature exists to
prevent. Restored and green at 38/38. A detector that has never fired is not evidence.

`phoenix-core/test/boundary.test.ts` still passes (5/5): the change is arithmetic plus two string
columns, so nothing moved toward a runtime binding.