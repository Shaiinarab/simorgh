---
type: "Project State"
title: "Simorgh — Project Scope and Current State"
description: "Evidence-oriented description of the current repository, verified capabilities and unresolved gaps."
tags:
  - simorgh
  - project-state
  - architecture
  - okf
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "stable"
stale_after: "2026-10-12T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: security-audit
    resource: "SECURITY-AUDIT.md"
    title: "Security audit"
  - id: continuation-review
    resource: "research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# Simorgh — project scope and current state

> **TL;DR:** latest pinned repository snapshot is `main` at `9687eb3`. The committed baseline reports
> 138 workerd and 504 Node tests; this docs pass did not rerun them. The remaining execution blockers are
> AUTH-004 principal ownership, quota admission/usage integration, then retrieval and memory. Follow
> [the OKF TODO queue](todo/index.md); this file's older sections are historical evidence where marked.

**Written:** 2026-09-22 · **Updated:** 2026-10-10 · **Canonical plan:** [`ROADMAP-SPINE.md`](ROADMAP-SPINE.md).
**Status:** repository-reported baseline at `9687eb3` is 138 Workers tests + 504 Node tests, with typecheck
exit 0; this docs migration did not rerun the suites. The Go baseline is repository-reported as 6 modules
with tests and 3 without tests. Earlier sections preserve dated context, not current instructions.

> **Read this as a claim set, not a fact set.** Every number and path below was true when written and
> every one is re-derivable with the commands given. If this file and the code disagree, **the code
> wins** — and that disagreement is itself a finding worth reporting.

> **Stale-subsection policy:** this file accumulates work across many branches. When a section's reality
> has moved on, the section is marked stale and left for context rather than silently rewritten — but the
> stale marker itself must be true. If a marker has gone stale *again* (e.g. something marked "stale" is
> now actually current, or a stale marker is attached to the wrong reality), that is itself a documentation
> defect worth fixing the same session.

---

## 1. Where we are

| Fact | Value |
|---|---|
| Public repository branch | `main` — HEAD `9687eb3` (2026-10-10) |
| Local worktree / remote divergence | Not inspected in this hosted documentation update |
| Historical branch details | Retained below only as dated context; not an active task |

> The prose below was written when the branch was much younger. Some of it still describes reality
> accurately; some is marked stale and kept for context. When in doubt, re-derive from git rather than
> trusting a paragraph — `git rev-parse`, `git merge-base`, and the suite counts at the bottom of §11.5
> are the cheap truth.

A free-to-run, no-KYC agentic AI gateway. It federates several free-tier model providers into one
"flock" and answers requests through whichever provider is healthy and configured — so the gateway
works with **zero secrets** (one provider needs no key) and degrades honestly when a provider is
down, dormant, or cooling off.

The product surface is two things:

1. **A core** that answers: rate-limit → authenticate → validate → run allow-listed tools → write the
   transparency ledger → fly the flock (failover) → answer.
2. **A control plane** that puts cores wherever they can run, finds them, watches them, and fails over
   between them.

Deliberate non-goals, stated in the repo: it is **not** a provider-agnostic magic layer that pretends
model differences away, and it does **not** silently degrade a failed request into a fabricated
answer.

---

## 2. The architecture that now exists

The central change of this branch: the monolith was split into an **engine** and a **control plane**,
with a one-way dependency.

```
simorgh-platform  ──imports──▶  @simorgh/phoenix-core  ──imports──▶  nothing
(control plane)                 (runtime-agnostic engine)
```

| Package | Path | Role |
|---|---|---|
| `@simorgh/phoenix-core` | `phoenix-core/` | Provider routing, the agent tool loop, the tool executor, request validation, rate limiting, the transparency ledger, health/cooldowns. **No runtime bindings** — every capability arrives as an injected *port*. |
| `simorgh-platform` | `simorgh-platform/` | Targets, REST + MCP connectors plus a conformance kit, deploy plans + a preflight gate, the fleet, the platform's *own* MCP server, and a self-hosted Node core. |
| the Cloudflare app | `src/` (root) | The Workers host: Hono routes, the `FlockCoordinator` and `DataTrustVault` Durable Objects, and host adapters that bind the engine to `Env`. |

**The rule is absolute and machine-enforced.** `phoenix-core/test/boundary.test.ts` fails the build if
the engine contains a `cloudflare:` import, any `node:` import outside its single declared adapter, or
a bare runtime global (`Response`, `crypto.`, `SqlStorage`, …). The engine is portable *because* it
cannot drift.

Full detail — the port table, the `FlightDeps` seam, the invariant list, and how-to recipes for adding
a provider/target/host — is in [`ARCHITECTURE.md`](ARCHITECTURE.md). Read that first.

### 2.1 The one genuinely clever seam

`executeAgent()` takes a **union** of two dependency shapes. A host can either hand over the raw
ingredients (`providers`, `cooldownUntil`, `record`) and let the engine fly them, or fly them itself
and hand back the result (`fly`).

The second form is not symmetry, it is a hard constraint: on Cloudflare the cooldown and observation
writes live in Durable Object SQLite, reachable only over RPC, and **a closure cannot cross that
boundary**. Without the seam the Workers host had to re-implement the pipeline's ordering — so the
Data Trust contract ("the request is recorded before any provider is dialled") held in one deployment
and was merely *assumed* in the other. Now the order exists once.

---

## 3. What works, verified — the durable table

Every row below was executed, not inferred. Commands are copy-pasteable from the repo root.
**§3.1 is explicitly stale** (the per-file composition describes a tree three commits old) — the live
suite counts you should measure regressions against are in §11.5. The workers suite is root `test/**`,
not `simorgh-platform/test/**` — the latter is part of the Node suite.

| # | Claim | Command | Result |
|---|---|---|---|
| 1 | Types pass across all three configs | `npm run typecheck` | clean (0 errors) |
| 2 | The Workers app works in workerd | `npm run test:workers` | **138 passed** (14 files) — current as of HEAD |
| 3 | The engine + platform pass on plain Node | `npm run test:node` | **504 passed** (28 files) — current as of HEAD |
| 4 | The platform reaches a live core **over REST and MCP**, and the answers match | `npm run e2e:ask` | **10/10 checks** |
| 5 | A real core boots **unbuilt** and answers | `npm run simorgh -- smoke` | 5/5 checks (health, flock status, auth-fails-closed, execute-degrades-honestly, mcp-initialize) |
| 6 | The engine runs on a different runtime | `freebuff2 bash -lc 'cd … && npx vitest run --config vitest.node.config.ts'` | **202 passed on Node 22.23** (host is Node 26.7) |
| 7 | No build step is needed to run the thing | `node simorgh-platform/src/cli.ts targets` | works |

> The container column matters: the whole suite was re-run inside a clean `freebuff2` container against
> the same mounted tree, and passed identically. That is the portability claim actually tested.
>
> > **Note:** the per-file counts in §3.1 were current when written and are now stale. The stale marker
> > in §11.5 is the single source of truth for which numbers you should re-derive regressions against.

### 3.1 Exact suite composition (so a regression is visible as a number) — **STALE, §11.5 owns the current counts**

**workerd — 11 files, 93 tests:** `agent` 17 · `flock-routing` 14 · `http` 12 · `health-storage` 11 ·
`durable-scheduled` 10 · `durable-objects` 9 · `security` 7 · `index` 4 · `telegram` 4 · `rate-limit` 3 ·
`core-wiring` 2
(the last is a 2-test probe proving the workspace package resolves *inside workerd*).

**Node — 19 files, 261 tests.** Engine (10 files, 148): `scheduled` 32 · `quota` 27 · `security` 19 ·
`ledger` 14 · `tools` 14 · `flock` 11 · `agent` 9 · `storage` 9 · `execute` 8 · `boundary` 5.
Platform (9 files, 113): `targets` 17 · `preflight` 16 · `connectors` 15 · `integration` 13 ·
`mcp-server` 13 · `doctor` 12 · `deploy` 11 · `fleet` 10 · `conformance` 6.

> **Why keep the stale numbers?** They let you spot the delta (`93 → 138`, `261 → 473`) in one glance,
> which is exactly what the stale marker is for. Current counts are at the bottom of §11.5 and were
> re-verified this session: workers **138**, node **473**.

A collection-time failure is *not* a normal failure: treat it as a hard stop. `phoenix-core/test/boundary.test.ts`
(5 tests) is the guard that keeps the engine portable, and it fails on a *collection* error, which is why the
totals above are asserted per file rather than by intent.

### Capability matrix

| Capability | Exists | Working | Tested | Notes |
|---|---|---|---|---|
| Core API (Hono, workerd) | ✅ | ✅ | ✅ | Route contracts pinned in `test/http.test.ts` |
| Agent runtime (bounded tool loop) | ✅ | ✅ | ✅ | Sequential by design, budget of 4 iterations; synthesis folds tool results into the prompt |
| Provider abstraction | ✅ | ✅ | ✅ | `Provider` contract + factories; capability differences are explicit |
| Failover | ✅ | ✅ | ✅ | Priority order, dormant skip, cooldowns, fail-through. **A throwing provider no longer 500s the request** (behaviour change, deliberate) |
| Tool allow-list | ✅ | ✅ | ✅ | `search_web`, `get_server_time`. Bodies live in the engine once, shared by both hosts |
| Authentication | ✅ | ✅ | ✅ | Bearer + constant-time SHA-256 compare; **fails closed** with 503 when unconfigured |
| Rate limiting | ✅ | ✅ | ✅ | Per-user SQL counter in a Durable Object |
| Persistence | ✅ | ✅ | ✅ | SQLite both sides: DO `SqlStorage` on the edge, `node:sqlite` self-hosted |
| Transparency ledger | ✅ | ✅ | ✅ | Append-only, written *before* the flight. One implementation, two hosts |
| Telegram | ✅ | ✅ | ✅ | Client + webhook; `src/telegram.ts:116` reads `X-Telegram-Bot-Api-Secret-Token`, and `test/telegram.test.ts` covers it (4 tests) |
| Dashboard | ✅ | ✅ | ✅ | `src/dashboard.ts` rendered by `GET /dashboard` (`src/index.ts:195`), asserted by `test/http.test.ts` (25 tests) |
| Cron | ✅ | ✅ | ✅ | Stale-health sweep |
| Multi-target deploy | ✅ | ✅ | ✅ | 3 real targets (`cloudflare-workers`, `node`, `byo-endpoint`), manual mode for all three; `cli` for `cloudflare-workers` and `node` only |
| Deploy preflight gate | ✅ | ✅ | ✅ | 33 tests; verified live against a real core *and* an impostor on a port |
| Platform MCP server | ✅ | ✅ | ✅ | 13 tests; session-enforced, MCP-spec-correct tool errors |
| Connector conformance kit | ✅ | ✅ | ✅ | 7 conformance checks (`conformance.test.ts`: 13 tests); runs both connectors against one double and fails a deliberately broken one |
| Fleet + failover across cores | ✅ | ✅ | ✅ | `Fleet.ask` reports *every* failure, not just the last |
| `doctor` (diagnose a broken fleet) | ✅ | ✅ | ✅ | 12 tests; stable codes, never throws on an unhealthy fleet |
| Observability | ⚠️ | partial | partial | Request IDs + structured errors. No metrics/tracing. |
| GitHub integration | ❌ | ❌ | ❌ | Not started |
| Vercel adapter | ❌ | ❌ | ❌ | Not started |
| Pages UI | ❌ | ❌ | ❌ | Not started |

✅ verified · ⚠️ partial / unverified · ❌ absent

---

## 4. The Go side — a second *runtime*, not a duplicate

> **Correction.** An earlier draft of this file said the Go work was "not built or tested" and
> "uncommitted". Both were wrong, and both are the kind of claim that should never be asserted
> without running the command. Verified below.

`go.work` declares **eight Go modules** — `bot`, `gateway`, `tools`, and
`packages/{config,crypto,ledger,providers,providers/groq}` — 17 `.go` files, 2 864 lines. It is
**committed** (`7a54d64 feat(go): land the self-hosted gateway workspace`) and it is **green**, both
locally and in CI (the `go` job in `.github/workflows/ci.yml`):

| Check | Command | Result |
|---|---|---|
| Build | `GOFLAGS=-mod=readonly go build all` | exits 0 |
| Vet | `GOFLAGS=-mod=readonly go vet github.com/shaiinarab/simorgh/...` | exits 0 |
| Test | `GOFLAGS=-mod=readonly go test github.com/shaiinarab/simorgh/...` | 6 packages `ok`, 3 `no test files` |

Override `GOFLAGS` per command: the host's `~/.config/go/env` holds `GOFLAGS=-mod=vendor` written by
another project, which makes every non-vendored build fail with a *misleading* "inconsistent vendoring".

### 4.1 `gateway/` is a real answering runtime, with a *different* wire contract

This is not scaffolding. `gateway/internal/server/server.go` (328 lines) serves:

- `POST /v1/chat/completions` — OpenAI-compatible, **with SSE streaming** — which no TypeScript host implements.
- `GET /v1/models` — aggregated catalog across adapters, with per-provider warnings.
- `GET /health` — `{status, uptime, providers[]}`. Note: **not** the core's shape.
- `GET /status` — per-provider requests/tokens/errors **plus remaining daily quota** from a configured
  cap (e.g. Groq's ~14 400/day). No TypeScript host models quota at all.
- `GET /simorgh/config` — a bootstrap channel for bot peers behind bearer-token auth.
- `packages/crypto` — AES-256-GCM sealing of provider keys with argon2id derivation: **secrets at
  rest**. The TypeScript side only reads secrets from the environment.

Its failover is *near*, not identical: `Registry.Select` orders by health, then latency EMA
(`0.7·old + 0.3·new`), then priority, and drops an adapter after **3 consecutive errors**. The engine
orders by priority with explicit cooldowns. Same question, **two policies** — which is the real risk
here: two half-maintained truths, not duplicated code.

### 4.2 The precise gap

**The Go gateway cannot join the platform's fleet.** The core contract the platform dials is
`GET /health`, `GET /api/v1/flock/status`, `POST /api/v1/agent/execute`,
`GET /api/v1/user/{id}/logs`, and `POST /mcp` (`simorgh_status`, `simorgh_ask`). The Go server exposes
**none** of those. So today the product's central promise — *connect a core wherever it runs* — holds
only for TypeScript hosts.

Second gap: the HTTP surface was untested until `server_test.go` landed; the SSE writer and failover
loop remain the thinnest Go coverage. `packages/providers/selection_test.go` (142 lines),
`packages/crypto`, `packages/config`, `packages/ledger` and `gateway/internal/server` are tested.

Decision recorded in [`adr/ADR-0001-go-workspace-role.md`](adr/ADR-0001-go-workspace-role.md).
**Nothing is deleted.**

---

## 5. What is not done

Product: no Vercel adapter, no GitHub capability, no Pages UI.
Hardening: no metrics/tracing, no dependency-vulnerability gate in CI (`npm audit` exists as the
`security:check` script but **is not called by CI**), no secrets-scanner.
Process: PR #1 (`production-readiness-v0-3`, the ChatGPT push) is still **open** against `main` — and
this branch's base commit `e0053fc` **is** that PR's head, so this branch is stacked directly on top of
it. A local `main` exists at `2dca0dd`, one commit ahead of `origin/main`.

### 5.1 A real defect found and fixed during this pass, as an example of what to look for

PR #1's hardening had a **double-escaped regex** on line 23 of `src/security.ts`:
`/^Bearer\\s+(.+)$/i` — two literal backslashes instead of `\s`. `extractBearerToken` therefore
returned `undefined` for *every* request, so **every authenticated route 401'd**. One character
produced 8 test failures *and* 7 type errors, and it was invisible in review because the code "looked
hardened". The lesson generalises: on this repo, *run the suite* — do not read the diff.

---

## 6. How to run it

```bash
cd projects/simorgh

upm test                                     # both suites, workers first
upm run typecheck                            # three configs

upm run e2e:ask                              # the CLI reaching a live core, over REST and MCP
upm run platform:smoke                        # boot a real core, probe it, exit 0/1

upm run simorgh -- targets                    # where a core can live
upm run simorgh -- plan node --origin 127.0.0.1:8788
upm run simorgh -- deploy node --mode cli --dry-run   # preflight-gated; prints, runs nothing
upm run simorgh -- serve                      # run a phoenix-core here
upm run simorgh -- connect node http://127.0.0.1:8788 --api-key <token>
upm run simorgh -- ask "who is simorgh" --prefer rest
upm run simorgh -- status
upm run simorgh -- doctor
```

Two environment notes, both load-bearing:

- **Set `NO_PROXY=127.0.0.1,localhost`** for anything that talks to a local core. A global proxy env
  var intercepts localhost on this box otherwise.
- **`deploy --mode cli` requires `--yes`.** There is no env var, no config file, and no "we're in CI
  so obviously yes". Without it the CLI prints what it *would* run and exits 2.

### Historical coordination process (retired)

The project previously coordinated work with brief/report files and a custom board. That framework was
removed on 2026-10-10 because the 17 coordination tasks are closed and their durable results have been
moved into source, tests, ADRs and research documents. The active queue is now
[`docs/todo/index.md`](todo/index.md); see the
[retirement record](history/coordination-retirement-2026-10-10.md) for the destination of each result.

**Current review rule:** grade work on changed artifacts and acceptance evidence, not a runner's exit
code. Verify boundary claims against a real core or builder, use negative controls for detectors, and
run both TS suites before merging runtime changes.
---

## 7. Open decisions (need a human or a deliberate choice)

1. **The Go fork** (§4): consume the engine's contract, or archive.
2. **PR #1**: merge, or fold into this branch's history? This branch is built *on top of* its two
   commits, so merging this branch supersedes it.
3. **Sequential vs parallel agent execution**: the loop is sequential and bounded on purpose. Parallel
   is only worth it where the workload actually benefits — *not* because swarm sounds good.
4. **Which branch is the default.** `origin/main` is the remote default, but local `main` (`2dca0dd`)
is one commit ahead of it and this branch is stacked on `production-readiness-v0-3`, not on `main`.
Pick the integration order deliberately: `production-readiness-v0-3` → `main`, or this branch as one
PR that supersedes it.
5. **Whether the Go gateway converges on the core contract** (decision 1, §4.2). Recorded as
ADR-0001 with a prerequisite.

---

## 8. Suggested next engineering steps, in dependency order

1. **Commit and stage this branch properly**, then reconcile PR #1 (decision 2). The work was 84
   uncommitted paths (17 modified + 67 new — the "33" was `git status`'s *collapsed* directory count,
   not a file count) — the highest-risk state in the whole repo. **Done in this pass**: see §10.
2. **Establish a coverage floor and hunt genuinely dead code.** (Correction to an earlier draft of
   this file: the dashboard *is* wired and tested. Do not trust a "this looks untested" impression —
   `grep -rn` and the per-file counts in §3.1 settle it in seconds.)
3. **Build the Go decision** (decision 1) into an actual outcome: a thin Go client of the core's REST
   API, or an archive move with a README note. Either way, stop paying interest on the fork.
4. **Add a dependency/vulnerability gate** (`npm audit --omit=dev` is already a script) plus a
   secrets scan to CI. Cheap, and this repo handles provider credentials.
5. **Add the Vercel adapter** as the next host — it is the cheapest real test of the portability
   claim, because it is neither workerd nor Node-with-SQLite. If the engine needs changes to fit a
   third host, that is the boundary finding worth having.
6. **Then** product surface: GitHub capability, Pages UI.

---

## 9. Provenance

Everything above was produced on 2026-09-22 from the working tree at `e0053fc`, by: reading the source,
running both suites, running the e2e and smoke harnesses, running the suites again inside a clean
container and building/vetting/testing the Go workspace. The old coordination reports are retired; their durable outcomes are mapped in [the retirement record](history/coordination-retirement-2026-10-10.md).

### 9.1 Claims this file got wrong, and how they were caught

Two were false as first written, and both were caught by running a command rather than re-reading:

| Claim | Reality | How it was caught |
|---|---|---|
| "There is no local `main` branch" | `main` exists at `2dca0dd`, ahead 1 of `origin/main` | `git branch -avv` |
| "The Go work was not built or tested" | builds, vets and tests clean; runs in CI | `go build all`, `go vet`, `go test` |
| "33 changed files" | 84 paths (17 modified + 67 new) | `git status --short -uall \| wc -l` |

Every one of those errors was in the *direction of understating what exists*. That is the more
dangerous direction — it invites rewriting work that is already done and green.

Three adversarial checks were run because a green suite is not evidence on its own:

- The deploy gate was verified **live** against a real core *and* against an unrelated server occupying
  a port — which caught a preflight check that claimed *"a core is already responding (HTTP 501)"* for
  any status at all. It now reads the health payload and distinguishes a core from an impostor.
- The MCP server was checked against the **spec**: it had put `isError` *inside* the JSON payload
  rather than on the tool result, so any compliant client would have read a failed tool as a success.
- The connector test stub was checked against the **wire**: it emitted `answer`/`answeredBy` (the
  platform's vocabulary) instead of `agentResponse`/`meta.answered_by` (a core's), so it agreed with
  our own mapper while disagreeing with every real core.

Each of those was found by *running* something, not by reading a diff. Keep doing that.

---

## 10. What the second pass committed, and what it changed

The 84 pending paths were landed as **six atomic commits** on top of `e0053fc` (which is PR #1's own
head, so this branch is stacked directly on the PR rather than on `main`):

| Commit | What it carries |
|---|---|
| `fe4bdb3` | `refactor(core)`: the engine extraction — `phoenix-core/`, the eight Worker host adapters, the affected tests, the workspace wiring |
| `4f99637` | `feat(platform)`: the control plane — targets, connectors + conformance, deploy + preflight, fleet, MCP server, Node runtime, CLI |
| `f9d9dec` | `docs`: ARCHITECTURE.md, this file, and `adr/ADR-0001` |
| `a8ce109` | Historical coordination commit; its custom workflow has since been retired |
| `07d7266` | `ci`: the comment recording that one `npm test` invocation covers both suites |
| `1f38842` | `docs(readme)`: the module split, both suites, the platform CLI, and the repository-map fix |

Nothing was pushed. PR #1 remains open — merging this branch supersedes it, and that is a decision for
the repository owner, not for an agent.

### 10.1 Corrections made in the same pass

| Claim | Was | Now |
|---|---|---|
| README repository map | nested the root `src/*.ts` files under `simorgh-platform/`, describing a tree that does not exist | corrected, with the host adapters and both suites listed |
| Old coordination note | claimed Go work was uncommitted | the Go workspace is committed (`7a54d64`); current gates live in CI and `CONTRIBUTING.md` |
| `AGENTS.md` | described a single-package Worker; never mentioned the split, the two suites, the CLI, or the Go workspace | rewritten around the real tree, the boundary rule, the environment traps, and a definition of done |
| `.gitignore` | `.openclaw/` not ignored, although several briefs direct a worker to write a throwaway demo *inside the repo* | ignored |

### 10.2 Added in this pass

- **`docs/adr/ADR-0001`** — the Go workspace's role, decided on evidence (tests before convergence;
nothing deleted).
- **`docs/adr/ADR-0002` + `docs/HOST-PORTABILITY.md`** — the Vercel evaluation, and the finding behind it:
**`SqlPort` is synchronous, so no networked database can implement it.** The portability claim is
narrower than the README implied — portable across runtimes that can supply a *synchronous* SQL
implementation. Vercel is therefore deferred. Deno 2 is the cheaper third host still untested; the Bun host that
answered this question was built, proven, and then removed by owner decision (`5c53dfe`).
- **`docs/OBSERVABILITY.md`** — what exists, what the ledger already answers, and the one real gap:
**provider latency is recorded nowhere on the TypeScript side** (while the Go side keeps an EMA).
- **`scripts/security-scan.sh`** — the secrets + dependency gate, wired into CI *and* runnable locally as
`npm run security:scan`. Verified with a negative control: exit `1` with a planted token, `0` clean.- **`.agents/skills/`** — five project skills: `simorgh-architecture`, `simorgh-testing`,
  `simorgh-deploy-boundary`, `simorgh-go-workspace`.

---

## 11. The 2026-10-08 pass — the launch-blocking security fix, and two commits

**Historical evidence, written 2026-10-08.** Its commands and conclusions describe that session's snapshot; re-run them before treating the results as current.

### 11.1 The finding that mattered: a fix that was staged but not wired

The tree arrived with **4,223 lines staged and uncommitted** across 25 paths, and `npm run typecheck`
**failing** on one of them (`parseTokenSubjects` returned `{[k: string]: unknown}`, which is not
`Readonly<Record<string, string>>`). Fixing that type error unblocked the rest.

The staged work turned out to contain the primitives for the **AUTH-002/AUTH-003 fix** — and none of
the wiring. `authenticateServiceIdentity` had **zero callers**; `subjectMatches` had **zero callers
anywhere, including tests**; and `src/index.ts` had not been touched at all. So both IDOR holes were
still open while the code that closes them sat in the diff looking finished. This is the repo's own
documented failure mode — *an all-green suite hiding a real defect* — and the reason the audit's
§4 acceptance is void here is that the 11 October launch is both a **second principal** and a **public
deployment**, the two triggers it names.

### 11.2 What landed, as two commits

| Commit | What it carries |
|---|---|
| `85f5be5` | `feat(core)`: the capability layer, provider parity, the Gemini/OpenRouter birds, the `upm`-correct deploy step, and the four docs that are that work's rationale |
| `ffd925c` | `fix(security)`: AUTH-002 + AUTH-003 closed **on both hosts**, with tests, a positive control inside each test, and a negative control run on each host |

The security commit is the one to read. Three things in it are worth carrying forward:

1. **The Node host had the identical hole.** `simorgh-platform/src/runtimes/node.ts` served the same
   two routes with the same missing check. A fix on the edge alone would have left a reachable host,
   and the workerd suite cannot see the Node runtime at all — which is exactly the asymmetry §3.1's
   per-file counts exist to make visible.
2. **Ownership needed the ledger.** A `refId` had no link to a principal except the append-only
   `ref_id` column, so this added `LedgerPort.findByRef`, an index, and the DO RPC. The index is a
   *second* `exec()` rather than more text in `LEDGER_SCHEMA`, because the Node host's `SqlPort` is
   `node:sqlite`'s `prepare()`, which prepares **one** statement — the combined version would have
   thrown there while passing on a Durable Object.
3. **Deliberate behaviour change, and it is a refusal.** With `SIMORGH_API_KEY` alone there is no way
   to attribute a token to a user, so the per-user routes answer `503 IDENTITY_UNRESOLVED` instead of
   guessing. A solo deployment loses only the ability to read a per-user ledger until it sets
   `SIMORGH_API_KEYS`. Every other route is unaffected.

### 11.3 A second bug, found because a test disagreed

`authenticateServiceIdentity` checked the token *before* the configuration, so an unconfigured
deployment answered `401` on these two routes where the rest of the app answers `503`.
`platform-connectors.test.ts` caught it — its per-route "fails closed" assertion is the reason the two
paths now agree. Worth noting as a pattern: the test that caught this was not written for this change.

### 11.4 Found, not fixed

- **A `SIMORGH_API_KEYS` token cannot execute.** It can read its own data but `/api/v1/agent/execute`
  still authenticates against `SIMORGH_API_KEY` alone, so a multi-caller deployment must issue both.
  Closing it is not mechanical: the `userId` would have to come from the token instead of
  `X-Simorgh-User-Id`, or a caller can spend another caller's rate-limit budget and write ledger rows
  in their name (AUTH-004). Recorded at `NodeRuntimeOptions.apiKeys`.
- **Four HIGH findings remain carried** under the audit's §4: AUTH-001, SSRF-001, MCP-001, SEC-001.
  With AUTH-002/003 closed the §4 table records two of its six as no longer deferred.
- **Retrieval is still unbuilt** (`docs/research/WHERE-WE-ARE-AND-WHERE-WE-GO.md` §1). The launch cut
  deliberately excludes it; the embedding budget, not the engineering, is the binding constraint.

### 11.5 Numbers as of this commit

| Check | Result |
|---|---|
| `npm run typecheck` | clean, 3 configs |
| `npm run test:workers` | **138 passed**, 14 files |
| `npm run test:node` | **504 passed**, 28 files |
| `npm run platform:smoke` | **5/5** |
| `npm run e2e:ask` | **10/10** |
| `go build` / `go vet` / `go test` | green, 6 packages |
| `npm run security:scan` | PASS — `.dev.vars` present but never tracked |

The per-file composition in §3.1 is **stale** and is left as written 2026-09-22 rather than
re-derived: it described a tree three commits old, and the totals above are the ones a regression
should be measured against. Re-derive the per-file numbers if a specific file's count is what you need.

### 11.6 The capability matrix is wired, so the pattern is now broken once in each direction

`capabilities.ts` and the identity primitives were both built-but-unwired. The second one is now wired:
`GET /api/v1/capabilities` on **both** hosts, over a shared probe layer
(`phoenix-core/src/capability-probes.ts`, TASK-017, five commits). It is bearer-gated, because it names
which providers the deployment holds keys for.

A live core, on a **host difference four documents describe and no command previously showed**:

```
GET /api/v1/capabilities  (node host, real defaultProviders, 3 keys set)
  inference   ok       3/4 available: shahin, gemini, bulbul
  embeddings  DEGRADED 0/1 available: (none)  [no_adapter_registered]
  ... 4 of 5 capabilities degraded
```

**Four adapters, not five, and that is correct** — the Node roster is the Workers catalog *minus Homā*,
because Homā is a Cloudflare binding with no Node equivalent. With no keys at all but `OLLAMA_BASE_URL`
set, the same endpoint answers `inference ok 1/5 available: ollama` — the key-free local path is real.

**One open gap, and it is a vocabulary problem rather than a missing line:** `ollama` classifies as
`unknown`, so under `FREE_ONLY` the planner refuses the *only* key-free option on the self-hosted host.
`renewing` means "does this allowance refill", and a local daemon has no allowance — your own hardware,
unbounded and always present. Neither `true` (a refilling quota that does not exist) nor `false` (a
one-time grant, spend last) is true, so this needs a third state decided rather than a value guessed.
Track the resolution in [provider discovery](todo/E2-provider-discovery.md) and [ADR-0005](adr/ADR-0005-free-only-mode.md); do not guess whether local inference is a renewing free allowance.

---

## 12. Truth reconciliation — 2026-10-09 (§0 of `ROADMAP-SPINE.md` is the canonical ledger)

Everything in §1–§11 above was written against older branch states; per this file's own policy the
prose is kept, and this section records what changed and where truth now lives. **§1's branch table is
stale**: the public repository snapshot used for this update is `main` at `9687eb3`.

### 12.1 The roadmap changed shape: from feature list to vertical spine

The project crossed the point where another module adds capability. The plan is now one executable
spine — `Principal → Goal → Task DAG → Capability → Quota/Cost Plan → Provider+Account+Model →
Execution → Tools/MCP/Retrieval → Result → Verification → Persist → Memory → Next Task` — encoded in
[`ROADMAP-SPINE.md`](ROADMAP-SPINE.md) with epics A–F and an explicit freeze list (no Rust core, no
second scheduler/task DB, no provider chase, no pooled free credentials, no giant PWA yet). Phase
ledger: Foundation/Routing/Capability/Task-model **done**; Durable execution **active** (Phase 4);
Retrieval / Memory / Autonomous loop **next**; Connectors / UI **later**.

### 12.2 Toolchain: verified green on Node 22 + Go 1.26, upm-everywhere

| Check (all run 2026-10-09) | Result |
|---|---|
| `fnm`-managed Node | **v22.23.3 default** (`.nvmrc`=22), **v26.11.1** available for eval slices |
| `upm install --frozen-lockfile` | ✅ 93 pkgs |
| `upm run typecheck` (tsgo ×3 projects) | ✅ exit 0 |
| `upm run test:workers` | ✅ 14 files / **138 passed** |
| `upm run test:node` | ✅ 28 files / **504 passed** (was 473 — swarm/session/capability suites grew) |
| Go workspace on **go1.26.0** | ✅ all modules build/vet/test clean (`./...` must be run per-module or from a module dir; root repo dir is not itself a Go module) |
| npm/Bun/pnpm remnants in docs & scripts | ✅ swept — instructions now say `upm run …` / `upx …`; historical evidence lines keep their original commands, labelled |

TypeScript note: stable TS 7 (native compiler, ~8–12× full-build speedups per Microsoft's 7.0
announcement) is the target; `@typescript/native-preview` (`tsgo`) stays canonical until an isolated
`typescript@7`/`tsc` evaluation slice passes all three tsconfigs — never mixed with feature work
(ROADMAP-SPINE A2). Vitest stays at 4.x pinned by `@cloudflare/vitest-pool-workers` compat; do not
bump to 5 blindly.

### 12.3 What §11.4 left open is now formally EPIC-A3 / EPIC-B

- **AUTH-004** (caller-supplied `X-Simorgh-User-Id` still believed by `/api/v1/agent/execute`) is
  promoted to the **gate**: multi-user autonomous execution is forbidden until credential-derived
  `principalId` owns every task/schedule/memory/retrieval/connector/ledger operation, with the seven
  cross-principal negative tests listed in ROADMAP-SPINE A3.
- **The quota brain is still disconnected from the machine that spends quota.** `planTaskRun()` calls
  `planQuotaRun()`, but production scheduled execution is claim→fly. EPIC-B makes the invariant real:
  *nothing spends provider quota until the capacity planner says it can*, then closes the usage loop
  (`recordUsage()` → health → ledger). B4 proves one end-to-end durable task through the whole spine.
- **Retrieval remains unbuilt** — confirmed again by the 2026-10 external audits; EPIC-C starts with a
  `RetrievalPort` in phoenix-core (core never imports `env.AI_SEARCH`), Cloudflare AI Search adapter
  first (hybrid search, built-in storage, namespace isolation; Free ≈1k semantic + 1k full-text
  queries/mo, billing from 2026-11-01), plus a tiny `POST /knowledge` slice with retrieval provenance.
- Swarm (`swarm.ts`) plans but does not drive execution — EPIC-D gives it exactly one real job
  (multi-source research digest) rather than a second framework.

### 12.4 Where planning truth lives now

- [`ROADMAP-SPINE.md`](ROADMAP-SPINE.md) owns the architecture, dependencies, phase order and freeze list.
- [`todo/index.md`](todo/index.md) and its linked OKF v0.2 task documents own the live implementation queue.
- [`index.md`](index.md) maps the documentation bundle. New/updated task concepts carry provenance,
  generation time, lifecycle/freshness and work-status metadata.
- BMAD skills remain available as optional tools; generated sprint/planning artifacts are derived and
  never override the roadmap or TODO queue.
- The 17 old coordination tasks are closed. Their durable conclusions live in the existing ADRs,
  architecture/security docs and research reports; the retired framework and task files are summarized
  in [the retirement record](history/coordination-retirement-2026-10-10.md).

**Order of attack:** A3 → B1 → B2 → B3 → B4 → C1 → C2 → C3 → C4 → D1 → E1 → E2 → E3.
