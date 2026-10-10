---
okf_version: "0.2"
---
# Simorgh documentation

## TL;DR

Read in this order: [current TODOs](todo/index.md) → [roadmap spine](ROADMAP-SPINE.md) → [current state](STATE-OF-PROJECT.md) → [security audit](SECURITY-AUDIT.md) → [reference architecture](REFERENCE-ARCHITECTURE.md).

Planning documents use OKF v0.2: Markdown with YAML frontmatter, sources/provenance, generation time, lifecycle status, freshness deadline, and ordinary Markdown cross-links. Task progress is recorded in the task concept's `work_status`; OKF `status` remains the document lifecycle (draft/stable/deprecated). No custom database, index service, or required validator is introduced.

## Core

- [Roadmap spine](ROADMAP-SPINE.md) — architecture, phases, dependencies and frozen non-goals.
- [TODO index](todo/index.md) — ordered implementation queue and task links.
- [Project state](STATE-OF-PROJECT.md) — evidence-backed capabilities and known gaps.
- [Architecture](ARCHITECTURE.md) and [reference architecture](REFERENCE-ARCHITECTURE.md) — invariants and reusable mechanisms.
- [Security audit](SECURITY-AUDIT.md) — findings, severity and disposition.

## Decisions and research

- [Architecture decisions](adr/) — decisions that constrain implementation.
- [Research](research/) — ecosystem evidence, benchmarks and adoption studies.
- [Continuation review](research/CONTINUATION-REVIEW-2026-10-10.md) — why the next work is identity → quota-aware durable execution → knowledge → swarm.
- [Retirement record](history/coordination-retirement-2026-10-10.md) — where the former coordination framework's conclusions now live.

## Documentation rules

- Prefer the existing implementation and proven mechanisms; add a dependency only when a port cannot reuse what is already installed.
- Every claim about current behavior names code/tests or carries a source.
- Keep a short **TL;DR** near the beginning of substantial docs.
- Keep task docs small, independently reviewable and linked to prerequisites.
- Do not change runtime behavior in a documentation-only task.
