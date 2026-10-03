# TASK-013 — Routing convergence: where TypeScript and Go actually disagree

- Owner: any
- Status: open
- Depends on: nothing · Estimate: 60–90 min · Runner: freebuff CLI agent (host, parallel with the Lead)


## 0. Start here: introduce yourself

Your **first** action is a short introduction into `mailbox/OUTBOX/TASK-013-INTRO.md`
(≤40 lines): who you are, the role you are taking, what you reach for first and why, your
honest read on whether this brief is well-specified, and what you would ask a maintainer.

## 1. Orient yourself before you start

**Read first:** `AGENTS.md` (especially **Environment traps** and the **Definition of
Done**), then the files named below. `AGENTS.md` records three cases of an all-green suite
hiding a real defect; that is the standard you are being held to.

**Skills** — catalog at `/home/shai/personal/projects/docs/skills-catalog.md`; read each
SKILL.md before use:

- - `golang-patterns`, `golang-testing` — for reading and judging the Go side
- `contract-first` — for deciding whether the two runtimes need a shared value model
- `deepwiki`, `context7` — for checking how comparable gateways model this
- `search-first` — forces the reuse check first

**Harnesses** — `/home/shai/personal/projects/harnesses/`:

- `agents/personas/` — read two or three persona files. They show how this workspace scopes a
  specialist: explicit triggers, named MCPs, named skills. That is the house style.
- `self-bench/BENCH-GUIDE.md` — for a stateless task loop if your work is multi-iteration.

**Ground rules:** never hard-delete (use `.openclaw/tmp/` for scratch, `_archive/` at the
workspace root for real removals); no `npm install`/`npm ci` (the package manager is **upm**);
no `git commit`/`push`/`rebase` — the Lead integrates.

## Why this exists

Simorgh runs the same engine on two runtimes, and the repo has an accepted ADR saying they must not
grow two separate routing policies. That ADR is asserted, not measured. This task produces the first
real comparison of the two implementations so the assertion either holds or gets corrected.

There is a second reason, and it is more concrete. `docs/adr/ADR-0003-free-compute-capacity.md` makes
several **factual claims about the Go side** — that `packages/ledger/ledger.go` computes
`cap - used-since-boot` with no reset, that `groq.go:50` discards `dailyCap`, and that `Registry.Select`
never reads `Remaining()`. Those claims are load-bearing for the whole quota design. **Verify them
against the source.** If any is wrong, that is the single most valuable thing you can return, and you
should say so loudly rather than quietly working around it.

## Read first

- `phoenix-core/src/flock.ts` — the engine's routing policy, with the four ordered decisions and the
  reasoning for each. This is your reference implementation.
- `phoenix-core/src/health.ts` — cooldowns, `COOLDOWN_RATE_LIMIT_MS`, the 429 discovery path.
- `phoenix-core/src/quota.ts` — the new capacity layer (another lane is editing it; read, don't write).
- `gateway/`, `packages/` — the Go workspace. Start with `packages/ledger/`, the registry, and each
  provider adapter (`groq.go` and friends).
- `docs/adr/ADR-0001-go-workspace-role.md` — the existing decision this task may be amending.
- `mailbox/OUTBOX/TASK-007-REPORT.md` — the Go gateway test lane; it already touched this code.

## Deliverable 1 — the comparison

A table, one row per decision the gateway actually makes:

| Decision | TypeScript engine | Go gateway | Same? | Where they differ |

Cover at minimum: candidate ordering, the dormant/secret-absent skip, cooldown after failure, fail-through
on a thrown provider, exhaustion reporting (how many failures are surfaced), and whether usage is ever
*acted on* rather than only reported.

For each difference give the **reason** — is one of them simply wrong, do they serve different
deployments, or is this an unavoidable consequence of the two runtimes not sharing memory?

## Deliverable 2 — the ADR-0003 fact check

For each of the three claims above: **confirmed / refuted / partially true**, with `file:line` evidence
and the actual code quoted. This is the higher-value half of the task. Refuting a load-bearing claim
beats confirming all three.

## Deliverable 3 — the decision

Pick exactly one, and justify it against the alternative:

- **TS engine is the source of truth; Go is a protocol-compatible execution companion** — Go keeps its
  own routing for wire compatibility and is explicitly *not* a second source of scheduling truth; or
- **a normalized shared protocol/value model is required** — the two need a common contract, and you
  should say what it would contain and what it would cost.

Then state, concretely: what existing code is reused, what the compatibility impact is, and **which tests
would be required** to keep the two from drifting. If both options remain materially unresolved on the
evidence, say that instead of picking — an honest "unresolved, here is the experiment that would settle
it" is a better answer than a confident guess.

## Environment trap — read this before running anything Go

`GOFLAGS` is polluted machine-wide on this box. `~/.config/go/env` sets `GOFLAGS=-mod=vendor`, which
makes every non-vendored Go build fail with a **misleading** `inconsistent vendoring in <dir>` even
though no `vendor/` directory exists. Override per command:

```bash
cd /home/shai/personal/projects/projects/simorgh
GOFLAGS=-mod=readonly go build all
GOFLAGS=-mod=readonly go vet github.com/shaiinarab/simorgh/...
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/... -count=1
```

Do **not** delete `~/.config/go/env` — other projects on this box need it. Do not add a `vendor/`
directory to work around it. And do not use `mirror.kargadan.ir` as a Go proxy: it serves tampered
modules and is banned by the workspace AGENTS.md.

## Allowlist — these paths are yours exclusively

```
docs/research/ROUTING-CONVERGENCE.md   (new)
docs/research/GO-QUOTA-FINDINGS.md     (new)
```

## Do NOT touch — other lanes are working in this same worktree

- `gateway/`, `packages/`, `bot/`, `tools/` — **read only.** This task produces evidence, not patches.
- `docs/adr/**` — the Lead writes the ADR from your findings. Recommend; do not author.
- `phoenix-core/**`, `src/**` — other lanes are editing these right now.
- `bench/**` — the audit lane

## Constraints

- Read-only on all source. If you find a Go bug, report it with `file:line`; do not fix it.
- Do **not** run `git commit`, `git push`, or `git rebase`.
- **Do not run the TypeScript test suite.** Other lanes are mid-write and a red suite in a file you did
  not touch is noise, not signal. You may run `npm run typecheck` once at the end and must say in your
  report whether the result was attributable to your own reads (it should not be — you write no TS).

## Acceptance — paste verbatim

```bash
cd /home/shai/personal/projects/projects/simorgh
GOFLAGS=-mod=readonly go build all
GOFLAGS=-mod=readonly go vet github.com/shaiinarab/simorgh/...
GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/... -count=1
git log --oneline -1
```

If a command cannot run, say which and why. Silence reads as a pass.

## Required in the report

- The three ADR-0003 claims, each with a verdict and quoted evidence.
- The comparison table.
- Your decision, or an honest statement that the evidence does not settle it.
- **What you found but did not fix.** In particular: any place where the Go gateway could spend money,
  over-quota, or report a wrong number to an operator. Those are security-relevant and the Lead needs
  them even if they are out of scope here.

## Report

Write `mailbox/OUTBOX/TASK-013-REPORT.md`. **The last non-empty line must be exactly `TASK-013-END`.**

If blocked, write `mailbox/NAGS/open-TASK-013-<slug>.md`.

TASK-013-BRIEF-END