---
name: simorgh-go-workspace
description: The Go side of simorgh — eight modules under go.work, the gateway as a second answering runtime with its own routing policy, the core-contract gap that keeps it out of the fleet, and the GOFLAGS vendoring trap on this host. Use when touching gateway/, packages/, bot/ or tools/, when a go build fails with "inconsistent vendoring", or when deciding where a gateway feature belongs.
---

# The Go workspace

## What is there

`go.work` declares **eight** modules — `bot`, `gateway`, `tools`,
`packages/{config,crypto,ledger,providers,providers/groq}` — 16 `.go` files, ~1 900 lines. Committed at
`7a54d64 feat(go): land the self-hosted gateway workspace`, and green in CI (the `go` job in
`.github/workflows/ci.yml`).

```
GOFLAGS=-mod=readonly go build all
GOFLAGS=-mod=readonly go vet  github.com/shaiinarab/simorgh/...
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/... -count=1
```

or `npm run go:build` / `go:vet` / `go:test`.

## The `GOFLAGS` trap — this is the one that wastes an afternoon

This host's `~/.config/go/env` contains, written by an **unrelated project**:

```
GOFLAGS=-mod=vendor
GOPROXY=off
GOSUMDB=off
GOTOOLCHAIN=local
```

So every build of a non-vendored module fails with:

```
inconsistent vendoring in /path
```

…even though **no `vendor/` directory exists**. The message is misleading; the cause is the global env.
**Override per command** (`GOFLAGS=-mod=readonly go build all`). **Do not delete that file** and do not
add a `vendor/` directory — other projects on this box genuinely want `-mod=vendor`.

Second trap: in a workspace, `go build all` / `go test all` also pulls the **stdlib's and dependencies'
own tests**. Scope with the module-path pattern: `go test github.com/shaiinarab/simorgh/...`.

`-count=1` on any test run that is meant as evidence — otherwise Go replays a cached result.

## `gateway/` is a second *answering runtime*, not scaffolding

`gateway/internal/server/server.go` (321 lines) serves an **OpenAI-compatible** surface:

- `POST /v1/chat/completions` — **with SSE streaming** (`stream: true`). No TypeScript host streams.
- `GET /v1/models` — aggregated catalog across adapters, with per-provider warnings.
- `GET /health` — `{status, uptime, providers[]}`.
- `GET /status` — per-provider requests/tokens/errors **plus remaining daily quota** from a configured
  cap. No TypeScript host models quota.
- `GET /simorgh/config` — bootstrap channel for bot peers behind bearer-token auth.

`packages/crypto` seals provider keys with **AES-256-GCM** and argon2id derivation — **secrets at rest**.
The TypeScript side reads secrets from the environment only. That asymmetry is real and, so far, unowned.

## Two policies for the same question — the actual risk

| | Go `Registry.Select` | engine `flock` routing |
|---|---|---|
| order | health → latency EMA → priority | priority → cooldowns, dormant skipped |
| demotion | **3 consecutive errors** → unhealthy | cooldown timestamp |
| latency | EMA `0.7·old + 0.3·new` | not modelled |

Neither is wrong. Maintaining both with nothing that fails when they diverge **is** the problem. The
recorded direction (ADR-0001) is the engine's policy becomes authoritative and the latency EMA becomes
an *input* to it, not a competing rule.

Good behaviour in `server.go` worth preserving — each has a reason:

- rate-limited upstream → **429 + `Retry-After`**, not a generic 502
- **client gone** (`r.Context().Err() != nil`) is **not** a provider error and must not fail over
- once headers are on the wire, **failover is impossible** — return, do not retry
- errors use the OpenAI error envelope, so existing SDK clients understand them

## The core-contract gap

The platform dials `/health`, `/api/v1/flock/status`, `/api/v1/agent/execute`,
`/api/v1/user/{id}/logs` and `/mcp`. **The Go gateway exposes none of them**, so it cannot join the
fleet. That is the concrete reason the product's central promise ("connect a core wherever it runs")
today holds only for TypeScript hosts.

And `gateway/internal/server` has **no test file** — `packages/providers/selection_test.go` (142 lines),
`packages/crypto`, `packages/config` and `packages/ledger` are tested; the HTTP surface, the SSE writer
and the failover loop are not.

**Order matters: tests before convergence.** A cross-language contract has no compiler — nothing fails
when Go's `/health` and the engine's `/health` drift apart. The only detector is a test on each side
asserting the same shape, so tests are what make convergence safe rather than the paperwork after it.

## Working in here

- Read `docs/adr/ADR-0001-go-workspace-role.md` before proposing a change. **Nothing was deleted, and
  nothing should be** — the Go side is the only implementation of streaming, OpenAI wire compatibility,
  sealed secrets and quota visibility.
- Match the house style in `packages/providers/groq/groq_test.go`.
- Test with `net/http/httptest` and a **fake `Adapter` that counts calls** — several of the behaviours
  above (client-gone, headers-sent, no-adapter-dialled) are only provable as call-count assertions.
- The `Adapter` interface must be satisfied for concurrency; state that when you implement one.
- `bot/main.go` (6 lines) and `tools/main.go` (7 lines) are stubs. Leave them alone unless a brief says
  otherwise.
