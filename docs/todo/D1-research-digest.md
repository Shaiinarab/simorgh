---
type: "Implementation Task"
title: "D1 — One evaluated multi-source research digest"
description: "Use the existing task graph and swarm to deliver one bounded evidence-rich research workflow."
tags:
  - simorgh
  - todo
  - swarm
  - research
  - verification
  - epic-d
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P1"
depends_on:
  - B4
  - C2
  - C4
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
  - id: promptfoo
    resource: "https://www.promptfoo.dev/docs/configuration/guide/"
    title: "Prompt assertion evaluation pattern"
---
# D1 — One evaluated multi-source research digest

## TL;DR

Prove the whole architecture on one useful task: research a question from supplied URLs, reuse past
knowledge, compare sources, verify claims, persist evidence and resume after a quota delay.

## Work

- Begin with URLs supplied by the caller. Do not build a general web-discovery subsystem first.
- Decompose into bounded tasks: fetch sources in parallel, retrieve prior knowledge, compare, synthesize,
  verify and write back to knowledge.
- Use the existing swarm decomposition and quota admission. Do not build another orchestrator.
- Treat verification as its own task, not merely a prompt paragraph.
- Score evidence quality with deterministic acceptance checks and adversarial fixtures.

## Acceptance

- A digest resumes after interruption or quota delay without discarding completed work.
- Every factual claim is supported by a relevant fetched excerpt; contradictions are named; unsupported
  claims are labelled.
- A negative control attaches a genuine but irrelevant citation to a false claim and the verifier rejects
  it. Checking only that a URL was fetched is insufficient.
- Persisted results include sources, excerpts, timestamps, confidence/verification status and provenance.
