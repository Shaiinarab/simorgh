# Simorgh — external review brief

**Purpose:** hand this to an external model (ChatGPT) to brainstorm the *next move*. It is
self-contained; no repository access is needed to reason about it.
**Written:** 2026-09-24 · **Repo state:** `feat/phoenix-core-modularization` @ `5c53dfe`, working tree clean.
**How to read the numbers:** §3 says explicitly which figures I re-ran today and which are carried
from the project's own docs. Treat anything unmarked as a *claim*, not a measurement.

---

## 0. The ask

I have a working system with several plausible next moves and a limited amount of uncompensated time.
I want you to:

1. **Rank the candidate directions in §7** by leverage, with the dependency order between them —
   several look independent and are not.
2. **Attack the assumptions.** §8 lists constraints I believe are hard. Tell me which ones I am
   treating as fixed when I shouldn't.
3. **Name what I am not seeing** — the strongest argument against my current instinct (which is: fix
   the security findings, then make the Go runtime join the fleet).
4. **Tell me what NOT to do next**, and why. A "you are about to spend a week on the wrong thing"
   answer is more useful to me than a longer list of options.

---

## 1. What Simorgh is (60 seconds)

A **free-to-run, no-KYC agentic AI gateway**. It federates several free-tier model providers into one
"flock" and answers each request through whichever provider is healthy and configured — so the gateway
**works with zero secrets** (one provider needs no key) and **degrades honestly** when a provider is
down, dormant, or cooling off.

Two product surfaces:

1. **A core that answers:** rate-limit → authenticate → validate → run allow-listed tools → write an
   append-only transparency ledger → fly the flock (failover) → answer.
2. **A control plane that puts cores wherever they can run**, finds them, watches them, and fails over
   between them. Cores are discovered/dialled over **REST and MCP**.

**Deliberate non-goals, stated in the repo:** it is *not* a provider-agnostic magic layer that pretends
model differences away, and it *never* silently degrades a failed request into a fabricated answer.
Honest failure is a feature.

---

## 2. Architecture

The central refactor: a monolith split into an **engine** and a **control plane**, with a one-way
dependency.

```
simorgh-platform  ──imports──▶  @simorgh/phoenix-core  ──imports──▶  nothing
(control plane)                 (runtime-agnostic engine)
```

| Package | Path | Role |
|---|---|---|
| `@simorgh/phoenix-core` | `phoenix-core/` | Provider routing, the agent tool loop, the tool executor, request validation, rate limiting, the transparency ledger, health/cooldowns. **No runtime bindings** — every capability arrives as an injected *port*. |
| `simorgh-platform` | `simorgh-platform/` | Targets, REST + MCP connectors plus a conformance kit, deploy plans + a preflight gate, the fleet, the platform's *own* MCP server, a self-hosted Node core, a CLI. |
| the Cloudflare app | `src/` (root) | The Workers host: Hono routes, `FlockCoordinator` + `DataTrustVault` Durable Objects, and host adapters binding the engine to `Env`. |
| the Go workspace | `bot/ gateway/ tools/ packages/` | A **second answering runtime** (see §5.1) — eight modules, one of which (`gateway/`) speaks OpenAI-compatible chat completions with SSE streaming, which no TypeScript host does. |

**The boundary rule is machine-enforced.** `phoenix-core/test/boundary.test.ts` fails the build if the
engine contains a `cloudflare:` import, any `node:` import outside its single declared adapter, or a
bare runtime global (`Response`, `crypto.`, `SqlStorage`, …). The engine is portable *because* it
cannot drift. This is the single most valuable property in the codebase.

### 2.1 The one genuinely clever seam

`executeAgent()` accepts a **union** of two dependency shapes: a host can hand over the raw ingredients
(`providers`, `cooldownUntil`, `record`) and let the engine fly them, **or** fly them itself and hand
back the result (`fly`).

The second form is not symmetry — it is a hard constraint. On Cloudflare, cooldown and observation
writes live in Durable Object SQLite reachable only over RPC, and **a closure cannot cross that
boundary**. Without the seam the Workers host re-implemented the pipeline's ordering, so the Data Trust
contract ("the request is recorded *before* any provider is dialled") held in one deployment and was
merely *assumed* in the other. Now the order exists once.

---

## 3. What is verified working

### 3.1 Re-run on 2026-09-24 (by me, just now — command + result)

| Check | Command | Result |
|---|---|---|
| Types, all three configs | `npm run typecheck` | **clean, 0 errors** |
| Workers host in workerd | `npm test` (workers half) | **93 passed / 11 files** |
| Engine + platform on Node | `npm test` (node half) | **261 passed / 19 files** |
| ~~Engine on **Bun** (3rd runtime)~~ | *removed 2026-10-03* | 10/10 at the time; `bun:sqlite` satisfied the synchronous `SqlPort` with no engine change. Host deleted, finding kept — `ADR-0002` |
| A real core boots unbuilt and answers | `npm run platform:smoke` | **5/5 checks, exit 0** |
| Go workspace builds | `go build all` | exit 0 |
| Go tests | `go test github.com/shaiinarab/simorgh/...` | **6 packages `ok`** (incl. `gateway/internal/server`), 3 have no tests |
| Dependency vulnerabilities | `npm audit --omit=dev` | **0 vulnerabilities** |
| CI jobs present | `.github/workflows/ci.yml` | `workers`, `go`, `security` |

### 3.2 Carried from the project's own docs (last verified 2026-09-22, **not** re-run today)

| Claim | Command | Result |
|---|---|---|
| The platform reaches a live core over REST **and** MCP, and the answers match | `npm run e2e:ask` | 10/10 checks |
| No build step is needed | `node simorgh-platform/src/cli.ts targets` | works |
| The whole suite passes inside a clean container | `freebuff2 bash -lc 'npx vitest run --config vitest.node.config.json'` | 202 passed on **Node 22.23** (host is 26.7) |

The container run matters: it is the portability claim actually tested rather than asserted.

### 3.3 Capability matrix

`✅` implemented + working + tested · `⚠️` partial or unverified · `❌` absent

| Capability | State | Notes |
|---|---|---|
| Core API (Hono on workerd) | ✅ | |
| Agent runtime (bounded tool loop) | ✅ | Sequential **by design**, budget of 4 iterations |
| Provider abstraction + failover | ✅ | Priority order, dormant skip, cooldowns. A *throwing* provider no longer 500s the request (deliberate behaviour change) |
| Tool allow-list | ✅ | Exactly two: `search_web`, `get_server_time`. Bodies live in the engine once, shared by both hosts |
| Authentication | ✅ | Bearer + constant-time SHA-256 compare; **fails closed** with 503 when unconfigured |
| Rate limiting | ✅ | Per-user SQL counter in a Durable Object |
| Persistence | ✅ | SQLite on both sides: DO `SqlStorage` on the edge, `node:sqlite` self-hosted |
| Transparency ledger | ✅ | Append-only, written *before* the flight |
| Telegram bot + webhook | ✅ | Shared-secret authenticated |
| Dashboard | ✅ | Server-rendered at `GET /dashboard` |
| Multi-target deploy + preflight gate | ✅ | 3 targets; preflight verified live against a real core *and* an impostor |
| Platform MCP server | ✅ | Session-enforced, spec-correct tool errors |
| Connector conformance kit | ✅ | Runs both connectors against one double; fails a deliberately broken one |
| Fleet + failover across cores | ✅ | Reports *every* failure, not just the last |
| `doctor` (diagnose a broken fleet) | ✅ | Stable codes, never throws on an unhealthy fleet |
| **3rd-runtime proof (Bun)** | ✅ *(artifact removed 2026-10-03)* | Established that `SqlPort` is not Node-shaped. The host is deleted and the toolchain is Node-only; the conclusion stands — see §4 and `ADR-0002` |
| Observability | ⚠️ | Request IDs + structured errors. **No metrics, no tracing, no provider latency recorded anywhere on the TS side** |
| Test coverage | ⚠️ | Suites are green but **no coverage provider is installed**, so coverage cannot be measured at all |
| **Go gateway in the fleet** | ❌ | See §5.1 — the product's central promise is unmet for the Go runtime |
| GitHub capability | ❌ | Not started |
| Pages UI | ❌ | Not started |
| Vercel adapter | ❌ | Deliberately deferred — see §4 |

---

## 4. The portability finding — this is the key architectural constraint

A host must supply **six ports**. Five are trivial (`fetch`, `sha256`, `randomUUID`, `now`,
`ContextStorePort`). The sixth is the one that matters:

> **`SqlPort` is synchronous.** `exec()` returns a cursor synchronously, with a synchronous
> `toArray()`.

Consequence, recorded in `ADR-0002`: **no networked database can implement `SqlPort`.** That kills the
obvious "deploy it on Vercel with Postgres/Neon" path — not for reasons of vendor fit or cold starts,
but because the port's *shape* forbids an async database. The portability claim is therefore narrower
than the README originally implied: portable across runtimes that can supply a **synchronous** SQL
implementation.

**This has now been tested on three dialects, and it held on the third with zero engine change:**

| Runtime | SQL implementation | Dialect quirk |
|---|---|---|
| Cloudflare workerd | DO `SqlStorage` | fuses read+write into `exec` |
| Node | `node:sqlite` `DatabaseSync` | splits `prepare().all()` from `.run()` |
| **Bun** (new) | **`bun:sqlite` `Database`** | splits `db.query().all()` from `.run()` |

The engine's dialect sniff (`RETURNS_ROWS = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i`) is reused verbatim on
Bun, because Bun splits reads from writes exactly as `node:sqlite` does — it turned out **not** to be
Node-shaped after all. The only residual differences (`db.query()` vs `prepare()`, `ArrayBuffer` →
`Uint8Array` bindings) live in the host adapter. `createNodePorts` runs unchanged on Bun.

**So: a third runtime cost one adapter file and zero engine changes.** The interesting corollary is
that the constraint in `ADR-0002` is now the *binding* constraint on host choice, and it is a design
choice (synchronous SQL) rather than an environmental one.

---

## 5. What is NOT implemented

### 5.1 The Go gateway cannot join the fleet — the biggest structural gap

The core contract the platform dials is: `GET /health`, `GET /api/v1/flock/status`,
`POST /api/v1/agent/execute`, `GET /api/v1/user/{id}/logs`, `POST /mcp` (`simorgh_status`,
`simorgh_ask`). The Go server exposes **none** of those.

So the product's central promise — *connect a core wherever it runs* — currently holds **only for
TypeScript hosts**. Meanwhile the Go side has real, non-duplicated capability:

- `POST /v1/chat/completions` — OpenAI-compatible **with SSE streaming** (no TS host does this).
- `GET /status` — per-provider requests/tokens/errors **plus remaining daily quota** from a configured
  cap (e.g. Groq's ~14,400/day). ~~No TypeScript host models quota at all.~~
  **Superseded 2026-10-02** by `phoenix-core/src/quota.ts` (ADR-0003): the TS side now has quota
  windows, reset horizons, and a scheduler decision. Note the Go remainder is
  `cap - used-since-boot` — no reset, and `Registry.Select` never reads it — so the TS model is the
  replacement, not a duplicate.
- `packages/crypto` — AES-256-GCM sealing of provider keys with argon2id derivation, i.e. **secrets at
  rest**. The TypeScript side only ever reads secrets from the environment.

And its failover policy *differs* from the engine's: Go orders by health, then latency EMA
(`0.7·old + 0.3·new`), then priority, and drops an adapter after 3 consecutive errors; the engine
orders by priority with explicit cooldowns. **Same question, two policies.** That divergence — two
half-maintained truths — is the actual risk here, not duplicated code. Recorded as `ADR-0001`, with
nothing deleted.

Go test coverage is now real but uneven: `gateway/internal/server`, `packages/{config,crypto,ledger,providers,groq}`
all test green; `bot/` and `tools/` have no tests.

### 5.2 Security — 25 audit findings, 6 high. This is the largest *unfinished* work.

From `docs/SECURITY-AUDIT.md` (TASK-009). The audit's own framing: *authentication stops at the service
token and authorization stops at the URL path.* The six highs:

| ID | Finding | Why it matters |
|---|---|---|
| **AUTH-002** | **IDOR** on `/api/v1/user/:userId/logs` | Any authenticated caller reads **any** user's complete ledger (prompts, tools, tiers) by enumerating a URL parameter. Highest-value target: it leaks request history. |
| **AUTH-001** | `/api/v1/flock/status` is unauthenticated | Any internet caller learns which providers are configured and their health — a reconnaissance map. |
| **AUTH-003** | **IDOR** on `/api/v1/context/:refId` | Same pattern as AUTH-002 for offloaded context; the UUID is not secret. |
| **SSRF-001** | No fleet-endpoint validation | The platform dials whatever origin is in the fleet file, with no private/link-local IP guard. |
| **MCP-001** | Platform MCP handler auth unresolved | The handler itself has no auth check; the lane could not locate the route that mounts it. **Still an open question** — do not treat as either confirmed or dismissed. |
| **SEC-001** | Fleet API keys stored in **plaintext** | `~/.simorgh/fleet.json`, no encryption, no `chmod 0600` — while the Go side already seals keys with AES-256-GCM. A capability asymmetry: the fix exists in the other runtime. |

Plus 8 medium and 11 low/informational, including 7 **negative confirmations** (surfaces checked and
found correct) which are genuinely useful — they stop the next auditor redoing the work.

Three of the load-bearing claims were independently re-verified against the code by the lead
(AUTH-002, SSRF-001, SEC-001 — all confirmed). The rest are the audit's word.

### 5.3 Other absences

- **No metrics/tracing.** `docs/OBSERVABILITY.md` identifies the one real gap: provider **latency is
  recorded nowhere** on the TypeScript side, while the Go side keeps an EMA. If "which provider is
  actually good right now" is a product question, the data does not exist.
- **Coverage cannot be measured** — no `@vitest/coverage-v8` installed. Tests pass; nobody knows what
  they cover.
- One dead symbol (`findModelBird`), found by an audit that specifically checked for false positives
  in dynamic dispatch first.
- No GitHub capability, no Pages UI, no secrets scanner beyond the new `security:scan` script.

---

## 6. Process and environment (this shapes what is cheap)

- **Work runs as mailbox lanes**: a brief in `INBOX/`, a report in `OUTBOX/` ending `TASK-<id>-END`,
  and `fbmail check <id>` as the machine-readable verdict. 10 lanes have run; the board is currently
  clean (`reported=10 open=0 stale=0`).
- **Grade a lane on artifacts + `fbmail check`, never on the driver's exit code.** This has burned the
  project twice — once a lane exited 0 having delivered 1 of 3 files, once a lane's *false-negative*
  assertion was read as a real defect for two days.
- **Hardware:** i5-3570, 16 GB, **no AVX2** → API-only, no local inference, ever.
- **Network (Iran):** PyPI blocked, a specific Go proxy is banned (tampered modules), npm works via a
  mirror, and a global proxy env var intercepts localhost unless `NO_PROXY` is set. Costs and
  connectivity are real constraints on any "just run it in CI/hosted" plan.
- **Every free-tier provider used is rate-capped and quota-limited** — which is why §5.1's quota
  modelling on the Go side is interesting and its absence on the TS side is a gap.
- **Deliberately not pushed.** PR #1 (`production-readiness-v0-3`) is open; this branch is stacked
  directly on that PR's head commit, not on `main`.

---

## 7. Open decisions I want pressure-tested

**D1 — The Go gateway: converge on the core contract, or archive?**
Converge = implement the 5 core endpoints in Go so the Go runtime genuinely joins the fleet, and the
product's central promise becomes true for two runtimes. Archive = stop paying interest on a divergent
second failover policy. The argument *for* converging: Go already owns SSE streaming, quota modelling,
and secrets-at-rest — three things the TS side lacks. The argument *against*: two failover policies in
two languages is a permanent maintenance tax on a solo project.

**D2 — Fix the 6 highs before any new surface, or ship surface and fix after?**
My instinct is fix first. Specific worry: AUTH-002/AUTH-003 are multi-tenant data leaks, and the
"product" is currently one operator on free tiers.

**D3 — What is the product's actual next increment?**
Candidates: (a) the security fixes; (b) the Go convergence; (c) an observability pass (latency + quota
data, then "route by what's actually working"); (d) GitHub capability; (e) a UI. I cannot tell whether
the missing piece is *trustworthiness*, *capability*, or *a face*.

**D4 — Should `SqlPort` be made async-capable?**
That single design choice would re-open serverless-with-networked-DB hosts (Vercel/Neon) at the cost of
touching the engine boundary that everything else depends on. Is that trade worth making *before*
there is a user who needs it?

**D5 — Is the "three runtimes" proof a product feature or a sunk cost?**
Bun is a *proof* today, not a deployment: it runs with an in-memory SQLite, no supervisor, no
persistence. Should it become a supported target (with the hardening that implies), or is the
portability evidence itself the deliverable?

**D6 — Branch integration order.**
`production-readiness-v0-3` → `main`, then this branch; or this branch as one PR that supersedes it?
A local `main` is ahead of `origin/main` by one commit. This is pure housekeeping but it gates every
future merge.

**D7 — Sequential vs parallel agent execution.**
The loop is sequential and bounded on purpose (budget 4 iterations, one tool per iteration). Is
parallelism worth it *anywhere*, or is that a solution looking for a problem?

---

## 8. Constraints I believe are hard — tell me which I am wrong about

1. **No local inference** (no AVX2) → every capability is an API call against a free tier.
2. **No KYC / no payment** is a product premise, not a temporary state. Any provider that needs a card
   is out.
3. **Solo, uncompensated operator** — every design must reduce maintenance load, not add it.
4. **The engine boundary must stay machine-enforced.** Any change that weakens
   `boundary.test.ts` is disallowed, because that test is what keeps the portability claim honest.
5. **Iran network reality** — assume nothing can be pulled from PyPI, GitHub is flaky at times, a
   global proxy intercepts localhost.

---

## 9. What a good answer looks like

- A **ranked shortlist** with the dependency order, not seven parallel options.
- The **1–2 highest-leverage moves**, with the reason they dominate the others.
- **Explicit false-assumption flags** against §8.
- **What not to do next**, and the cost of getting it wrong.
- If you think the framing itself is wrong — e.g. that "next move" is the wrong question because the
  product lacks a user rather than a feature — say that instead.

---

### Provenance

Written 2026-09-24 by Buffy (a Freebuff CLI session) from: the working tree at `5c53dfe`; commands
re-run that day (§3.1); `docs/{STATE-OF-PROJECT,QUALITY,SECURITY-AUDIT,HOST-PORTABILITY,OBSERVABILITY}.md`,
`docs/adr/ADR-0001`, `docs/adr/ADR-0002`; and the ten lane reports in `mailbox/OUTBOX/`.

**This brief inherits its sources' errors.** §3.1 is measured; §3.2 is not, and is marked as such. If a
number here disagrees with the repo, the repo wins — and the disagreement is itself a finding worth
reporting, because twice already this project has believed "unfinished" about work that was finished
and green.
