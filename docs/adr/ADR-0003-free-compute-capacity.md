# ADR-0003 — Free-compute capacity lives in the engine, not in a scheduler service

- **Status:** accepted
- **Date:** 2026-10-02
- **Decides:** where quota state lives, who computes the schedule, and why Simorgh did not adopt an
  existing external quota engine
- **Supersedes:** nothing. **Amends:** `ADR-0002` (the synchronous `SqlPort` finding) — this ADR is
  deliberately built *so that* decision does not have to be revisited yet.

## Context

The platform answers a request through whichever free-tier provider is healthy. It has never asked
how much of a provider's budget is left, or when that budget returns. Two consequences:

1. A 100k-token research job and a 200-token "what time is it" both spend the same last 2k tokens.
2. There is no way to express "wait four minutes for B to reset, then run on B".

The Go side *appears* to solve this. `packages/ledger/ledger.go` counts requests, prompt tokens and
completion tokens per provider, and `GET /status` reports `remaining_requests` against an
operator-configured `daily_cap`. Three facts make that a readout rather than a scheduler:

- `Remaining()` is `cap - used-since-process-boot`. There is no reset, so a "daily" budget never
  returns and the number is wrong after the first day.
- `groq.go:50` discards the cap outright — `_ = dailyCap // ledger wiring happens at the gateway layer`.
- `Registry.Select` reads health, latency EMA and priority. It never reads `Remaining()`.

Meanwhile the box already contains two systems with quota machinery:

| System | What it has | What it lacks |
|---|---|---|
| **OmniRoute** (`~/.omniroute/storage.sqlite`, running, 3 jobs / 18,592 runs) | `quota_pools`, `quota_allocations`, `quota_consumption`, `quota_snapshots`, `provider_quota_state`, `provider_quota_reset_events`, `provider_key_limits`, `provider_plans`, `domain_budgets`, `domain_circuit_breakers`, `domain_fallback_chains`, `routing_decisions` — the whole §10/§16 shape, already designed | **Every one has 0 rows.** Zero providers configured. It is a schema, not a system. |
| **9router** (running, port 20128) | 39 provider accounts with per-connection priority, a 41-model `free` combo, 1,451 rows of per-request token and cost history, round-robin fallback | No quota awareness at all: no `quota`/`limit`/`rate`/`budget`/`credit` key exists anywhere in its settings, and no per-connection health column. |

## Decision

**Put the capacity model in `@simorgh/phoenix-core`, as pure functions over a value type, persisted
through the existing `SqlPort`.**

- `phoenix-core/src/quota.ts` owns quota windows, reset horizons, `capacityFor`, `postSpendValue`,
  and `planQuotaRun`. It is pure over `(states, workload, now)`.
- One table, `quota_state`, keyed `(provider_id, account_id, model_id)` — which is what makes
  `Provider → Account → Credential → Model → Quota` a schema fact rather than a naming convention.
- `Provider.accountId` is optional and defaults to `"default"`, so single-credential deployments are
  the degenerate case and adding a second account changes no call site.
- Latency lives in the same row because `health.ts` never recorded it, and
  `docs/OBSERVABILITY.md` names provider latency as the one real measurement gap on this side.

### The scheduling rule

For a task with slack: **maximise the usable capacity left in the pool after the spend.**

    postSpendValue = Σ_windows  max(0, remaining − cost) · exp(−untilReset / horizon)

`sparse` capacity that refills soon is cheap to consume (a four-minute dip); capacity that does not
refill for twelve hours is the only thing the pool has for twelve hours. For a task **about to miss
its deadline**, the objective switches entirely: least observed latency, ties broken on most
remaining. Preserving the pool is worthless to a task that will not get done.

This rejects the intuitive rule — "use the account with the most left" — which agrees by luck when
both accounts refill at the same rate and gets the *smaller* account wrong when they do not. Both
cases are pinned in `phoenix-core/test/quota.test.ts`.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Adopt OmniRoute's quota tables** | Its schema is the best on this box and already has the §10 shape. Rejected for now: it is a second runtime with a second routing policy and no configured providers, so adopting it makes Simorgh *depend* on a system that is itself unproven here. The shapes now agree (`provider_quota_state` ↔ `quota_state`), so this stays open as a migration rather than a rewrite. |
| **Consume 9router's SQLite for quota state** | It holds the only real per-account token and cost history on the box. Rejected: no documented config format, no public schema contract, and it would couple the engine to a third party's private tables. **Also explicitly declined by the repository owner, who wants Simorgh independent of other routers.** |
| **Make `SqlPort` async now** (unblocks Vercel/Postgres for state) | Touches every host adapter and every test, and `ADR-0002`'s stated prerequisite — a host that needs it — does not exist. Deferring it is what this ADR is for. |
| **An external durable-execution runtime** (Inngest / Trigger.dev / Restate / Temporal) | None is installed, and none is needed yet: "delay until a reset" needs a Durable Object alarm and one table, not a broker. Revisit if task graphs arrive. |
| **Reuse the Go ledger** | Right shape, wrong home. It is in-memory, non-resetting, and on a runtime the engine does not depend on. The *shape* was adopted instead: `postSpendValue`'s latency EMA reuses the Go registry's exact `0.7·old + 0.3·new` so the two runtimes cannot drift on that number. |

## Consequences

**What it costs**

- One more table per host, and hosts must apply `QUOTA_SCHEMA` (done: both the Durable Object
  constructor and the Node runtime).
- The capacity state is only as good as the declared limits. Free tiers publish them unevenly and
  change them without notice, so this needs a discovery story (§ next slice) rather than a
  hand-maintained table forever.
- Nothing is scheduled *yet*. `planQuotaRun` returns a decision; the caller that turns
  `action: "delay"` into a Durable Object alarm is the next slice, and it is deliberately not in this
  one.

**What it prevents**

- A second routing policy in a second language: the Go side's daily-cap arithmetic is now
  demonstrably the wrong model, and `postSpendValue` is the replacement, so "two half-maintained
  truths" (`ADR-0001`) stops growing.
- Building a scheduler on top of a gateway that cannot measure itself.

**How it can be replaced later**

The pure functions take plain values and return plain values. Swapping the *storage* means
reimplementing four statements against a different `SqlPort`; swaping the *policy* means editing
`planQuotaRun` alone, with 27 tests that pin the behaviour and no host to touch. The table can also
be dropped in favour of OmniRoute's without touching the policy, because the policy never sees SQL.

## Verification

`phoenix-core/test/quota.test.ts` — 27 tests, all on the Node suite, no runtime bindings:

- the §11 worked example, verbatim, as an executable specification (delay 4 minutes onto B, then run
  on B after its reset);
- the two cases that defeat "use the biggest pile" (sooner refill with less remaining; equal reset
  times with unequal remaining);
- the urgency switch, and that an unmeasured account is not treated as the fastest one;
- `impossible` distinguished from `wait`, so a task larger than an account's whole budget fails
  fast instead of queueing forever;
- the period roll, which is the defect the Go ledger has today;
- three accounts of one provider as three rows — the compute pool.

`test/durable-objects.test.ts` asserts the table exists in **real workerd**, over the RPC boundary,
which is the "verify against reality, not against your own fixture" rule this repo already applies to
`bird_health`. The boundary guard was run as a negative control: a planted `cloudflare:` import in
`quota.ts` fails `phoenix-core/test/boundary.test.ts` by name.
