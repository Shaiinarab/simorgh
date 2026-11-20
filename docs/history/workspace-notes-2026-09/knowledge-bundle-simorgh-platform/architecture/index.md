
# Simorgh Platform — Architecture

## Core Architecture

```
client / CLI / MCP ──▶ Cloudflare Worker (Hono)
  /api/v1/agent/execute
    ├─▶ Intent Shield (tool allow-list)
    ├─▶ Context Offload ──▶ KV (CONTEXT_STORE)
    ├─▶ Data Trust log ──▶ DataTrustVault (DO)
    └─▶ runFlock() ──▶ FlockCoordinator (DO, SQLite) — Swarm-State
                       ├─ Shāhīn (Groq, llama-3.3-70b, priority 10)
                       ├─ Bulbul (HF Router, Llama-3.3-70B, priority 20)
                       └─ Homā (CF Workers AI, llama-3.2-3b, priority 30, ALWAYS ON, zero-KYC guarantee)
  /dashboard — 30-Bird Mission Control
```

## Core Components

| Component | Responsibility | Boundary |
|-----------|---------------|----------|
| `POST /api/v1/agent/execute` | Tool loop + flock failover | `WEBHOOK_SECRET` + KV |
| FlockCoordinator (DO, SQLite) | Swarm-State: bird health, circuit breaker | Atomic read-modify-write |
| DataTrustVault (DO) | Transparency ledger for data sharing | Immutable append-only |
| KV `CONTEXT_STORE` | Offloaded request payloads | TTL-based eviction |
| Intent Shield | Tool allow-list, prompt injection defense | Pre-loop + mid-flight vetting |
| `GET /dashboard` | Mission Control UI | Self-contained HTML (no build) |

## The Flock — Provider Adapters

Each "bird" normalizes a provider to one shape and is tried in priority order (lower = first). A bird stays dormant until its key is present, so the gateway runs with zero secrets.

### Current Birds (Shipped)

| id | Bird | Provider | Model | Key | Priority |
|----|------|----------|-------|-----|----------|
| `shahin` | 🦅 Shāhīn | Groq (OpenAI-compat) | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | 10 |
| `bulbul` | 🐦 Bulbul | HuggingFace Router | `meta-llama/Llama-3.3-70B-Instruct` | `HF_TOKEN` | 20 |
| `homa` | 🕊️ Homā | Cloudflare Workers AI | `@cf/meta/llama-3.2-3b-instruct` | *none* | 30 (**always on → zero-KYC guarantee**) |

## Intent Shield

- Tool allow-list: `search_web`, `get_server_time` only.
- Vet before loop + mid-flight.
- Logs blocked attempts.
- Mutable in code today; planned as declarative policy engine in Epic 6.

## Data Trust / Data Pact

- Every execute call logged to DataTrustVault DO with userId, tier, timestamp.
- Queryable via `/api/v1/user/:userId/logs`.
- Tiers: `Free-Volunteer`, `Pro-Paid`, `Pro-Data-Pact`.
- Compliance line: opt-in only, PII-scrubbed, revocable.

## Dashboard

- Self-contained HTML with inline CSS/JS, no build step.
- Polls `/api/v1/flock/status` every 5s.
- Flight Console: prompt → execute → see flock attempts + answer.

## API Surface

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/v1/agent/execute` | Run the agent (tool loop + flock failover). |
| `GET`  | `/api/v1/flock/status` | Live Swarm-State: which birds are awake/tired/dormant. |
| `GET`  | `/api/v1/context/:refId` | Retrieve an offloaded request payload from KV. |
| `GET`  | `/api/v1/user/:userId/logs` | Data-Trust transparency: a user's ledger entries. |
| `GET`  | `/dashboard` | Self-contained Mission Control UI. |
| `GET`  | `/` | Health text. |

## Compliance Line (Non-Negotiable)

✅ Caching · users' own keys · opt-in data sharing · honest rate-limit backoff · local fallback.  
❌ Throwaway-account rotation · scraped keys · ban-evasion proxies. **The framework enforces this by design.**

## See Also

- [Source map](../source/index.md)
- [Planning](../planning/index.md)
- [Research](../research/index.md)
- [Simorgh Platform index](../index.md)
