---
type: "Implementation Task"
title: "C4 — Layered, inspectable memory"
description: "Add principal-owned editable memory blocks and searchable archival memory with provenance."
tags:
  - simorgh
  - todo
  - memory
  - knowledge
  - epic-c
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P1"
depends_on:
  - C3
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# C4 — Layered, inspectable memory

## TL;DR

Memory is not session state, context offload or the transparency ledger. Start with a small editable
in-context layer and a searchable archival layer. Make every memory inspectable and deletable.

## Work

- Add memory behind a port and reuse the existing persistence layer.
- Separate small editable memory blocks from archival memory retrieved on demand.
- Expose explicit insert, replace, rethink, search, read and delete operations as agent tools.
- Store provenance on each write: principal, agent, timestamp, originating task/source and version.
- Make deletion authoritative so deleted content cannot re-enter the next context through retrieval.

## Acceptance

- An agent can insert and search its own memory; the operator can read and delete it.
- A cannot read, write, search or delete B's memory.
- Deleting a memory block removes it from all future context for the owner.
- Session history, task state, archival knowledge and memory blocks remain distinct concepts.
