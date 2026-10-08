# TASK-012 — Native Compute Audit: intro

I am the performance-audit specialist for this lane. Read-only: I measure the real
functions in `phoenix-core`, compute what a faster implementation could actually buy,
and recommend for or against Rust/Wasm on numbers, not vibes.

**Role.** I reach for the clock first and the code second. The brief's hypothesis —
Simorgh's hot paths are I/O-bound and the scheduler is a few dozen float ops — is
falsifiable, and the repo's own ADR-0001/0002 bar is "evidence, not intent". So the
deliverable is a benchmark under `bench/native-audit/` that imports the real modules
(no copied functions), reports median/p95/N/machine, and a ceiling computation that
divides each hotspot's cost by a real per-request budget.

**Read on the brief.** Well-specified. The one ambiguity: "per-request CPU budget" is
not a number the repo publishes, so I will ground it in the one hard fact the pipeline
has — the provider HTTP call is the wall-time dominant term — and state my assumption
explicitly rather than invent a p95. The negative-control requirement is the right
instinct; I am planting one.

**What I would ask a maintainer.** Two things. (1) Is there a measured end-to-end
request latency anywhere (dashboard, logs) I can divide against, or is the 500 ms
provider-call assumption the right order of magnitude? (2) If the answer is "the
sanitizer worries me, not the scheduler", say so — `sanitizeModelOutput` is the one
candidate where input size (answer bytes) is unbounded, and it is the row I would
watch if this verdict is ever revisited.

First action: verify Node can import `phoenix-core/src/*.ts` unbuilt, then build the
harness. No code changes outside `bench/native-audit/**` and the report.
