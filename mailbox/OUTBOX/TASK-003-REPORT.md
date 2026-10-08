# TASK-003 Report — `simorgh doctor`

- Brief: `mailbox/INBOX/TASK-003-simorgh-doctor.md`
- Dispatched to: lane via `codex exec` (headless), `setid`+`disown`, 4200s window
- Completed by: Lead session (host)

## Status

**Success — but not by the lane that was dispatched, and that is the interesting part.**

The lane exited `EXIT=0` and wrote **one** of the brief's three deliverables. This
report records what it produced, what it did not, and why — because "the agent exited
0" and "the work landed" turned out to be different claims, and the mailbox protocol's
own `check` was the only thing that distinguished them.

## What was asked

Three deliverables: `src/doctor.ts`, `doctor` wired into `src/cli.ts`, and
`test/doctor.test.ts` with ≥8 tests.

## What the lane delivered

`simorgh-platform/src/doctor.ts` — 211 lines, and **good work**. It implements the
diagnosis exactly as briefed: a stable `code` per cause, `severity`, a one-sentence
`detail`, a fix `hint`, `ok` derived from "no error-severity finding", a
`classifyError` that separates 401 from 503 from ECONNREFUSED, the two
afternoon-wasting conditions (all-dormant, all-tired) as their own codes, and
`renderDoctor`. It uses the real `connectorFor`/`CoreHealth`/`FlockStatus` types
rather than inventing shapes. I kept it and made one change (below).

## What the lane did not deliver

- `src/cli.ts` was **never touched** — `grep -n doctor simorgh-platform/src/cli.ts`
  returned nothing.
- `test/doctor.test.ts` was **never created**.
- The report you are reading was **never written**.

`EXIT=0`, no report, 1/3 landed.

### Why — and this is the reusable finding

The lane's log shows, immediately before it stopped:

```
ERROR codex_core::tools::router: error=unsupported call: apply_patch
Now I'll make the three changes to cli.ts: add import, update USAGE, add case in switch, add cmdDoctor function.
```

`apply_patch` is the harness's edit tool, and it is **not supported by the model this
`codex exec` session routed to** (`kc/kilo-auto/free`). The failure mode is precise and
worth stating plainly:

> The harness **can create files but cannot edit them**. Writing `doctor.ts` was a
> create, and it worked. Every remaining step — the import, the `USAGE` line, the
> `switch` case, the `cmdDoctor` function — was an *edit*, and every one was refused.

An agent in that state will typically announce the edit it is about to make, fail to
make it, and then terminate. It does not error out, so the driver sees `EXIT=0`.

**Operational consequence for this mailbox:** a lane dispatched to this harness must
either (a) receive an edit-free brief — every deliverable a new file — or (b) be
driven by a harness whose edit tool is supported. As a mitigation the Lead should
check `fbmail check <id>` (exit 0/1) rather than the driver's exit code, and should
verify the *artifacts* exist rather than trusting a completion message. Both of those
were true here and both fired.

## What the Lead completed

1. **`doctor` wired into `simorgh-platform/src/cli.ts`** — import, a `USAGE` line under
   "What are they doing", the `case "doctor"` dispatch, and `cmdDoctor` handling
   `--json` and the `--fleet` path, returning 0/1.
2. **`simorgh-platform/test/doctor.test.ts`** — 12 tests (brief asked ≥8), all through
   a stub `FetchLike`, so no test needs a running core or a port.
3. **One behaviour change in `doctor.ts`.** The lane made an empty fleet a `warn` with
   `ok: true` — so `simorgh doctor` on a fresh checkout printed a finding and exited
   **0**. A doctor that reports all-clear on an unconfigured deployment is the one
   command an operator trusts to say the deployment is fine, so `no-instances` is now
   `error` / `ok: false` / exit **1**, matching `simorgh status`, which already exits 1
   for the same condition. Flagged here because it is a deliberate contract choice, not
   a formatting preference.

## Checks

```
npm run typecheck && echo OK-typecheck
OK-typecheck

npx vitest run --config vitest.node.config.ts simorgh-platform/test/doctor.test.ts
 Test Files  1 passed (1)
      Tests  12 passed (12)

npm run simorgh -- doctor ; echo "doctor-exit=$?"
✗ [no-instances] fleet: No instances recorded in the fleet file.
  → simorgh connect <target> <endpoint>

1 problem(s) found.
doctor-exit=1

npm run simorgh -- doctor --json
{"ok":false,"diagnoses":[{"subject":"fleet","severity":"error","code":"no-instances",
  "detail":"No instances recorded in the fleet file.",
  "hint":"simorgh connect <target> <endpoint>"}]}

npm run simorgh -- doctor --fleet /nonexistent/fleet.json ; echo "empty-exit=$?"
empty-exit=1        # never a stack trace

npm run simorgh -- help | grep doctor
  simorgh doctor                              why an instance is not answering
```

Full suites, on the host and independently inside **fb2** (a clean container, Node
v22.23.2):

```
host:  workers 82/82   node 139/139
fb2:   workers 82/82   node 139/139   typecheck OK   doctor-exit=1
```

## Codes emitted

`ok` · `no-instances` · `connection-refused` · `unreachable` · `auth-unauthorized`
(401) · `auth-not-configured` (503) · `all-providers-dormant` · `all-providers-tired`

## Next_actions

1. The lane delivered `doctor.ts` and stopped. Nothing is half-written: the file it
   produced is complete and wired, so there is no integration debt beyond this note.
2. `simorgh doctor` has no test for the `--target` case the brief mentioned as
   optional; it diagnoses recorded instances only. If per-target preflight is wanted
   before `connect`, that is a new brief.

## Artifacts

- `simorgh-platform/src/doctor.ts` (by the lane; one change by the Lead)
- `simorgh-platform/src/cli.ts` (Lead — import, USAGE, dispatch, `cmdDoctor`)
- `simorgh-platform/test/doctor.test.ts` (Lead — new, 12 tests)

## NAGs

- `NAG: the dispatched harness cannot edit files — check before the next wave` —
  any brief whose deliverables include modifying an existing file will fail at
  `apply_patch` and report `EXIT=0`. Prefer new-file briefs for this harness until its
  edit tool is confirmed working.

TASK-003-END
