# TASK-008 — quality audit: dead code, untested critical paths, and assertions that cannot fail

- Owner: any
- Status: done (Lead 2026-09-22T14:52)
- Depends on: nothing · Estimate: 45–70 min · Runner: codex lane (headless)

## Why this exists

The suite is green (**82** workerd + **202** Node) and that number is not the question. The question is
what the green number *cannot* see. This repo already has three documented instances of a passing suite
hiding a real defect:

1. `simorgh-platform/src/deploy/preflight.ts` reported *"a core is already responding"* for **any** HTTP
   status, including `501`. Green tests, false statement.
2. `simorgh-platform/src/mcp/server.ts` put `isError` **inside** the JSON payload instead of on the MCP
   tool result, so a compliant client read a failed tool as a **success**.
3. A test stub emitted `answer`/`answeredBy` where a real core sends `agentResponse`/`meta.answered_by` —
   so the stub agreed with our own mapper while disagreeing with **every real core**.

All three were found by *running something against reality*, not by adding tests. Your job is to find
the next ones, and to say honestly how much of the suite is load-bearing.

## Read first

- `README.md` §Testing — the suite split, and why `phoenix-core/test/boundary.test.ts` matters
- `docs/ARCHITECTURE.md` — the port table and the invariants the engine is supposed to hold
- `docs/STATE-OF-PROJECT.md` §3.1 — the per-file test counts; §9.1 — claims this project got wrong
- `vitest.config.ts`, `vitest.node.config.ts` — the two suites and their scope
- `phoenix-core/src/**` and `simorgh-platform/src/**` — the implementation under audit
- `mailbox/OUTBOX/TASK-004-REPORT.md`, `TASK-005-REPORT.md`, `TASK-006-REPORT.md` — what the lanes found

## Deliverable — `docs/QUALITY.md` (new)

A single document with the sections below. **Every row must carry `file:line` evidence.** A claim
without a line number is a guess; label guesses as guesses or leave them out.

### 1. Method — say exactly what you ran

State the commands you used and their real output. Reading, `grep`, `git grep`, per-file test counts.
If you tried a coverage tool and it was unavailable, say so and give the exact error rather than
reporting coverage you did not measure. **Check this specifically:**

```bash
ls node_modules/@vitest/coverage-v8 2>/dev/null || echo "coverage provider NOT installed"
npx vitest run --coverage 2>&1 | tail -20
```

If the provider is missing, do **not** install it (network installs are not your call) — report the gap
and propose the exact `devDependencies` line plus the script that should exist.

### 2. Dead code — with the false-positive check

Table: `symbol`, `defined at`, `referenced from`, `verdict` (`dead` / `test-only` / `live-via-X`).

Rules that matter here, both learned the expensive way on this workspace:

- **A symbol referenced only by its own test file is not "used".** Mark it `test-only`, not `live`.
- **Avoid false positives.** Before calling something dead, check dynamic references: string-keyed
  dispatch (`case "platform_ask":`), `Object.keys(...)` iteration, MCP tool-name dispatch, CLI subcommand
  tables, `import * as`, and `.ts` extension imports. A symbol reached only through a string is live.
  State which of these checks you performed.

### 3. Untested critical paths — ranked

The paths where a silent break costs the most, and whether a test actually reaches them. Consider at
least:

- the **engine's error branches** in `phoenix-core/src/execute.ts` and `flock.ts` (what happens when
  *every* provider fails? when the ledger write fails? when a tool throws?)
- the **`deploy --mode cli --yes` consent gate** in `simorgh-platform/src/deploy/apply.ts` — the one
  thing standing between a plan and a real, half-applied deploy
- **`fleet-store.ts`** persistence: what happens on a corrupt or empty fleet file?
- the **auth fail-closed** path (`phoenix-core/src/security.ts`) when `SIMORGH_API_KEY` is unset
- the **Telegram webhook** secret-token check

For each: is it covered, and if so **by which test name**? Naming the test that covers it is the point —
"there are 12 tests in that file" is not coverage.

### 4. Assertions that cannot fail

The highest-value section. Find tests whose assertion would still pass if the implementation were wrong.
Look specifically for:

- `toContain` where `toEqual` is meant — **this exact bug let two forbidden MCP aliases through**; the
  test asserted the tool list *contained* the right names without asserting it contained nothing else
- stubs and fakes that disagree with the real wire format (`agentResponse` vs `answer`)
- fakes that cannot express failure (a `fetch` double with no `json()`, a fake that always succeeds)
- assertions on a value the test itself just constructed
- `expect(...).toBeDefined()` / `.toBeTruthy()` where a shape check is meant
- tests whose name promises more than the body checks

For each: `test name`, `file:line`, **the specific wrong implementation that would still pass**. That
last column is what makes the finding credible — if you cannot name one, drop the row.

### 5. Duplication still present

The engine extraction removed six duplicated modules from `src/`. Verify it was complete rather than
assumed:

- Are `src/{flock,health,rate-limit,models,agent,security,agent-service,data-trust}.ts` true thin
  adapters, or do any still hold logic that also exists in `phoenix-core`? Compare bodies, not imports.
- Is the tool executor defined once? (`phoenix-core/src/tools.ts` vs any host copy.)
- Is the ledger schema defined once? (`phoenix-core/src/ledger.ts` vs the `node:` adapter.)

Report leftovers as `file:line` pairs that still duplicate, or state that the extraction is complete.

### 6. Proposed coverage floor

A single concrete proposal: which suite, what threshold, the exact command, and **why that number**
(a floor that the current suite already meets by a wide margin is theatre; one that cannot be met
without meaningful tests is a target). Say plainly if you think a coverage gate is the wrong tool here
and conformance tests are worth more — with your reasoning.

### 7. The ten things you would fix first, ranked by risk

Short, ordered, each one line, each with the `file:line` that justifies it.

## Allowlist — touch nothing else

```
docs/QUALITY.md   (new)
```

**Read-only audit.** Do not edit source, do not edit tests, do not add dependencies, do not run
`npm install`. If you find a bug, write it up with evidence — the Lead fixes it.

## Acceptance — run these and paste the output verbatim

```bash
cd /home/shai/personal/projects/projects/opensource/simorgh-platform
npm run typecheck && echo OK-typecheck
npm test 2>&1 | grep -E "Test Files|Tests " && echo OK-tests
ls node_modules/@vitest/coverage-v8 2>/dev/null || echo "coverage provider NOT installed"
```

Your deliverable is a document, so also prove it exists and is non-trivial:

```bash
wc -l docs/QUALITY.md
grep -c 'file:line\|:[0-9]' docs/QUALITY.md   # or however you cite locations
```

## Report

`mailbox/OUTBOX/TASK-008-REPORT.md`, per `mailbox/README.md`, ending with `TASK-008-END` as the last
non-empty line. Include the acceptance output verbatim, and **be explicit about what you could not
measure** — an audit that reports its own blind spots is worth more than one that does not.
