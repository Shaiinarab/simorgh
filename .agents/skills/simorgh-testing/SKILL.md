---
name: simorgh-testing
description: How testing works in simorgh-platform — the two suites and what each can prove, which suite a change needs, and the repo's documented cases of a green suite hiding a real bug. Use when writing or judging tests, when a test passes but the behaviour is questionable, when deciding whether a fixture is trustworthy, or when a collection error appears.
---

# Testing simorgh-platform

The suite is green (**82** workerd + **202** Node) and that number is not the question. This skill is
about what the green number **cannot** see.

## Two suites, split by what each can prove

| Suite | Config | Scope | Runs against |
|---|---|---|---|
| workers | `vitest.config.ts` | `test/**` | the Cloudflare app **inside workerd**: DO RPC, real KV, real SQLite, cron shape, HTTP route contracts. `remoteBindings: false`, so it is hermetic — no Cloudflare account, no token, no outbound request. |
| node | `vitest.node.config.ts` | `phoenix-core/test/**` + `simorgh-platform/test/**` | the engine and the platform on plain Node: routing, the agent tool loop, the tool executor, the ledger, validation, rate limiting, targets, connectors + conformance, deploy, preflight, fleet, `doctor`. |

```bash
npm test                                                # BOTH, workers first
npm run test:workers
npm run test:node
npx vitest run --config vitest.node.config.ts <file>    # one file, scoped
```

**A change that passes only one suite has been tested on one runtime.** Run both.

The split is the design, not bookkeeping. The engine/Node suite is the **portability detector**: if
`phoenix-core` ever picks up a runtime binding, that suite stops resolving and goes red while the
workerd suite keeps passing. That asymmetry is the signal.

## A collection error is a hard stop

`phoenix-core/test/boundary.test.ts` fails on a *collection* error, not an assertion error. A collection
failure means "this file could not even be loaded" — treat it as a hard stop, report the file and the
exact error, and do not re-run hoping. It is the guard that keeps the engine portable.

## Green tests have hidden real bugs here — three times

| The defect | Why the suite missed it |
|---|---|
| Deploy preflight reported *"a core is already responding"* for **any** HTTP status, including `501` | the test asserted the check's `id` and `severity` only — never the claim |
| The MCP server put `isError` **inside** the JSON payload instead of on the MCP **tool result** | the suite asserted `isError` in the same wrong place the server wrote it, so both agreed on a shape no compliant client reads |
| A connector stub emitted `answer` / `answeredBy` (the *platform's* vocabulary) where a real core sends `agentResponse` / `meta.answered_by` | the stub agreed with our own mapper while disagreeing with **every real core** |

The common thread: **the test encoded the implementation's assumption instead of the outside world's
contract.** Every one of those was found by running something against reality, never by adding a test.

## The rules that follow

- **Verify a boundary against reality at least once.** Use the real plan builder, a real core, the real
  wire shape — not only a fixture you wrote in the same sitting as the code.
- **`toContain` is not `toEqual`.** Where a list's *completeness* is the property, assert equality.
  This exact mistake let two forbidden MCP aliases (`simorgh_status`, `simorgh_ask` on the *platform*
  server) pass a `tools/list` test.
- **A fixture must be able to express failure.** A `fetch` double with no `json()` method, or a stub
  that always succeeds, cannot test an error path — it can only test that the happy path is still happy.
- **Every detector needs a negative control.** Plant a failure, watch the check go red, remove it. The
  deploy preflight and the secrets scanner in `scripts/security-scan.sh` were both proven this way. A
  scanner that has never fired is not evidence.
- **Name the test that covers a claim.** "There are 12 tests in that file" is not coverage.
- **Assert on stable things** — ids, severities, codes, wire field names — not on prose. Prose changes
  for good reasons and makes tests brittle in a way that trains people to ignore them.

## Per-file counts are part of the guard

The counts are recorded in `docs/STATE-OF-PROJECT.md` §3.1 and in the README, per file, deliberately:
a suite that silently *shrinks* is the failure mode that is easiest to miss, and a total can stay green
while a file disappears. When you add or remove tests, update those numbers.

Current: workerd 10 files/82 — `agent` 17, `flock-routing` 14, `http` 12, `health-storage` 11,
`durable-objects` 8, `security` 7, `index` 4, `telegram` 4, `rate-limit` 3, `core-wiring` 2.
Node 17 files/202 — engine 8/89 (`security` 19, `ledger` 14, `tools` 14, `flock` 11, `agent` 9,
`storage` 9, `execute` 8, `boundary` 5), platform 9/113 (`targets` 17, `preflight` 16, `connectors` 15,
`integration` 13, `mcp-server` 13, `doctor` 12, `deploy` 11, `fleet` 10, `conformance` 6).

## Commands that check the *assembled* thing

Unit tests do not assemble anything. Three commands do, and they are the ones that have caught the
boundary bugs:

```bash
npm run e2e:ask          # the CLI reaches a live core over REST *and* MCP, and compares the answers
npm run platform:smoke   # boots a real core on an ephemeral port, probes it, exits 0/1
npm run simorgh -- doctor # diagnoses a fleet that will not answer
```

Two environment notes: set `NO_PROXY=127.0.0.1,localhost` first, and remember `deploy --mode cli`
requires `--yes`, so a test that deploys must pass it explicitly (it is the whole point of the gate).

## Adding a test — what good looks like here

1. Pick the suite by **what it needs**, not by where the file lives: does it need a binding or a
   runtime? → workers. Pure logic and ports? → node.
2. Inject the dependency (env, fetch, which, clock) rather than reaching for a global.
3. Write the assertion you would want if the implementation were wrong.
4. Run a negative control: break the implementation deliberately, confirm the test fails, restore.
5. Add the per-file count to the docs if the total moved.

## Related

- `AGENTS.md` §Verification discipline — the rules in their shortest form
- `docs/QUALITY.md` — the audit of assertions that cannot fail
- Skills: `simorgh-architecture` (the invariants under test), `simorgh-deploy-boundary`
