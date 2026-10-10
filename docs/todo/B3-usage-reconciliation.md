---
type: "Implementation Task"
title: "B3 — Actual usage reconciliation"
description: "Record real provider consumption and latency into the quota planner after each flight."
tags:
  - simorgh
  - todo
  - quota
  - observability
  - epic-b
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P0"
depends_on:
  - B2
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
  - id: quota-adr
    resource: "../adr/ADR-0003-free-compute-capacity.md"
    title: "Free compute capacity"
---
# B3 — Actual usage reconciliation

## TL;DR

The scheduler cannot plan accurately if it never learns what each call consumed. Record observed usage
at the real provider boundary, preserving unknowns instead of fabricating zeros.

## Work

- After each provider response, reconcile request count, token usage and latency into the existing
  quota state. Do not create a second usage ledger.
- Keep the transparency ledger separate: it answers what happened; quota accounting answers how much
  documented allowance was consumed.
- If usage is missing, store unknown or an explicitly labelled estimate. Never convert missing data to
  zero.
- Add a reproducer for the suspected reset-timestamp defect in recordUsage before changing the code.
  Confirm whether any other operation advances the timestamp; fix only after the reproducer proves it.

## Acceptance

- A real or faithfully instrumented flight changes the relevant quota counters and latency.
- Reset timestamps advance, and consecutive calls after reset accumulate instead of repeatedly
  resetting.
- Tests cover missing token usage, failed calls, reset boundaries and idempotent reconciliation.
- The provider's reported usage is distinguished from estimates in status and logs.
