---
type: "Implementation Task"
title: "C1 — RetrievalPort with a real local fallback"
description: "Add portable retrieval behind a core port and an honest local lexical-search implementation."
tags:
  - simorgh
  - todo
  - retrieval
  - knowledge
  - epic-c
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P1"
depends_on:
  - B4
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# C1 — RetrievalPort with a real local fallback

## TL;DR

Retrieval is the largest product gap. Add one runtime-agnostic port and two adapters: a real local
lexical implementation and a conditional Cloudflare AI Search adapter. Do not make the core Cloudflare-only.

## Work

- Declare RetrievalPort in phoenix-core's existing ports module. The core must not import a Cloudflare
  binding or vendor-specific client.
- Inspect the installed SQLite/runtime capabilities and prove whether FTS5 is available before
  selecting it. Local search must be a working implementation, not a stub or a placeholder LIKE query.
- Implement Cloudflare AI Search as one host adapter only after checking no-card eligibility, regional
  availability and what happens beyond included usage.
- Preserve the option for Vectorize or another external store later through the same port; do not build
  every adapter now.
- Budget AI Search's stated free envelope and the reported 2026-11-01 billing change; recheck official
  pricing immediately before deployment.

## Acceptance

- The same port contract works on Workers and Node with no runtime imports in phoenix-core.
- Local search returns real ranked text and source metadata.
- Hosted search's eligibility/region/over-quota behavior is documented from first-party evidence.
- Missing hosted retrieval degrades to local search or a truthful unavailable result.
