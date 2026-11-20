---
type: "Research Digest"
title: "Architecture epics and stories for a provider federation gateway (August 2026)"
description: "Digest returning 2026 failover patterns plus six candidate epics — Auto-Wrapper, BYOK/MCP core, Data Trust, Intent Shield, Swarm-State — with stories, acceptance criteria and risks. Superseded as a queue by docs/todo/."
tags:
  - "simorgh"
  - "research"
generated:
  by: "process:simorgh-prd-research-2026-08"
  at: "2026-08-31T17:56:00+03:30"
status: "deprecated"
stale_after: "2027-02-01T00:00:00+03:30"
imported:
  by: "agent:codebuff"
  at: "2026-11-20T18:18:17+03:30"
  from: "~/personal/projects/projects/simorgh-prd-research"
---
<!-- Imported verbatim from ~/personal/projects/projects/simorgh-prd-research on 2026-11-20. -->

# Architecture Epics & Stories for a Resilient AI Provider Federation Gateway (2026 State)

**Platform:** Simorgh — free-to-run, no-KYC, agentic AI gateway on Cloudflare Workers that federates fragmented free-tier providers into one resilient "flock."

**Research Sources:** Shared context at ~/simorgh-prd-research/SHARED_CONTEXT.md, current codebase, and targeted research on 2026 best practices.

## 1. Current 2026 Best Practices for Multi-Provider AI Failover/Federation Architecture

**Key Patterns (2026):**
- **Circuit Breakers:** Hystrix-style or Resilience4j equivalents — open on consecutive failures, half-open for probes, fallback to alternate providers.
- **Health Checks:** Periodic /health or /status endpoints (HTTP, WebSocket, or gRPC) with configurable intervals (e.g., 30s–5m) and failure thresholds.
- **Retry/Routing Strategies:** Exponential backoff + jitter, circuit-breaker-aware routing, load-based or priority-based failover (e.g., primary + secondary + tertiary with health scores).
- **Resilient Patterns:** Bulkhead isolation per provider, timeout budgets, graceful degradation, observability (Prometheus metrics, distributed tracing).
- **Serverless-Native:** Leverage Cloudflare Workers/DO for stateless failover with KV for shared state (Swarm-State).

**Sources:** Industry reports on edge AI gateways (LiteLLM, OpenRouter, Portkey patterns), Cloudflare Workers AI Gateway docs (2026), and agentic framework literature.

## 2. "Auto-Wrapper" Epic — LLM Auto-Generating MCP Wrappers for REST/OpenAPI Services

**Epic Name:** Auto-Wrapper Epic

**Objective:** Enable the Simorgh platform to automatically generate production-ready MCP (Model Context Protocol) wrappers for any REST or OpenAPI service, allowing seamless integration into the Flock without manual SDK work.

**3-5 Stories:**
- **Story 1: OpenAPI-to-MCP Code Generator**  
  Acceptance Criteria: LLM (e.g., Groq/llama-3.3-70b) takes OpenAPI/Swagger spec; outputs complete Hono Worker + MCP adapter; tests against sample endpoints; generates TypeScript types.
- **Story 2: MCP Protocol Research & Integration**  
  Acceptance Criteria: Research and implement MCP 2026-07-28 spec (native inter-agent communication); create wrapper that exposes MCP methods for any generated service; supports bidirectional tool calling.
- **Story 3: LLM Wrapper Validation & Fallback**  
  Acceptance Criteria: Generated wrappers pass integration tests; auto-fallback to original REST if MCP fails; metrics logged for wrapper success rate.
- **Story 4: Registry & Discovery**  
  Acceptance Criteria: Wrappers registered in FlockCoordinator; live discovery via `/flock/status`; versioned, with auto-regeneration on spec changes.
- **Story 5: Edge Case & Security Hardening**  
  Acceptance Criteria: Handles auth (BYOK), rate-limiting, error mapping; security review for prompt injection in generation.

**Technical Risks:** 
- LLM hallucination in code generation (mitigate with test suites).
- Performance overhead of auto-generated wrappers.
- Compatibility with evolving MCP spec.

## 3. "BYOK / MCP Core" Epic — Per-User Keys + Native MCP Inter-Agent Communication

**Epic Name:** BYOK / MCP Core Epic

**Objective:** Provide per-user Bring-Your-Own-Key (BYOK) management and native MCP support for secure, efficient inter-agent communication within the Simorgh flock and external MCP clients.

**3-5 Stories:**
- **Story 1: Secure Key Vault & Rotation**  
  Acceptance Criteria: Encrypted storage in DataTrustVault/DO; per-user API keys with rotation, revocation, audit logs; zero-knowledge handling.
- **Story 2: MCP Adapter Layer**  
  Acceptance Criteria: Native MCP server in Worker; supports tool calling, streaming, context passing; interop with existing agent loops.
- **Story 3: Swarm-State Integration**  
  Acceptance Criteria: MCP-aware Swarm-State tracks per-user bird health; cross-request state sharing via Durable Object.
- **Story 4: Client-Side MCP Support**  
  Acceptance Criteria: CLI and dashboard expose MCP endpoints; support for external MCP agents calling Simorgh flock.
- **Story 5: Compliance & Data Pact Integration**  
  Acceptance Criteria: Keys tied to consent tiers; PII-scrubbed sharing for Data-Pact users.

**Technical Risks:** 
- Key management complexity in serverless environment.
- Performance/scalability of MCP connections.
- Security surface of exposing MCP endpoints.

## 4. Data Trust / Data Pact Architecture Patterns

**Epic Name:** Data Trust / Data Pact Epic

**Objective:** Implement opt-in, PII-scrubbed data sharing, transparency ledgers, and consent management so users can "pay" with research/data instead of cash while maintaining sovereignty.

**3-5 Stories:**
- **Story 1: Consent & Tiers Engine**  
  Acceptance Criteria: Free-Volunteer / Pro-Paid / Pro-Data-Pact tiers; granular consent per data type; revocation workflow.
- **Story 2: PII Scrubbing & Anonymization**  
  Acceptance Criteria: Automatic scrubbing pipeline (regex, LLM-assisted) before sharing; verifiable audit logs.
- **Story 3: Transparency Ledger**  
  Acceptance Criteria: Immutable ledger (KV/DO) of all data-sharing events; user dashboard view; exportable reports.
- **Story 4: Integration with Flock & Swarm-State**  
  Acceptance Criteria: Shared data flows respect consent; Swarm-State uses aggregated (scrubbed) insights.
- **Story 5: Edge Cases & Enforcement**  
  Acceptance Criteria: Rejects unauthorized sharing; fallback to non-shared mode; compliance reporting.

**Technical Risks:** 
- Edge cases in scrubbing complex PII.
- Performance of ledger queries in high-throughput.
- Regulatory alignment (GDPR/CCPA in 2026).

## 5. Intent Shield Patterns

**Epic Name:** Intent Shield Epic

**Objective:** Implement edge-based tool allow-listing, policy-as-code, and prompt injection defense to ensure safe execution of agent tools while preserving sovereignty.

**3-5 Stories:**
- **Story 1: Tool Allow-List & Policy Engine**  
  Acceptance Criteria: Declarative policies (JSON/YAML); runtime vetting of every tool call; user-defined allow-lists.
- **Story 2: Prompt Injection Defense**  
  Acceptance Criteria: Edge sanitization, input validation, model-side guards; logging of blocked attempts.
- **Story 3: Policy-as-Code Integration**  
  Acceptance Criteria: Policies versioned, A/B tested, tied to user tiers and Data-Pact consent.
- **Story 4: Swarm-State Policy Sharing**  
  Acceptance Criteria: Shared policy state across flock birds; dynamic updates without downtime.
- **Story 5: Observability & Audit**  
  Acceptance Criteria: Full logs for shield decisions; dashboard view; regression testing.

**Technical Risks:** 
- False positives in allow-listing.
- Latency impact on edge.
- Maintaining policy consistency across serverless instances.

## 6. Swarm-State / Durable Object Patterns

**Epic Name:** Swarm-State / Durable Object Epic

**Objective:** Implement durable, serverless state sharing across requests for Swarm-State (hive memory of bird health/tiredness), enabling resilient failover and consistent flock behavior.

**3-5 Stories:**
- **Story 1: FlockCoordinator Durable Object**  
  Acceptance Criteria: Single source of truth for bird status; CRUD via KV fallback; atomic updates.
- **Story 2: Health Check & Failover Logic**  
  Acceptance Criteria: Real-time status sync; automatic rerouting on bird failure; graceful degradation.
- **Story 3: Request-to-Request State Passing**  
  Acceptance Criteria: State propagated via context offload or headers; no data loss on cold starts.
- **Story 4: Observability & Scaling**  
  Acceptance Criteria: Metrics exported; horizontal scaling support; backpressure handling.
- **Story 5: Integration with Other Epics**  
  Acceptance Criteria: Used by Auto-Wrapper, BYOK, Intent Shield, and Data Trust for consistent behavior.

**Technical Risks:** 
- DO cost/scale limits in 2026.
- Consistency vs. eventual consistency trade-offs.
- Debugging distributed state.

## Additional PRD Gaps & Recommendations
- Expand milestones with explicit acceptance criteria tied to these epics.
- Add non-functional requirements (latency SLAs, cost tracking, compliance matrix).
- Include competitor comparison (LiteLLM, OpenRouter, Portkey) and gap analysis.
- Add security/compliance annexure and rollout plan.

**Next Steps:** Use these epics to create formal BMAD stories or PRD sections. Run `bmad-sprint-planning` or `bmad-create-epics-and-stories` on this digest for further refinement.

**Status:** Research complete. Digest written and ready for review/implementation.