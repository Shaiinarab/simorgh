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

```bash
# install dependencies
npm install

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
├── src/
│   ├── index.ts       # Hono app: routes, Intent Shield, tool loop, Data Trust, Context Offload
│   ├── flock.ts       # The Flock: bird adapters + FlockCoordinator DO + runFlock()
│   ├── models.ts      # Model Registry (Auto-Wrapper): catalog + findModelBird
│   ├── data-trust.ts  # DataTrustVault DO: transparency ledger
│   └── dashboard.ts   # Self-contained Mission Control HTML (inline CSS/JS, no build)
├── test/
│   └── index.test.ts  # Core contract tests
├── docs/prd/
│   ├── PRD.md         # Full Product Requirements Document with 13 epics & 63 stories
│   └── EPICS_AND_STORIES.md  # Sprint planning summary
├── tsconfig.json      # TypeScript 7 (tsgo) config — strict, noEmit
├── wrangler.toml      # bindings: AI, KV(CONTEXT_STORE), DOs(FlockCoordinator, DataTrustVault)
├── SOUL.md            # Design philosophy
├── AGENT.md           # Agent contract (review-first)
├── AGENTS.md          # AI agent compatibility instructions
└── README.md
```

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
