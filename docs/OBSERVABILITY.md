# Observability — what exists, what is derivable, and the minimum viable layer

**Written:** 2026-09-22 · **Status:** assessment. Nothing implemented; §4 is a proposal.

## 1. What exists today

| Signal | Where | Notes |
|---|---|---|
| Request correlation | `src/index.ts:35-36`, `simorgh-platform/src/runtimes/node.ts` | `X-Request-Id` on every response, and used as the correlation field in every error payload |
| Error logging | `src/index.ts:151`, node runtime `catch` | `console.error(JSON.stringify({ event, requestId, … }))` — structured, not prose |
| Cron event | `src/index.ts:570` | `{ event: "flock_sweep", changed }` |
| Provider health | `phoenix-core/src/health.ts` `bird_health` table | `status`, `consecutive_failures`, `cooldown_until`, `last_ok`, `total_calls`, `total_failures` |
| Flock view | `GET /api/v1/flock/status` | The persisted health table, read back |
| Transparency ledger | `phoenix-core/src/ledger.ts` | Append-only: user, tier, ref, timestamp, action, details — written **before** the flight |
| Rate-limit headers | `X-RateLimit-Limit/Remaining/Reset`, `Retry-After` | On every `/api/v1/agent/execute` response |
| Traces / metrics | — | **none**, and no dependency for either (`package.json` has no `pino`, `@opentelemetry/*`, `prom-client`) |

That is a better starting point than "partial" suggests. The two things a distributed system usually
buys first — **correlation** and a **durable record of what happened** — are both already here, and the
ledger is deliberately append-only and written before any provider is dialled, so it is *not* lossy under
failure. Which leads to the main observation:

## 2. The ledger is already the telemetry

Almost every question an operator asks can be answered by **reading tables that already exist**, not by
emitting new signals:

| Question | Already answerable from |
|---|---|
| Which providers are tired / cooling? | `bird_health.status`, `cooldown_until` |
| Which provider fails most? | `total_failures` / `total_calls` |
| What did user X do, and did it succeed? | the ledger, via `GET /api/v1/user/{id}/logs` |
| Was the flock degraded for this request? | the ledger entry's `details` + `ref_id` |
| Is a bird dormant or broken? | `describeFlock` — dormant is computed, not persisted |
| Am I being rate-limited? | the rate-limit headers |

So the gap is **not instrumentation. It is a query surface.** The cheapest useful observability work here
is exposing what is already written — not adding an agent, a collector, or a backend.

## 3. What is genuinely absent

**a. Latency — now recorded, in `quota_state` (2026-10-02).** *Was:* recorded nowhere on the
TypeScript side — a grep for `latency|latencyMs|duration|elapsed` across `phoenix-core/src` and `src`
returned **nothing**, and `bird_health` had no timing column. *Now:* `phoenix-core/src/quota.ts`
writes `latency_ema_ms` / `last_latency_ms` per `(provider, account, model)`, on the Go registry's
exact `0.7·old + 0.3·new`. Two caveats, both deliberate:

- **It is not on `bird_health`.** Recommendation 1 below proposed that column. It went to
  `quota_state` instead, because `bird_health` already owns the call and failure counters, and a
  second copy of a counter is a second truth — the failure mode `ledger.ts` documents having already
  paid for once. Per-account was the more useful grain anyway.
- **Only the scheduler's urgent path reads it.** It is not yet exposed on any endpoint, so
  `docs/STATE-OF-PROJECT.md` still rates observability `⚠️`.

The remaining consequences:

- The flock orders by **priority only**. It has no way to prefer the faster of two healthy providers.
- Nobody can answer "which provider is slow this week, and did it get slower?" — the only timing
  evidence is how long a whole request took, which is not attributed to a provider.
- **The Go gateway does record it** (`Registry.RecordResult` keeps a latency EMA, `0.7·old + 0.3·new`,
  and orders by it). So the two implementations differ in what they can even observe — which is the same
  two-policies problem ADR-0001 records, seen from the telemetry side.

**b. No cross-host correlation.** Each core generates its own request ids, and the platform either
forwards a request to one core or reports failures across several. A request that fails over between
*cores* has no single id threading both. `simorgh ask` mitigates this by reporting every failure rather
than only the last, but nothing carries one id across the hop.

**c. No deployment or fleet-change event.** `deploy` reports to stdout and exits; nothing durable records
"core X was added at T". `fleet-store.ts` holds the current state, not its history.

## 4. Minimum viable layer — four signals, in this order

Each is small, and each is answerable by the store that already exists. **Do not add a metrics backend
for this.**

1. ~~**Record provider latency.**~~ **Done**, with a different table: see (a) above for why
   `quota_state` and not `bird_health`. *The schema prerequisite is now met — what is still missing is
   the consumer: nothing exposes the EMA on an endpoint, and `flyFlock` still orders by priority only.*
2. **Expose a derived summary, not new counters.** One route that reads `bird_health` + the ledger and
   returns per-provider success rate, failure count, current cooldown, and last-ok. No aggregation
   daemon: the tables are small and already indexed by primary key.
3. **Emit an event at the two decision points that matter.** A provider **failover** and a **cooldown
   write** are the moments an operator needs to see; both already exist in code as `recordObservation`
   and `cooldownUntil`. One structured line each, carrying the existing `requestId`.
4. **Correlate across the core hop.** Have `Fleet.ask` pass the platform's request id as
   `X-Request-Id` on the outbound call, so a failover across cores is one trace rather than N. This is a
   header-forwarding change, not an architecture change.

## 5. What not to add

- **No OpenTelemetry SDK, no tracing backend, no metrics pipeline.** For a free-tier, single-operator
  gateway with two hosts, this is more moving parts than product, and it would be the largest dependency
  in the repo. If a hosted backend is ever wanted, `console.log(JSON.stringify(...))` is already the
  right ingestion shape for most of them — the cost of adopting one later is low precisely because the
  logs are structured now.
- **No sampling.** Volumes here are per-provider calls on a free tier; sampling would hide the failures
  the ledger exists to prove.
- **Do not make the ledger best-effort to improve throughput.** It is an architectural contract
  (written *before* the flight). Losing rows to make room for metrics would trade the guarantee for the
  measurement.

## 6. Evidence

```bash
grep -rIn 'latency\|latencyMs\|duration\|elapsed' --include='*.ts' phoenix-core/src src   # → 22 hits, all in quota.ts (latency_ema_ms / last_latency_ms)
grep -n -A 12 'HEALTH_SCHEMA' phoenix-core/src/health.ts                                  # no timing column
grep -n 'latencyEMA\|RecordResult' packages/providers/adapter.go                          # Go does record it
grep -rIn 'console\.\|process.stderr' --include='*.ts' src simorgh-platform/src | head    # structured logs
grep -nE '"(pino|winston|@opentelemetry[^"]*|prom-client)"' package.json                  # → none
```
