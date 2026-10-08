# TASK-003 — `simorgh doctor`: turn a fleet failure into a named cause

- Owner: any
- Status: done (Lead 2026-09-21T22:27)
- Depends on: nothing · Estimate: 30–45 min · Runner: pool lane (headless) or an fb2/fb3 container session

## Why this exists

`simorgh status` reports *that* an instance is unreachable. It does not say why, and the four causes
need four different fixes:

| Cause | What the operator must do |
|---|---|
| nothing recorded in the fleet file | `simorgh connect <target> <endpoint>` |
| connection refused / DNS | wrong endpoint, or the core is not running |
| `401` | the recorded `--api-key` is wrong |
| `503 AUTH_NOT_CONFIGURED` | the core has no `SIMORGH_API_KEY`; it fails closed by design |
| every provider `dormant` | the core is up but has **no provider keys**, so it can never answer |
| every provider `tired` | the flock is cooling down; check the provider, not the core |

The last two are the ones that waste an afternoon: the core is healthy, the fleet is green, and
every request returns `flock_exhausted`. `doctor` should name that condition explicitly.

## Read first

- `simorgh-platform/src/fleet.ts` — `createFleet`, `connectorFor`, `CoreInstance`, `InstanceReport`
- `simorgh-platform/src/connectors/types.ts` — `CoreConnector`, `CoreHealth`, `toAskResult`
- `simorgh-platform/src/fleet-store.ts` — `loadFleet` (it warns rather than throws on a bad file)
- `simorgh-platform/src/cli.ts` — the command dispatch and output style (`out()`, `--json`)
- `phoenix-core/src/flock.ts` — `ProviderStatus` / `FlockStatus`, so the diagnosis reads real fields
- `simorgh-platform/test/fleet.test.ts` — the stub-`fetch` pattern to copy, not reinvent
- `mailbox/README.md` — stack rules; `npm install` is not needed, the workspace is already linked

## Deliverable 1 — `simorgh-platform/src/doctor.ts`

Export a pure-ish entry point, e.g.:

```ts
export interface Diagnosis {
  subject: string;                 // instance id, or a target id
  severity: "ok" | "warn" | "error";
  code: string;                    // stable, greppable, e.g. "unreachable", "auth-not-configured"
  detail: string;                  // one sentence, actionable
  hint?: string;                   // the command to run to fix it
}

export interface DoctorReport {
  ok: boolean;                     // false when any diagnosis is "error"
  diagnoses: Diagnosis[];
}

export function diagnoseInstances(
  instances: readonly CoreInstance[],
  options?: { fetch?: FetchLike }
): Promise<DoctorReport>;

export function renderDoctor(report: DoctorReport): string;
```

Rules:
- **Never throw for an unhealthy fleet** — an unreachable core is a finding, not a crash. Catch it
  and turn it into a `Diagnosis`.
- Derive the *whole* diagnosis from data you actually have: the connector's error string, the
  `FlockStatus` payload, `loadFleet`'s warning. Do not guess a cause you cannot observe — if the
  detail is `http_500` and nothing more, say exactly that.
- Distinguish "no instances recorded" from "instances recorded but all unreachable". They are
  different problems with different fixes.
- A `401` must produce a different `code` from a `503`. Distinguish them by the message the REST
  connector already produces (`bearer token rejected` vs `fails closed`), or by issuing a probe
  yourself — your call, but say which in a comment.
- The "core is up, fleet is green, but **every** provider is dormant or tired" case must be its own
  diagnosis. That is the point of the command.

## Deliverable 2 — wire it into `simorgh-platform/src/cli.ts`

Add a `doctor` command:
- `simorgh doctor` — diagnose every recorded instance
- `--json` — emit the `DoctorReport` as JSON (consistent with the other commands)
- exit **0** when healthy, **1** when any diagnosis is `error`
- add it to `USAGE` under "What are they doing", in the existing style
- **change nothing else in the file.** Do not reorder commands, rename anything, or reformat
  unrelated lines — another lane depends on this file being stable.

## Deliverable 3 — `simorgh-platform/test/doctor.test.ts`

At least **8** tests, using an injected stub `fetch` (copy the pattern from `fleet.test.ts`). Cover at
minimum: healthy fleet; empty fleet; connection refused; `401`; `503`; all providers dormant; all
providers tired; a mix where one instance is fine and another is dead. Assert on `code` and on
`report.ok`, not on prose wording — prose will change, codes must not.

Tests run under the **Node** config (`vitest.node.config.ts`), not the workerd one. Your file is at
`simorgh-platform/test/`, so it is picked up automatically.

## Allowlist — touch nothing else

```
simorgh-platform/src/doctor.ts          (new)
simorgh-platform/src/cli.ts
simorgh-platform/test/doctor.test.ts    (new)
```

## Acceptance — run these and paste the results

```bash
npm run typecheck && echo OK-typecheck
npm test && echo OK-tests
npx vitest run --config vitest.node.config.ts simorgh-platform/test/doctor.test.ts && echo OK-doctor
npm run simorgh -- doctor; echo "doctor-exit=$?"      # must be 0 or 1, never a stack trace
npm run simorgh -- doctor --json | head -c 400; echo
```

Also prove the diagnosis is real, not decorative — with an empty fleet:

```bash
FBMAIL_DOCTOR_FLEET=/tmp/nonexistent-fleet.json npm run simorgh -- doctor 2>&1 | head -20
```

(If `--fleet` is the cleaner way to point it at a path, use that instead; either is fine, but say
which you used in the report.)

## Report

`mailbox/OUTBOX/TASK-003-REPORT.md`, per the template, ending with `TASK-003-END` as the last
non-empty line. Include the acceptance output verbatim, the test count, and the list of `code`
values you emit.
