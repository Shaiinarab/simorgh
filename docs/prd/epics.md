# Simorgh — Epics (canonical, sprint-planning format)

> Canonical epic/story list derived from [PRD.md](./PRD.md). This file is the
> machine-parsed source for sprint tracking (`sprint_plan.py`). Statuses below
> reflect the PRD; the tracking file records them explicitly.

---

### Epic 1: MVP — Edge Agent Core

Ship the edge agent: execute loop, Intent Shield, Context Offload (KV), Data Trust (DO).

- **PRD status:** shipped

### Story 1.1: Agent execute loop

`POST /api/v1/agent/execute` accepts prompt + tools, runs the tool loop, returns a synthesized answer.

- **Acceptance:** endpoint accepts prompt + tools; runs tool loop; returns synthesized answer
- **PRD status:** shipped

### Story 1.2: Intent Shield (tool allow-list)

Unlisted tools rejected before the loop and mid-flight; shield logs blocked attempts.

- **Acceptance:** unlisted tools rejected pre-loop + mid-flight; blocked attempts logged
- **PRD status:** shipped

### Story 1.3: Context Offload (KV)

Large request payloads offloaded to KV `CONTEXT_STORE`; retrievable via `/api/v1/context/:refId`.

- **Acceptance:** large payloads offloaded to KV; retrievable via ref endpoint
- **PRD status:** shipped

### Story 1.4: Data Trust Vault (DO)

Every execute call logged to `DataTrustVault` DO with userId, tier, timestamp; queryable via `/api/v1/user/:userId/logs`.

- **Acceptance:** every execute logged with userId/tier/timestamp; queryable endpoint
- **PRD status:** shipped

### Story 1.5: Health endpoint

`GET /` returns fixed health text; `GET /health` returns no sensitive state.

- **Acceptance:** root returns fixed health text; health returns no sensitive state
- **PRD status:** shipped

---

### Epic 2: The Flock — Multi-Provider Federation

Make the metaphor real: multi-provider failover + Swarm-State circuit breaker.

- **PRD status:** shipped

### Story 2.1: Bird adapter pattern

Each provider normalized to one shape; tried in priority order; dormant until key present.

- **Acceptance:** providers normalized; priority order; dormant-until-key
- **PRD status:** shipped

### Story 2.2: FlockCoordinator DO (SQLite)

`bird_health` table: status, consecutive_failures, cooldown_until, last_ok, total_calls, total_failures.

- **Acceptance:** bird_health schema with health, failures, cooldown, counters
- **PRD status:** shipped

### Story 2.3: Circuit breaker logic

Rate-limit → 60s rest; transient error → 15s × min(failures, 5) backoff.

- **Acceptance:** rate-limit rest 60s; transient backoff 15s × min(failures, 5)
- **PRD status:** shipped

### Story 2.4: pickRoute()

Returns healthy birds in priority order; tired bird skipped by concurrent/next requests.

- **Acceptance:** healthy birds in priority order; tired birds skipped
- **PRD status:** shipped

### Story 2.5: Flock status endpoint

`GET /api/v1/flock/status` returns live Swarm-State: awake/tired/dormant per bird.

- **Acceptance:** live swarm-state per bird (awake/tired/dormant)
- **PRD status:** shipped

---

### Epic 3: Mission Control — Dashboard

Make the flock *visible*: live dashboard + Flight Console.

- **PRD status:** shipped

### Story 3.1: Self-contained dashboard HTML

`GET /dashboard` renders inline CSS/JS, no build step; works on workers.dev.

- **Acceptance:** self-contained HTML; no build step; works on workers.dev
- **PRD status:** shipped

### Story 3.2: Live flock status display

Dashboard polls `/api/v1/flock/status`; shows bird health in real time.

- **Acceptance:** polls status endpoint; renders live bird health
- **PRD status:** shipped

### Story 3.3: Flight Console

Interactive prompt → execute → see flock attempts + answer in the dashboard.

- **Acceptance:** prompt input; execute; shows flock attempts and answer
- **PRD status:** shipped

---

### Epic 4: The Real Agent — Useful Tools

Make the agent genuinely *useful*: real web search + clean answer synthesis.

- **PRD status:** shipped

### Story 4.1: search_web(query) tool

Real, no-KYC web search (DuckDuckGo Instant Answer); returns structured results.

- **Acceptance:** no-KYC web search tool; structured results
- **PRD status:** shipped

### Story 4.2: get_server_time() tool

Returns ISO-8601 server time.

- **Acceptance:** returns ISO-8601 timestamp
- **PRD status:** shipped

### Story 4.3: Clean answer synthesis

Agent synthesizes tool results into a coherent natural-language answer; no raw JSON dumps.

- **Acceptance:** coherent NL answer; no raw JSON dumps
- **PRD status:** shipped

### Story 4.4: Multi-tool orchestration

Agent can call multiple tools in sequence to answer complex prompts.

- **Acceptance:** sequential multi-tool calls for complex prompts
- **PRD status:** shipped

### Story 4.5: Answer quality tests

End-to-end tests: "What time is it?" → synthesized answer contains ISO timestamp; "Search for X" → synthesized answer references search results.

- **Acceptance:** e2e tests for time + search prompts pass
- **PRD status:** shipped

---

### Epic 5: Swarm-State Hardening

Harden the Swarm-State / Durable Object patterns for production resilience.

- **PRD status:** backlog

### Story 5.1: DO atomic updates

FlockCoordinator supports concurrent `pickRoute()` calls without race conditions; tested with 10 concurrent requests.

- **Acceptance:** no races under 10 concurrent requests
- **PRD status:** backlog

### Story 5.2: KV fallback

If DO is unavailable, fall back to KV-cached bird health with eventual consistency.

- **Acceptance:** KV fallback with eventual consistency
- **PRD status:** backlog

### Story 5.3: Request-to-request state passing

State propagated via context offload or headers; no data loss on cold starts.

- **Acceptance:** state survives cold starts
- **PRD status:** backlog

### Story 5.4: Metrics export

Bird call counts, failure rates, cooldown events exported via `/api/v1/flock/status` and dashboard.

- **Acceptance:** call/failure/cooldown metrics exposed
- **PRD status:** backlog

### Story 5.5: Backpressure handling

When all birds are tired, return a clear "flock exhausted" response with retry-after header.

- **Acceptance:** flock-exhausted response with Retry-After
- **PRD status:** backlog

---

### Epic 6: Intent Shield — Policy-as-Code

Edge-based tool allow-listing, policy-as-code, and prompt injection defense.

- **PRD status:** backlog

### Story 6.1: Declarative policy engine

Policies defined in JSON/YAML; runtime vetting of every tool call; user-defined allow-lists.

- **Acceptance:** declarative policies; runtime vetting; user allow-lists
- **PRD status:** backlog

### Story 6.2: Prompt injection defense

Edge sanitization of model outputs; input validation; model-side guards; logging of blocked injection attempts.

- **Acceptance:** output sanitization; input validation; injection attempts logged
- **PRD status:** backlog

### Story 6.3: Policy versioning

Policies versioned, A/B tested, tied to user tiers and Data-Pact consent.

- **Acceptance:** versioned policies; A/B; tier/consent binding
- **PRD status:** backlog

### Story 6.4: Swarm-State policy sharing

Shared policy state across flock birds; dynamic updates without downtime.

- **Acceptance:** shared policy state; live updates
- **PRD status:** backlog

### Story 6.5: Shield audit dashboard

Full logs for shield decisions visible in dashboard; regression testing for policy changes.

- **Acceptance:** shield decision logs in dashboard; policy regression tests
- **PRD status:** backlog

---

### Epic 7: Data Trust / Data Pact

Opt-in, PII-scrubbed data sharing, transparency ledgers, and consent management — users "pay" with research/data instead of cash.

- **PRD status:** backlog

### Story 7.1: Consent & tiers engine

Free-Volunteer / Pro-Paid / Pro-Data-Pact tiers; granular consent per data type; revocation workflow.

- **Acceptance:** three tiers; granular consent; revocation
- **PRD status:** backlog

### Story 7.2: PII scrubbing pipeline

Automatic scrubbing (regex + LLM-assisted) before any data sharing; verifiable audit logs of scrubbing decisions.

- **Acceptance:** regex + LLM scrubbing; audit logs
- **PRD status:** backlog

### Story 7.3: Transparency ledger

Immutable ledger (DO) of all data-sharing events; user dashboard view; exportable reports.

- **Acceptance:** immutable ledger; dashboard view; exports
- **PRD status:** backlog

### Story 7.4: Flock consent integration

Shared data flows respect consent tier; Swarm-State uses only aggregated (scrubbed) insights for Pro-Data-Pact users.

- **Acceptance:** consent-tier-aware flows; aggregated insights only
- **PRD status:** backlog

### Story 7.5: Enforcement & compliance

Rejects unauthorized sharing; fallback to non-shared mode on consent revocation; compliance reporting (GDPR/CCPA).

- **Acceptance:** unauthorized sharing rejected; non-shared fallback; GDPR/CCPA reporting
- **PRD status:** backlog

---

### Epic 8: Auto-Wrapper — LLM-Generated MCP Wrappers

Automatically generate production-ready MCP wrappers for any REST/OpenAPI service, integrated into the Flock without manual SDK work.

- **PRD status:** backlog

### Story 8.1: OpenAPI-to-MCP code generator

LLM takes OpenAPI/Swagger spec; outputs complete Hono Worker + MCP adapter; generates TypeScript types; tests against sample endpoints.

- **Acceptance:** spec → Worker + MCP adapter + TS types; sample tests pass
- **PRD status:** backlog

### Story 8.2: MCP protocol integration (2026-07-28)

Implement MCP 2026-07-28 spec; wrapper exposes MCP methods for any generated service; supports bidirectional tool calling.

- **Acceptance:** MCP methods exposed; bidirectional tool calling
- **PRD status:** backlog

### Story 8.3: Wrapper validation & fallback

Generated wrappers pass integration tests; auto-fallback to original REST if MCP fails; metrics logged for wrapper success rate.

- **Acceptance:** integration tests pass; REST fallback; success metrics
- **PRD status:** backlog

### Story 8.4: Registry & discovery

Wrappers registered in FlockCoordinator; live discovery via `/flock/status`; versioned, with auto-regeneration on spec changes.

- **Acceptance:** registry in FlockCoordinator; live discovery; versioning
- **PRD status:** backlog

### Story 8.5: Security hardening (wrappers)

Handles auth (BYOK), rate-limiting, error mapping; security review for prompt injection in code generation.

- **Acceptance:** BYOK auth; rate limits; injection review
- **PRD status:** backlog

---

### Epic 9: BYOK / MCP Core

Per-user Bring-Your-Own-Key management and native MCP support for secure inter-agent communication.

- **PRD status:** backlog

### Story 9.1: Secure key vault & rotation

Encrypted storage in DataTrustVault/DO; per-user API keys with rotation, revocation, audit logs; zero-knowledge handling.

- **Acceptance:** encrypted vault; rotation/revocation; audit; zero-knowledge
- **PRD status:** backlog

### Story 9.2: MCP adapter layer

Native MCP server in Worker; supports tool calling, streaming, context passing; interop with existing agent loops.

- **Acceptance:** MCP server in Worker; tool/stream/context support
- **PRD status:** backlog

### Story 9.3: Swarm-State MCP integration

MCP-aware Swarm-State tracks per-user bird health; cross-request state sharing via Durable Object.

- **Acceptance:** per-user bird health; DO state sharing
- **PRD status:** backlog

### Story 9.4: Client-side MCP support

CLI and dashboard expose MCP endpoints; external MCP agents can call the Simorgh flock.

- **Acceptance:** MCP endpoints in CLI/dashboard; external agents can call flock
- **PRD status:** backlog

### Story 9.5: Compliance & Data Pact integration

Keys tied to consent tiers; PII-scrubbed sharing for Pro-Data-Pact users.

- **Acceptance:** keys bound to consent; scrubbed sharing
- **PRD status:** backlog

---

### Epic 10: Flock Expansion — More Birds

Expand the flock beyond 3 birds to 5-10 no-KYC free providers, making the federation genuinely resilient.

- **PRD status:** backlog

### Story 10.1: Bird adapter spec

Document the bird adapter interface; any provider can be added by implementing the interface.

- **Acceptance:** documented adapter interface; add-a-bird guide
- **PRD status:** backlog

### Story 10.2: Google Gemini bird

`morgh-e-safed` adapter for Google AI Studio free tier; tested with real prompts.

- **Acceptance:** Gemini adapter; real-prompt tests
- **PRD status:** backlog

### Story 10.3: Cerebras bird

`simorgh-e-javani` adapter for Cerebras Cloud free tier; tested with real prompts.

- **Acceptance:** Cerebras adapter; real-prompt tests
- **PRD status:** backlog

### Story 10.4: GitHub Models bird

`ghodrat` adapter for GitHub Models API; tested with real prompts.

- **Acceptance:** GitHub Models adapter; real-prompt tests
- **PRD status:** backlog

### Story 10.5: Flock priority tuning

Dashboard shows all birds; priority auto-tuned based on latency + success rate metrics.

- **Acceptance:** full bird list; auto-tuned priorities
- **PRD status:** backlog

---

### Epic 11: Observability & Operations

Make the platform operable — logs, metrics, alerts, and debugging tools.

- **PRD status:** backlog

### Story 11.1: Structured logging

All requests logged with structured JSON; correlation IDs for tracing across birds.

- **Acceptance:** JSON logs; correlation IDs
- **PRD status:** backlog

### Story 11.2: Metrics dashboard

Dashboard shows: request count, P50/P95 latency, bird success rate, tool call count, shield blocks.

- **Acceptance:** metrics rendered in dashboard
- **PRD status:** backlog

### Story 11.3: Alerting hooks

Webhook or email alert when all birds are tired or error rate exceeds threshold.

- **Acceptance:** alert on flock exhaustion / error threshold
- **PRD status:** backlog

### Story 11.4: Debug mode

`?debug=1` flag returns full flock attempt log, tool iterations, and shield decisions in response.

- **Acceptance:** debug flag returns attempt/tool/shield traces
- **PRD status:** backlog

### Story 11.5: Cost tracking

Dashboard shows estimated cost per request ($0 for free tier; BYOK cost for paid).

- **Acceptance:** per-request cost estimate shown
- **PRD status:** backlog

---

### Epic 12: Security Hardening

Harden the platform for public-facing production use.

- **PRD status:** backlog

### Story 12.1: Rate limiting

Per-IP and per-user rate limiting on `/api/v1/agent/execute`; configurable thresholds.

- **Acceptance:** per-IP + per-user limits; configurable
- **PRD status:** backlog

### Story 12.2: Authentication

Optional API key auth for the gateway; BYOK keys never exposed in responses.

- **Acceptance:** optional API-key auth; no key leakage
- **PRD status:** backlog

### Story 12.3: Secret redaction

All responses redact secrets, keys, credentials; verified by property-based tests.

- **Acceptance:** redaction verified by property tests
- **PRD status:** backlog

### Story 12.4: SECURITY.md

Responsible disclosure policy; security boundary documentation.

- **Acceptance:** SECURITY.md with disclosure + boundaries
- **PRD status:** backlog

### Story 12.5: Dependency audit

`npm audit` + `npm ci` in CI; no high-severity vulnerabilities in production deps.

- **Acceptance:** CI audit gate; no high-severity vulns
- **PRD status:** backlog

---

### Epic 13: Documentation & Community

Make the project accessible, understandable, and contributable.

- **PRD status:** backlog

### Story 13.1: README (comprehensive)

Getting started, architecture, API reference, bird list, deployment guide — the current README is the baseline.

- **Acceptance:** comprehensive README maintained
- **PRD status:** shipped

### Story 13.2: CONTRIBUTING.md

Contribution guide: bird adapter spec, code style, test requirements, PR process.

- **Acceptance:** CONTRIBUTING.md published
- **PRD status:** backlog

### Story 13.3: Architecture decision records (ADRs)

Key architecture decisions documented as ADRs in `docs/adr/`.

- **Acceptance:** ADRs for key decisions
- **PRD status:** backlog

### Story 13.4: Bird adapter tutorial

Step-by-step guide for adding a new bird to the flock.

- **Acceptance:** tutorial walks through adding a bird
- **PRD status:** backlog

### Story 13.5: API documentation

OpenAPI/Swagger spec for all Simorgh API endpoints; interactive docs.

- **Acceptance:** OpenAPI spec; interactive docs
- **PRD status:** backlog
