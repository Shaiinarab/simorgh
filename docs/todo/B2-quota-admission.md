---
type: "Implementation Task"
title: "B2 — Quota-aware admission and reservations"
description: "Make every production provider call pass through the existing free-only capacity planner."
tags:
  - simorgh
  - todo
  - quota
  - free-only
  - epic-b
generated:
  by: "agent:gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P0"
depends_on:
  - A3
  - B1
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
  - id: free-only-adr
    resource: "adr/ADR-0005-free-only-mode.md"
    title: "FREE_ONLY and unknown-cost rules"
---
# B2 — Quota-aware admission and reservations

## TL;DR

Connect the existing planner to production. No provider call should start until admission says run.
A delayed task must make zero provider calls. Optimize legitimate documented free capacity; do not
circumvent provider terms, hard limits or account enforcement.

## Work

- Before immediate, scheduled, and each admitted swarm execution: load current quota states and call
  the existing task/quota planner.
- Introduce a reservation/hold so concurrent tasks cannot each spend the same remaining allowance.
  Release or reconcile it on usage, failure or expiry.
- If the plan says delay, persist the wake time and return without dialing any provider.
- If the plan says unavailable, record a truthful reason; never mark it as successful.
- Ensure the provider actually dialed is the candidate admitted by the planner. Every failover must
  re-enter the same admission logic rather than silently changing to an unreserved candidate.
- Treat provider reset times and headers as observed facts; use bounded backoff and provider-native
  limits.

## Acceptance

- Every execution path is covered: immediate on Workers, immediate on Node, scheduled alarm, swarm
  leaves, and each fallback destination.
- Two competing tasks cannot reserve the same capacity.
- A delayed task makes no upstream request.
- FREE_ONLY rejects paid and unknown-cost candidates; unknown does not silently mean free.
- No pooled free credentials, account farming, identity spoofing or rate-limit/bans evasion. Multiple
  accounts are only separate, explicit resources when the provider permits that use.
