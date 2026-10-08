# TASK-013 — Routing convergence: where TypeScript and Go actually disagree

Read-only comparison. Evidence, not patches. Worktree at commit `721a189`. Full evidence
dumps: `docs/research/ROUTING-CONVERGENCE.md` (comparison + decision) and
`docs/research/GO-QUOTA-FINDINGS.md` (fact check + unfixed defects).

## 1. ADR-0003 fact check — all three claims CONFIRMED

This was the higher-value half of the task. Verdicts with quoted evidence:

### Claim 1 — `Remaining()` computes `cap - used-since-boot` with no reset: **CONFIRMED**

`packages/ledger/ledger.go:82-98` — `r := int64(c) - used` where `used = e.Requests`
(line 91). `e.Requests` is only ever incremented (`Record`, ledger.go:60); no reset method
exists in the package. The only time field, `start` (ledger.go:31), feeds `Uptime()` alone
(ledger.go:101). The test suite pins the no-reset behaviour: `ledger_test.go:62-67` records
200 requests against a cap of 100 and asserts remaining clamps to 0 — no daily roll is
asserted anywhere. A "daily" budget never returns on the daily horizon; after the first
day boundary the number is wrong forever (clamped at 0) until process restart.

### Claim 2 — `groq.go:50` discards `dailyCap`: **CONFIRMED**

`packages/providers/groq/groq.go:50`:

```go
_ = dailyCap // ledger wiring happens at the gateway layer (Epic 2/7)
```

The comment is accurate about where the wiring happens: `assemble.go:31` passes
`p.DailyCap` into `groq.New`; `assemble.go:35-36` calls `led.SetDailyCap(p.ID, p.DailyCap)`.
So the cap reaches the ledger — but only for the `/status` readout (`server.go:233-236`).
The adapter never sees it; nothing consumes it for routing.

### Claim 3 — `Registry.Select` never reads `Remaining()`: **CONFIRMED**

`packages/providers/adapter.go:187-206` — `Select` filters on `c.healthy &&
c.Supports(model)` and sorts with `better()` (adapter.go:208-216), which compares only
`healthy`, `latencyEMA`, `priority`. The `Candidate` struct (adapter.go:100-107) has no
quota field. Grep of the whole Go tree: the only `Remaining()` call site outside the
ledger package is `server.go:233` in `handleStatus` — reporting only.

**Bottom line:** the ADR's factual basis holds. "A readout rather than a scheduler" is
accurate, including that the cap is operator-configured (`config.go:29`, yaml
`daily_cap`). The premise ADR-0003 was built on is sound; no correction to the ADR is
needed. (Refuting a load-bearing claim would have been more valuable still — but the
source agrees with the ADR on all three.)

## 2. The comparison

| Decision | TypeScript engine | Go gateway | Same? | Where they differ |
|---|---|---|---|---|
| Candidate ordering | Static priority order (`byPriority`, provider.ts:176-178); latency EMA only breaks ties on the urgent quota path (`pickUrgent`, quota.ts:552-560) | Healthy first, then lower latency EMA, then priority (`Select`/`better`, adapter.go:187-216) | **No** | Go reorders by measured latency every request; TS holds priority fixed. This is the "competing rule" ADR-0001 §4.4 says must stop being independently defined. |
| Dormant / secret-absent skip | Skipped without charge, no cooldown, recorded as a `dormant` attempt (flock.ts:94-97) — a deployment fact, not a fault | No dormant concept; a keyless provider is still registered (assemble.go:21-28) and dialled per-request, failing and accumulating errors. Only `Enabled: false` is skipped (assemble.go:18-20) | **No** | Go penalises a provider that was never dialled — the exact mistake flock.ts:79-85 documents avoiding. |
| Cooldown after failure | Time-based: 60 s rate-limit / 15 s other (health.ts:32-33), persisted in `bird_health`, self-expiring, background sweep (health.ts:122-130) | No time-based cooldown; 3 consecutive errors → unhealthy (adapter.go:159-163); any success revives (adapter.go:166-167) | **No** | TS heals by the clock; Go heals only via a success that unhealthy adapters never receive (see lockout, §4). |
| Fail-through on thrown provider | try/catch at the single dial site (flock.ts:105-114); providers also self-catch (provider.ts:123-125) | Error-return idiom; loop continues (server.go:117-130) with client-gone and headers-sent guards (server.go:119-128) | **Yes**, structurally | Go's two wire guards have no TS equivalent because the TS engine does not stream. |
| Exhaustion reporting | Every attempt in `flock_attempts` with reason, incl. skips (flock.ts:91-119); `flockRetryAfterSeconds` → soonest real cooldown or honest `null` (flock.ts:169-178) | Only the **last** error surfaced (server.go:88, 135-143); `Retry-After` only if the last error is a 429 (server.go:138-141) | **No** | Go cannot distinguish "all rate-limited" from "last wire error"; no per-attempt list, no skip reasons, no computed retry hint. |
| Usage ever *acted on* | Yes — `planQuotaRun` returns run/delay/unavailable from quota windows with reset horizons (quota.ts:463-543); `recordUsage` rolls periods (quota.ts:747-774) | No — `Remaining()` called only by `/status` (server.go:233); `Select` never reads it | **No** | Go collects, displays, and never acts: it dials past the operator's `daily_cap` and learns only via a 429, which also burns the 3-error budget. |

**Reasons, per difference.** Two are simply wrong against the repo's own decisions
(latency-first ordering vs ADR-0001 §4.4; non-resetting quota arithmetic vs ADR-0003).
Two follow honestly from different deployments (standalone OpenAI-compatible endpoint with
in-process state vs runtime-agnostic core with persisted tables; SSE wire guards). One is
unavoidable without shared memory (Go's health/cooldown state is process-local until the
core-contract convergence lands). None is a consequence of one side being "stupid" — the
divergences are policy choices, and two of them have ADRs that already say the other way.

## 3. The decision

**The TS engine is the source of truth; the Go gateway is a protocol-compatible execution
companion.**

Justified against the alternative:

- The decision is already made twice. ADR-0001 §4 chose convergence on the core contract
  with the engine holding routing authority ("Registry.Select keeps giving *candidates*;
  the *order* stops being independently defined"); ADR-0003 put the capacity model in
  `phoenix-core`. This task measured the premise and it holds: all three ADR-0003 claims
  confirmed, ordering divergence real.
- A shared **live** value model would require the two processes to share quota/health
  state — either the Go gateway calls the engine per request (breaking standalone
  deployment and the fleet's "connect a core wherever it runs" claim) or both write the
  same table (the "two definitions, nothing comparing them" trap `ledger.ts` documents).
- The value-level sharing that *is* appropriate already exists by reuse, not by runtime:
  `quota.ts:598-603` deliberately reuses Go's exact `0.7·old + 0.3·new`
  (adapter.go:171), and the wire contracts are shared shapes.

Concretely: (a) `Registry.Select` returns candidates in engine policy order — priority
first, latency as documented input/tiebreak (today adapter.go:187-216 sorts
latency-first and `selection_test.go:69` pins that); (b) `/status` `remaining_requests`
is labelled a process-lifetime readout or dropped — `windowRemaining` (quota.ts:229-237)
is the only correct arithmetic; (c) the Go lockout gets a recovery path — wire `/health`
probe results into `MarkHealthy` (adapter.go:177, no non-test caller today).

**Compatibility impact.** Go keeps `/v1/chat/completions` and `/v1/models` unchanged
(OpenAI SDK audience, ADR-0001 §4.3) and gains the core-contract routes. No TypeScript
change. Only candidate order and `/status` quota semantics move.

**Tests that keep the two from drifting:**

1. *Order conformance* — both runtimes emit the same candidate order for the same
   provider set. `selection_test.go:69` currently encodes the divergence and must be
   rewritten to the converged policy.
2. *Quota arithmetic* — `quota.test.ts` (27 tests) pins the reset roll on the TS side;
   add a Go-side test pinning `Remaining()` as a process-lifetime readout (or remove the
   field from `/status`) so both "remaining" numbers cannot claim to be "daily".
3. *Golden-vector conformance* — same inputs (providers, priorities, cooldowns, quota
   rows) → same routing decision on both runtimes. A cross-language contract has no
   compiler; this is the detector ADR-0001 §4 calls for.
4. *Lockout recovery* — a Go test that a probe-revived adapter (`MarkHealthy`) re-enters
   `Select`. It fails today because no production code calls `MarkHealthy`.

## 4. Found but not fixed (security-relevant)

1. **Fail-closed lockout, no recovery.** Once every adapter supporting a model accumulates
   3 consecutive errors, `Select` returns empty → 404 (server.go:81-85). Revival requires
   a success (unhealthy adapters are never selected, so never succeed) or `MarkHealthy`
   (adapter.go:177, no non-test caller). `/health` probes all adapters (server.go:187-197)
   but discards the results. Recovery = process restart.
2. **Over-quota spend.** Nothing acts on `Remaining()`; the gateway dials past the
   operator's `daily_cap`, discovering the limit only via a 429 — which also burns the
   3-error budget driving finding 1.
3. **Wrong operator number.** After the first daily boundary, `remaining_requests` is
   permanently 0 (clamped, ledger.go:94-96) until restart — reads as "exhausted" when the
   budget may have reset at midnight.
4. **Exhaustion under-reporting.** Only the last error reaches the client (server.go:142);
   no per-attempt list, no skip reasons, no computed `Retry-After` unless the last error
   was a 429.
5. **Dormant providers are dialled.** A keyless provider entry is registered
   (assemble.go:21-28) and fails per-request, accumulating `cloudErrors` — the doctrine
   flock.ts:79-85 documents. (Config in practice always carries a key; nothing enforces
   it.)

Already fixed by another lane (verified in tree): the non-streaming usage bug TASK-007
flagged is fixed at server.go:106-111 (`u = resp.Usage` with the finding comment).

## 5. Acceptance

```
GOFLAGS=-mod=readonly go build all                                       → exit 0
GOFLAGS=-mod=readonly go vet github.com/shaiinarab/simorgh/...            → exit 0
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/... -count=1  → all ok (7 modules)
git log --oneline -1   → 721a189 docs: mark the shipped flock stories and leave 5.4 deliberately half-open
npm run typecheck       → exit 0
```

Typecheck note: this task wrote no TypeScript, so the green typecheck is not attributable
to these reads — it reflects the other lanes' state, which was green at commit `721a189`.

No git commit/push/rebase performed. `gateway/`, `packages/`, `phoenix-core/`,
`docs/adr/**` untouched (reads only). Allowlist honoured: the only files written are this
report, `docs/research/ROUTING-CONVERGENCE.md`, `docs/research/GO-QUOTA-FINDINGS.md`,
and `mailbox/OUTBOX/TASK-013-INTRO.md`.

TASK-013-END
