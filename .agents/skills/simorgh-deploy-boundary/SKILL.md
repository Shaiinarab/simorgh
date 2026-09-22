---
name: simorgh-deploy-boundary
description: The three distinct readiness concepts in simorgh-platform — doctor, preflight and conformance — plus the deploy consent gate, the core contract a connector dials, and the impostor/health-shape trap. Use when touching targets, deploy, connectors, fleet, doctor or preflight, or when a core cannot be reached by the platform.
---

# The platform's deploy and readiness boundary

## Three concepts that must never collapse into one

They look similar and are deliberately separate. Merging them is the mistake this skill exists to
prevent.

| Concept | Question it answers | Scope | Lives in |
|---|---|---|---|
| **`doctor`** | *Is my environment / fleet healthy, and if not, why?* | local diagnosis | `src/doctor.ts` |
| **`preflight`** | *Can this plan actually succeed here, right now?* | one deploy plan, before consent | `src/deploy/preflight.ts` |
| **`conformance`** | *Does this connector/target behave per the contract?* | one connector against one double | `src/connectors/conformance.ts` |

- **`doctor` never throws on an unhealthy fleet.** An unreachable core is a *finding* with a stable code
  (`unreachable`, `auth-not-configured`, `no-providers`, `all-tired`, …) and a fix hint — not a stack
  trace. Exit **0** healthy, **1** unhealthy. Never make it throw: a diagnosis tool that crashes on the
  broken thing is useless exactly when it is needed.
- **`preflight` is read-only and must not do the work it checks.** No installs, no deploys, no writes.
  It may probe reachability. Anything more makes it a second deployer. It runs *before* the consent
  prompt, because the expensive failure is a **half-applied deploy**.
- **`conformance` runs both connectors against a single double** and fails a deliberately broken one —
  that is what makes it a conformance check rather than a mock.

## The deploy consent gate

`deploy --mode cli` requires **`--yes`**. There is no env var, no config file, and no "we are in CI so
obviously yes". Without it the CLI prints exactly what it would have run and exits **2**.

Use `--dry-run` to execute through a *recording* runner instead: you see the calls without running them.

**Do not add an exemption path.** The gate is the feature. If a test or a CI job needs to deploy, pass
`--yes` explicitly in the command.

## What a connector dials — the core contract

A core exposes:

```
GET  /health                        → { status, timestamp }*        (*see the shape trap below)
GET  /api/v1/flock/status           → the flock: providers, health, cooldowns
POST /api/v1/agent/execute          → the answer      (agentResponse, meta.answered_by)
GET  /api/v1/user/{id}/logs         → the transparency ledger
POST /mcp                           → MCP: tools/list, tools/call
```

MCP tool names on a **core**: `simorgh_status`, `simorgh_ask`.

**`simorgh_*` means one core. `platform_*` means the whole fleet.** Never alias across the two — a
client reaching both would see one name mean two things. This was found (two aliases shipped) and
removed once; a `toContain` assertion on `tools/list` was what let it through, which is why completeness
must be asserted with equality.

## The health-shape trap — read this before writing a reachability check

A reachability check that reports a **false positive** is worse than one that reports nothing: it sends
the operator off to deploy somewhere they are not deploying.

The real shapes differ by host:

| Host | `/health` returns |
|---|---|
| a TS core (`simorgh-platform/src/runtimes/node.ts`) | `{ status, timestamp }` |
| the Go gateway | `{ status, uptime, providers[] }` |

Two consequences, both learned by running it:

1. **Do not claim more than you observed.** The original preflight reported *"a core is already
   responding"* for **any** HTTP status, including `501` from an unrelated server on the same port. It
   now reads the health payload and distinguishes a core from an impostor. **Reproduce that case
   deliberately** — any server answering on the port is an impostor until the payload says otherwise.
2. **Do not require a field you have not seen a real host send.** A check that demands `flock` on
   `/health` would misreport a *real* core as broken. Verify against a live core before writing the
   discriminator.

## Targets

`src/targets.ts` — a target answers **where a core can live** and **how the platform reaches it**.
Three real ones: `cloudflare-workers`, `node`, `byo-endpoint`. `{origin}` and `{service}` are
substituted at plan time.

Derive, never hardcode: preflight collects argv heads from the plan's own `steps[].run` and required
secrets from its own `secrets` array. **A hardcoded tool list or target id in preflight breaks the
property that a new target is covered for free.** There is a test asserting a hand-built plan whose step
runs `frobnicate` produces a missing-tool blocker — that is the guard against re-hardcoding.

`byo-endpoint` means the operator supplies the origin. **It is also the SSRF surface** — see
`docs/SECURITY-AUDIT.md` and check whether any validation exists before adding a dial.

## Exit codes are the interface

```
doctor              0 healthy · 1 unhealthy (never throws)
deploy              0 ran · 2 refused (no --yes, or a preflight blocker)
preflight report    plan.ok === false when any check is a "blocker"
fbmail check <id>   0 done · 1 no report · 2 not END-terminated · 3 malformed brief
```

Scripts depend on these. Changing one is a breaking change — update the docs that state it.

## Related

- `docs/STATE-OF-PROJECT.md` §3 — the capability matrix with the commands that prove each row
- `docs/adr/ADR-0001-go-workspace-role.md` §4.2 — why the Go gateway cannot join the fleet yet
- Skills: `simorgh-testing` (the three green-suite-hidden bugs all lived on this boundary),
  `simorgh-architecture`
