---
type: "Project Overview"
title: "Project Simorgh — the agentic OS edge gateway"
description: "Entry point: what Simorgh is, the flock of free providers, the API surface and the repository map."
tags:
  - simorgh
  - readme
  - overview
  - flock
  - okf
generated:
  by: "opencode/space-bunny-free"
  at: "2026-10-13T10:05:00Z"
status: "stable"
verified:
  by: "process:okf-fact-check-2026-10-12"
  at: "2026-10-13T10:05:00Z"
stale_after: "2026-11-13T00:00:00Z"
sources:
  - id: flock-catalog
    resource: "src/flock.ts"
    title: "The eight-bird PROVIDERS catalog and the FlockCoordinator DO"
  - id: workers-routes
    resource: "src/index.ts"
    title: "The 16 Workers-host route registrations"
  - id: mcp-tools
    resource: "simorgh-platform/src/connectors/mcp.ts"
    title: "The core MCP tool names"
  - id: cli
    resource: "simorgh-platform/src/cli.ts"
    title: "The eleven CLI subcommands"
---

# 🦅 Project Simorgh — The Agentic OS Edge Gateway

> *"Thirty birds set out to find the Simorgh. After a long journey, the thirty survivors
> (si morgh) discover that they themselves — united — **are** the Simorgh."*
> — Attar of Nishapur, *The Conference of the Birds*

**Simorgh** is a free-to-run, no-KYC, self-evolving **agentic AI gateway** that stitches
the fragmented free tiers of the internet into one resilient, sovereign intelligence.
Its founding metaphor is literal architecture: **many small "birds" (free-tier providers)
fly together as one Simorgh, and when one bird tires, the flock reroutes.**

## TL;DR

Simorgh already has the routing engine, capability probes, task graph, durable schedule state and
transparency ledger. The missing product is the connected execution path: **principal identity →
quota admission → durable execution → knowledge/memory → one verified swarm workflow**.

Start with [the current TODO queue](docs/todo/index.md), read the [roadmap spine](docs/ROADMAP-SPINE.md),
and follow the task's acceptance checks. Documentation uses [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md):
plain Markdown, YAML frontmatter, provenance, lifecycle/freshness and cross-links.

- **Stack:** Cloudflare Workers · Hono · TypeScript 7 (tsgo — `@typescript/native-preview`; pinned dev preview 7.0.0-dev.20260707.2, unpublished since 2026-07-07; stable 7.0.2 now on npm) · Durable Objects (SQLite) · KV
- **Cost to run:** $0 — every primitive used is on a genuinely free, no-credit-card tier.

---

## Quick Start

**Roadmap & status:** the canonical forward plan is [`docs/ROADMAP-SPINE.md`](docs/ROADMAP-SPINE.md)
(vertical execution spine, epics A–F, phase ledger: Foundation/Routing/Capability/Task-model **done**,
Durable execution **active**, Retrieval/Memory/Autonomy **next**). Current verified baseline: **178 workerd + 504 node tests green** (17 and 28 files), typecheck
exit 0 (upm 1.4.0; suites also green on Node 26.11 / Go 1.25).
The old PRD epic list (`docs/prd/`) is historical. `docs/todo/index.md` is the live ordered task queue;
BMAD artifacts are optional derived scaffolding, not a second source of truth.

Package manager is **upm**, runtime is **Node**. There is no `package-lock.json`; `upm.lock` is
committed and is the reproducible build input. `npm run <script>` still works — `npm` here is only
running a package.json script, not installing anything.

```bash
# install dependencies (upm — https://github.com/unjs/upm)
upm install

# typecheck — TypeScript 7 (tsgo, the native Go port)
upm run typecheck

# local dev (miniflare) — Homā works with no secrets at all
upm run dev              # wrangler dev --local --port 8787 (the Workers AI binding
                         #   still dials Cloudflare, so "no secrets" ≠ "no network")
#   → http://127.0.0.1:8787/dashboard
#   → http://127.0.0.1:8787/api/v1/flock/status

# run a core on this box instead — see docs/DEPLOY.md
export NO_PROXY=127.0.0.1,localhost
upm run simorgh -- serve --port 8788   # keys come from process.env

# deploy (typecheck-gated: three tsgo configs, then wrangler deploy; needs your Cloudflare auth)
upm run deploy

# extra birds (optional — absent = dormant, safe-by-default). The flock holds eight;
# Homā (Workers AI) needs no key. Priorities decide the order, lowest first.
upx wrangler secret put GROQ_API_KEY               # shahin     10  Groq
upx wrangler secret put GEMINI_API_KEY             # gemini     15  Google
upx wrangler secret put HF_TOKEN                   # bulbul     20  HuggingFace
upx wrangler secret put OPENROUTER_API_KEY         # openrouter 25  OpenRouter
upx wrangler secret put CEREBRAS_API_KEY           # cerebras   26  Cerebras
upx wrangler secret put NVIDIA_API_KEY             # nvidia     27  NVIDIA NIM
upx wrangler secret put VERCEL_AI_GATEWAY_API_KEY  # aigateway  28  Vercel AI Gateway

# distinguish callers. A map token → userId, which is what makes the per-user
# routes refuse data that is not the caller's. Unset ⇒ those routes fail closed.
upx wrangler secret put SIMORGH_API_KEYS           # '{"<token>": "<userId>"}'
```

**Three places, not one.** Cloudflare is the *optional* path. A local Node run is a first-class way to
run Simorgh — the same engine, the same core routes and wire contracts, no account and no card — and a
self-hosted box is the third. All three, with the trap that will cost you an hour, the free-plan
ceilings that will bite, and an honest account of which routes the Node host does *not* serve:
**[`docs/DEPLOY.md`](docs/DEPLOY.md)**.

Then open the deployed `/dashboard`, exhaust Groq's quota, and **watch the flock reroute to the next
awake bird** in real time — with a `RouteReason` on every skip, so the choice is legible rather than
lucky.

---
---

## Modules

The repo holds two packages, linked by a one-way dependency: the platform imports `@simorgh/phoenix-core`; the core imports nothing from the platform. Full architecture, port contracts, and invariant rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Package | Path | What it does |
|---------|------|--------------|
| `@simorgh/phoenix-core` | `phoenix-core/` | Runtime-agnostic engine: provider routing, agent tool loop, request validation, rate limiting, ledger. No runtime bindings — every capability arrives as an injected port. |
| `simorgh-platform` | `simorgh-platform/` | Control plane: deployment targets, REST/MCP connectors, the connector conformance kit, deploy plans + preflight gate, fleet management, and the self-hosted Node runtime. |
| the Cloudflare app | `src/` (root) | The Workers host: the Hono routes, the Durable Object shells, and the host adapters that bind `phoenix-core` to Cloudflare's bindings. |

---

## Standing on working shoulders

Simorgh's architecture is a composition, not an invention — every stage of the spine has a
working, starred precedent, and this repo's job is joining them under free/no-KYC constraints
with honest degradation. The cross-walk lives in
[`docs/REFERENCE-ARCHITECTURE.md`](docs/REFERENCE-ARCHITECTURE.md); what was studied, taken,
and refused (with reasons) is in [`docs/research/`](docs/research/) and
[ADR-0007](docs/adr/ADR-0007-adopted-patterns-from-working-open-source.md). Code that is
copied carries its MIT attribution; the refusal list is as load-bearing as the adoption list.

---

## Testing

Two suites, split by what each can actually prove. `upm test` runs both, workers first.

```bash
upm test                                                # both suites
upm run test:workers                                    # workerd: the Cloudflare app
upm run test:node                                       # plain Node: engine + platform
upx vitest run --config vitest.node.config.ts <file>    # one file, scoped
```

Plus three commands that check the *assembled* thing rather than a unit:

```bash
upm run e2e:ask          # the CLI reaches a live core over REST *and* MCP, and compares the answers
upm run platform:smoke   # boots a real core on an ephemeral port, probes it, exits 0/1
upm run simorgh -- doctor # diagnoses a fleet that will not answer
```

| Suite | Config | Files | Runs against |
|-------|--------|-------|--------------|
| workers | `vitest.config.ts` | `test/**` | The Cloudflare app *inside workerd*: Durable Object RPC, real KV, the cron shape, HTTP route contracts, and the full request path through Hono. Real bindings from `wrangler.toml`; only the flock is stubbed. |
| node | `vitest.node.config.ts` | `phoenix-core/test/**` + `simorgh-platform/test/**` | The **engine** in isolation — routing, the agent tool loop, the tool executor, the ledger, validation, rate limiting, the portability invariants — and the **platform** — targets, connectors plus their conformance kit, deploy plans, preflight, the fleet, `doctor`. Real SQLite in memory; no runtime, no network. |

`phoenix-core/test/boundary.test.ts` is the reason the split matters: it fails the build if the
engine reaches for `cloudflare:workers`, any `node:` module outside its one declared adapter, or a
bare runtime global. If the engine ever picks up a binding, the Node suite stops resolving and goes
red while the workers suite keeps passing. That signal is the point.

Two deliberate choices worth knowing about:

- **Routing is tested as a pure function, not through the Durable Object.** Homā calls
  Workers AI on every request and Workers AI has no local simulation, so routing tests
  driven through the DO would need the real internet (and would bill for it).
  `flyFlock()` therefore takes its birds, env and cooldown lookup as arguments.
- **The tool allow-list is asserted, not assumed.** `http.test.ts` sends a request with
  disallowed tools and checks that the Durable Object received only the allow-listed
  ones — the security property, verified at the boundary rather than at the source.

The workers suite is **fully hermetic**: it needs no Cloudflare account, no API token, and makes
no outbound request. That is not luck — `vitest.config.ts` sets `remoteBindings: false`,
because the pool otherwise opens a remote proxy session through wrangler at startup and
fails on any machine without `CLOUDFLARE_API_TOKEN`. The trade-off is deliberate: the
routing tests use a fake env, and the HTTP tests stub the flock, so no test wants a real
provider. A suite that needs production credentials to assert that a fallback works is a
suite that will eventually be disabled.

---

## The platform CLI

`simorgh-platform` is a control plane you drive from a terminal. It runs **unbuilt** — Node ≥22 strips
the types — so there is no build step between you and a running core.

```bash
upm run simorgh -- targets                              # where a core can live
upm run simorgh -- plan node --origin 127.0.0.1:8788     # what deploying there involves
upm run simorgh -- deploy node --mode cli --yes          # deploy (preflight-gated)
upm run simorgh -- serve                                # run a phoenix-core on this box
upm run simorgh -- connect node http://127.0.0.1:8788 --api-key <token>
upm run simorgh -- instances                            # which cores are recorded as mine
upm run simorgh -- disconnect <id>                       # forget one
upm run simorgh -- ask "who is simorgh" --prefer rest     # ask the fleet, with failover
upm run simorgh -- status                                # what is up, and what it can answer with
upm run simorgh -- doctor                                # why one of them is not answering
upm run simorgh -- smoke                                 # boot a core, probe it, exit 0/1
```

Eleven subcommands in total. The three not shown above — `instances`, `disconnect` and `smoke` — are
the ones `e2e:ask` depends on, so a fleet is created and torn down between two CLI calls.

Four things it is opinionated about:

- **`deploy` is preflight-gated.** Required secrets, tools missing from `PATH`, unresolved `{origin}`
  placeholders, and a runtime older than the workspace's `engines.node` are all checked *before* the
  consent prompt. A doomed plan never starts, so it cannot leave a half-applied deploy behind — which
  is the most expensive state a deployer can produce. `--skip-preflight` overrides, explicitly.
- **`deploy --mode cli` requires `--yes`.** No env var, no config file, no "we are in CI so obviously
  yes". Without it the CLI prints exactly what it would have run and exits 2. `--dry-run` executes
  through a recording runner instead, so you can see the calls without running them.
- **`ask` fails over and says what it skipped.** Every failure is reported, not just the last one — with
  three cores down for three different reasons, "connection refused" alone sends you to the wrong one.
- **`doctor` never throws on an unhealthy fleet.** An unreachable core is a finding with a stable code
  (`unreachable`, `connection-refused`, `auth-not-configured`, `auth-unauthorized`, `no-instances`,
  `all-providers-dormant`, `all-providers-tired`) and a fix hint, not a stack trace. Exit 0 healthy,
  1 unhealthy.

---

## Deploying

Three places: local Node, Cloudflare Workers, or a self-hosted box. The Cloudflare walkthrough is
below because it is the one with a moving part; the other two, and what is genuinely portable between
them, are in **[`docs/DEPLOY.md`](docs/DEPLOY.md)**.

```bash
upx wrangler login
upm run deploy                                   # typecheck-gated wrangler deploy
```

`wrangler.toml` ships with a real `CONTEXT_STORE` id, so there is no placeholder to replace — that
step used to be required and was removed. If `wrangler kv namespace create` prints a different id,
that is a *second* namespace, not a missing one; the DO migration story is in
[`docs/DEPLOY.md`](docs/DEPLOY.md#3-deploy).

The deployed worker is named `simorgh` (renamed from `simorgh-edge-gateway`), so it answers at
`https://simorgh.<your-subdomain>.workers.dev`.

---

## The Flock

Each "bird" normalizes a provider to one shape and is tried in priority order (lower first).
A bird stays **dormant** until its key is present, so the gateway runs with **zero secrets**.

| id | Bird | Provider | Model | Key | Priority |
|----|------|----------|-------|-----|----------|
| `shahin` | 🦅 Groq | Groq (OpenAI-compat) | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | 10 (fastest, first) |
| `gemini` | 🔮 Gemini | Google Generative Language | `gemini-2.5-flash` | `GEMINI_API_KEY` | 15 (the one bird that is *not* OpenAI-shaped — see [ARCHITECTURE.md](docs/ARCHITECTURE.md) §1.1) |
| `bulbul` | 🐦 HuggingFace | HuggingFace Router | `meta-llama/Llama-3.3-70B-Instruct` | `HF_TOKEN` | 20 |
| `openrouter` | 🌐 OpenRouter | OpenRouter (OpenAI-compat) | `openrouter/free` — a router over the `:free` pool, so the weights behind an answer can differ between calls | `OPENROUTER_API_KEY` | 25 |
| `cerebras` | ⚡ Cerebras | Cerebras (OpenAI-compat) | `llama-3.3-70b` | `CEREBRAS_API_KEY` | 26 — **unclassified**, so `FREE_ONLY` refuses it until a cost row exists |
| `nvidia` | 🟢 NVIDIA NIM | NVIDIA NIM (OpenAI-compat) | `meta/llama-3.3-70b-instruct` | `NVIDIA_API_KEY` | 27 — **unclassified**, same |
| `aigateway` | ▲ Vercel AI Gateway | Vercel AI Gateway (OpenAI-compat) | `meta/llama-3.3-70b-instruct` | `VERCEL_AI_GATEWAY_API_KEY` | 28 — **unclassified**, same |
| `homa` | 🕊️ Workers AI | Cloudflare Workers AI | `@cf/meta/llama-3.2-3b-instruct` | *none* | 30 (**always present → zero-KYC guarantee**) |

Three of those eight carry no cost classification (`phoenix-core/src/capability-probes.ts`), which
means `FREE_ONLY` treats "unknown" as "not free" and refuses them. That is deliberate — and it is
exactly what task E3 exists to fix; the commit that added the birds did not add their cost rows.

---

## API Reference

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/v1/agent/execute` | Run the agent (tool loop + flock failover). |
| `GET`  | `/api/v1/flock/status` | Live Swarm-State: which birds are awake/tired/dormant. If the Durable Object is unreachable, the last KV snapshot answers instead, marked `"source": "kv-cache"` with its original `timestamp` — stale and labelled, never a 500 and never an invented flock. |
| `GET`  | `/api/v1/context/:refId` | Retrieve an offloaded request payload from KV. |
| `GET`  | `/api/v1/user/:userId/logs` | Data-Trust transparency: a user's ledger entries. |
| `GET`  | `/api/v1/quota` | Every declared account's quota row, over RPC from the Durable Object. |
| `GET`  | `/api/v1/capabilities` | What this deployment can actually do: per-provider capability probes, the unclaimed ones, and a rendered summary. Bearer-gated (unlike `/api/v1/flock/status`) because the payload names which providers the deployment holds keys for. |
| `GET`  | `/api/v1/schedule` | The Durable Object's scheduled flights, with state, attempts and outcome. |
| `POST` | `/api/v1/schedule` | Schedule a prompt to run through the flock at or after `resumeAt`. Bounds are the execute bounds plus a 30-day horizon. |
| `POST` | `/api/v1/telegram/webhook` | The Telegram chat gateway — verified by the shared webhook secret *before* the body is parsed. |
| `POST` | `/api/v1/discord/webhook` | The Discord chat gateway — verified by Discord's Ed25519 signature *before* the body is parsed, then acknowledged inside Discord's 3-second deadline. |
| `POST` | `/api/v1/setup/validate` | First-run wizard: check a provider key and get back the command to run. **Deliberately unauthenticated** — it holds no user data and is rate-limited to a fixed upstream URL. |
| `POST` | `/api/v1/setup/check-mcp` | First-run wizard: does a named MCP endpoint complete an `initialize` handshake. Same deliberate posture. |
| `GET`  | `/api/v1/platform/connectors` | The connector matrix — Cloudflare, Telegram, Discord, GitHub — with readiness derived from the live environment, and the tool surface. |
| `GET`  | `/dashboard` | The unified control plane: setup, overview, flock, platforms, schedules, quota, tools/MCP and direct chat, plus a connections manager for `secret`/`mcp`/`data` targets. Unauthenticated, ships no secret, and bearer-gates its own calls. |
| `GET`  | `/health` | `{status, timestamp}`. |
| `GET`  | `/` | Health text. |

Everything under `/api/*` that reads or changes **user** data is bearer-gated and **fails closed**:
with no `SIMORGH_API_KEY` configured the answer is `503 AUTH_NOT_CONFIGURED`, never an open route.
The two exceptions are the `/api/v1/setup/*` routes above, which exist so a first run can check a key
it does not have yet; they are rate-limited and reach a fixed upstream. `POST /mcp` is registered by
the **Node** runtime only — the deployed Worker mounts no `/mcp`.

Two per-user routes (`/api/v1/user/:userId/logs`, `/api/v1/context/:refId`) additionally require
`SIMORGH_API_KEYS` — a token→userId map — so a caller can only read their own data. Without it they
fail closed rather than serving an unverified user.

### MCP tools

`simorgh_*` means one core; `platform_*` means the whole fleet. They are different namespaces and must
never be aliased — that collision was found and removed once already.

| Tool | Namespace | Meaning |
|---|---|---|
| `simorgh_status` | one core | Health and flock state of a single instance (served at `POST /mcp` by the Node runtime) |
| `simorgh_ask` | one core | Ask one instance — treated as an *action*, so its content is parsed, not just displayed |
| `platform_targets` | fleet | Where cores can be deployed |
| `platform_fleet` | fleet | Which instances are recorded, health and recent answers |
| `platform_ask` | fleet | Ask the fleet, with failover |

The dashboard asks the operator for the key and keeps it in `localStorage`; the server never embeds it
in the page.

---

## Repository Map

```
simorgh-platform/
├── phoenix-core/           # @simorgh/phoenix-core — runtime-agnostic engine (ports, routing, agent, validation)
│   ├── src/                # engine source: ports.ts, flock.ts, agent.ts, security.ts, execute.ts, health.ts, rate-limit.ts, models.ts, provider.ts
│   │   └── node/           # Node adapter: nodeSqlPort, createNodePorts, memoryContextStore, sqlLedger (the only node: import in the engine)
│   └── test/               # engine tests: 18 files — see the directory
├── simorgh-platform/       # the control plane package (imports phoenix-core; nothing imports it)
│   ├── src/                #   targets, connectors (rest/mcp) + conformance kit, deploy (plan/runner/preflight), fleet, mcp/server, runtimes (node/smoke), cli, doctor
│   ├── scripts/            #   e2e-ask.ts — the CLI reaching a live core over REST *and* MCP
│   └── test/               #   10 files, 147 tests (vitest.node.config.ts)
├── src/                    # the Cloudflare host — the Worker itself
│   ├── index.ts            #   Hono app: 16 route registrations, Intent Shield, Data Trust, Context Offload, cron
│   ├── flock.ts            #   host adapter → engine routing, the 8-bird PROVIDERS catalog + FLOCK, the FlockCoordinator DO
│   ├── agent.ts            #   host adapter → engine agent loop (tool registry, synthesis prompt)
│   ├── agent-service.ts    #   host adapter → engine execute pipeline; builds workerPorts()
│   ├── data-trust.ts       #   DataTrustVault DO: the transparency ledger (delegates to the engine)
│   ├── health.ts           #   bird_health storage statements (upsert, cooldown, sweep)
│   ├── models.ts           #   Model Registry (Auto-Wrapper): catalog + findModelBird
│   ├── rate-limit.ts       #   host adapter → engine rate limiter
│   ├── security.ts         #   host adapter → engine security
│   ├── platform.ts         #   the connector matrix registry (live / needs-secret / not-wired)
│   ├── setup.ts            #   first-run wizard: validate a provider key, emit the command
│   ├── setup-mcp.ts        #   first-run wizard: probe an MCP endpoint's initialize handshake
│   ├── telegram.ts         #   Telegram client + webhook (secret-token verified)
│   ├── discord.ts          #   Discord client + Interactions Endpoint (Ed25519 signature verified)
│   ├── message-chunks.ts   #   the shared outbound splitter both gateways use
│   └── dashboard.ts        #   Self-contained Mission Control HTML: app shell + the universal connections manager
├── test/                   # the workerd suite (vitest.config.ts) — 17 files; see Testing section for current counts
├── packages/               # Go workspace modules
│   ├── config/             #   provider config load/validate
│   ├── crypto/             #   AES-256-GCM sealing, argon2id key derivation
│   ├── ledger/             #   usage ledger
│   └── providers/          #   symmetric adapter interface + latency/health registry (+ providers/groq)
├── gateway/                # Go: the self-hosted gateway binary
├── bot/  tools/            # Go: companions
├── index.md                # OKF bundle root: okf_version + the documentation map
├── docs/prd/               # PRD.md (historical planning, amended by ADR-0008) + EPICS_AND_STORIES.md
├── docs/todo/              # OKF v0.2 implementation tasks and acceptance criteria
├── worker-configuration.d.ts  # GENERATED by `wrangler types` — do not edit
├── env.d.ts                # Hand-written: the secrets `wrangler types` cannot see
├── go.work                 # Go workspace root (8 modules)
├── tsconfig.json           # TypeScript 7 (tsgo) — strict, noEmit
└── wrangler.toml           # bindings: AI, KV(CONTEXT_STORE), DOs, cron, CORS_ORIGINS
```

### Types

`worker-configuration.d.ts` is generated and supersedes `@cloudflare/workers-types`:

```bash
upm run types   # wrangler types — rerun after editing wrangler.toml
```

It is committed so a fresh clone typechecks without booting Wrangler. Because it is
regenerated wholesale, hand-written additions go in `env.d.ts` — which declares the
secrets, twice, for the top-level `Env` and for `Cloudflare.Env`. Those are separate
interfaces: `DurableObject` and `WorkerEntrypoint` default to the latter, so declaring a
secret on only one of them yields an `env.GROQ_API_KEY` that typechecks in the router and
fails inside a Durable Object.

---

## Development Method — BMAD × OKRs

Built with the **BMAD Method** (Orchestrator → Analyst → PM → Architect → UX → Dev → QA).
Planning uses **OKRs** (Objective + measurable Key Results). See [`docs/prd/PRD.md`](docs/prd/PRD.md).

---

## License & Ethos

Open-source (MIT), built for *"the greater good"* — a free agentic OS anyone can run.
Data sharing is **always opt-in**, encrypted, and PII-scrubbed. Safe-by-default is a
framework guarantee, not a policy afterthought.

*Si morgh → Simorgh. Thirty birds → one.* 🔥
