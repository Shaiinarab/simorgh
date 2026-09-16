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

## Testing

```bash
npm test        # vitest, running *inside* workerd via @cloudflare/vitest-pool-workers
```

47 tests across five files. They are split by what they need, on purpose:

| File | Runs against | Covers |
|------|--------------|--------|
| `flock-routing.test.ts` | nothing but a fake env | The routing policy — priority order, dormant skip, cooldowns, fall-through, exhaustion — plus the real Groq/HF adapters with `fetch` stubbed. No runtime, no network. |
| `health-storage.test.ts` | a real `SqlStorage` | The `bird_health` upsert and the cron sweep. |
| `durable-objects.test.ts` | real Durable Objects | The RPC boundary and SQLite, through the actual stubs. |
| `http.test.ts` | real KV + a real ledger DO | Route contracts; only the flock is stubbed. |
| `index.test.ts` | the worker entry | `fetch` and `scheduled` handler shape. |

Two deliberate choices worth knowing about:

- **Routing is tested as a pure function, not through the Durable Object.** Homā calls
  Workers AI on every request and Workers AI has no local simulation, so routing tests
  driven through the DO would need the real internet (and would bill for it).
  `flyFlock()` therefore takes its birds, env and cooldown lookup as arguments.
- **The tool allow-list is asserted, not assumed.** `http.test.ts` sends a request with
  disallowed tools and checks that the Durable Object received only the allow-listed
  ones — the security property, verified at the boundary rather than at the source.

`vitest` may print `close timed out after 10000ms` at the end. That is the remote AI
binding holding a connection open; the suite still exits `0`. It is noise, not a hang.

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
├── src/                    # TypeScript / Workers
│   ├── index.ts            # Hono app: routes, Intent Shield, Data Trust, Context Offload, cron
│   ├── flock.ts            # Bird adapters + flyFlock() routing core + FlockCoordinator DO
│   ├── health.ts           # bird_health storage statements (upsert, cooldown, sweep)
│   ├── models.ts           # Model Registry (Auto-Wrapper): catalog + findModelBird
│   ├── data-trust.ts       # DataTrustVault DO: transparency ledger
│   └── dashboard.ts        # Self-contained Mission Control HTML (inline CSS/JS, no build)
├── test/                   # 5 suites, 47 tests — see Testing above
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
