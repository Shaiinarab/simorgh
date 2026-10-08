# Simorgh Skillstack — Top 20 per Category (Brainstorm Baseline, 2026-10)

Installed/verified in this workspace. Rule of thumb for every pick: **genuinely free tier, no-KYC where
possible, edge-portable, and it must survive Simorgh's own invariants** (`SOUL.md`, `AGENT.md`, the
boundary test in `phoenix-core/test/boundary.test.ts`).

Legend: ✅ installed & import-verified · 📦 available via npx/uvx on demand · 🎯 target (adopt when the
matching module lands)

---

## Category A — Core TS/Edge Stack (the bird that flies the gateway)

| # | Tool | Status | Why for Simorgh |
|---|------|--------|-----------------|
| 1 | TypeScript 7 native preview (`tsgo`) | ✅ repo dep | Typecheck gate already wired into `npm run deploy` |
| 2 | Hono 4 | ✅ repo dep | Route layer of `src/`; keep pinned to latest 4.x |
| 3 | Wrangler 4 / workerd + miniflare | ✅ 4.86 via npx | Local dev, e2e, dry-run deploy gate |
| 4 | `@cloudflare/vitest-pool-workers` | ✅ repo dep | Real-bindings test suite (KV, DO RPC, cron) |
| 5 | Vitest 4 | ✅ 4.1.11 | Both suites (`vitest.config.ts`, `vitest.node.config.ts`) |
| 6 | upm 1.4 | ✅ via npx | Repo's declared package manager; `upm.lock` is the build input |
| 7 | Biome 2.5 | ✅ global | Fast lint+format for a tsgo-first repo (no ESLint/Prettier tax) |
| 8 | JSR CLI | 📦 0.14 via npx | Publish `phoenix-core` as a JSR package → the "npm of the flock" moment |
| 9 | Durable Objects (SQLite-backed) | ✅ platform | Session/quota ledger state; already used |
| 10 | Workers KV | ✅ platform | Dormant-bird manifests, model catalog cache |
| 11 | Workers R2 (free 10 GiB) | 🎯 | Ledger snapshots, redacted review evidence blobs |
| 12 | Queues + Cron Triggers | 🎯 | Quota-probe fan-out ("everybird") without burning requests |
| 13 | Hyperdrive / D1 | 🎯(D1) | D1 = free SQLite mirror for dashboard analytics |
| 14 | Workerd compatibility flags | ✅ | Keep `wrangler.toml` compat date newest |
| 15 | `env.d.ts` generated bindings (`wrangler types`) | ✅ script | Regenerate after every binding change |
| 16 | Cloudflare AI Gateway primitives | 🎯 | flock vocabulary already mirrors `cf-aig-routing-reason` |
| 17 | Containers-on-Workers (beta) | 🎯 watch | Escape hatch for heavy probes; NOT free-tier-safe yet |
| 18 | Pages free hosting | 🎯 | Static dashboard fallback off-Worker |
| 19 | esbuild (via wrangler) | ✅ implicit | Don't add a second bundler; one pipeline |
| 20 | Zod 4 (or valibot) | 🎯 add | Shared schema pkg between core & platform validation |

## Category B — Free-Tier Provider Birds (the flock itself)

| # | Provider | Free tier | KYC/Card | Note |
|---|----------|-----------|----------|------|
| 1 | Groq | Generous daily tokens | No card | Already a secret slot |
| 2 | Google Gemini API | Free tier w/ rate caps | No card | Secret slot exists |
| 3 | Hugging Face Inference | Daily credits | No card | `HF_TOKEN` slot exists |
| 4 | OpenRouter | Free models pool | No card | Slot exists |
| 5 | Mistral La Plateforme | Free tier | No card | 🎯 new slot candidate |
| 6 | Cloudflare Workers AI | 10k neurons/day | No card | Same vendor as host — zero-latency bird |
| 7 | Cerebras | Free tier | No card | 🎯 fast-infer reroute target |
| 8 | SambaNova | Free tier | No card | 🎯 |
| 9 | Cohere trial/free | Limited | No card | 🎯 embed-rerank bird |
| 10 | GitHub Models | 60 req/min free | OAuth only | 🎯 brilliant for no-KYC: uses git token |
| 11 | Together free credits | Small | Card-gated ⚠️ | Only if policy relaxes |
| 12 | Fireworks free tier | Small | No card | 🎯 |
| 13 | DeepInfra free tier | Per-model caps | No card | 🎯 |
| 14 | Pollinations.ai | Truly free, no key | None | 🎯 image bird, perfect fit |
| 15 | Homā (built-in last bird) | $0 | None | The always-there fallback — keep sacred |
| 16 | Ollama local | $0 | None | Self-hosted third-place runtime |
| 17 | llama.cpp server | $0 | None | Bench parity with `bench/native-audit` |
| 18 | vLLM (on free colab/grids) | Episodic | Account | 🎯 capacity experiments (ADR-0003) |
| 19 | Triton/inference.js | OSS | None | Later self-host story |
| 20 | HF Spaces inference | Daily credits | No card | 🎯 serverless-GPU bird |

## Category C — Python AI/Agent Layer (Homā sidecars, evals, quota brains)

| # | Library | Status | Why |
|---|---------|--------|-----|
| 1 | uv 0.12 | ✅ | Fastest free computing: installs itself |
| 2 | FastAPI (+standard) | ✅ | Sidecar API pattern for any non-edge capability |
| 3 | Pydantic v2 / pydantic-settings | ✅ | Wire-contract parity with `phoenix-core` validation |
| 4 | orjson | ✅ | Cheapest JSON in the flock |
| 5 | uvloop | ✅ | Node-comparable event loop for probes |
| 6 | httpx | ✅ | Async provider probing client |
| 7 | aiohttp | ✅ | Locust/legacy compat |
| 8 | websockets | ✅ | Live flock-status push experiments |
| 9 | sse-starlette | ✅ | SSE streaming parity with Workers' streams |
| 10 | tenacity | ✅ | Retry/backoff semantics shared with Go `packages/` |
| 11 | pybreaker | ✅ | Circuit breaker = "tired bird" model, prototype here first |
| 12 | structlog | ✅ | Parity with `docs/OBSERVABILITY.md` |
| 13 | sqlmodel + aiosqlite | ✅ | Ledger replay tooling over SQLite exports |
| 14 | polars | ✅ | Quota-analytics dataframe (faster than pandas, less RAM) |
| 15 | duckdb | ✅ | Local OLAP over ledger files — free "warehouse" |
| 16 | pyarrow | ✅ | Interchange for bench results |
| 17 | tiktoken | ✅ | Cost/token estimation before routing (complexity.ts twin) |
| 18 | jinja2 | ✅ | Prompt templates for eval harness |
| 19 | openai / anthropic / groq SDKs | ✅ | Protocol-faithful clients for provider conformance kit |
| 20 | llama-index-core | ✅ | Retrieval experiments without lock-in |

## Category D — MCP & Agent Interop

| # | Tool | Status | Why |
|---|------|--------|-----|
| 1 | MCP TypeScript SDK | 🎯 add | Platform already exposes MCP routes; go canonical |
| 2 | FastMCP (py) | ✅ | Wrap any python probe as an MCP server in 10 lines |
| 3 | mcporter | 📦 0.9 via npx | Call MCP servers from CI/scripts |
| 4 | mcp-server-groq | 📦 uvx-ready | Dogfood: Simorgh's own bird as MCP |
| 5 | Context7 MCP | 🎯 register | Fresh docs for agents working on this repo |
| 6 | Playwright MCP | 🎯 | Dashboard e2e beyond `dashboard-client-check.sh` |
| 7 | Sentry MCP | 🎯 | Error-aware routing later |
| 8 | Supabase MCP | ✗ skip | Breaks no-KYC ethos |
| 9 | Composio MCP | 🎯 watch | Connector marketplace ideas vs our conformance kit |
| 10 | Smithery | 🎯 watch | Registry distribution channel |
| 11 | `.well-known/oauth-authorization-server` | 🎯 | Remote MCP auth without accounts |
| 12 | MCP sampling | 🎯 | Let connected agents borrow the flock |
| 13 | MCP elicitation | 🎯 | Matches SOUL.md "human decision gate" perfectly |
| 14 | Apps-in-MCP (2026 spec) | 🎯 watch | Interactive dashboard widgets inside chat clients |
| 15 | AGNTCY / OASF | 🎯 watch | Agent-directory standards for future federation |
| 16 | A2A protocol | 🎯 watch | Bird-to-bird comms beyond our gateway |
| 17 | Claude Code + skills | ✅ repo has `.agents/skills` | Extend those five skills; keep them canonical |
| 18 | BMAD-METHOD | ✅ repo has `.bmad` | Phase artifacts feed `_bmad-output` |
| 19 | LangGraph (py/js) | 🎯 optional | Only if swarm.ts grows past hand-rolled loops |
| 20 | CrewAI | ✗ pass | Too opinionated; conflicts with phoenix-core minimalism |

## Category E — Observability, Eval & Quality

| # | Tool | Status | Why |
|---|------|--------|-----|
| 1 | OpenTelemetry JS | 🎯 add | Workers OTel exporter → Grafana Cloud free tier |
| 2 | Grafana Cloud free | 🎯 | Dashboards for flock reroute events |
| 3 | Uptime Kuma | 🎯 self-host | `platform:smoke` already makes a perfect probe |
| 4 | Sentry free (5k errors) | 🎯 | Worker error capture |
| 5 | langfuse | ✅ | LLM tracing + cost per route decision |
| 6 | pytest + pytest-asyncio | ✅ | Python sidecar tests |
| 7 | hypothesis | ✅ | Property tests mirroring boundary-test philosophy |
| 8 | locust | ✅ CLI-only | Load the gateway locally (gevent conflict in-sandbox import) |
| 9 | k6 (Grafana) | 🎯 | Scripted load, better CI ergonomics |
| 10 | ruff | ✅ 0.16 | Python lint/format |
| 11 | pre-commit | ✅ 4.6 | Gate codespell/ruff/biome hooks |
| 12 | codespell | ✅ | Docs hygiene |
| 13 | semgrep | 🎯 | Security scan step alongside `scripts/security-scan.sh` |
| 14 | npm audit / pnpm audit parity | ✅ built-in | Add to `security:check` chain |
| 15 | vitest coverage (v8) | ✅ via vitest | Enforce on phoenix-core |
| 16 | bench/native-audit harness | ✅ repo | Extend with provider TTFT benchmarks |
| 17 | promptfoo | 🎯 | Routing-quality evals across birds |
| 18 | DSPy | ✅ | Optimizer experiments for classifier prompts (complexity.ts) |
| 19 | Instructor | ✅ | Structured-output evals via any free provider |
| 20 | dspy-eval / golden sets in mailbox | 🎯 | Turn `mailbox/` receipts into regression corpus |

## Category F — Data, Storage & Compute (free-computing frontier)

| # | Tech | Status | Why |
|---|------|--------|-----|
| 1 | Cloudflare D1 | 🎯 | Free SQLite at edge; ledger mirror |
| 2 | DO SQLite storage | ✅ used | Keep as primary session store |
| 3 | R2 | 🎯 | Evidence blobs, zero egress |
| 4 | KV | ✅ used | Manifests |
| 5 | DuckDB-WASM | 🎯 | Analytics directly in the dashboard, $0 backend |
| 6 | SQLite (better-sqlite3 parity in node runtime) | ✅ | simorgh-platform node host |
| 7 | libSQL/Turso free | ⚠️ account | Only if no-KYC rule revisited |
| 8 | Upstash Redis free | ⚠️ card-less now | Rate-limit hot path offload candidate |
| 9 | Valkey | 🎯 self-host | License-clean Redis for box deployments |
| 10 | pgvector | ✗ pass | Postgres breaks $0 constraint |
| 11 | sqlite-vec | 🎯 add | Embeddings search inside existing SQLite — zero new service |
| 12 | hnswlib (py) | 🎯 | Local ANN for retrieval sidecar |
| 13 | Cloudflare Queues | 🎯 | Probe fan-out |
| 14 | Cron Triggers | ✅ available | Quota refresh sweeps |
| 15 | Colab/Kaggle free GPUs | 🎯 | Offline model distillation for Homā |
| 16 | Fly.io free allowance (changed 2026) | ⚠️ verify | Second-region cores experiment |
| 17 | Oracle Cloud Always-Free | ⚠️ card | Strong but KYC-heavy — document tradeoff |
| 18 | GitHub Actions free minutes | ✅ use harder | CI for both suites + go workspace |
| 19 | Workers for Platforms | 🎯 watch | The "fleet" monetization primitive |
| 20 | Deno Deploy/Koyeb/Northflank free | ⚠️ compare | Portability proof for HOST-PORTABILITY.md |

## Category G — Frontend/Dashboard + DevEx

| # | Tool | Status | Why |
|---|------|--------|-----|
| 1 | Current dashboard (inline TS) | ✅ | Keep dependency-free until feature scale demands otherwise |
| 2 | htmx | 🎯 option | Interactivity without a SPA build chain |
| 3 | Lit 3 | 🎯 option | If components proliferate; plays nice with Workers SSR |
| 4 | Tailwind CSS v4 | 🎯 | Rapid polish for marketing/dashboard |
| 5 | Vite 7 | 🎯 | Only if SPA path chosen |
| 6 | vitepress / docs site | 🎯 | Public docs from `docs/` |
| 7 | playwright | 🎯 | Dashboard e2e + MCP |
| 8 | vitest UI mode | ✅ | Debug sessions |
| 9 | zod | 🎯 | Shared contracts |
| 10 | oRPC/tRPC | 🎯 evaluate | Typed REST between CLI and core (vs current wire contracts) |
| 11 | Ink (React CLI) | 🎯 | Upgrade `simorgh` CLI UX |
| 12 | clack/prompts | 🎯 | Beautiful CLI prompts |
| 13 | citty (unjs) | 🎯 | CLI framework aligned with upm/unjs ecosystem |
| 14 | changelog via `conventional-changelog` | 🎯 | Release discipline |
| 15 | GitHub Codespaces free hours | 🎯 | Zero-machine dev |
| 16 | VS Code + Biome ext | 🎯 | Editor wiring |
| 17 | Git LFS off (keep repo light) | ✅ policy | Good call, keep |
| 18 | Renovate/Dependabot | 🎯 enable | Supply-chain freshness |
| 19 | Taskfile/go-task | 🎯 | Unify npm/go/python entrypoints |
| 20 | just | 🎯 alt | Lighter alias layer than Make |

---

### Honesty notes (things I did NOT claim)
- Environment Node is **v20**, repo engines say **>=22.3** → install `nvm` or pin Node 22 LTS before running `npm test`.
- Go here is **1.19**; `go.work` needs **1.25** → upgrade before `npm run go:build`.
- `locust` imports fail *inside mixed-process* due to gevent monkey-patching; standalone CLI works.
- Nothing was added to `package.json`/`upm.lock` — global/on-demand only, so the reproducible build stays untouched.
- **Blocker found:** `upm 1.4` crashes on Node 20 (`b.fsp.glob is not a function`) — it requires Node ≥22's
  `fs.glob`. Installing Node 22 unblocks `upm install`, the test suites, and `tsgo` (whose exact dev build
  is in `upm.lock`, not on npm under the bare `tsgo` name).

---

## Appendix: Toolchain Upgrade — 2026-10-09 (verified)
- **fnm 1.39** installed (`~/.local/bin/fnm`), auto-switch via `eval "$(fnm env --use-on-cd)"` in ~/.bashrc + new `.nvmrc` (=22).
- **Node v22.23.3 (Jod LTS)** and **v26.11.1 (Current)** installed; default = 26, repo pins 22 via .nvmrc. npm 11.20.
- **Go 1.26.0** → /usr/local/go, symlinks in /usr/local/bin (old apt 1.19 shadowed them — fixed). go.work's `go 1.25` line is satisfied.
- Post-upgrade green build: `upm install` ✓ (93 pkgs/7s) · vitest 138/138 ✓ · vitest.node 500/500 ✓ · tsgo --noEmit ✓ · go build+test all packages ✓.
- Note: gateway/server tests previously failed only because PATH `go` was 1.19 (no method-based ServeMux); on 1.26 they pass.
