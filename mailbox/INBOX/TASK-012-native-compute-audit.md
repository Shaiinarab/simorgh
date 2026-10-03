# TASK-012 — Native Compute Audit: measure, then recommend *against* Rust unless proven

- Owner: fb2
- Status: open
- Depends on: nothing · Estimate: 60–90 min · Runner: freebuff CLI agent (podman)

## Why this exists

Someone proposed adding a Rust/Wasm core to Simorgh. This task exists to find out whether that is
justified, and my prior expectation is that it **is not** — Simorgh's hot paths are I/O-bound, not
CPU-bound, and the deterministic arithmetic in the scheduler is a few dozen floating-point operations
per decision. A task whose answer is "no" is a real result, and it is the result the repo's own
principle demands:

> Use existing software for commodity capability, own the orchestration/composition layer, and spend
> engineering effort only where Simorgh gains real leverage.

What is **not** acceptable is a verdict of "Rust would be faster" with no measurement. So the deliverable
is a benchmark harness plus a verdict table, and a negative verdict is a first-class outcome.

## Read first

- `phoenix-core/src/quota.ts` — the most arithmetic-dense module: `windowRemaining`, `capacityFor`,
  `postSpendValue` (an `exp()` per window), `planQuotaRun` (`sort`/compare over candidates). This is the
  primary candidate and it is almost certainly not worth accelerating.
- `phoenix-core/src/flock.ts`, `phoenix-core/src/execute.ts` — the per-request pipeline. Count the SQL
  round trips and the `await`s; an answer dominated by I/O cannot be made faster by a faster inner loop.
- `phoenix-core/src/tools.ts` — tool bodies. The only place CPU work could plausibly concentrate.
- `phoenix-core/src/ledger.ts` — append-only writes. Again I/O.
- `phoenix-core/src/security.ts` — hashing. **Check this one carefully**: it may already delegate to a
  port, in which case the only real question is whether the hash is hot. Report what you find.
- `docs/adr/ADR-0001-go-workspace-role.md` and `ADR-0002` — the bar for "evidence, not intent".

## Method — the audit must be honest in both directions

1. **Inventory every CPU-bound loop** in the reachable code. For each, state in one line what the
   actual input size is on a *real* request (not a synthetic worst case). If the input is a 200-token
   prompt and a 3-provider list, say so — that number is the whole answer.
2. **Measure.** Build a small benchmark under `bench/native-audit/` that times the real functions from
   `phoenix-core` over representative inputs. Report **median and p95**, over enough iterations to be
   meaningful, plus the iteration count. Report the machine you measured on. A number without its
   sample size is not a measurement.
3. **Compute the ceiling.** For each hotspot, state the total per-request CPU budget and what fraction
   the hotspot is. If `planQuotaRun` is 4 µs of a request whose wall time is dominated by a 900 ms
   provider call, then even an infinitely fast Rust implementation buys ~0.004%, and you should say
   exactly that.
4. **Then** evaluate Rust/Wasm, against each of: CPU cost · determinism · memory · bundle size ·
   Cloudflare Workers cold-start · cross-runtime reuse · maintenance cost · whether a **mature OSS Rust
   implementation already exists** (check licence and maintenance before proposing anything).
5. **Cloudflare constraint, verify it:** Wasm is supported on Workers, but a module must be
   `wasm32-unknown-unknown`-compatible, cannot touch the filesystem or the network, and is instantiated
   **per isolate** — so cold-start and bundle size are first-class costs, not footnotes. If you cannot
   verify a claim, mark it `unverified` rather than asserting it.

## The report format — one row per candidate

```
CANDIDATE:
HOTSPOT:                 (file:line)
CURRENT IMPLEMENTATION:
MEASURED COST:           (median / p95 / N / machine)
REAL INPUT SIZE:
EXPECTED BENEFIT AT BEST: (the ceiling from step 3 — the number that decides it)
WASM COMPATIBLE:
BUNDLE IMPACT:
CROSS-RUNTIME REUSE:
MAINTENANCE COST:
OSS CORE AVAILABLE:       (name + licence + last release, or none found)
VERDICT:                 ACCELERATE | DEFER | REJECT
REASON:                  (one sentence, no adjectives)
```

`REJECT` with a measured reason is a full-credit answer. `DEFER` is acceptable only with a named
trigger that would make it worth revisiting.

## Allowlist — these paths are yours exclusively

```
bench/native-audit/**                  (new — the harness and its results)
docs/research/NATIVE-COMPUTE-AUDIT.md  (new — the report)
```

## Do NOT touch — other lanes are working in this same worktree

- `phoenix-core/**` and `src/**` — **read these, write nothing.** Another lane is editing
  `phoenix-core/src/quota.ts` right now; you will see it change under you, and that is expected.
- `docs/adr/**` — the Lead owns ADRs
- `docs/research/ROUTING-CONVERGENCE.md`, `docs/research/GO-QUOTA-FINDINGS.md` — another lane
- `package.json` — a toolchain migration is in flight; do not add or remove dependencies

If you need a benchmark to import a function, import it from `phoenix-core/src/*.ts` — do not copy the
source into `bench/`. A copied function measures the copy, not the code.

## Constraints

- Benchmark in plain Node. **Do not introduce Rust, `wasm-pack`, or any build toolchain** — this task
  produces measurements and a recommendation, not an implementation. If your conclusion is "build it",
  the next task builds it.
- Do **not** run `git commit`, `git push`, or `git rebase`. The Lead integrates.
- Do not add a dependency. Use `node:perf_hooks` and what is already installed.

## Acceptance — paste output verbatim

```bash
cd /home/shai/personal/projects/projects/simorgh

node --version
ls -R bench/native-audit
node bench/native-audit/run.mjs          # or the entry point you created
```

The benchmark must run to completion with no network. **If you could not run something, say which and
why.**

## Required in the report

- A negative control for your measurement: show the harness detecting a deliberately wrong result, or
  demonstrate the timing is stable across two runs. A number that cannot be shown to move is not a
  measurement.
- An explicit statement of what you could **not** verify, and how you would verify it.
- What you found but did **not** fix.

## Report

Write `mailbox/OUTBOX/TASK-012-REPORT.md`. **The last non-empty line must be exactly `TASK-012-END`.**

If blocked, write `mailbox/NAGS/open-TASK-012-<slug>.md`.

TASK-012-BRIEF-END