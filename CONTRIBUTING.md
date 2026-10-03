# Contributing to Simorgh

Simorgh is a free-to-run, no-KYC agentic AI gateway: it federates fragmented free-tier model
providers into one "flock" and answers through whichever is healthy and configured, so it runs with
**zero secrets** and degrades honestly instead of fabricating an answer. See [`README.md`](README.md)
for the product and the repository map, and [`AGENTS.md`](AGENTS.md) for the operating contract — this
document is the contributor-facing view of the same rules.

**Depth lives in `.agents/skills/`, and this document deliberately does not restate it.** Those files
are written for the job; if this page and a skill disagree, the skill is closer to the code. Load one
by name when the task calls for it:

| Skill | Load when |
|---|---|
| [`simorgh-architecture`](.agents/skills/simorgh-architecture/SKILL.md) | Touching the module split, a port, the routing policy, or adding a provider or host |
| [`simorgh-testing`](.agents/skills/simorgh-testing/SKILL.md) | Writing or judging tests, or deciding which suite a change needs |
| [`simorgh-deploy-boundary`](.agents/skills/simorgh-deploy-boundary/SKILL.md) | Anything touching targets, deploy, `doctor`, preflight, or conformance |
| [`simorgh-go-workspace`](.agents/skills/simorgh-go-workspace/SKILL.md) | Touching `gateway/`, `packages/`, `bot/`, `tools/`, or a `go.work` / `GOFLAGS` problem |
| [`simorgh-lanes`](.agents/skills/simorgh-lanes/SKILL.md) | Dispatching parallel agent work through the mailbox |

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node 22** | CI pins `node-version: 22` (`.github/workflows/ci.yml`); the comment there states upm requires Node 22.3+, citing [`docs/adr/ADR-0004-toolchain-upm.md`](docs/adr/ADR-0004-toolchain-upm.md). Node is the **only** JavaScript runtime — Bun was removed on 2026-10-03 and must not come back. |
| **[upm](https://github.com/unjs/upm)** — the package manager | `upm.lock` is committed and is the reproducible build input. `npm run <script>` is how you *run a script*; npm is **not** how you install. |
| **Go 1.25** | Only if you touch `gateway/`, `packages/`, `bot/`, `tools/` (the eight modules under `go.work`). |
| Cloudflare account | Only for a real deploy. The test suites need none — see "Hermetic" below. |

```bash
upm install                     # once; node_modules is not committed
upm install --frozen-lockfile   # what CI does: fail rather than resolve
```

> **There is no `package-lock.json` and you must not create one.** It is gitignored on purpose. A
> second lockfile is a second resolution of the same manifest, with nothing comparing the two — the
> exact failure mode `phoenix-core/src/ledger.ts` was written to document having already paid for
> once. If a tool regenerates it, delete it. The rationale, including what had to change in the
> manifest and how the dependency-audit gate was rebuilt around it, is
> [ADR-0004](docs/adr/ADR-0004-toolchain-upm.md).

Node's floor is written as `engines.node: ">=20"` in `package.json`, which is lower than what the
toolchain actually needs; trust the table above. (Aligning that field is a proposed change, not one
this document makes.)

---

## The one-paragraph architecture rule

```
simorgh-platform  ──imports──▶  @simorgh/phoenix-core  ──imports──▶  nothing
```

`phoenix-core` is the **runtime-agnostic engine**; the platform is the **control plane** that places,
finds, watches and fails over between cores. The engine must stay portable: no `cloudflare:` import,
no `node:` import outside its single declared adapter (`phoenix-core/src/node/`), no bare runtime
global.

**The port pattern.** Every capability the engine needs arrives as an **injected port**
(`phoenix-core/src/ports.ts`): SQL, fetch, time, UUID, the context store. So the discipline in one
line:

> **If you find yourself wanting an import inside the engine, the port is missing — add the port, not
> the import.**

That is machine-enforced: `phoenix-core/test/boundary.test.ts` fails the build when it stops being
true. It fails on a *collection* error, which is why a boundary failure looks like a hard stop rather
than a normal test failure. Do not weaken it to make a change land. The full port table and the
nine-point invariant list are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §3 and §5; the recipes
are in [the skill](.agents/skills/simorgh-architecture/SKILL.md).

**Consequence to remember:** because the pipeline's ordering exists once, in the engine, a step you
add there lands in every host or none.

---

## The two test suites, and which one your change needs

Two configs, split by **what each can prove** — not by convenience.

| Suite | Command | Config | Files it runs | Choose it when |
|---|---|---|---|---|
| **workers** | `npm run test:workers` | `vitest.config.ts` | `test/**` | Your change needs a binding or a runtime: Durable Object RPC, KV, SQLite, the cron shape, HTTP route contracts. Runs **inside workerd** with real bindings from `wrangler.toml`. |
| **node** | `npm run test:node` | `vitest.node.config.ts` | `phoenix-core/test/**` + `simorgh-platform/test/**` | Pure logic and ports: routing, the agent tool loop, the tool executor, the ledger, validation, rate limiting, the portability invariants, targets, connectors, deploy, preflight, fleet, `doctor`. Real SQLite in memory; **no runtime, no network**. |

```bash
npm test                                              # BOTH, workers first
npx vitest run --config vitest.node.config.ts <file>  # one file, scoped
```

**The rule: pick the suite by what the test needs, not by where the file lives.** Does it need a
binding or a runtime? → workers. Pure logic and ports? → node.

**And then run both before you open a PR.** A change that passes only one suite has been tested on one
runtime. The asymmetry is the point: if the engine ever picks up a runtime binding, the node suite
stops resolving and goes red *while the workerd suite keeps passing*. That signal is the portability
detector, not a quirk.

**Hermetic by design.** The workers suite needs no Cloudflare account, no API token, and makes no
outbound request, because `vitest.config.ts` sets `remoteBindings: false`. Do not disable it. A suite
that needs production credentials to assert that a fallback works is a suite that will eventually be
disabled.

**Per-file test counts are part of the guard.** A suite that silently *shrinks* is the easiest failure
mode to miss, and a total can stay green while a file disappears. The counts live in
[`docs/STATE-OF-PROJECT.md`](docs/STATE-OF-PROJECT.md) §3.1 and in
[the testing skill](.agents/skills/simorgh-testing/SKILL.md) — **update them when you add or remove
tests**, and if a number you find there disagrees with what the suite actually prints, the suite is
right and the doc is stale.

### Three commands that check the assembled thing

Unit tests do not assemble anything. These do, and they are the ones that have caught boundary bugs:

```bash
npm run e2e:ask          # the CLI reaches a live core over REST *and* MCP, and compares the answers
npm run platform:smoke   # boots a real core on an ephemeral port, probes it, exits 0/1
npm run simorgh -- doctor  # diagnoses a fleet that will not answer
```

---

## Verification discipline — the rule that matters most

> **A green suite is not a verified system.**

This repository has three documented cases of all-green tests hiding a real defect: a preflight check
that reported success for *any* HTTP status including `501`, an MCP server that put `isError` inside
the JSON payload instead of on the tool result, and a connector stub that agreed with our own mapper
while disagreeing with every real core. The common thread: **the test encoded the implementation's
assumption instead of the outside world's contract.**

So, on this repo:

- **Verify against reality, not against your own fixture.** Hit a real core, or the real plan builder,
  at least once for anything on a boundary.
- **A negative control is required for any detector.** Plant a failure, watch the check go red, remove
  it. A scanner that has never fired is not evidence.
- **`toContain` is not `toEqual`.** Where a list's *completeness* is the property, assert equality.
  A `toContain` on `tools/list` is what once let two forbidden MCP aliases ship.
- **Name the test that covers a claim.** "There are 12 tests in that file" is not coverage.
- **A fixture must be able to express failure.** A `fetch` double with no `json()`, or a stub that
  always succeeds, cannot test an error path.
- **`EXIT=0` from a sub-agent or sub-process is not evidence the work landed.** Grade on artifacts.
- **A collection-time failure is a hard stop**, not a normal failure: report the file and the error,
  never re-run hoping.

The reasoning behind each of these, and the audit of assertions that cannot fail, is in
[`docs/QUALITY.md`](docs/QUALITY.md).

---

## How to add a provider

The short form ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6; longer form in
[the architecture skill](.agents/skills/simorgh-architecture/SKILL.md)):

1. Create a factory returning a `Provider` (contract: `phoenix-core/src/provider.ts`). At minimum
   `id`, `name`, `provider`, `model`, `priority`, `call(prompt, ctx)`; optionally `requires` for
   secret-gated dormancy.
2. **Declare capabilities explicitly.** Do not pretend providers are interchangeable — that is a
   stated non-goal of the product.
3. **Add it to the host's provider list, not to the engine.** Node:
   `simorgh-platform/src/runtimes/providers.ts`. Workers: the host entry `src/index.ts`.
4. **A missing key means dormant, not broken.** Never fail a request because a provider is
   unconfigured — that is why the gateway runs with zero secrets, and a dormant bird appearing in
   "errors" is a bug.
5. If it needs a secret, add it to that target's `secrets` in `simorgh-platform/src/targets.ts` and
   to the deploy step's `needs`. (A `FREE_ONLY` deployment will also refuse it until its cost is
   classified — see [`docs/adr/ADR-0005-free-only-mode.md`](docs/adr/ADR-0005-free-only-mode.md).)

### What a new provider will break

Three assertions pin the *complete* shipped flock by id, so adding a bird turns all three red — update
them deliberately rather than loosening them:

- `test/http.test.ts:154` — `GET /api/v1/flock/status` route contract
- `test/flock-routing.test.ts:271` — "is ordered Shāhīn → Bulbul → Homā, with Homā key-free"
- `test/durable-objects.test.ts:33` — the same list over Durable Object RPC, plus
  `toHaveLength(3)` and the `[10, 20, 30]` priorities

And **conditionally** `phoenix-core/test/boundary.test.ts`: not because adding a provider breaks it,
but because it is the guard you will trip *if* you implement the provider inside `phoenix-core/src/`
and reach for a runtime binding — a `node:` import outside the adapter, a `cloudflare:` import, or a
bare global such as `crypto.`. That is the test doing its job. Provider code that takes its fetch
through an injected port will not trip it.

---

## Adding a target or a host

Both are documented as recipes in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6 — do not
reconstruct them here. The one-line versions:

- **Target** (`simorgh-platform/src/targets.ts`): a target answers *where a core can live* and *how the
  platform reaches it*. Ship the runtime entrypoint, then append a `DeploymentTarget` whose step list
  actually completes. **Derive nothing by target id** — preflight collects argv heads and secrets from
  the plan itself, so a new target is covered for free. Hardcoding a tool list or a target id
  anywhere in preflight destroys that property, and a test guards it.
- **Host**: bind the ports, reuse the engine's tool executor and ledger rather than copying them
  (two hosts once had their own copies), and add a suite that runs the engine with **no bindings at
  all**.

## The deploy surface

`deploy --mode cli` requires **`--yes`**: no env var, no config file, no "we are in CI so obviously
yes". Without it the CLI prints exactly what it would have run and exits 2. Use `--dry-run` to execute
through a *recording* runner. **Do not add an exemption path** — the gate is the feature; if a test
needs to deploy, pass `--yes` in the command.

`doctor`, `preflight` and `conformance` are three different things and must never collapse into one:
diagnosis, a per-plan check before consent, and a per-connector contract check. Preflight is read-only
and must not do the work it checks. Details, the exit-code contract that scripts depend on, and the
health-shape trap are in
[`simorgh-deploy-boundary`](.agents/skills/simorgh-deploy-boundary/SKILL.md).

## The Go surface

The Go workspace is eight modules under `go.work`; `npm run go:build` / `go:vet` / `go:test` wrap the
commands correctly (they already set `GOFLAGS=-mod=readonly`). Two things to know before you start:
`gateway/` is a **second answering runtime**, not scaffolding, and it exposes **none** of the core
contract the platform dials — so it cannot join the fleet today. Tests come before convergence, not
after: a cross-language contract has no compiler. Read
[`simorgh-go-workspace`](.agents/skills/simorgh-go-workspace/SKILL.md) and
[`docs/adr/ADR-0001-go-workspace-role.md`](docs/adr/ADR-0001-go-workspace-role.md) first.

---

## Conventions

- **ESM**, `"type": "module"`, TypeScript 7 via `tsgo` (`@typescript/native-preview`). Strict.
- **Relative imports inside packages carry an explicit `.ts` extension**, because plain `node` runs
  these sources unbuilt. Match the surrounding style.
- **No TypeScript-only runtime syntax** — no parameter properties, no `enum`, no `namespace`. Node's
  type stripping refuses them at runtime.
- **Each port is declared exactly once, in `ports.ts`.**
- **Never weaken a type, a test, or a security check to make something pass.** If a test fails because
  the implementation is wrong, fix the implementation; if it fails because the contract changed
  deliberately, update the test **and say so in the commit message**.
- **Prefer the standard library and the primitives already here** over a new dependency. Boring is a
  feature in a gateway.
- **Comments explain *why*** and carry the evidence for a non-obvious decision. Several are load-bearing;
  do not strip them as noise.
- **Documentation must describe reality, not intent.** If you change behaviour, change the doc that
  claims otherwise — `README.md`, `docs/ARCHITECTURE.md`, `docs/STATE-OF-PROJECT.md`, `docs/adr/`.
- **No secrets in code, ever.** See [`SECURITY.md`](SECURITY.md) and `npm run security:scan`.

### Environment traps that each cost a real debugging session

- **`export NO_PROXY=127.0.0.1,localhost`** before anything that talks to a local core — a global proxy
  variable intercepts localhost on some machines.
- **`GOFLAGS` is polluted machine-wide** (`~/.config/go/env` sets `-mod=vendor` from an unrelated
  project), so every non-vendored Go build fails with a **misleading** `inconsistent vendoring`
  error. Override per command; **do not delete that file**, and do not add a `vendor/` directory to work
  around it.
- **`go test all` / `go build all`** in a workspace also pull the stdlib's and dependencies' own tests —
  use the module-path pattern. `-count=1` on any test run meant as evidence.
- **Never use `mirror.kargadan.ir` as a Go module proxy** — it serves tampered modules (a verified
  `go.sum` SECURITY ERROR). Use `proxy.golang.org` or vendored deps.
- **Health payload shapes differ by host** (a TS core sends `{status, timestamp}`; the Go gateway sends
  `{status, uptime, providers[]}`). Do not discriminate on a field you have not seen a real host send.
- **A collection error is a hard stop.**

---

## Commits and branches

- **Conventional-commit subjects, imperative, one line**: `fix(platform): …`, `docs(adr): …`,
  `feat(core): …`.
- **Commit messages say *why*, not what.**
- Keep changes **atomic and separable**; do not sweep unrelated files into a commit.
- Inspect the diff before committing and confirm it contains only what you intended.
- **Never** `git reset --hard`, `git clean -fd`, force-push, or delete branches.
- **Never push without an explicit instruction to push.** Most work here stays local until asked.

### Never do

Full list in [`AGENTS.md`](AGENTS.md) §Never do. The two that bite hardest:

- **Never hand-edit a generated file**: `worker-configuration.d.ts` (`wrangler types`), `upm.lock`
  (`upm install`), `go.work.sum` (`go mod tidy`). Hand-written additions go in `env.d.ts`. `upm.lock`
  is *committed*, which makes it the one lockfile a careless edit can quietly desynchronise from
  `package.json`.
- **Do not "fix" a failing test by deleting it or loosening the assertion.**

---

## Pull request checklist

This is [`AGENTS.md`](AGENTS.md) §Definition of Done. Copy it into the PR description and tick it —
if you cannot tick a line, say why in the PR rather than deleting the line.

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

Two additions for routes, connectors, fleet storage or MCP handler registration, from
[`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md) §4:

```
□ §1 of the security audit re-read before review (a PR that adds a route can widen an accepted finding)
□ If the change adds a second principal, stores persistent user data, or makes a core publicly
  reachable: the §4 risk acceptance is void — say so in the PR
```

### The commands a reviewer will run

```bash
npm run typecheck      # 3 configs: root, phoenix-core, simorgh-platform
npm test               # BOTH suites
npm run security:scan  # secrets scan + dependency audit — the same script CI runs
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs three jobs: TypeScript
(typecheck + tests + `wrangler deploy --dry-run`), Go (build, vet, test), and Security
(`bash scripts/security-scan.sh`). The security job deliberately needs **no install step**: there is
no `package-lock.json` to install from, and the gate resolves its own throwaway dependency tree.

---

## Where the depth is

| Document | What it holds |
|---|---|
| [`AGENTS.md`](AGENTS.md) | The operating contract: commands, conventions, Definition of Done, never-do list, git rules |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Port table, invariant list, target × connector matrix, how-to recipes, where to run things |
| [`docs/STATE-OF-PROJECT.md`](docs/STATE-OF-PROJECT.md) | Verified capabilities with the commands that reproduce them; exact suite composition |
| [`docs/QUALITY.md`](docs/QUALITY.md) | The audit of assertions that cannot fail |
| [`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md) | Trust boundaries, findings with evidence, and the recorded risk acceptance |
| [`docs/adr/`](docs/adr/) | Decisions with their evidence — including [ADR-0004](docs/adr/ADR-0004-toolchain-upm.md) (upm) and [ADR-0005](docs/adr/ADR-0005-free-only-mode.md) (`FREE_ONLY`) |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability, and what does and does not count here |
