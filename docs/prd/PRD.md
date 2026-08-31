# 🦅 Project Simorgh — Product Requirements Document (PRD)

> *"Thirty birds set out to find the Simorgh. After a long journey, the thirty survivors (si morgh) discover that they themselves — united — **are** the Simorgh."*
> — Attar of Nishapur, *The Conference of the Birds*

**Version:** 2.0 (PRD-Ready)
**Date:** August 31, 2026
**Status:** Approved for Implementation
**Author:** Shahin Arab · GLM-5.2 (Freebuff CLI) · Grok-4.6 (xagent research)

---

## 1. Executive Summary

**Simorgh** is a free-to-run, no-KYC, self-evolving **agentic AI gateway** that stitches the fragmented free tiers of the internet into one resilient, sovereign intelligence. Its founding metaphor is literal architecture: **many small "birds" (free-tier providers) fly together as one Simorgh, and when one bird tires, the flock reroutes.**

### Problem Statement

Modern agent stacks are expensive, gated behind KYC/credit cards, and fragile — one provider rate-limit kills the run. The free tiers already exist; they just don't cooperate. Simorgh is the **connective tissue** that makes them work together as one intelligence.

### Unique Positioning

Simorgh is the **world's first open-source, AI-native API Federation & Data Trust** that is:
- **Edge-native** (Cloudflare Workers, not a SaaS or local library)
- **No-KYC** (zero secrets required — Homā/Workers AI is always on)
- **Agent-loop-native** (not just a router — a full execute loop with Intent Shield)
- **Data-sovereign** (opt-in Data Pact, PII-scrubbed, transparency ledger)

### Competitive Landscape (2026)

| Feature | Simorgh | LiteLLM | Portkey | OpenRouter | Cloudflare AI Gateway |
|---------|---------|---------|---------|------------|----------------------|
| **Deployment** | Edge (Workers) | Local/Self-host | SaaS/Cloud | Managed SaaS | Cloud (Workers) |
| **No-KYC** | ✅ (Homā always on) | ❌ | ❌ | ❌ | ❌ |
| **Agent Loop** | ✅ (execute + tools) | ❌ (router only) | Partial | ❌ | ❌ (router only) |
| **Intent Shield** | ✅ (allow-list) | ❌ | ❌ | ❌ | ❌ |
| **Data Trust** | ✅ (Data Pact) | ❌ | ❌ | ❌ | ❌ |
| **Swarm-State** | ✅ (DO hive memory) | ❌ | Partial | ❌ | ❌ |
| **Auto-Wrapper** | 🗓️ (M4) | ❌ | ❌ | ❌ | ❌ |
| **Cost** | $0 | Free OSS | Paid | Freemium | Free tier |

**Key insight:** No competitor combines edge-native deployment, no-KYC operation, agent-loop execution, and data sovereignty. Simorgh's unique value is the *flock federation* — not just routing, but cooperative intelligence.

---

## 2. Vision & Goals

### North Star

*"Give any operator clarity before automation — a sovereign, free, resilient agentic AI gateway that federates fragmented free tiers into one cooperative intelligence, with data sovereignty by design."*

### OKRs (Objective + Key Results)

**Objective 1: Ship a genuinely useful agent (M3)**
- KR1: Real web search tool integrated (DuckDuckGo Instant Answer)
- KR2: Clean answer synthesis from tool results
- KR3: End-to-end test: prompt → tool call → synthesized answer
- KR4: P95 latency < 3s for single-bird answers

**Objective 2: Perfect the Flock federation (M1+)**
- KR1: ≥5 no-KYC free providers in the flock
- KR2: Automatic failover on rate-limit with <1s reroute
- KR3: Swarm-State DO tracks bird health across serverless hops
- KR4: Dashboard shows live flock status

**Objective 3: Ship Auto-Wrapper (M4)**
- KR1: OpenAPI spec → working MCP wrapper in <60s
- KR2: Generated wrappers pass integration tests
- KR3: Wrappers registered in FlockCoordinator with versioning

**Objective 4: BYOK + MCP core**
- KR1: Per-user encrypted key vault with rotation
- KR2: Native MCP server in Worker (2026-07-28 spec)
- KR3: External MCP agents can call the Simorgh flock

---

## 3. The Flock — Provider Adapters

Each "bird" normalizes a provider to one shape and is tried in priority order (lower = first). A bird stays **dormant** until its key is present, so the gateway runs with **zero secrets**.

### Current Birds (Shipped)

| id | Bird | Provider | Model | Key | Priority |
|----|------|----------|-------|-----|----------|
| `shahin` | 🦅 Shāhīn | Groq (OpenAI-compat) | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | 10 |
| `bulbul` | 🐦 Bulbul | HuggingFace Router | `meta-llama/Llama-3.3-70B-Instruct` | `HF_TOKEN` | 20 |
| `homa` | 🕊️ Homā | Cloudflare Workers AI | `@cf/meta/llama-3.2-3b-instruct` | *none* | 30 (**always on → zero-KYC guarantee**) |

### Candidate Birds (2026 Free, No-KYC Providers)

Based on 2026 research, these additional free-tier providers could join the flock:

| Candidate | Provider | Free Tier | KYC? | Bird Name (proposed) |
|-----------|----------|-----------|------|---------------------|
| Google Gemini | AI Studio | Generous free tier | May require | `morgh-e-safed` |
| Cerebras | Cerebras Cloud | Free tier available | Likely | `simorgh-e-javani` |
| GitHub Models | GitHub Models API | Free tier | GitHub account | `ghodrat` |
| Mistral | La Plateforme | Free tier | Email | `dastan` |
| OpenRouter (free models) | OpenRouter | Free models available | API key | `pari` |

**Compliance line (non-negotiable):**
✅ Caching · users' own keys · opt-in data sharing · honest rate-limit backoff · local fallback.
❌ Throwaway-account rotation · scraped keys · ban-evasion proxies. **The framework enforces this by design.**

---

## 4. Architecture

```
                       ┌─────────────────────────────────────────────┐
   client / CLI / MCP  │            Cloudflare Worker (Hono)          │
   ───────────────────▶│  /api/v1/agent/execute                      │
                       │    │                                        │
                       │    ├─▶ Intent Shield (tool allow-list)      │
                       │    ├─▶ Context Offload ──▶ KV (CONTEXT_STORE)│
                       │    ├─▶ Data Trust log ──▶ DataTrustVault (DO)│
                       │    │                                        │
                       │    └─▶ runFlock() ──┐                        │
                       │                     │  asks "who's awake?"   │
                       │        FlockCoordinator (DO, SQLite)  ◀──────┤  Swarm-State
                       │                     │                        │
                       │     ┌───────────────┼───────────────┐        │
                       ▼     ▼               ▼               ▼        │
                    Shāhīn(Groq)     Bulbul(HF)      Homā(CF Workers AI)
                    priority 10      priority 20     priority 30 (always on, no key)
                       └─────────────── one answers ─────────────┘   │
                       │  /dashboard  ──  30-Bird Mission Control  ────┘
                       └─────────────────────────────────────────────┘
```

### Core Components

| Component | Responsibility | Boundary |
|-----------|---------------|----------|
| `POST /api/v1/agent/execute` | Tool loop + flock failover | `WEBHOOK_SECRET` + KV |
| `FlockCoordinator` (DO, SQLite) | Swarm-State: bird health, circuit breaker | Atomic read-modify-write |
| `DataTrustVault` (DO) | Transparency ledger for data sharing | Immutable append-only |
| KV `CONTEXT_STORE` | Offloaded request payloads | TTL-based eviction |
| Intent Shield | Tool allow-list, prompt injection defense | Pre-loop + mid-flight vetting |
| `GET /dashboard` | Mission Control UI | Self-contained HTML (no build) |

---

## 5. Epics & Stories

### Epic 1: MVP — Edge Agent Core ✅ SHIPPED

**Objective:** Ship the edge agent: execute loop, Intent Shield, Context Offload (KV), Data Trust (DO).

**Status:** ✅ Shipped

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 1.1 | Agent execute loop | `POST /api/v1/agent/execute` accepts prompt + tools, runs tool loop, returns synthesized answer | ✅ |
| 1.2 | Intent Shield (tool allow-list) | Unlisted tools rejected before loop + mid-flight; shield logs blocked attempts | ✅ |
| 1.3 | Context Offload (KV) | Large request payloads offloaded to KV `CONTEXT_STORE`; retrievable via `/api/v1/context/:refId` | ✅ |
| 1.4 | Data Trust Vault (DO) | Every execute call logged to `DataTrustVault` DO with userId, tier, timestamp; queryable via `/api/v1/user/:userId/logs` | ✅ |
| 1.5 | Health endpoint | `GET /` returns fixed health text; `GET /health` returns no sensitive state | ✅ |

---

### Epic 2: The Flock — Multi-Provider Federation ✅ SHIPPED

**Objective:** Make the metaphor real: multi-provider failover + Swarm-State circuit breaker.

**Status:** ✅ Shipped

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 2.1 | Bird adapter pattern | Each provider normalized to one shape; tried in priority order; dormant until key present | ✅ |
| 2.2 | FlockCoordinator DO (SQLite) | `bird_health` table: status, consecutive_failures, cooldown_until, last_ok, total_calls, total_failures | ✅ |
| 2.3 | Circuit breaker logic | rate-limit → 60s rest; transient error → 15s × min(failures, 5) backoff | ✅ |
| 2.4 | `pickRoute()` | Returns healthy birds in priority order; tired bird skipped by concurrent/next requests | ✅ |
| 2.5 | Flock status endpoint | `GET /api/v1/flock/status` returns live Swarm-State: awake/tired/dormant per bird | ✅ |

---

### Epic 3: Mission Control — Dashboard ✅ SHIPPED

**Objective:** Make the flock *visible*: live dashboard + Flight Console.

**Status:** ✅ Shipped

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 3.1 | Self-contained dashboard HTML | `GET /dashboard` renders inline CSS/JS, no build step; works on workers.dev | ✅ |
| 3.2 | Live flock status display | Dashboard polls `/api/v1/flock/status`; shows bird health in real-time | ✅ |
| 3.3 | Flight Console | Interactive prompt → execute → see flock attempts + answer in dashboard | ✅ |

---

### Epic 4: The Real Agent — Useful Tools 🛠️ IN PROGRESS

**Objective:** Make the agent genuinely *useful*: real web search + clean answer synthesis.

**Status:** 🛠️ In Progress

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 4.1 | `search_web(query)` tool | Real, no-KYC web search via DuckDuckGo Instant Answer; returns structured results | ✅ |
| 4.2 | `get_server_time()` tool | Returns ISO-8601 server time | ✅ |
| 4.3 | Clean answer synthesis | Agent synthesizes tool results into a coherent natural-language answer; no raw JSON dumps | 🛠️ |
| 4.4 | Multi-tool orchestration | Agent can call multiple tools in sequence to answer complex prompts | 🛠️ |
| 4.5 | Answer quality tests | End-to-end tests: "What time is it?" → synthesized answer contains ISO timestamp; "Search for X" → synthesized answer references search results | ⬜ |

---

### Epic 5: Swarm-State Hardening

**Objective:** Harden the Swarm-State / Durable Object patterns for production resilience.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 5.1 | DO atomic updates | FlockCoordinator supports concurrent `pickRoute()` calls without race conditions; tested with 10 concurrent requests | ⬜ |
| 5.2 | KV fallback | If DO is unavailable, fall back to KV-cached bird health with eventual consistency | ⬜ |
| 5.3 | Request-to-request state passing | State propagated via context offload or headers; no data loss on cold starts | ⬜ |
| 5.4 | Metrics export | Bird call counts, failure rates, cooldown events exported via `/api/v1/flock/status` and dashboard | ⬜ |
| 5.5 | Backpressure handling | When all birds are tired, return a clear "flock exhausted" response with retry-after header | ⬜ |

**Technical Risks:**
- DO cost/scale limits in 2026 free tier
- Consistency vs. eventual consistency trade-offs
- Debugging distributed state across serverless hops

---

### Epic 6: Intent Shield — Policy-as-Code

**Objective:** Implement edge-based tool allow-listing, policy-as-code, and prompt injection defense.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 6.1 | Declarative policy engine | Policies defined in JSON/YAML; runtime vetting of every tool call; user-defined allow-lists | ⬜ |
| 6.2 | Prompt injection defense | Edge sanitization of model outputs; input validation; model-side guards; logging of blocked injection attempts | ⬜ |
| 6.3 | Policy versioning | Policies versioned, A/B tested, tied to user tiers and Data-Pact consent | ⬜ |
| 6.4 | Swarm-State policy sharing | Shared policy state across flock birds; dynamic updates without downtime | ⬜ |
| 6.5 | Shield audit dashboard | Full logs for shield decisions visible in dashboard; regression testing for policy changes | ⬜ |

**Technical Risks:**
- False positives in allow-listing blocking legitimate tool calls
- Latency impact of policy evaluation at the edge
- Maintaining policy consistency across serverless instances

---

### Epic 7: Data Trust / Data Pact

**Objective:** Implement opt-in, PII-scrubbed data sharing, transparency ledgers, and consent management so users can "pay" with research/data instead of cash.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 7.1 | Consent & tiers engine | Free-Volunteer / Pro-Paid / Pro-Data-Pact tiers; granular consent per data type; revocation workflow | ⬜ |
| 7.2 | PII scrubbing pipeline | Automatic scrubbing (regex + LLM-assisted) before any data sharing; verifiable audit logs of scrubbing decisions | ⬜ |
| 7.3 | Transparency ledger | Immutable ledger (DO) of all data-sharing events; user dashboard view; exportable reports | ⬜ |
| 7.4 | Flock consent integration | Shared data flows respect consent tier; Swarm-State uses only aggregated (scrubbed) insights for Pro-Data-Pact users | ⬜ |
| 7.5 | Enforcement & compliance | Rejects unauthorized sharing; fallback to non-shared mode on consent revocation; compliance reporting (GDPR/CCPA) | ⬜ |

**Technical Risks:**
- Edge cases in scrubbing complex PII (code blocks, URLs, structured data)
- Performance of ledger queries in high-throughput
- Regulatory alignment (GDPR/CCPA in 2026)

---

### Epic 8: Auto-Wrapper — LLM-Generated MCP Wrappers

**Objective:** Enable Simorgh to automatically generate production-ready MCP wrappers for any REST/OpenAPI service, allowing seamless integration into the Flock without manual SDK work.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 8.1 | OpenAPI-to-MCP code generator | LLM takes OpenAPI/Swagger spec; outputs complete Hono Worker + MCP adapter; generates TypeScript types; tests against sample endpoints | ⬜ |
| 8.2 | MCP protocol integration (2026-07-28) | Implement MCP 2026-07-28 spec; wrapper exposes MCP methods for any generated service; supports bidirectional tool calling | ⬜ |
| 8.3 | Wrapper validation & fallback | Generated wrappers pass integration tests; auto-fallback to original REST if MCP fails; metrics logged for wrapper success rate | ⬜ |
| 8.4 | Registry & discovery | Wrappers registered in FlockCoordinator; live discovery via `/flock/status`; versioned, with auto-regeneration on spec changes | ⬜ |
| 8.5 | Security hardening | Handles auth (BYOK), rate-limiting, error mapping; security review for prompt injection in code generation | ⬜ |

**Technical Risks:**
- LLM hallucination in code generation (mitigate with test suites + type checking)
- Performance overhead of auto-generated wrappers
- Compatibility with evolving MCP spec

---

### Epic 9: BYOK / MCP Core

**Objective:** Provide per-user Bring-Your-Own-Key (BYOK) management and native MCP support for secure, efficient inter-agent communication.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 9.1 | Secure key vault & rotation | Encrypted storage in DataTrustVault/DO; per-user API keys with rotation, revocation, audit logs; zero-knowledge handling | ⬜ |
| 9.2 | MCP adapter layer | Native MCP server in Worker; supports tool calling, streaming, context passing; interop with existing agent loops | ⬜ |
| 9.3 | Swarm-State MCP integration | MCP-aware Swarm-State tracks per-user bird health; cross-request state sharing via Durable Object | ⬜ |
| 9.4 | Client-side MCP support | CLI and dashboard expose MCP endpoints; external MCP agents can call the Simorgh flock | ⬜ |
| 9.5 | Compliance & Data Pact integration | Keys tied to consent tiers; PII-scrubbed sharing for Pro-Data-Pact users | ⬜ |

**Technical Risks:**
- Key management complexity in serverless environment
- Performance/scalability of MCP connections on Workers
- Security surface of exposing MCP endpoints

---

### Epic 10: Flock Expansion — More Birds

**Objective:** Expand the flock beyond 3 birds to 5-10 no-KYC free providers, making the federation genuinely resilient.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 10.1 | Bird adapter spec | Document the bird adapter interface; any provider can be added by implementing the interface | ⬜ |
| 10.2 | Google Gemini bird | `morgh-e-safed` adapter for Google AI Studio free tier; tested with real prompts | ⬜ |
| 10.3 | Cerebras bird | `simorgh-e-javani` adapter for Cerebras Cloud free tier; tested with real prompts | ⬜ |
| 10.4 | GitHub Models bird | `ghodrat` adapter for GitHub Models API; tested with real prompts | ⬜ |
| 10.5 | Flock priority tuning | Dashboard shows all birds; priority auto-tuned based on latency + success rate metrics | ⬜ |

---

### Epic 11: Observability & Operations

**Objective:** Make the platform operable — logs, metrics, alerts, and debugging tools.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 11.1 | Structured logging | All requests logged with structured JSON; correlation IDs for tracing across birds | ⬜ |
| 11.2 | Metrics dashboard | Dashboard shows: request count, P50/P95 latency, bird success rate, tool call count, shield blocks | ⬜ |
| 11.3 | Alerting hooks | Webhook or email alert when all birds are tired or error rate exceeds threshold | ⬜ |
| 11.4 | Debug mode | `?debug=1` flag returns full flock attempt log, tool iterations, and shield decisions in response | ⬜ |
| 11.5 | Cost tracking | Dashboard shows estimated cost per request ($0 for free tier; BYOK cost for paid) | ⬜ |

---

### Epic 12: Security Hardening

**Objective:** Harden the platform for public-facing production use.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 12.1 | Rate limiting | Per-IP and per-user rate limiting on `/api/v1/agent/execute`; configurable thresholds | ⬜ |
| 12.2 | Authentication | Optional API key auth for the gateway; BYOK keys never exposed in responses | ⬜ |
| 12.3 | Secret redaction | All responses redact secrets, keys, credentials; verified by property-based tests | ⬜ |
| 12.4 | SECURITY.md | Responsible disclosure policy; security boundary documentation | ⬜ |
| 12.5 | Dependency audit | `npm audit` + `npm ci` in CI; no high-severity vulnerabilities in production deps | ⬜ |

---

### Epic 13: Documentation & Community

**Objective:** Make the project accessible, understandable, and contributable.

| Story | Description | Acceptance Criteria | Status |
|-------|-------------|---------------------|--------|
| 13.1 | README (comprehensive) | Getting started, architecture, API reference, bird list, deployment guide — the current README is the baseline | ✅ |
| 13.2 | CONTRIBUTING.md | Contribution guide: bird adapter spec, code style, test requirements, PR process | ⬜ |
| 13.3 | Architecture decision records (ADRs) | Key architecture decisions documented as ADRs in `docs/adr/` | ⬜ |
| 13.4 | Bird adapter tutorial | Step-by-step guide for adding a new bird to the flock | ⬜ |
| 13.5 | API documentation | OpenAPI/Swagger spec for all Simorgh API endpoints; interactive docs | ⬜ |

---

## 6. Non-Functional Requirements

| Category | Requirement | Target |
|----------|-------------|--------|
| **Cost** | Run cost | $0 (all free-tier primitives) |
| **Latency** | Single-bird answer P95 | < 3s |
| **Latency** | Failover reroute | < 1s |
| **Availability** | Zero-KYC guarantee | Homā always on (Workers AI, no key) |
| **Security** | Secret exposure | Never (redaction verified by tests) |
| **Compliance** | Data sharing | Opt-in only, PII-scrubbed, revocable |
| **Test coverage** | Core paths | 100% pass before merge |
| **Type safety** | TypeScript strict | `tsgo --noEmit` passes |

---

## 7. Milestone Roadmap

| Milestone | Epics | Status |
|-----------|-------|--------|
| **MVP** | Epic 1 | ✅ shipped |
| **M1 — The Flock** | Epic 2 | ✅ shipped |
| **M2 — Mission Control** | Epic 3 | ✅ shipped |
| **M3 — The Real Agent** | Epic 4, 6 (Intent Shield) | 🛠️ in progress |
| **M3.5 — Flock Hardening** | Epic 5, 10 | 🗓️ next |
| **M4 — Auto-Wrapper** | Epic 8 | 🗓️ backlog |
| **M5 — BYOK / MCP** | Epic 9 | 🗓️ backlog |
| **M6 — Data Trust** | Epic 7 | 🗓️ backlog |
| **M7 — Production** | Epic 11, 12, 13 | 🗓️ backlog |

---

## 8. Design Philosophy (SOUL)

Simorgh exists to give an operator **clarity before automation**. Its first loyalty is to the person who owns the data, provider accounts, and deployment risk—not to throughput, novelty, or a provider's preferred workflow.

> **Never turn a plan into an external effect without an explicit, scoped, expiring, reviewable human decision.**

- Be **ambitious in planning** and **conservative in action**
- Describe uncertainty honestly: a local manifest does not prove a connected account
- Expose the cheapest safe next step
- Require a human-controlled boundary before any provider-side change

---

## 9. Agent Contract (Review-First)

| Intent | Current policy | Provider effect |
|---|---|---|
| Inspect profile or module manifest | Allowed | `none` |
| Plan a local module or source review | Allowed | `none` |
| Enable or disable a module through the CLI | Human-confirmed local metadata only | `none` |
| Accept credentials, complete OAuth, clone/import data | Refuse | `none` |
| Register gateway, send a message, deploy, upload, mutate DNS | Refuse | `none` |

---

## 10. Research Evidence

This PRD synthesizes:
1. **Original platform evidence:** README.md, SOUL.md, AGENT.md, REPULSE_ARCHITECTURE.md, test files
2. **Grok-4.6 research digest** (13 turns, 1M context, web search): Architecture epics & stories for federation, Auto-Wrapper, BYOK, Data Trust, Intent Shield, Swarm-State
3. **Web research (2026):** Competitor landscape (LiteLLM, Portkey, OpenRouter, Requesty, Kong, Cloudflare AI Gateway, Helicone); free no-KYC provider survey (Groq, HuggingFace, Cloudflare Workers AI, Google Gemini, Cerebras, GitHub Models, Mistral, OpenRouter free)

---

*Si morgh → Simorgh. Thirty birds → one.* 🔥
