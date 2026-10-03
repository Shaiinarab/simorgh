# 🦅 Project Simorgh — The Agentic OS Edge Gateway

> *"Thirty birds set out to find the Simorgh. After a long journey, the thirty survivors
> (si morgh) discover that they themselves — united — **are** the Simorgh."*
> — Attar of Nishapur, *The Conference of the Birds*

**Simorgh** is a free-to-run, no-KYC, self-evolving **agentic AI gateway** that stitches
the fragmented free tiers of the internet into one resilient, sovereign intelligence.
Its founding metaphor is literal architecture: **many small "birds" (free-tier providers)
fly together as one Simorgh, and when one bird tires, the flock reroutes.**

- **Stack:** Cloudflare Workers · Hono · TypeScript 7 (tsgo — `@typescript/native-preview`) · Durable Objects (SQLite) · KV
- **Cost to run:** $0 — every primitive used is on a genuinely free, no-credit-card tier.

---

## Quick Start

Package manager is **upm**, runtime is **Node**. There is no `package-lock.json`; `upm.lock` is
committed and is the reproducible build input. `npm run <script>` still works — `npm` here is only
running a package.json script, not installing anything.

```bash
# install dependencies (upm — https://github.com/unjs/upm)
upm install

# typecheck — TypeScript 7 (tsgo, the native Go port)
npm run typecheck

# local dev (miniflare) — Homā works with no secrets at all
npm run dev              # wrangler dev (--local --port 8787)
#   → http://127.0.0.1:8787/dashboard
#   → http://127.0.0.1:8787/api/v1/flock/status

# deploy (typecheck-gated; needs your Cloudflare auth)
npm run deploy           # tsgo --noEmit && wrangler deploy

# add extra birds (optional — absent = dormant, safe-by-default)
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put HF_TOKEN
```

Then open `…workers.dev/dashboard`, exhaust Groq's quota, and **watch the flock reroute to Homā** in real time.

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

## Testing

Two suites, split by what each can actually prove. `npm test` runs both, workers first.

```bash
npm test                                                # both suites
npm run test:workers                                    # workerd: the Cloudflare app
npm run test:node                                       # plain Node: engine + platform
npx vitest run --config vitest.node.config.ts <file>    # one file, scoped
```

Plus three commands that check the *assembled* thing rather than a unit:

```bash
npm run e2e:ask          # the CLI reaches a live core over REST *and* MCP, and compares the answers
npm run platform:smoke   # boots a real core on an ephemeral port, probes it, exits 0/1
npm run simorgh -- doctor # diagnoses a fleet that will not answer
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
npm run simorgh -- targets                              # where a core can live
npm run simorgh -- plan node --origin 127.0.0.1:8788     # what deploying there involves
npm run simorgh -- deploy node --mode cli --yes          # deploy (preflight-gated)
npm run simorgh -- serve                                # run a phoenix-core on this box
npm run simorgh -- connect node http://127.0.0.1:8788 --api-key <token>
npm run simorgh -- ask "who is simorgh" --prefer rest     # ask the fleet, with failover
npm run simorgh -- status                                # what is up, and what it can answer with
npm run simorgh -- doctor                                # why one of them is not answering
```

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
  (`unreachable`, `auth-not-configured`, `no-providers`, `all-tired`, …) and a fix hint, not a stack
  trace. Exit 0 healthy, 1 unhealthy.

---

## Deploying

```bash
npx wrangler login
npx wrangler kv namespace create CONTEXT_STORE   # paste the id into wrangler.toml
npm run deploy                                   # typecheck-gated wrangler deploy
```

The KV namespace id is the one placeholder this repo ships with. `wrangler dev` and
`wrangler deploy --dry-run` are both happy with it; a real deploy is not, so the
command above is not optional.

---

## The Flock

Each "bird" normalizes a provider to one shape and is tried in priority order (lower first).
A bird stays **dormant** until its key is present, so the gateway runs with **zero secrets**.

| id | Bird | Provider | Model | Key | Priority |
|----|------|----------|-------|-----|----------|
| `shahin` | 🦅 Shāhīn | Groq (OpenAI-compat) | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | 10 (fastest, first) |
| `bulbul` | 🐦 Bulbul | HuggingFace Router | `meta-llama/Llama-3.3-70B-Instruct` | `HF_TOKEN` | 20 |
| `homa` | 🕊️ Homā | Cloudflare Workers AI | `@cf/meta/llama-3.2-3b-instruct` | *none* | 30 (**always present → zero-KYC guarantee**) |

---

## API Reference

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/v1/agent/execute` | Run the agent (tool loop + flock failover). |
| `GET`  | `/api/v1/flock/status` | Live Swarm-State: which birds are awake/tired/dormant. |
| `GET`  | `/api/v1/context/:refId` | Retrieve an offloaded request payload from KV. |
| `GET`  | `/api/v1/user/:userId/logs` | Data-Trust transparency: a user's ledger entries. |
| `GET`  | `/dashboard` | Self-contained Mission Control UI. |
| `GET`  | `/` | Health text. |

---

## Repository Map

```
simorgh-platform/
├── phoenix-core/           # @simorgh/phoenix-core — runtime-agnostic engine (ports, routing, agent, validation)
│   ├── src/                # engine source: ports.ts, flock.ts, agent.ts, security.ts, execute.ts, health.ts, rate-limit.ts, models.ts, provider.ts
│   │   └── node/           # Node adapter: nodeSqlPort, createNodePorts, memoryContextStore, sqlLedger (the only node: import in the engine)
│   └── test/               # engine tests: boundary.test.ts, execute.test.ts, flock.test.ts, security.test.ts, storage.test.ts, agent.test.ts
├── simorgh-platform/       # the control plane package (imports phoenix-core; nothing imports it)
│   ├── src/                #   targets, connectors (rest/mcp) + conformance kit, deploy (plan/runner/preflight), fleet, mcp/server, runtimes (node/smoke), cli, doctor
│   ├── scripts/            #   e2e-ask.ts — the CLI reaching a live core over REST *and* MCP
│   └── test/               #   9 files, 113 tests (vitest.node.config.ts)
├── src/                    # the Cloudflare host — the Worker itself
│   ├── index.ts            #   Hono app: routes, Intent Shield, Data Trust, Context Offload, cron
│   ├── flock.ts            #   host adapter → engine routing, plus the FlockCoordinator DO
│   ├── agent.ts            #   host adapter → engine agent loop (tool registry, synthesis prompt)
│   ├── agent-service.ts    #   host adapter → engine execute pipeline
│   ├── data-trust.ts       #   DataTrustVault DO: the transparency ledger (delegates to the engine)
│   ├── health.ts           #   bird_health storage statements (upsert, cooldown, sweep)
│   ├── models.ts           #   Model Registry (Auto-Wrapper): catalog + findModelBird
│   ├── rate-limit.ts       #   host adapter → engine rate limiter
│   ├── security.ts         #   host adapter → engine security
│   ├── telegram.ts         #   Telegram client + webhook (secret-token verified)
│   └── dashboard.ts        #   Self-contained Mission Control HTML (inline CSS/JS, no build)
├── test/                   # 11 files, 93 tests — the workerd suite (vitest.config.ts)
├── packages/               # Go workspace modules
│   ├── config/             #   provider config load/validate
│   ├── crypto/             #   AES-256-GCM sealing, argon2id key derivation
│   ├── ledger/             #   usage ledger
│   └── providers/          #   symmetric adapter interface + latency/health registry
├── gateway/                # Go: the self-hosted gateway binary
├── bot/  tools/            # Go: companions
├── docs/prd/               # PRD.md (13 epics / 63 stories) + EPICS_AND_STORIES.md
├── mailbox/                # Agent task protocol (briefs, board, selftests)
├── worker-configuration.d.ts  # GENERATED by `wrangler types` — do not edit
├── env.d.ts                # Hand-written: the secrets `wrangler types` cannot see
├── go.work                 # Go workspace root (8 modules)
├── tsconfig.json           # TypeScript 7 (tsgo) — strict, noEmit
└── wrangler.toml           # bindings: AI, KV(CONTEXT_STORE), DOs, cron trigger
```

### Types

`worker-configuration.d.ts` is generated and supersedes `@cloudflare/workers-types`:

```bash
npm run types   # wrangler types — rerun after editing wrangler.toml
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
