# TASK-011 — Report: FREE_ONLY resource mode

state: done

## Outcome

FREE_ONLY is implemented, tested and committed. `ADR-0005-free-only-mode.md`.

The gate landed in `phoenix-core/src/quota.ts` only, as the brief required:

- **`ProviderCost`** — a three-variant union `free | paid {usdPerMTokens} | unknown`. The
  field is **required** on `QuotaState`, because a type that permits the omission permits the
  bill.
- **`CostMode`** on `PlanOptions.mode`, defaulting to `FREE_ONLY` so an unconfigured
  deployment fails closed — matching the repo's existing rule that unconfigured auth is `503`,
  never anonymous-allowed.
- **`costVerdict(cost, mode)`** — one exported definition of the gate and of both reason
  strings, so a host that pre-filters cannot re-derive them and diverge.
- **The gate runs before any capacity arithmetic.** A paid provider under a tight quota would
  otherwise be rejected as `exceeds_tokens_budget`, which tells an operator to buy capacity
  when what they actually need is `mode: "PAID_ALLOWED"`. A policy refusal is the binding
  reason, so it is the reason reported.
- **Persistence** — `cost_usd REAL NOT NULL DEFAULT 0` plus `cost_class TEXT NOT NULL DEFAULT
  'unknown'`, wired through `declareQuota` (write), `SELECT_ALL`/`QuotaRow` (read) and
  `toQuotaState` (decode). `recordUsage` deliberately does not touch cost.

## The encoding decision the brief left open

`0` cannot be both "free" and "nobody said", which is the one place the brief's framing
under-determined the design. Two columns rather than one:

- `cost_usd > 0` → paid
- `cost_usd <= 0` **and** `cost_class = 'free'` → free
- everything else → unknown

A contradictory row resolves to **paid**, so a typo cannot buy capacity for nothing.

## Test → claim

| Required | Test |
|---|---|
| paid rejected | `rejects a paid provider under FREE_ONLY, by name` |
| **unknown rejected** | `rejects an unclassified provider under FREE_ONLY — unknown is not free` |
| unknown eligible when paid allowed | `routes onto that same unclassified provider once the mode allows paid` |
| `unavailable`, never `run` | `answers \`unavailable\`, never \`run\`, when FREE_ONLY has nothing eligible` |
| SQLite round trip | `carries a declared cost through declareQuota → readQuota → toQuotaState` |
| `0` → unknown | `reads a bare 0 cost column back as unknown, never as free` |
| negative control | below |

Plus four added: `defaults to FREE_ONLY when the caller configures nothing`, `does not rank
free above paid — free only wins by being eligible`, `reports the cost refusal instead of a
capacity reason`, `re-declaring an account updates its cost without touching its usage`.

27 pre-existing tests still present and passing; 11 added. **38 total.**

## Negative control — red output verbatim

Planted `{ eligible: true }` in `costVerdict`'s `unknown` branch:

```
 ❯ phoenix-core/test/quota.test.ts (38 tests | 2 failed) 43ms
     × rejects an unclassified provider under FREE_ONLY — unknown is not free 12ms
     × answers `unavailable`, never `run`, when FREE_ONLY has nothing eligible 2ms

AssertionError: expected { eligible: true } to deeply equal { eligible: false, …(1) }
- Expected
+ Received
  {
-   "eligible": false,
-   "reason": "cost_unknown_in_free_only",
+   "eligible": true,
  }

AssertionError: expected 'run' to be 'unavailable' // Object.is equality
Expected: "unavailable"
Received: "run"
```

The second failure is the real symptom: the plant made an unclassified provider get **run**.
Restored → 38/38.

## Verbatim acceptance output

```
$ npx vitest run --config vitest.node.config.ts phoenix-core/test/quota.test.ts
 Test Files  1 passed (1)
      Tests  38 passed (38)

$ npx vitest run --config vitest.node.config.ts phoenix-core/test/boundary.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Also green at the time: full node suite, root typecheck, `simorgh-platform` config, and
`npm run security:scan`.

## Two changes the brief had to be corrected on

1. **ADR numbering.** The brief said write `ADR-0004-free-only-mode.md`. `ADR-0004` was
   `toolchain-upm.md`, committed earlier the same day. Two records on one number is this
   repo's own "two definitions nothing compares" trap, so it was written as
   **`ADR-0005-free-only-mode.md`** with the collision noted inside.
2. **Two lines of shared fixtures changed, unavoidably.** The `state()` helper gained a fifth
   `cost` parameter defaulting to `{kind:"free"}`, and the `groq` literal gained
   `cost: {kind:"free"}`. Every one of the 27 pre-existing assertions is byte-identical. This
   was forced: the new default is `FREE_ONLY`, which under the rule refuses every unclassified
   fixture. The alternative — defaulting `PAID_ALLOWED` to leave fixtures untouched — is
   exactly the fail-open the brief forbids.

## What was found but NOT fixed

1. **`docs/adr/ADR-0003` is stale** — its Verification section still says "27 tests" and it
   never mentions cost. It should carry an "Amended by ADR-0005" line.
2. **Fail-closed makes a fresh deployment unrunnable.** Every row in a new database reads back
   `unknown`, and under the default mode all of them are refused — so `planQuotaRun` returns
   `unavailable` until an operator calls `declareQuota` with `cost: {kind:"free"}`. That is
   correct and it is the price of the rule, but it means a wall of
   `cost_unknown_in_free_only` is a *misconfiguration* signal being reported through the
   *capacity* channel. Making it legible in `/api/v1/flock/status` is the next slice.
3. **Concurrent-agent coupling.** The sibling task building the task graph and swarm found
   that its fixtures would have passed **for the wrong reason** without `cost: {kind:"free"}`,
   because the cost gate fires before the capacity gate those tests exist to exercise. Fixed
   on that side; worth knowing that two features now interact.

## Where the framing was wrong

- **`usdPerMTokens` is a unit this project invented.** The brief specified
  `free (0) / paid (>0)` but never said per what — per token, per request, or per call. The
  unit is named so the field cannot lie, and the scheduler consumes only `kind`, so a wrong
  unit costs a status number and never a routing decision. If the real model is per-request,
  the field's name changes and nothing else does.
- **`PAID_ALLOWED` does not prefer free.** Free wins there only by being eligible; with equal
  capacity the tie falls to input order. Adding cost as a term in `postSpendValue` would be a
  second objective competing with ADR-0003's headline decision, so it was recorded as an
  explicit non-decision and pinned with a test.

TASK-011-END