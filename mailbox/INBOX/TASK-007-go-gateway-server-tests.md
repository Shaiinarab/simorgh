# TASK-007 — test the Go gateway's HTTP surface *before* converging it on the core contract

- Owner: any
- Status: done (Lead 2026-09-22T14:56)
- Depends on: nothing · Estimate: 60–90 min · Runner: codex lane (headless)

## Why this exists

`gateway/internal/server/server.go` (321 lines) carries the whole product: the route table, the
failover loop, the SSE writer, the client-gone short-circuit, the headers-sent guard, the OpenAI error
shape. It has **no test file**. `packages/providers/selection_test.go`, `packages/crypto`,
`packages/config` and `packages/ledger` are all tested; the HTTP surface is not.

That matters right now because `docs/adr/ADR-0001-go-workspace-role.md` makes convergence on the core
contract (`/api/v1/flock/status`, `/api/v1/agent/execute`, `/mcp`) the next step for this gateway.
Convergence edits `server.go`. Editing an untested failover loop is how a working failover loop breaks
quietly. **This brief is the prerequisite, not the follow-up.**

## Read first

- `gateway/internal/server/server.go` — the entire surface. `New`, `Handler`, `IssueBotToken`,
  `RevokeBotToken`, and the six handlers.
- `gateway/internal/server/assemble.go` — `Assemble`, which builds a Registry from config
- `packages/providers/adapter.go` — the `Adapter` interface you must fake, and `Registry`
  (`Register`, `Select`, `RecordResult`, `Models`, `All`)
- `packages/ledger/ledger.go` — `New`, `Record`, `Snapshot`, `Remaining`, `SetDailyCap`, `Uptime`
- `packages/providers/groq/groq_test.go` — the house style for a Go test in this repo; match it
- `docs/adr/ADR-0001-go-workspace-role.md` §6 — why this task exists

## Deliverable 1 — `gateway/internal/server/server_test.go` (new)

Use `net/http/httptest`. Write a **fake `Adapter`** with configurable per-method behaviour (error or
success, per call), and count how many times each of its methods was called — several of the tests
below are only meaningful as call-count assertions.

At least **14** tests. Cover all of:

**Route table**
1. `GET /` → 200, body has `service: "simorgh-gateway"` and a `version`.
2. An unknown path under `/` → 404 with the OpenAI error envelope
   (`{"error":{"message":…,"type":…,"code":…}}`) — not a bare 404.

**`POST /v1/chat/completions` validation**
3. Malformed JSON body → 400, `code: "invalid_request_error"`.
4. Missing `model` → 400, and **no adapter is dialled** (assert the call count is 0).
5. **Missing `messages` → 400, and no adapter is dialled.** ⚠️ See the bug note below.
6. A model no adapter supports → 404, `code: "model_not_found"`.

**Failover**
7. First candidate errors, second succeeds → 200, and the response body is the *second* adapter's.
8. Every candidate fails → 502, `code: "provider_error"`.
9. A `*providers.RateLimitedError` → **429** with a `Retry-After` header, and the header is in seconds.
10. Success records the provider's usage in the ledger (assert `Snapshot()` token counts) and calls
    `RecordResult` with a nil error.
11. Failure records an error in the ledger and calls `RecordResult` with the error.

**Streaming**
12. `stream: true` → `Content-Type: text/event-stream`, each chunk is `data: <json>\n\n`, and the
    stream ends with `data: [DONE]\n\n`.
13. **Client-gone is not a provider error.** Cancel the request context during the stream, then assert
    the ledger recorded **neither a request nor an error** for that adapter — the handler must return
    without recording and without failing over.
14. **Headers-sent refuses to fail over.** Once a stream has begun and the first adapter then fails,
    exactly **one** adapter must have been dialled. (This is the `Content-Type == "text/event-stream"`
    guard in the error path. Proving it needs a fake that streams one chunk *and then* returns an
    error.)

**`GET /v1/models`**
15. Aggregates across adapters, and a warning appears in `simorgh_warnings` when one adapter's
    `ListModels` errors — the request still returns 200.

**`GET /health`**
16. `status: "ok"` with an uptime string when every adapter is healthy; `status: "degraded"` and the
    adapter's error text when one is not.

**`GET /status`**
17. Per-provider counters reflect a real `Ledger` after recorded usage; `remaining_requests` and
    `daily_cap` appear **only** when a cap was set via `SetDailyCap`, and are **absent** otherwise.

**`GET /simorgh/config`**
18. 404 when no `Bootstrapper` is wired.
19. 401 without a bearer token; 401 with a token that was never issued.
20. 200 and the bootstrapper's payload with a token from `IssueBotToken`; then 401 again after
    `RevokeBotToken`.

> **Bug note — read this before writing test 5.** In `handleChatCompletions` the missing-`messages`
> branch writes the 400 error but has **no `return`**:
>
> ```go
> if len(req.Messages) == 0 {
>     writeOpenAIError(w, 400, "invalid_request_error", "missing required field: messages")
> }
> ```
>
> A request with a `model` and no `messages` therefore **continues into the failover loop**. Write
> test 5 to assert the *correct* behaviour (400 **and** zero adapters dialled). It will fail. Then fix
> it by adding the single missing `return`, and say so plainly in your report. **Do not** weaken the
> test to match the bug, and do not change anything else in that file.

## Allowlist — touch nothing else

```
gateway/internal/server/server_test.go   (new)
gateway/internal/server/server.go        (ONLY to add the missing `return` described above)
```

Do **not** add the core-contract routes, do not touch the routing policy, do not change the health
payload shape, do not edit `packages/**`, `bot/`, `tools/`, or anything TypeScript. Those are later
tasks with their own briefs.

## Acceptance — run these and paste the output verbatim

```bash
cd /home/shai/personal/projects/projects/opensource/simorgh-platform
GOFLAGS=-mod=readonly go build all && echo OK-build
GOFLAGS=-mod=readonly go vet github.com/shaiinarab/simorgh/... && echo OK-vet
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/... -count=1
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/gateway/internal/server -v -count=1
```

`GOFLAGS` **must** be set per command. This host's `~/.config/go/env` carries `GOFLAGS=-mod=vendor`
(written by an unrelated project), which makes every non-vendored build fail with a misleading
`inconsistent vendoring in <dir>` even though no `vendor/` directory exists.

`-count=1` in step 4 is not optional: without it `go test` replays a cached result and the output is
not evidence.

## Report

`mailbox/OUTBOX/TASK-007-REPORT.md`, per `mailbox/README.md`, ending with `TASK-007-END` as the last
non-empty line. Include:

- the acceptance output verbatim,
- the test count and the names of all tests,
- **explicitly: whether the missing-`messages` bug was real, whether the test caught it, and the
  one-line fix you applied**,
- anything in `server.go` you believe is wrong but did **not** change (name it, do not fix it),
- whether `go test` reported any race — and if you did not run with `-race`, say so.
