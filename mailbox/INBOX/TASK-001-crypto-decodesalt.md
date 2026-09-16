# TASK-001 — `crypto.DecodeSalt` is called but never defined; the Go workspace does not build

- Owner: any
- Status: done (Lead 2026-09-16T21:49)
- Depends on: nothing · Estimate: 20–35 min · Runner: fb2 or fb3 container session

## Why this exists

The Go side of simorgh-platform has never been committed and **does not compile**. One error, and it
blocks every other Go lane (the gateway binary cannot be built at all):

```
$ go build all
# github.com/shaiinarab/simorgh/gateway/cmd/simorgh-gateway
gateway/cmd/simorgh-gateway/main.go:62:23: undefined: crypto.DecodeSalt
```

`packages/crypto/crypto.go` exports `NewSalt`, `DeriveKey`, `Encrypt`, `Decrypt`, `NewSecretBox` —
there is no `DecodeSalt`. The caller (`gateway/cmd/simorgh-gateway/main.go`, the `unlock` path) reads
the per-install salt out of the config as **base64** and expects a decoder returning
`([]byte, error)`:

```go
saltB64 := ""
for _, p := range cfg.Providers {
    if p.Key != nil { saltB64 = p.Key.Salt; break }
}
salt, err := crypto.DecodeSalt(saltB64)
if err != nil { log.Fatalf("salt: %v", err) }
box = crypto.NewSecretBox(pass, salt)
```

So the salt is stored base64 (produced from `NewSalt()`) and read back here. The fix is to add the
decoder the caller already assumes — **not** to change the caller, unless the interface is genuinely
wrong (say so in the report if it is).

## Deliverable

1. `packages/crypto/crypto.go` — `DecodeSalt(s string) ([]byte, error)`, base64-decoding the salt
   the config carries. Decide and document the encoding explicitly in a comment
   (`StdEncoding` vs `RawStdEncoding` matters: padded vs unpadded, and the mismatch is silent at
   first and fails at `NewSecretBox` time). Whatever you pick, a salt produced by `NewSalt()` and
   encoded with the matching encoder must round-trip.
2. A test in `packages/crypto/crypto_test.go` proving the round trip **and** the failure path
   (empty string, invalid base64, wrong padding) — the existing suite style is table-free `Test*`
   functions, match it.
3. Remove the build break: `go build all` must be clean.

## Acceptance — paste the real output

```bash
# use the scoped flags: the host go env is polluting with -mod=vendor (see mailbox/README.md)
GOFLAGS=-mod=readonly go build all
GOFLAGS=-mod=readonly go vet ./packages/... ./gateway/... ./bot/... ./tools/...
GOFLAGS=-mod=readonly go test ./packages/... ./gateway/... ./bot/... ./tools/...
```

**Do not** run `go test all` — in a workspace it also runs the stdlib's and dependencies' own tests.

## Prove the test can fail

In a throwaway copy, break the round trip (flip the base64 variant, or return the input unchanged)
and paste the failing assertion. A test you have never seen fail is not a test.

## Allowlist

- `packages/crypto/crypto.go`
- `packages/crypto/crypto_test.go`
- `mailbox/OUTBOX/TASK-001-REPORT.md`
- `mailbox/NAGS/open-*`

**Do NOT touch:** `gateway/**`, `bot/**`, `tools/**`, `src/**` (TypeScript), `docs/**`,
`go.work`, `mailbox/bin/fbmail`, another task's brief.

## Hard rules

- Lock first: `mailbox/bin/fbmail lock packages/crypto/crypto.go packages/crypto/crypto_test.go -b TASK-001`,
  and `mailbox/bin/fbmail unlock --all` when done.
- **Stack is pinned** — plain Go, no new dependency. The module already has `golang.org/x/crypto`;
  a base64 decoder is stdlib `encoding/base64`, so this needs nothing new.
- **Never** `git commit` / `git push` / `git rebase`. The Lead integrates and commits.
- English for code comments. Persian only for user-facing text (there is none in this lane).
- If the salt encoding in `cfg.Providers[].Key.Salt` cannot be determined from the code, **say so**
  and state the assumption you made — do not guess silently.

## Report

`mailbox/OUTBOX/TASK-001-REPORT.md` per the template in `projects/shiraz-league/mailbox/README.md` §7
(same protocol), ending with `TASK-001-END` as the **last non-empty line**.
