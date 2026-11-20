---
type: "Research Context"
title: "Simorgh Platform — shared research context (August 2026)"
description: "The brief that opened the August PRD research: vision, flock concepts, API surface, milestone status and the research goal. It describes the standalone `/home/shai/simorgh-platform` repository that this repository replaced."
tags:
  - "simorgh"
  - "research"
generated:
  by: "process:simorgh-prd-research-2026-08"
  at: "2026-08-31T17:41:00+03:30"
status: "deprecated"
stale_after: "2027-02-01T00:00:00+03:30"
imported:
  by: "agent:codebuff"
  at: "2026-11-20T18:18:17+03:30"
  from: "~/personal/projects/projects/simorgh-prd-research"
---
<!-- Imported verbatim from ~/personal/projects/projects/simorgh-prd-research on 2026-11-20. -->

# Simorgh Platform — Shared Research Context

## What Simorgh Is

**Simorgh** (سیمرغ) is a free-to-run, no-KYC, self-evolving **agentic AI gateway** on Cloudflare Workers that stitches the fragmented free tiers of the internet into one resilient, sovereign intelligence. Its founding metaphor is literal: **many small "birds" (free-tier providers) fly together as one Simorgh, and when one bird tires, the flock reroutes.**

- **Live:** `https://simorgh-edge-gateway.shahino3ozone1353.workers.dev`
- **GitHub:** `Shaiinarab/Simorgh-edge-gateway` (public, MIT, TypeScript, 57KB)
- **Stack:** Cloudflare Workers · Hono · TypeScript 7 (tsgo — `@typescript/native-preview`) · Durable Objects (SQLite) · KV
- **Cost to run:** $0 — every primitive used is on a genuinely free, no-credit-card tier.

## Vision

Modern agent stacks are expensive, gated behind KYC/credit cards, and fragile (one provider rate-limit kills the run). Simorgh's thesis: the free tiers already exist — they just don't cooperate. Simorgh is the **connective tissue** that makes them adopt each other and work together as one "supercomputer."

Positioning: *the world's first open-source, AI-native API Federation & Data Trust.*

## Signature Concepts

| Concept | Meaning |
|---|---|
| **The Flock** | 30 → 30k free/fragmented services, orchestrated as one intelligence. When a bird tires (rate-limit/error), the flock reroutes. |
| **Intent Shield** | Edge heuristic that vets every tool call against an allow-list/policy before execution. |
| **Data Trust / Tiers** | `Free-Volunteer`, `Pro-Paid`, `Pro-Data-Pact` — users may "pay with data" via opt-in, PII-scrubbed research sharing instead of cash. |
| **Swarm-State** | Hive memory (a Durable Object) so the flock remembers which birds are healthy/tired across requests and serverless hops. |
| **Auto-Wrapper** | (Roadmap) an LLM that auto-generates MCP wrappers for any REST/OpenAPI service. |

## Compliance Line (Safe-by-Default, Non-Negotiable)
✅ Caching · users' own keys · opt-in data sharing · honest rate-limit backoff · local fallback.
❌ Throwaway-account rotation · scraped keys · ban-evasion proxies. **The framework enforces this by design.**

## Architecture

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

## API Surface

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/v1/agent/execute` | Run the agent (tool loop + flock failover). |
| `GET`  | `/api/v1/flock/status` | Live Swarm-State: which birds are awake/tired/dormant. |
| `GET`  | `/api/v1/context/:refId` | Retrieve an offloaded request payload from KV. |
| `GET`  | `/api/v1/user/:userId/logs` | Data-Trust transparency: a user's ledger entries. |
| `GET`  | `/dashboard` | Self-contained Mission Control UI. |

## Milestones (BMAD × OKRs)

| Milestone | Objective | Status |
|-----------|-----------|--------|
| **MVP** | Edge agent: execute loop, Intent Shield, Context Offload (KV), Data Trust (DO) | ✅ shipped |
| **M1 — The Flock** | Make the metaphor real: multi-provider failover + Swarm-State | ✅ shipped |
| **M2 — Mission Control** | Make the flock *visible*: live dashboard + Flight Console | ✅ shipped |
| **M3 — The Real Agent** | Make the agent genuinely *useful*: real web search + clean answer synthesis | 🛠️ in progress |
| **M4 — Auto-Wrapper** | LLM auto-generates MCP wrappers for any REST/OpenAPI service | 🗓️ backlog |
| **BYOK / MCP core** | Per-user keys + native MCP so agents call each other efficiently | 🗓️ backlog |

## Soul (Design Philosophy)

Simorgh exists to give an operator **clarity before automation**. Its first loyalty is to the person who owns the data, provider accounts, and deployment risk—not to throughput, novelty, or a provider's preferred workflow.

> **Never turn a plan into an external effect without an explicit, scoped, expiring, reviewable human decision.**

## Agent Contract (Review-First)

| Intent | Current policy | Provider effect |
|---|---|---|
| Inspect profile or module manifest | Allowed | `none` |
| Plan a local module or source review | Allowed | `none` |
| Enable or disable a module through the CLI | Human-confirmed local metadata only | `none` |
| Accept credentials, complete OAuth, clone/import data | Refuse | `none` |
| Register gateway, send a message, deploy, upload, mutate DNS | Refuse | `none` |

## Research Goal

The user believes this platform is "PRD-ready" — the vision, architecture, milestones, and design philosophy are all documented. The research task is to **perfect and complete the epics and stories** so they can form a formal PRD. This means:

1. Research current best practices for AI gateway/federation architecture (2026 state)
2. Research competitor/similar open-source projects and their PRD structures
3. Research BMAD PRD epic/story format and how to structure them for this platform
4. Identify gaps in the current milestone descriptions
5. Produce formal epics with acceptance criteria and stories
