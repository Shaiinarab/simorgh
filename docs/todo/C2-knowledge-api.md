---
type: "Implementation Task"
title: "C2 — Knowledge ingestion, search and deletion"
description: "Expose a small identity-gated knowledge API with chunk-level source provenance."
tags:
  - simorgh
  - todo
  - knowledge
  - retrieval
  - api
  - epic-c
generated:
  by: "agent:gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P1"
depends_on:
  - A3
  - C1
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# C2 — Knowledge ingestion, search and deletion

## TL;DR

Ship the smallest useful knowledge surface before connectors or a large UI: ingest, get, search, and
delete a document with source/chunk provenance.

## Work

- Add POST /knowledge, GET /knowledge/:id and POST /knowledge/search, plus a delete operation needed
  to guarantee deletion semantics.
- Gate every route through the authenticated principal from A3.
- Return documentId, chunkId, source, title, text, score, timestamp, metadata and knowledgeNamespace.
- Preserve ingestion source and content metadata, document state, and errors honestly.

## Acceptance

- Search results carry the full provenance envelope.
- An owner can retrieve and delete their document; deleted material stops appearing in future search.
- A principal cannot fetch, search or delete another principal's knowledge.
- Local and hosted adapters satisfy the same contract, even if local search is lexical rather than
  semantically equivalent.
