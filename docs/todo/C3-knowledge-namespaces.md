---
type: "Implementation Task"
title: "C3 — Principal and agent knowledge namespaces"
description: "Enforce knowledge isolation in Simorgh and map storage namespaces behind the adapter."
tags:
  - simorgh
  - todo
  - knowledge
  - authorization
  - multi-tenant
  - epic-c
generated:
  by: "agent:gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P1"
depends_on:
  - C2
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# C3 — Principal and agent knowledge namespaces

## TL;DR

A retrieval provider's namespace is storage isolation, not Simorgh authorization. Simorgh decides who
can query each principal and agent namespace.

## Work

- Define principal-personal and per-agent namespaces as data derived from the authenticated principal.
- Prevent clients from choosing arbitrary namespace IDs or switching to another principal by changing
  request parameters.
- Map namespaces through RetrievalPort adapters; do not leak AI Search identifiers into the core.
- Ensure namespace identity follows tasks, executions, and provenance.
- Include explicit delete and revocation semantics.

## Acceptance

- Principal A can read and search only its own personal and assigned agent knowledge.
- Principal B cannot read, search, delete or infer the existence of A's documents.
- Hosted and local adapters pass the same cross-principal tests.
