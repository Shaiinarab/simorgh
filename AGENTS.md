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
  `/api/v1/agent/execute`, `/api/v1/user/{id}/logs`, `/mcp` (Node runtime only — the Workers host
  registers no `/mcp` route).
- **the platform** *places, finds, watches and fails over between cores* — targets, connectors, deploy,
  fleet. Its MCP tools are `platform_*`.

**`simorgh_*` means one core. `platform_*` means the whole fleet.** Never alias one to the other; that
collision was found and removed once already.

## Plan of record (read before starting any work)

The strategic plan is [`docs/ROADMAP-SPINE.md`](docs/ROADMAP-SPINE.md). The live task queue is
[`docs/todo/index.md`](docs/todo/index.md); each task is one Markdown concept in OKF v0.2 format
with a required `type`, sources, generation metadata, lifecycle/freshness, priority, dependency and
work-status fields. [`docs/index.md`](docs/index.md) is the documentation map.

**Order of attack:** A3 (credential-derived principal) → B1 (unify task/schedule/execution) → B2
(quota admission) → B3 (usage reconciliation) → B4 (one correct durable task) → C1–C4 (retrieval,
knowledge namespaces, memory) → D1 (one evaluated research digest) → E1–E3 (MCP and provider
discovery). Do not skip dependency gates to add providers or polish the UI.

BMAD skills remain available as optional planning aids. BMAD output is derived scaffolding, not a
competing source of truth; the roadmap and task documents win. The August PRD epic list is historical.
There is no mailbox/fbmail workflow in this repository; do not recreate one. Use the task documents,
Git branches, and pull requests for reviewable work.

Every task's acceptance ends with:
`upm install --frozen-lockfile && upm run typecheck && upm test` green (+ per-module Go build/vet/test
when Go is touched). A doc that contradicts the code or a more recent decision is stale and must be
corrected in the same change.

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

The package manager is **upm** ([unjs/upm](https://github.com/unjs/upm)) and the runtime is
**Node**. There is no `package-lock.json` and there will not be one — `upm.lock` is the committed,
reproducible build input. See `docs/adr/ADR-0004-toolchain-upm.md` for why, including what had to
change in the manifest and what had to be rebuilt in the security gate.

```bash
upm install                     # once; node_modules is not committed
upm install --frozen-lockfile   # CI: fail rather than resolve
upm run typecheck               # 3 configs: root, phoenix-core, simorgh-platform
upm test                        # BOTH suites — workers first, then node
upm run test:workers            # workerd: the Cloudflare app
upm run test:node               # plain Node: the engine + the platform
upx vitest run --config vitest.node.config.ts <file>   # one file, scoped

upm run e2e:ask                 # the CLI reaches a live core over REST *and* MCP
upm run platform:smoke          # boots a real core on an ephemeral port, probes it, exits 0/1
upm run simorgh -- <cmd>        # targets | plan | deploy | serve | connect | ask | status | doctor
upm run security:scan           # secrets scan + dependency audit (the CI security gate)
upm run cf:dry-run              # wrangler bundle check

upm run go:build                # Go workspace (all 8 modules)
upm run go:vet
upm run go:test
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
  The same file sets `GOPROXY=off`/`GOSUMDB=off`/`GOTOOLCHAIN=local`, so the `-mod=readonly` override
  only builds off a warm module cache.
- **`go test all` / `go build all` in a workspace also pulls the stdlib's and dependencies' own tests.**
  For scoped runs use the module-path pattern: `go test github.com/shaiinarab/simorgh/...`.
- **Never use `mirror.kargadan.ir` as a Go module proxy** — it serves tampered modules (a verified
  `go.sum` SECURITY ERROR). Use `proxy.golang.org` or vendored deps.
- **`package-lock.json` must not come back.** It is gitignored on purpose. A second lockfile is a
  second resolution of the same manifest, and nothing would compare them — the same
  "two definitions, nothing comparing them" trap `ledger.ts` documents. If a tool regenerates it,
  delete it rather than committing it.
- **There is one JavaScript runtime: Node.** Bun was removed on 2026-10-03 (commit `efc4769` removed
  it; `5c53dfe` had landed the third-runtime host it used to prove `SqlPort` is not Node-shaped). Do
  not reintroduce it as a runtime, a package manager, or a dependency.
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

- ESM, `"type": "module"`, TypeScript 7 via `tsgo` (`@typescript/native-preview` — pinned dev preview
  7.0.0-dev.20260707.2, unpublished since 2026-07-07; stable 7.0.2 now on npm). Strict.
- **Never weaken a type, a test, or a security check to make something pass.** If a test fails because
  the implementation is wrong, fix the implementation; if it fails because the *contract* changed
  deliberately, update the test **and say so in the commit message**.
- **No secrets in code, ever.** Configuration arrives by env-var reference (`env.SIMORGH_API_KEY`,
  `process.env.CORS_ORIGINS`). `worker-configuration.d.ts` is **generated** by `wrangler types` — never
  hand-edit it; hand-written additions go in `env.d.ts`, and a secret must be declared on **both**
  `Env` and `Cloudflare.Env` or it will typecheck in the router and fail inside a Durable Object.
- Prefer the standard library and the primitives already here over a new dependency. Boring is a
  feature in a gateway.
- **Composition over invention — most of what we build is joining what already works.** Before
  writing new code, find the system that already solved the stage (the dossiers in
  `docs/research/` and the cross-walk in `docs/REFERENCE-ARCHITECTURE.md` are the starting
  point). Adopt proven *patterns* behind our ports; copy code only when the upstream license
  allows it — every ported file carries its MIT attribution line (ADR-0007 §5). Refuse the
  mechanism when it violates an invariant (no pooled credentials, no web-account automation,
  honest degradation always); ADR-0007 §3 is the refusal list and it is load-bearing. A new
  dependency is the last resort, never the first — stdlib, then what is already installed,
  then upstream.
- New or materially revised planning documents use OKF v0.2 Markdown + YAML frontmatter, sources, generation time, lifecycle status and a freshness deadline; reserved `index.md` files remain directory indexes. Put a short TL;DR near the top. Comments explain **why**, and carry the evidence for a non-obvious decision. Several comments in this
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
□ upm run typecheck passes (all 3 configs)
□ upm test passes — BOTH suites, not just the one you touched
□ If the boundary moved: phoenix-core/test/boundary.test.ts still passes
□ If Go changed: go:build + go:vet + go:test all pass
□ If a claim is on a boundary: verified against a real host/core, not only a fixture
□ Any new detector has had a negative control run against it
□ Edge cases considered: empty, missing, failure, and the fail-closed path
□ Security implications reviewed — no secret logged, echoed, or committed
□ upm run security:scan passes
□ Documentation updated where it now describes something false
□ git diff inspected; no unrelated files modified; no generated file hand-edited
□ Commit message says why, not what
```

## Never do

- Do not hand-edit `worker-configuration.d.ts`, `upm.lock`, or `go.work.sum`. Each is generated
  from its source (`wrangler types`, `upm install`, `go mod tidy`); hand-written additions go in
  `env.d.ts`. `upm.lock` is committed, which makes it the one lockfile in the repo that a
  careless edit can quietly desynchronise from `package.json`.
- Do not disable `remoteBindings: false` in `vitest.config.ts`; it is what keeps the suite hermetic and
  runnable without a Cloudflare account.
- Do not add a `vendor/` directory to work around the `GOFLAGS` trap — override per command instead.
- Do not commit anything under `.openclaw/` (agent scratch; throwaway demos live there).
- Do not "fix" a failing test by deleting it or loosening the assertion.

## Skills — load ONE, by name

Use `docs/index.md` for the documentation map and `docs/todo/index.md` for the live work queue. The ones written for
**this** repo:

| Skill | Load when |
|---|---|
| `simorgh-architecture` | Touching the module split, a port, the routing policy, or adding a provider/host |
| `simorgh-testing` | Writing or judging tests, or deciding which suite a change needs |
| `simorgh-deploy-boundary` | Anything touching targets, deploy, doctor, preflight, or conformance |
| `simorgh-go-workspace` | Touching `gateway/`, `packages/`, `bot/`, `tools/`, or a `go.work`/`GOFLAGS` issue |


Relevant global skills already installed: `cloudflare`, `workers-best-practices`, `durable-objects`,
`wrangler`, `diagnosing-bugs`, `code-review`, `tdd`, `resolving-merge-conflicts`.
