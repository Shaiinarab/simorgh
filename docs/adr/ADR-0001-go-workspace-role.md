# ADR-0001 — The role of the Go workspace (`gateway/`, `packages/`, `bot/`, `tools/`)

**Status:** Accepted · **Date:** 2026-09-22 · **Supersedes:** nothing

**Decision in one line:** the Go workspace is **kept as a second answering runtime**. It is not
deleted, not rewritten, and not merged into the TypeScript tree. Its first obligation is **tests for
its untested HTTP surface**; its second is **converging on the core contract** so the platform can
federate it like any other core.

---

## 1. Context

The repository contains two independent implementations of "answer a request by routing it across
fragmented free-tier providers":

| | TypeScript (`phoenix-core` + `src/`) | Go (`gateway/` + `packages/`) |
|---|---|---|
| Wire contract | the **core contract**: `/health`, `/api/v1/flock/status`, `/api/v1/agent/execute`, `/api/v1/user/{id}/logs`, `/mcp` | **OpenAI-compatible**: `/v1/chat/completions` (with SSE), `/v1/models`, `/health`, `/status`, `/simorgh/config` |
| Unit of work | an **agent turn** — a bounded tool loop with synthesis | a **chat completion** — a single provider call |
| Routing policy | priority order, dormant skip, explicit cooldowns, fail-through | health, then latency EMA (`0.7·old + 0.3·new`), then priority; unhealthy after 3 consecutive errors |
| Ledger | append-only **transparency** ledger (what happened, before the flight) | per-provider **usage/quota** ledger (requests, tokens, errors, remaining daily cap) |
| Secrets | read from the environment | **AES-256-GCM sealed at rest**, argon2id key derivation |
| Streaming | none | **SSE**, with correct client-gone and headers-sent handling |
| Provenance | `e126ae8` → the agentic product line | `7a54d64 feat(go): land the self-hosted gateway workspace`, 2026-09-16, tracking the PRD's FR1–FR25 |

Both descend from one PRD (`docs/prd/PRD.md`, 13 epics / 63 stories). They are two products cut from
it along different axes — and the Go one is not a sketch: `gateway/internal/server/server.go` (321
lines) has real failover, real SSE, and real error semantics (`429` + `Retry-After` on
`RateLimitedError`; *do not* fail over when the client disconnected; *cannot* fail over once headers
are on the wire).

### Verified state at the time of this decision

```
GOFLAGS=-mod=readonly go build all                                     → exit 0
GOFLAGS=-mod=readonly go vet    github.com/shaiinarab/simorgh/...      → exit 0
GOFLAGS=-mod=readonly go test   github.com/shaiinarab/simorgh/...      → 5 ok, 3 "no test files"
```

Tests exist for `packages/providers` (incl. `selection_test.go`, 142 lines), `packages/crypto`,
`packages/config`, `packages/ledger`, `packages/providers/groq`.
**`gateway/internal/server` has no test file.** That is the surface that carries the product.

## 2. The problem with the status quo

Not duplication of code — duplication of **policy**. Two routing policies, two health shapes, two
notions of a ledger, maintained by two languages, with nothing that fails when they disagree. The
platform's `doctor` and preflight can reach either one and will report differently for each.

And a concrete product gap: **the Go gateway cannot join the fleet.** The platform dials the core
contract; the Go server does not implement it. So today the product's central promise — *connect a
core wherever it runs* — holds only for TypeScript hosts, which is exactly the claim the modularization
was performed to make true.

## 3. Options considered

**A. Archive the Go workspace.** Cheapest to maintain; deletes the only implementation of SSE
streaming, OpenAI wire compatibility, secrets-at-rest, and quota visibility. Rejected: it removes real
capability and destroys history for the appearance of tidiness.

**B. Rewrite `gateway/` on top of `phoenix-core`.** Impossible as stated — `phoenix-core` is
TypeScript, Go cannot import it. "Consuming the contract" across languages can only mean implementing
the same *semantics*, which brings us to C or D.

**C. Freeze it as an independent OpenAI-compatible gateway.** Honest, and it serves a real audience
(any OpenAI SDK client gets a free, resilient endpoint with SSE). But it permanently institutionalizes
two policies and two ledger shapes, and leaves the fleet claim false for non-TS hosts.

**D. Converge on the core contract, keep the OpenAI surface as a compatibility layer.** *(chosen)*

## 4. Decision

1. **Keep** the Go workspace. Nothing is deleted; `bot/` and `tools/` stay as they are.
2. **Test `gateway/internal/server` first.** Convergence is a change to untested code; that is how a
   working failover loop gets broken quietly. Prerequisite, not follow-up.
3. **Converge on the core contract** as a *superset*: add `GET /api/v1/flock/status`,
   `POST /api/v1/agent/execute`, `POST /mcp` (`simorgh_status`, `simorgh_ask`) and an append-only
   transparency ledger, mapping the registry and usage ledger into the core's envelope
   (`agentResponse`, `meta.answered_by`). `/v1/chat/completions` and `/v1/models` **stay**.
4. **One policy per question.** Routing authority becomes the engine's policy (priority + cooldowns);
   the latency EMA becomes an input to it rather than a competing rule. `Registry.Select` keeps
   giving *candidates*; the *order* stops being independently defined.
5. **Do not mount the Go gateway inside the platform's MCP server**, and do not alias
   `simorgh_*`/`platform_*`. `simorgh_*` means one core; `platform_*` means the fleet. That naming
   collision was already found and fixed once.

### Why the prerequisites are in this order

Convergence touches `server.go`, whose failover, SSE and client-gone paths have **zero** test
coverage. A cross-language contract has no compiler: nothing fails when Go's `/health` and the
engine's `/health` drift apart. The only detector is a test on each side asserting the same shape —
so the tests are the deliverable that makes the convergence *safe*, not the paperwork that follows it.

## 5. Consequences

**Good.** The fleet claim becomes true for non-TypeScript hosts, which is the point of the split. The
Go side keeps streaming, sealed keys and quota visibility, and gains the transparency ledger. The
platform's `byo-endpoint` target becomes genuinely useful rather than nominally so.

**Costs.** Two languages remain in one repo (accepted — the alternative is deleting working
capability). Cross-language contract drift needs a deliberate guard: a conformance test per side, and
ideally the platform's existing connector conformance kit pointed at a real Go core. The Go server
grows a second wire vocabulary, which must be documented as *deliberate compatibility*, not confusion.

**Explicitly not decided here.** Whether the Go gateway eventually absorbs `bot/`; whether SSE is worth
adding to the TypeScript hosts; whether quota modeling belongs in `phoenix-core` (the usage ledger is
a *different artifact* from the transparency ledger and must not be conflated with it).

## 6. Follow-up, in dependency order

1. Add `gateway/internal/server` tests: the route table, the failover loop (all-fail → 502, rate-limited
   → 429 + `Retry-After`), client-gone not counting as a provider error, and headers-sent refusing to
   fail over mid-stream. **Do not touch routing until this exists.**
2. Add the core-contract routes; run the platform's conformance kit against a live Go gateway.
3. Fold the latency EMA into the engine's ordering (or explicitly document why it stays local).
4. Note the accepted divergence in `docs/ARCHITECTURE.md`.

## 7. Evidence

Every claim above is reproducible from the repo root:

```bash
GOFLAGS=-mod=readonly go build all
GOFLAGS=-mod=readonly go vet  github.com/shaiinarab/simorgh/...
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/...
find gateway -name '*_test.go'        # → no results (the §1 gap)
grep -n 'func (s \*Server) handle' gateway/internal/server/server.go
grep -n 'func (r \*Registry)' packages/providers/adapter.go
```

`GOFLAGS` must be overridden per command: this host's `~/.config/go/env` carries
`GOFLAGS=-mod=vendor` (written by another project), which makes every non-vendored build fail with a
misleading `inconsistent vendoring in <dir>` even though no `vendor/` directory exists.
