# TASK-005 — deploy preflight: know a deploy will fail *before* consenting to it

- Owner: any
- Status: done (Lead 2026-09-22T12:55)
- Depends on: nothing · Estimate: 40–60 min · Runner: pool lane (headless)

## Why this exists

`simorgh deploy <target> --yes` builds a plan and *runs* it. Nothing checks the environment first.

So the failure mode today is: the operator consents, `npm ci` runs for two minutes, and then step 4
dies because `CLOUDFLARE_API_TOKEN` is a stale token or `npx` is not on `PATH`. The deploy is now
**half-applied** — the most expensive state a deployer can leave behind. `buildDeployPlan` already
*warns* about missing secrets, but a warning printed next to an executing step list is not a gate.

Preflight is the missing gate: a read-only pass that answers **"can this plan actually succeed in this
environment, right now?"**, and refuses to let a doomed plan start.

The design constraint that matters: preflight must **not** do any of the work it is checking for. No
installing, no deploying, no network writes. It may probe reachability, and it may look at the
filesystem and environment. Anything else makes it a second deployer.

## Read first

- `simorgh-platform/src/deploy/plan.ts` — `buildDeployPlan`, `DeployPlan`, `PlanStep` (`run`,
  `needs`, `executable`), `PlanSecret` (`present`), `canExecute`
- `simorgh-platform/src/deploy/apply.ts` — the consent gate this sits in front of; match its tone and
  its refusal style
- `simorgh-platform/src/deploy/runner.ts` — how a step's argv is actually executed
- `simorgh-platform/src/targets.ts` — `DeploymentTarget`, `listTargets`, and the three real targets
  (`cloudflare-workers`, `node`, `byo-endpoint`). Note `node`'s steps call `node`, `npm`, `curl`;
  `cloudflare-workers` calls `npm`, `npx`, `curl`.
- `simorgh-platform/src/cli.ts` — the output style (`out()`), `--json`, exit-code conventions
- `phoenix-core/src/ports.ts` — `FetchLike`, for the reachability probe (inject it; do not reach for a
  global in a test)
- `mailbox/README.md` — report template. `npm install` is **not** needed; the workspace is already linked.

## Deliverable 1 — `simorgh-platform/src/deploy/preflight.ts` (new)

```ts
export type PreflightSeverity = "blocker" | "warning";

export interface PreflightCheck {
  id: string;                       // stable, greppable: "missing-secret", "missing-tool", ...
  severity: PreflightSeverity;
  detail: string;                   // one sentence, states what was observed
  hint?: string;                    // the command or edit that fixes it
}

export interface PreflightReport {
  target: string;
  service: string;
  ok: boolean;                      // false when any check is a "blocker"
  checks: PreflightCheck[];
  blockers: PreflightCheck[];       // convenience view; must agree with `checks`
}

export interface PreflightOptions {
  plan: DeployPlan;
  env?: Record<string, string | undefined>;
  /** Injected so this is testable and never surprises a caller. Default: global fetch. */
  fetch?: FetchLike;
  /** Injected so "is this tool installed?" is testable without a real PATH. Default: probes PATH. */
  which?: (command: string) => Promise<string | null>;
  /** Probe the endpoint for an already-running core. Default true. */
  probeEndpoint?: boolean;
}

export function runPreflight(options: PreflightOptions): Promise<PreflightReport>;
export function renderPreflight(report: PreflightReport): string;
```

Checks it must make — each derived from the plan, never hardcoded to a target id:

1. **Required secrets present.** Every `plan.secrets` entry with `required: true` and `present: false`
   is a `blocker`. Say which secret and what it unlocks.
2. **Executable tools exist.** Collect the argv heads from every `plan.steps[].run` (`npm`, `npx`,
   `node`, `curl`, …) and check each one via `which`. A missing tool is a `blocker`, naming the step
   id that needs it. **Do not hardcode the tool list** — derive it, so a new target is covered for free.
3. **An `{origin}` reached the plan unresolved.** If any generated step's argv or manual text still
   contains the literal `{origin}`, that is a `blocker` — a command with a placeholder in it will
   either fail or, worse, do the wrong thing.
4. **Mode/plan agreement.** If `plan.mode === "cli"` but the target cannot execute
   (`canExecute(target) === false`), that is a `blocker` — the plan promised execution it cannot deliver.
5. **A core is already live at the endpoint** (only when `probeEndpoint` and the endpoint is a real
   URL, i.e. contains no `{`). A reachable core is a **warning**, not a blocker: re-deploying over a
   live core is legal, it just deserves a sentence. Unreachable is **not** a check at all — nothing
   wrong with deploying into an empty address.
6. **Runtime version, where the target names one.** For the `node` target, compare the host's
   `process.versions.node` major against the workspace's `engines.node`. Read the version through an
   injected/parameterized value rather than assuming a global. A too-old runtime is a `blocker`.
   If you decide this check is not worth its complexity, **say so in the report** rather than shipping
   something half-wired.

Rules:
- **Never throw for a failing check.** An unusable environment is a report, not an exception. Catch
  errors from probes and turn them into a `warning` with the real message.
- **Never mutate anything.** No writes, no installs, no deploy steps. This is a read.
- `renderPreflight` must print blockers first, then warnings, then a one-line verdict — and be readable
  when there are zero checks (say the plan is clear, do not print an empty section).

## Deliverable 2 — `simorgh-platform/test/preflight.test.ts` (new)

At least **10** tests, using injected `env`, `which`, and `fetch`. Cover at minimum:
- a fully healthy plan → `ok: true`, zero blockers
- missing required secret → blocker naming that secret
- optional secret missing → **not** a blocker
- missing tool → blocker naming the step id that needs it
- unresolved `{origin}` in argv → blocker
- `cli` mode on a target that cannot execute → blocker
- live core at the endpoint → warning, `ok` still true
- dead endpoint → `ok: true` (proves the probe is not treated as a failure)
- a probe that *throws* → warning with the real message, never a rejected promise
- `blockers` and `checks` agree (no blocker omitted from `blockers`)

Assert on `id` and `severity`, not on prose. **Write one test that proves the tool list is derived**
(e.g. a hand-built plan whose step runs `frobnicate` produces a missing-tool blocker) — that is what
proves check 2 is not hardcoded.

## Allowlist — touch nothing else

```
simorgh-platform/src/deploy/preflight.ts   (new)
simorgh-platform/test/preflight.test.ts    (new)
.openclaw/tmp/preflight-demo.ts            (new — throwaway demo only)
```

Do **not** edit `cli.ts`, `apply.ts`, `plan.ts`, `runner.ts`, `targets.ts`, or `src/index.ts`. The Lead
wires preflight into `deploy` afterwards.

## Acceptance — run these and paste the output verbatim

```bash
npm run typecheck && echo OK-typecheck
npm test && echo OK-workerd
npx vitest run --config vitest.node.config.ts simorgh-platform/test/preflight.test.ts && echo OK-preflight
npx vitest run --config vitest.node.config.ts 2>&1 | tail -5
```

Then prove it against the **real** plan builder, not just hand-built fixtures. Write the throwaway
`.openclaw/tmp/preflight-demo.ts` and run it twice:

```bash
node .openclaw/tmp/preflight-demo.ts            # node target, no SIMORGH_API_KEY in env
SIMORGH_API_KEY=whatever node .openclaw/tmp/preflight-demo.ts
```

It should import `buildDeployPlan` and `runPreflight` from the platform source (Node 26 runs `.ts`
directly when the import specifier carries an explicit `.ts` extension — see how
`simorgh-platform/src/cli.ts` imports its siblings) and print the blockers for `node --origin
127.0.0.1:8788`. Paste both outputs into the report. If Node's type-stripping refuses something,
say exactly what it refused rather than working around it silently.

## Report

`mailbox/OUTBOX/TASK-005-REPORT.md`, per `mailbox/README.md`, ending with `TASK-005-END` as the last
non-empty line. Include the acceptance output verbatim, both demo runs, the test count, and the exact
`id` values you emit.
