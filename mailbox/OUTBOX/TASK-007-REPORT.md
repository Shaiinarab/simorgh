# TASK-007 — Go gateway HTTP surface tests

## Status

Done

## Summary

Created `gateway/internal/server/server_test.go` with 19 test functions (20 test cases including subtests) covering all HTTP surface areas of the gateway server: route table, chat completions validation, failover, streaming, models, health, status, and bootstrap config. Also fixed the missing-`messages` bug in `server.go`.

### Test names

1. TestRootReturnsServiceAndVersion
2. TestUnknownPathReturnsOpenAIError
3. TestMalformedJSONReturns400
4. TestMissingModel400NoAdapterCalled
5. TestMissingMessages400NoAdapterCalled
6. TestModelNotFound404
7. TestFailoverFirstErrorsSecondSucceeds
8. TestAllCandidatesFail502
9. TestRateLimited429RetryAfter
10. TestSuccessRecordsLedgerUsage
11. TestFailureRecordsLedgerError
12. TestStreamReturnsSSE
13. TestClientGoneNotProviderError
14. TestHeadersSentRefusesFailover
15. TestModelsAggregatesWithWarnings
16. TestHealthOkAndDegraded (subtests: all_healthy, one_degraded)
17. TestStatusWithLedger
18. TestSimorghConfigNoBootstrapper404
19. TestSimorghConfigAuth

### Fake adapter design

`fakeAdapter` implements the full `providers.Adapter` interface with per-method error/success configuration and call counting (`chatCalls`, `streamCalls`, `healthCalls`, `listCalls`). A `streamBlock` channel enables client-gone testing by blocking the stream until context cancellation. `fakeBootstrapper` implements `Bootstrapper` for config auth tests.

## Checks

```
GOFLAGS=-mod=readonly go build all && echo OK-build
OK-build
GOFLAGS=-mod=readonly go vet github.com/shaiinarab/simorgh/... && echo OK-vet
OK-vet
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/... -count=1
?   	github.com/shaiinarab/simorgh/bot	[no test files]
?   	github.com/shaiinarab/simorgh/gateway/cmd/simorgh-gateway	[no test files]
ok  	github.com/shaiinarab/simorgh/gateway/internal/server	0.057s
ok  	github.com/shaiinarab/simorgh/packages/config	0.007s
ok  	github.com/shaiinarab/simorgh/packages/crypto	0.497s
ok  	github.com/shaiinarab/simorgh/packages/ledger	0.014s
ok  	github.com/shaiinarab/simorgh/packages/providers	0.015s
ok  	github.com/shaiinarab/simorgh/packages/providers/groq	0.122s
?   	github.com/shaiinarab/simorgh/tools	[no test files]
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/gateway/internal/server -v -count=1
=== RUN   TestRootReturnsServiceAndVersion
--- PASS: TestRootReturnsServiceAndVersion (0.00s)
=== RUN   TestUnknownPathReturnsOpenAIError
--- PASS: TestUnknownPathReturnsOpenAIError (0.00s)
=== RUN   TestMalformedJSONReturns400
--- PASS: TestMalformedJSONReturns400 (0.00s)
=== RUN   TestMissingModel400NoAdapterCalled
--- PASS: TestMissingModel400NoAdapterCalled (0.00s)
=== RUN   TestMissingMessages400NoAdapterCalled
--- PASS: TestMissingMessages400NoAdapterCalled (0.05s)
=== RUN   TestModelNotFound404
--- PASS: TestModelNotFound404 (0.00s)
=== RUN   TestFailoverFirstErrorsSecondSucceeds
--- PASS: TestFailoverFirstErrorsSecondSucceeds (0.00s)
=== RUN   TestAllCandidatesFail502
--- PASS: TestAllCandidatesFail502 (0.00s)
=== RUN   TestRateLimited429RetryAfter
--- PASS: TestRateLimited429RetryAfter (0.00s)
=== RUN   TestSuccessRecordsLedgerUsage
--- PASS: TestSuccessRecordsLedgerUsage (0.00s)
=== RUN   TestFailureRecordsLedgerError
--- PASS: TestFailureRecordsLedgerError (0.00s)
=== RUN   TestStreamReturnsSSE
--- PASS: TestStreamReturnsSSE (0.00s)
=== RUN   TestClientGoneNotProviderError
--- PASS: TestClientGoneNotProviderError (0.05s)
=== RUN   TestHeadersSentRefusesFailover
--- PASS: TestHeadersSentRefusesFailover (0.00s)
=== RUN   TestModelsAggregatesWithWarnings
--- PASS: TestModelsAggregatesWithWarnings (0.00s)
=== RUN   TestHealthOkAndDegraded
=== RUN   TestHealthOkAndDegraded/all_healthy
--- PASS: TestHealthOkAndDegraded/all_healthy (0.00s)
=== RUN   TestHealthOkAndDegraded/one_degraded
--- PASS: TestHealthOkAndDegraded/one_degraded (0.00s)
=== RUN   TestStatusWithLedger
--- PASS: TestStatusWithLedger (0.00s)
=== RUN   TestSimorghConfigNoBootstrapper404
--- PASS: TestSimorghConfigNoBootstrapper404 (0.00s)
=== RUN   TestSimorghConfigAuth
--- PASS: TestSimorghConfigAuth (0.00s)
PASS
ok  	github.com/shaiinarab/simorgh/gateway/internal/server	0.067s
```

All tests pass including `-race` (no race conditions detected).

## Missing-`messages` bug

- **Was the bug real?** Yes. In `gateway/internal/server/server.go:78`, the missing-`messages` branch called `writeOpenAIError` but had no `return`, so execution fell through into the failover loop.
- **Did the test catch it?** Yes. `TestMissingMessages400NoAdapterCalled` asserts that a request with a model but no messages returns 400 AND that zero adapter methods were called. Before the fix, the test failed with "adapter called 1 times, want 0", confirming the fallthrough.
- **Fix applied:** Added the single missing `return` statement at `gateway/internal/server/server.go:79` after the `writeOpenAIError(w, 400, "invalid_request_error", "missing required field: messages")` call. No other changes to `server.go`.

## Issues not changed

- **Non-streaming usage not recorded:** The ledger records `u.PromptTokens`/`u.CompletionTokens` in `handleChatCompletions`, but `u` is only populated for streaming requests (`u, err = a.ChatCompletionStream(...)`). For non-streaming, `u` remains zero-valued, so `ledger.Record` stores zero tokens even when `resp.Usage` has values. This is a pre-existing issue in `server.go` — not changed per the brief's allowlist restriction.

## Race conditions

No race conditions were detected. Tests were run with `-race` explicitly; output was clean.

TASK-007-END
