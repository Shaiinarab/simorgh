# Routing convergence — TypeScript engine vs Go gateway

TASK-013 deliverable. Read-only comparison; evidence, not patches. All line numbers verified
against the worktree at commit `721a189`.

## The comparison

| Decision | TypeScript engine | Go gateway | Same? | Where they differ |
|---|---|---|---|---|
| Candidate ordering | Static priority order (`byPriority`, `phoenix-core/src/provider.ts:176-178`). Latency EMA exists (`quota.ts:119`) but only breaks ties on the *urgent* quota path (`pickUrgent`, `quota.ts:552-560`). | Healthy first, then lower latency EMA, then lower priority (`Registry.Select` + `better`, `packages/providers/adapter.go:187-216`). | **No** | Go reorders by measured latency on every request; TS holds priority fixed and uses latency only for urgent quota scheduling. This is exactly the "competing rule" ADR-0001 §4.4 says must stop being independently defined. |
| Dormant / secret-absent skip | Skipped without charge, no cooldown, recorded as a `dormant` attempt (`flock.ts:94-97`). Doctrine: a missing key is a deployment fact, not a provider fault. | No dormant concept. A provider entry with no key is still registered (`assemble.go:21-28` leaves `key = ""`) and dialled per-request; it fails and accumulates `cloudErrors`. Only `Enabled: false` is skipped, at assembly (`assemble.go:18-20`). | **No** | Go penalises a provider that was never dialled — the exact mistake `flock.ts:79-85` documents avoiding. |
| Cooldown after failure | Time-based: 60 s for rate-limit, 15 s otherwise (`health.ts:32-33`, `cooldownFor` 47-49), persisted in `bird_health`, self-expiring, background sweep (`sweepStale`, `health.ts:122-130`). | No time-based cooldown. 3 consecutive errors → `healthy = false` (`adapter.go:159-163`); any success revives (`adapter.go:166-167`). Unhealthy adapters excluded from `Select`. | **No** | Different mechanism *and* different recovery: TS heals by the clock; Go heals only via a success that unhealthy adapters never receive (see lockout finding, GO-QUOTA-FINDINGS.md). |
| Fail-through on a thrown provider | try/catch at the single dial site (`flock.ts:105-114`); shipped providers also self-catch (`provider.ts:123-125`). A throwing provider becomes one failed attempt; the loop continues. | Error-return idiom (no throws). Loop continues on error (`server.go:117-130`) with two wire guards: client-gone is not a provider error and does not fail over (`server.go:119-121`); once SSE headers are sent, failover is refused (`server.go:125-128`). | **Yes**, structurally | Go's two wire guards have no TS equivalent because the TS engine does not stream (ADR-0001 §1 table). |
| Exhaustion reporting | Every attempt lands in `flock_attempts` with its reason, including `dormant` and `cooling_down` skips (`flock.ts:91-119`). `flockRetryAfterSeconds` emits the soonest real cooldown expiry, or an honest `null` when there is nothing to wait for (`flock.ts:169-178`). | Only the **last** error is surfaced (`server.go:88`, `135-143`). `Retry-After` only when the last error is a `RateLimitedError` (`server.go:138-141`). | **No** | A Go client cannot distinguish "every provider rate-limited" from "last provider had a wire error", gets no per-attempt list, no skip reasons, and no computed retry hint. |
| Usage ever *acted on* | Yes. `planQuotaRun` returns run/delay/unavailable from quota windows with reset horizons (`quota.ts:463-543`); `recordUsage` folds real requests into counters with the period roll (`quota.ts:747-774`). | No. `Remaining()` is called only by `GET /status` (`server.go:233`); `Registry.Select` never reads it (ADR-0003 claim 3, confirmed). | **No** | Go collects, displays, and never acts: it dials past the operator's `daily_cap` and learns the limit only via a 429 — which also burns the 3-error budget. |

## Why they differ

Three distinct reasons, and telling them apart is the point:

1. **Simply wrong against the repo's own decisions.** Latency-first ordering (ADR-0001 §4.4:
   "the *order* stops being independently defined") and the non-resetting quota arithmetic
   (ADR-0003: `windowRemaining` is the replacement). Both are policy divergences, not
   deployment differences.
2. **Different deployments, honestly.** The Go gateway is a standalone OpenAI-compatible
   endpoint with in-process state, SSE streaming, and sealed secrets; the engine is a
   runtime-agnostic core with persisted health/quota tables. The wire guards and the
   health-probe shape follow from that.
3. **Unavoidable without shared memory.** Cooldown state in TS persists across restarts
   (`bird_health`); Go's registry state dies with the process. Until the Go gateway
   converges on the core contract (ADR-0001 §4.3), its health/cooldown view is
   process-local by construction.

## Decision

**The TS engine is the source of truth; the Go gateway is a protocol-compatible execution
companion.**

Justification against the alternative:

- The decision is already made twice. ADR-0001 §4 chose convergence on the core contract
  with the engine holding routing authority; ADR-0003 put the capacity model in
  `phoenix-core`. This task *measured* the premise: all three ADR-0003 claims about the Go
  side are confirmed (see GO-QUOTA-FINDINGS.md), and the ordering divergence is real.
- A shared **live** value model (option 2) would require the two processes to share
  quota/health state — either the Go gateway calls the engine per request (breaking
  standalone deployment and the fleet's "connect a core wherever it runs" claim) or both
  write the same table (the "two definitions, nothing comparing them" trap that
  `ledger.ts` documents having already paid for once).
- The value-level sharing that *is* appropriate already exists by reuse, not by runtime:
  the latency EMA constants are shared (`quota.ts:598-603` deliberately reuses Go's
  `0.7·old + 0.3·new` from `adapter.go:171`), and the wire contracts are shared shapes.

What option 1 requires concretely:

1. `Registry.Select` returns candidates in engine policy order — priority first, latency as
   the documented input/tiebreak (ADR-0001 §4.4). Today `adapter.go:187-216` still sorts
   latency-first and `selection_test.go:69` (`TestSelectionPrefersLowerLatency`) pins that.
2. `/status` `remaining_requests` is labelled a process-lifetime readout or dropped; the
   engine's `windowRemaining` (`quota.ts:229-237`) is the only correct arithmetic.
3. The Go fail-closed lockout gets a recovery path: wire `/health` probe results into
   `MarkHealthy` (`adapter.go:177`, currently no non-test caller).

**Compatibility impact.** Go keeps `/v1/chat/completions` and `/v1/models` unchanged (the
OpenAI SDK audience, ADR-0001 §4.3) and gains the core-contract routes. No TypeScript
change. Only candidate order and `/status` quota semantics move.

**Tests that keep the two from drifting:**

1. *Order conformance* — one test asserting both runtimes emit the same candidate order
   for the same provider set. `selection_test.go:69` currently encodes the divergence and
   must be rewritten to the converged policy.
2. *Quota arithmetic* — `quota.test.ts` (27 tests) already pins the reset roll on the TS
   side; add a Go-side test pinning `Remaining()` as a process-lifetime readout (or
   remove the field from `/status`) so both "remaining" numbers cannot claim to be "daily".
3. *Golden-vector conformance* — same inputs (providers, priorities, cooldowns, quota
   rows) → same routing decision on both runtimes. This is the cross-language drift
   detector ADR-0001 §4 calls for: a cross-language contract has no compiler.
4. *Lockout recovery* — a Go test that a probe-revived adapter (`MarkHealthy`) re-enters
   `Select`. It fails today because no production code calls `MarkHealthy`.
