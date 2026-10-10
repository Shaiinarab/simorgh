---
type: "Implementation Task"
title: "B4 — Truthful durable outcomes and recovery"
description: "Prove one end-to-end durable task and make retry state safe under crashes and stale claims."
tags:
  - simorgh
  - todo
  - durability
  - idempotency
  - epic-b
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P0"
depends_on:
  - B1
  - B2
  - B3
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# B4 — Truthful durable outcomes and recovery

## TL;DR

A task must say whether it completed, failed, is delayed or exhausted the flock. A retry must not let
an older claim overwrite a newer attempt, and uncertainty about external effects must be recorded.

## Work

- Use the existing attempt count as a fencing token when finalizing or failing a claimed task.
- Distinguish provider/flock exhaustion from goal success; exhausted must not be stored as done.
- Persist completed step results where needed so resume does not refetch and repeat finished work.
- Use business-operation idempotency keys, upserts or conditional writes where supported. If completion
  of an external effect is uncertain, record uncertainty rather than claiming exactly-once delivery.
- Make cancellation and retry/backoff states visible and recoverable.

## Acceptance

- One vertical test proves task → quota admission → durable schedule/alarm → execution → verification
  → persisted outcome → next-task wake.
- Crash/reclaim, duplicate wake, cancellation, quota exhaustion and retry preserve truthful outcomes.
- A stale attempt cannot finalize a replacement execution.
- Previously completed work is reused on resume; unsupported exactly-once claims are not made.
