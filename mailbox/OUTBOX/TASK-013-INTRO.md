# TASK-013 — Intro

I'm the routing-convergence analyst for the simorgh project. My role on this task: read-only
comparison of the two routing implementations (TypeScript engine in `phoenix-core` vs Go gateway in
`gateway/` + `packages/`), fact-check three load-bearing claims ADR-0003 makes about the Go side, and
return evidence — not patches.

What I reach for first: the primary sources. `phoenix-core/src/flock.ts` is the reference routing
policy; `packages/ledger/ledger.go` and the Go registry are what ADR-0003 makes factual claims about.
A claim in an ADR that the source contradicts is the highest-value finding on this task, so the
fact-check drives the order of work: read the Go files named in ADR-0003 *before* building the
comparison table, so the table is written with verified facts rather than the ADR's assertions.

Honest read on the brief: well-specified. The deliverables are enumerated (comparison table, three
verdicts with quoted evidence, one decision), the allowlist is explicit, and the environment trap
(`GOFLAGS=-mod=vendor`) is documented with the exact override. Two things I'd ask a maintainer:
(1) is the Go gateway expected to keep *any* routing policy of its own, or is wire-compatibility the
only bar — the brief's two options assume someone has already ruled on this; (2) the brief says
"another lane is editing" `quota.ts` — I read it but must not write it, so my comparison of the
capacity layer is a snapshot of a moving file.

What I will not do: touch `gateway/`, `packages/`, `phoenix-core/`, `docs/adr/`, or run the TS test
suite. Scratch goes in `.openclaw/tmp/`. No git operations.
