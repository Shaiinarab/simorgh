---
type: "Historical Record"
title: "LongCat harness playbook — how to work on simorgh (2026-10-07)"
description: "An agent harness's playbook for this repo. Its command list, test counts and epic status are a dated snapshot taken before the current task queue replaced the epic numbering."
tags:
  - "simorgh"
  - "history"
generated:
  by: "process:longcat-playbook-2026-10"
  at: "2026-10-07T00:00:00+03:30"
status: "deprecated"
stale_after: "2027-02-01T00:00:00+03:30"
imported:
  by: "agent:codebuff"
  at: "2026-11-20T18:18:17+03:30"
  from: "~/personal/projects/harnesses/models/longcat/playbook/SIMORGH.md"
---
<!-- Imported verbatim from ~/personal/projects/harnesses/models/longcat/playbook/SIMORGH.md on 2026-11-20. -->

# playbook/SIMORGH.md — LongCat playbook for simorgh development

> How to work on `projects/simorgh/` effectively. Load this when the task touches simorgh.

## What simorgh is

A free-to-run, no-KYC agentic AI gateway. Federates fragmented free-tier model providers into one
"flock" and answers through whichever is healthy and configured. Zero secrets, honest degradation.

**Stack:** Cloudflare Workers, Hono, TypeScript 7 (tsgo), Durable Objects (SQLite), KV.
**Two packages:** `@simorgh/phoenix-core` (runtime-agnostic engine) + `simorgh-platform` (control plane).

## The one architectural rule

```
simorgh-platform  ──imports──▶  @simorgh/phoenix-core  ──imports──▶  nothing
```

`phoenix-core` must stay runtime-agnostic. No `cloudflare:`, no `node:` outside `src/node/`, no bare
runtime globals. Machine-enforced by `phoenix-core/test/boundary.test.ts`.

## Commands

```bash
cd projects/simorgh
upm install                     # once; node_modules not committed
npm run typecheck               # 3 configs (tsgo)
npm test                        # BOTH suites — workers first, then node
npm run test:workers            # workerd: the Cloudflare app (93 tests)
npm run test:node               # plain Node: engine + platform (261 tests)
npm run e2e:ask                 # CLI reaches live core over REST + MCP
npm run platform:smoke          # boots real core, probes, exits 0/1
npm run simorgh -- <cmd>        # targets | plan | deploy | serve | connect | ask | status | doctor
npm run security:scan           # secrets + dependency audit
npm run cf:dry-run              # wrangler bundle check
npm run go:build                # Go workspace (all 8 modules)
npm run go:vet
npm run go:test
```

## Environment traps

- `export NO_PROXY=127.0.0.1,localhost` before anything local
- `GOFLAGS` polluted machine-wide → use `GOFLAGS=-mod=readonly go build all`
- `mirror.kargadan.ir` banned as Go proxy
- `package-lock.json` must not come back (upm.lock is the lockfile)
- Node is the only JS runtime (Bun removed 2026-10-03)
- `deploy --mode cli` requires `--yes`

## Verification discipline

**"A green suite is not a verified system."** Three documented cases of all-green tests hiding real
defects. So:
- Verify against reality, not fixtures
- Distinguish `toContain` from `toEqual` where completeness is the property
- A negative control is required for any detector
- Name the test that covers a claim
- `EXIT=0` from a sub-process is not evidence the work landed — grade on artifacts

## Current state (2026-10-07)

- **Green:** 93 workerd + 261 node tests, Go build/vet/test, typecheck, e2e:ask (10/10), platform:smoke (5/5)
- **Epics 1-4:** done. **Epic 5:** 4/5 (5-3 request-to-request state passing left). **Epic 6:** 1/5 (6-2 prompt injection defense in progress). **Epics 7-12:** backlog.
- **Open mailbox tasks:** TASK-011..016
- **Open decisions:** D1-D7 in `docs/EXTERNAL-REVIEW-BRIEF.md`
- **Not done:** Vercel adapter, GitHub capability, Pages UI, metrics/tracing, dependency-vulnerability gate in CI

## Key docs

| Doc | Path | Read when |
|---|---|---|
| Architecture | `docs/ARCHITECTURE.md` | Touching module split, ports, routing |
| State | `docs/STATE-OF-PROJECT.md` | What's verified, what's next |
| Quality audit | `docs/QUALITY.md` | Dead code, untested paths, coverage |
| Security audit | `docs/SECURITY-AUDIT.md` | 25 findings (6 high, all deferred) |
| Observability | `docs/OBSERVABILITY.md` | What's measured, what's absent |
| Host portability | `docs/HOST-PORTABILITY.md` | SqlPort sync constraint, Vercel rejected |
| External review | `docs/EXTERNAL-REVIEW-BRIEF.md` | Open decisions D1-D7 |
| ADRs | `docs/adr/` | Go workspace, SqlPort, free compute, upm, free-only |

## Project skills (load ONE by name)

| Skill | Load when |
|---|---|
| `simorgh-architecture` | Module split, ports, routing policy, adding provider/host |
| `simorgh-testing` | Writing/judging tests, deciding which suite |
| `simorgh-deploy-boundary` | Targets, deploy, doctor, preflight, conformance |
| `simorgh-go-workspace` | `gateway/`, `packages/`, Go modules, GOFLAGS |
| `simorgh-lanes` | Dispatching parallel agent work through the mailbox |

## Definition of Done

Copy into PR description:
```
□ Requirements understood — conflicts with docs written down
□ Relevant existing code inspected
□ Minimal change implemented
□ npm run typecheck passes (all 3 configs)
□ npm test passes — BOTH suites
□ If boundary moved: boundary.test.ts still passes
□ If Go changed: go:build + go:vet + go:test pass
□ If claim on boundary: verified against real host/core
□ New detector has had a negative control run
□ Edge cases: empty, missing, failure, fail-closed
□ Security reviewed — no secret logged/echoed/committed
□ npm run security:scan passes
□ Docs updated where they now describe something false
□ git diff inspected; no unrelated files; no generated file hand-edited
□ Commit message says why, not what
```
