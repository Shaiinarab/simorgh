---
type: "Implementation Task"
title: "B1 — One task, schedule and execution model"
description: "Make immediate and scheduled work use one canonical task/execution path."
tags:
  - simorgh
  - todo
  - execution
  - scheduler
  - epic-b
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P0"
depends_on:
  - A3
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# B1 — One task, schedule and execution model

## TL;DR

Unify the existing Task, scheduled-task row and execution attempt without creating a second database or
scheduler. A scheduled task must run the agent tool loop again; it must not replay only a raw flock call.

## Work

- Preserve the distinction: Task means what should happen; Execution means one attempt; Schedule means
  when it becomes eligible.
- Reuse the existing task and scheduled-task storage/state machine.
- Route scheduled execution through the same agent entry point used by immediate execution.
- Reauthorize requested tools at execution time. A persisted list of requested tools is not an allow-list.
- Capture the claim attempt/fencing value so a stale attempt cannot finalize a newer run.

## Acceptance

- A scheduled prompt that needs a tool actually executes that tool.
- The stored prompt is input to the agent loop, not pre-folded provider text.
- Immediate and scheduled executions use the same result/ledger shape.
- Crash/reclaim and duplicate alarm tests prove an old attempt cannot overwrite a newer attempt.
- No new task database or second scheduler appears.

## Depends on

[A3 — Principal identity](A3-principal-identity.md) must pass first.
