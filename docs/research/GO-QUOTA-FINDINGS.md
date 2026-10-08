# Go quota findings — ADR-0003 fact check and unfixed defects

TASK-013 deliverable. Read-only; evidence with `file:line` and quoted code. Worktree at
commit `721a189`. Companion to `ROUTING-CONVERGENCE.md`.

## ADR-0003 fact check — all three claims CONFIRMED

ADR-0003 (`docs/adr/ADR-0003-free-compute-capacity.md:18-25`) makes three factual claims
about the Go side. Each was verified against the source.

### Claim 1 — `Remaining()` is `cap - used-since-boot`, no reset: **CONFIRMED**

`packages/ledger/ledger.go:82-98`:

```go
func (l *Ledger) Remaining(providerID string) (remaining, cap int, known bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	c := l.daily[providerID]
	if c <= 0 {
		return 0, 0, false
	}
	var used int64
	if e := l.usage[providerID]; e != nil {
		used = e.Requests
	}
	r := int64(c) - used
	if r < 0 {
		r = 0
	}
	return int(r), c, true
}
```

- `used` is `e.Requests` (ledger.go:91), which is only ever **incremented** — in `Record`
  (ledger.go:60: `e.Requests++`). No reset method exists in the package; the exported
  surface is exactly `New`, `SetDailyCap`, `Record`, `Snapshot`, `Remaining`, `Uptime`.
- The only time field, `start` (ledger.go:31), feeds `Uptime()` alone (ledger.go:101).
- The test suite **pins** the no-reset behaviour: `packages/ledger/ledger_test.go:62-67`
  records 200 requests against a cap of 100 and asserts remaining clamps to 0 — no daily
  roll is asserted anywhere in the package.

Nuance the ADR states correctly: the counter is per-process-lifetime, so a restart resets it
(fresh `New()`), but a "daily" budget never returns on the daily horizon. After the first
day boundary the number is wrong forever (clamped at 0) until restart.

### Claim 2 — `groq.go:50` discards `dailyCap`: **CONFIRMED**

`packages/providers/groq/groq.go:50`:

```go
_ = dailyCap // ledger wiring happens at the gateway layer (Epic 2/7)
```

The comment's claim about *where* the wiring happens is also accurate:
`gateway/internal/server/assemble.go:31` passes `p.DailyCap` into `groq.New`, and
`assemble.go:35-36` calls `led.SetDailyCap(p.ID, p.DailyCap)`. So the cap does reach the
ledger — but only for the `/status` readout (`server.go:233-236`). The adapter itself never
sees it, and nothing consumes it for routing. The ADR's claim is about the discard at
groq.go:50; confirmed.

### Claim 3 — `Registry.Select` never reads `Remaining()`: **CONFIRMED**

`packages/providers/adapter.go:187-206`:

```go
func (r *Registry) Select(model string) []Adapter {
	var cands []*Candidate
	for _, id := range r.order {
		c := r.byID[id]
		if c.healthy && c.Supports(model) {
			cands = append(cands, c)
		}
	}
	// insertion sort — registry sizes are tiny (tens)
	for i := 1; i < len(cands); i++ {
		for j := i; j > 0 && better(cands[j], cands[j-1]); j-- {
			cands[j], cands[j-1] = cands[j-1], cands[j]
		}
	}
	...
}
```

`better()` (adapter.go:208-216) compares only `healthy`, `latencyEMA`, `priority`. The
`Candidate` struct (adapter.go:100-107) has no quota field. A grep of the whole Go tree
shows exactly one `Remaining()` call site outside the ledger package:
`gateway/internal/server/server.go:233` in `handleStatus` — reporting only.

**Bottom line:** the ADR's factual basis holds. Its framing — "a readout rather than a
scheduler" — is accurate, including that the cap is operator-configured
(`packages/config/config.go:29`, yaml `daily_cap`, with local-override propagation at
config.go:108-109).

## Found but not fixed (security-relevant; the Lead needs these)

1. **Fail-closed lockout, no recovery path.** Once every adapter supporting a model
   accumulates 3 consecutive errors, `Select` returns empty and the server answers 404
   (`server.go:81-85`). Revival paths: a success (`adapter.go:166-167`) — but unhealthy
   adapters are excluded from `Select`, so they never receive a request to succeed with —
   or `MarkHealthy` (`adapter.go:177`), which has **no non-test caller** (grep-verified).
   `/health` probes every adapter (`server.go:187-197`) but discards the results into the
   payload without feeding the registry. Recovery today = process restart.
2. **Over-quota spend.** Nothing acts on `Remaining()`. The gateway keeps dialling a
   provider whose `remaining_requests` is 0, discovering the limit only via a 429 — which
   also counts toward the 3-error budget that drives finding 1. An operator who configured
   `daily_cap` gets no enforcement of it.
3. **Wrong number reported to operators.** After the first daily boundary,
   `remaining_requests` is permanently 0 (clamped, ledger.go:94-96) until restart. It reads
   as "exhausted" when the budget may have reset at midnight.
4. **Exhaustion under-reporting.** Only the last error reaches the client
   (`server.go:88`, `135-143`); no per-attempt list, no skip reasons, no computed
   `Retry-After` unless the last error happened to be a 429. The TS engine surfaces every
   attempt with reasons (`flock.ts:91-119`) and an honest retry hint or `null`
   (`flock.ts:169-178`).
5. **Dormant providers are dialled.** A provider entry with no key is still registered
   (`assemble.go:21-28` leaves `key = ""`), so it fails per-request and accumulates
   `cloudErrors` — penalising a provider that was never dialled, the exact doctrine
   `flock.ts:79-85` documents. (Config in practice always carries a key; nothing enforces
   it.)

Already fixed by another lane (verified in tree, not by this task): the non-streaming
usage-recording bug TASK-007 flagged is fixed at `server.go:106-111` (`u = resp.Usage` with
the finding comment).

## Acceptance (from the brief, run 2026-10-08)

```
GOFLAGS=-mod=readonly go build all                                  → exit 0
GOFLAGS=-mod=readonly go vet github.com/shaiinarab/simorgh/...       → exit 0
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/... -count=1  → all ok
git log --oneline -1   → 721a189 docs: mark the shipped flock stories and leave 5.4 deliberately half-open
npm run typecheck       → exit 0 (no TS written by this task; not attributable to these reads)
```
