---
type: "Research Prompt"
title: "Outbound research prompt — Copilot (open-source landscape and PRD gaps)"
description: "The exact prompt sent for the August PRD research: competitor gateway survey, Cloudflare ecosystem patterns and the free-provider count. A record of what was asked, not a claim."
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

# Outbound research prompt — Copilot (open-source landscape and PRD gaps)

You are researching the Simorgh platform — a free-to-run, no-KYC agentic AI gateway on Cloudflare Workers. Read ~/simorgh-prd-research/SHARED_CONTEXT.md for full details.

YOUR RESEARCH MISSION: Produce a detailed research digest on "Open-Source AI Gateway Landscape & PRD Gap Analysis (2026)."

Research and cover:
1. Search GitHub and the web for similar open-source projects: AI gateways, multi-provider LLM routers, edge AI federation tools (e.g. LiteLLM, Portkey, OpenRouter, AI Gateway patterns). Compare their features to Simorgh's vision.
2. What do competitor PRDs and roadmaps look like? What epics/stories do they define?
3. What are the gaps in Simorgh's current milestone descriptions (MVP through M4 + BYOK)? What's missing that a production PRD would need?
4. Research the Cloudflare Workers ecosystem for AI gateway patterns — Durable Objects, KV, Workers AI, AI Gateway product. What's available in 2026?
5. Research the "30 birds" concept — how many genuinely free, no-KYC AI providers exist in 2026 that could join the flock? (Groq, HuggingFace, Cloudflare Workers AI, Mistral free tier, etc.)

For each gap found, propose what epic/story would fill it.

Write your full research digest to ~/simorgh-prd-research/digests/02-landscape-gaps.md
