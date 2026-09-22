# AGENTS.md — simorgh-platform

Operating contract for this repository. **Rules and commands live here; depth lives in skills** (index
at the bottom). If this file and the code disagree, the code wins — and the disagreement is a bug worth
reporting.

## What this repo is

A free-to-run, no-KYC agentic AI gateway. It federates fragmented free-tier model providers into one
"flock" and answers through whichever is healthy and configured, so it runs with **zero secrets** and
degrades honestly instead of fabricating an answer.

Two surfaces, and the distinction is load-bearing:

- **a core** *answers* — rate-limit → authenticate → validate → run allow-listed tools → write the
  transparency ledger → fly the flock → answer. `/health`, `/api/v1/flock/status`,
  `/api/v1/agent/execute`, `/api/v1/user/{id}/logs`, `/mcp`.
- **the platform** *places, finds, watches and fails over between cores* — targets, connectors, deploy,
  fleet. Its MCP tools are `platform_*`.

**`simorgh_*` means one core. `platform_*` means the whole fleet.** Never alias one to the other; that
collision was found and removed once already.

## The one architectural rule

```
simorgh-platform  ──imports──▶  @simorgh/phoenix-core  ──imports──▶  nothing
```

`phoenix-core` must stay **runtime-agnostic**. No `cloudflare:` import, no `node:` import outside its
single declared adapter (`phoenix-core/src/node/`), no bare runtime global. This is machine-enforced by
`phoenix-core/test/boundary.test.ts` — it fails the build, so do not weaken it to make a change land.

Every capability the engine needs arrives as an **injected port**. If you find yourself importing a
runtime binding into the engine, the port is missing, not the rule.

Corollary: package code imports relatively with **explicit `.ts` extensions**, because plain `node` runs
these unbuilt. Match that style.

## Commands

```bash
npm install                     # once; node_modules is not committed
npm run typecheck               # 3 configs: root, phoenix-core, simorgh-platform
npm test                        # BOTH suites — workers first, then node
npm run test:workers            # workerd: the Cloudflare app
npm run test:node               # plain Node: the engine + the platform
npx vitest run --config vitest.node.config.ts <file>   # one file, scoped

npm run e2e:ask                 # the CLI reaches a live core over REST *and* MCP
npm run platform:smoke          # boots a real core on an ephemeral port, probes it, exits 0/1
npm run simorgh -- <cmd>        # targets | plan | deploy | serve | connect | ask | status | doctor
npm run security:scan           # secrets scan + npm audit --omit=dev (the CI security gate)
npm run cf:dry-run              # wrangler bundle check

npm run go:build                # Go workspace (all 8 modules)
npm run go:vet
npm run go:test
```

**Two suites, split by what each can prove.** A change that only passes one has been tested on one
runtime. `test:workers` runs inside workerd with real Durable Objects, KV and SQLite; `test:node` runs
the engine and platform with no runtime bindings at all. If the engine ever picks up a binding, the
Node suite stops resolving and goes red while the workerd suite keeps passing — that asymmetry is the
portability detector, not a quirk.

A **collection-time failure is a hard stop**, not a normal failure. Report the file and the error;
never re-run hoping.

## Environment traps (each one cost a real debugging session)

- **`export NO_PROXY=127.0.0.1,localhost`** before anything that talks to a local core. A global proxy
  env var intercepts localhost on this box.
- **`GOFLAGS` is polluted machine-wide.** `~/.config/go/env` holds `GOFLAGS=-mod=vendor` (written by an
  unrelated project), which makes every non-vendored Go build fail with a **misleading**
  `inconsistent vendoring in <dir>` even though no `vendor/` exists. Override per command:
  `GOFLAGS=-mod=readonly go build all`. **Do not delete that file** — other projects on this box want it.
- **`go test all` / `go build all` in a workspace also pulls the stdlib's and dependencies' own tests.**
  For scoped runs use the module-path pattern: `go test github.com/shaiinarab/simorgh/...`.
- **Never use `mirror.kargadan.ir` as a Go module proxy** — it serves tampered modules (a verified
  `go.sum` SECURITY ERROR). Use `proxy.golang.org` or vendored deps.
- **`deploy --mode cli` requires `--yes`.** No env var, no config file, no CI exemption. That is the
  point: a doomed plan must never start, because a half-applied deploy is the most expensive state a
  deployer can leave behind.
- Health payload shapes differ between hosts. A core sends `{status, timestamp}`; the Go gateway sends
  `{status, uptime, providers[]}`. **Do not discriminate on a field you have not seen a real host send.**

## Verification discipline — the rule that matters most

**A green suite is not a verified system.** This repo has three documented cases of all-green tests
hiding a real defect:

| What was wrong | Why no test caught it |
|---|---|
| Preflight reported "a core is already responding" for **any** HTTP status, including `501` | The test only asserted the check's `id` and severity, never the claim |
| The MCP server put `isError` **inside** the JSON payload instead of on the tool result | The suite asserted `isError` in the same wrong place the server wrote it |
| A connector stub emitted `answer`/`answeredBy` where a real core sends `agentResponse` | The stub agreed with our own mapper while disagreeing with every real core |

So, on this repo:

- **Verify against reality, not against your own fixture.** Hit a real core (or the real plan builder)
  at least once for anything on a boundary.
- **Distinguish `toContain` from `toEqual`** where a list's *completeness* is the property.
- **A negative control is required for any detector.** A scanner that never fires is not evidence.
  Plant one, watch it fail, remove it.
- **Name the test that covers a claim.** "There are 12 tests in that file" is not coverage.
- `EXIT=0` from a sub-agent or sub-process is **not** evidence the work landed — grade on artifacts.

## Conventions

- ESM, `"type": "module"`, TypeScript 7 via `tsgo` (`@typescript/native-preview`). Strict.
- **Never weaken a type, a test, or a security check to make something pass.** If a test fails because
  the implementation is wrong, fix the implementation; if it fails because the *contract* changed
  deliberately, update the test **and say so in the commit message**.
- **No secrets in code, ever.** Configuration arrives by env-var reference (`env.SIMORGH_API_KEY`,
  `process.env.CORS_ORIGINS`). `worker-configuration.d.ts` is **generated** by `wrangler types` — never
  hand-edit it; hand-written additions go in `env.d.ts`, and a secret must be declared on **both**
  `Env` and `Cloudflare.Env` or it will typecheck in the router and fail inside a Durable Object.
- Prefer the standard library and the primitives already here over a new dependency. Boring is a
  feature in a gateway.
- Comments explain **why**, and carry the evidence for a non-obvious decision. Several comments in this
  repo are load-bearing; do not strip them as "noise".
- Documentation must describe **reality**, not intent. If you change behaviour, change the doc that
  claims otherwise — `README.md`, `docs/ARCHITECTURE.md`, `docs/STATE-OF-PROJECT.md`, `docs/adr/`.

## Git rules

- Conventional-commit subjects, imperative, one line, e.g. `fix(platform): …`, `docs(adr): …`.
- **Never** `git reset --hard`, `git clean -fd`, force-push, or delete branches.
- **Never push without an explicit instruction to push.** Most work here stays local until asked.
- Keep changes **atomic and separable**; do not sweep unrelated files into a commit.
- Inspect the diff before committing and confirm it contains only what you intended.

## Definition of Done

A change is done when **all** of these hold. Copy this into the PR description and tick it.

```
□ Requirements understood — and any conflict with the docs written down, not silently resolved
□ Relevant existing code inspected (not just the file being edited)
□ Minimal change implemented — no speculative abstraction, no unrelated cleanup
□ npm run typecheck passes (all 3 configs)
□ npm test passes — BOTH suites, not just the one you touched
□ If the boundary moved: phoenix-core/test/boundary.test.ts still passes
□ If Go changed: go:build + go:vet + go:test all pass
□ If a claim is on a boundary: verified against a real host/core, not only a fixture
□ Any new detector has had a negative control run against it
□ Edge cases considered: empty, missing, failure, and the fail-closed path
□ Security implications reviewed — no secret logged, echoed, or committed
□ npm run security:scan passes
□ Documentation updated where it now describes something false
□ git diff inspected; no unrelated files modified; no generated file hand-edited
□ Commit message says why, not what
```

## Never do

- Do not hand-edit `worker-configuration.d.ts`, `package-lock.json`, or `go.work.sum`.
- Do not disable `remoteBindings: false` in `vitest.config.ts`; it is what keeps the suite hermetic and
  runnable without a Cloudflare account.
- Do not add a `vendor/` directory to work around the `GOFLAGS` trap — override per command instead.
- Do not commit anything under `.openclaw/` (agent scratch; throwaway demos live there).
- Do not "fix" a failing test by deleting it or loosening the assertion.

## Skills — load ONE, by name

Start from `docs/skills-catalog.md` at the workspace root for the full index. The ones written for
**this** repo:

| Skill | Load when |
|---|---|
| `simorgh-architecture` | Touching the module split, a port, the routing policy, or adding a provider/host |
| `simorgh-testing` | Writing or judging tests, or deciding which suite a change needs |
| `simorgh-deploy-boundary` | Anything touching targets, deploy, doctor, preflight, or conformance |
| `simorgh-go-workspace` | Touching `gateway/`, `packages/`, `bot/`, `tools/`, or a `go.work`/`GOFLAGS` issue |
| `simorgh-lanes` | Dispatching parallel agent work through the mailbox |

Relevant global skills already installed: `cloudflare`, `workers-best-practices`, `durable-objects`,
`wrangler`, `diagnosing-bugs`, `code-review`, `tdd`, `resolving-merge-conflicts`.
