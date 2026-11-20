---
type: "Research Prompt"
title: "Outbound research prompt — architecture epics and stories"
description: "The exact prompt that produced 01-architecture-epics.md. A record of what was asked, not a claim."
tags:
  - "simorgh"
  - "research"
generated:
  by: "process:simorgh-prd-research-2026-08"
  at: "2026-08-31T17:42:00+03:30"
status: "deprecated"
stale_after: "2027-02-01T00:00:00+03:30"
imported:
  by: "agent:codebuff"
  at: "2026-11-20T18:18:17+03:30"
  from: "~/personal/projects/projects/simorgh-prd-research"
---
<!-- Imported verbatim from ~/personal/projects/projects/simorgh-prd-research on 2026-11-20. -->

# Outbound research prompt — architecture epics and stories

You are researching the Simorgh platform — a free-to-run, no-KYC agentic AI gateway on Cloudflare Workers that federates fragmented free-tier AI providers into one resilient "flock." 

Read the shared context at ~/simorgh-prd-research/SHARED_CONTEXT.md for full platform details.

YOUR RESEARCH MISSION: Produce a detailed research digest on "Architecture Epics & Stories for a Resilient AI Provider Federation Gateway (2026 State)."

Research and cover:
1. Current 2026 best practices for multi-provider AI failover/federation architecture (circuit breakers, health checks, retry/routing strategies)
2. How to structure the "Auto-Wrapper" epic — LLM auto-generating MCP wrappers for any REST/OpenAPI service (research MCP 2026-07-28 protocol, OpenAPI-to-MCP patterns, existing tools)
3. The "BYOK / MCP core" epic — per-user keys + native MCP inter-agent communication patterns
4. Data Trust / Data Pact architecture patterns — opt-in PII-scrubbed data sharing, transparency ledgers, consent management
5. Intent Shield patterns — tool allow-listing, policy-as-code, prompt injection defense at the edge
6. Swarm-State / Durable Object patterns for serverless state sharing across requests

For each, propose: Epic name, objective, 3-5 stories with acceptance criteria, and technical risks.

Write your full research digest to ~/simorgh-prd-research/digests/01-architecture-epics.md
