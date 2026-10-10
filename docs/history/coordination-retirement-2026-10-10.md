---
type: "Migration Record"
title: "Coordination Framework Retirement — October 10, 2026"
description: "Records where the completed coordination framework's durable results now live."
tags:
  - simorgh
  - history
  - migration
  - okf
generated:
  by: "agent:gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "stable"
stale_after: "2027-10-10T00:00:00Z"
sources:
  - id: todo-index
    resource: "todo/index.md"
    title: "Current TODO queue"
  - id: roadmap-spine
    resource: "ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review"
---
# Coordination Framework Retirement — October 10, 2026

## TL;DR

The 17 historical task briefs are closed. Remove the coordination runtime and keep the outcomes in
their maintained homes: architecture docs, tests, ADRs and research reports. The active queue is now
[docs/todo/index.md](../todo/index.md); this file is an archival pointer map, not a second backlog.

## Outcome map

| Historical task | Durable result / current home |
|---|---|
| 001 — crypto regression | Crypto implementation and tests under `packages/crypto/` |
| 002 — module boundary | `docs/ARCHITECTURE.md`, `AGENTS.md`, `phoenix-core/test/boundary.test.ts` |
| 003 — doctor | `simorgh-platform/src/doctor.ts` and its tests |
| 004 — connector conformance | `simorgh-platform/src/connectors/conformance.ts` and tests |
| 005 — deploy preflight | `simorgh-platform/src/deploy/preflight.ts` and tests |
| 006 — platform MCP | `simorgh-platform/src/mcp/server.ts` and tests |
| 007 — Go gateway server tests | `gateway/internal/server/` tests and CI |
| 008 — quality audit | `docs/QUALITY.md` and regression tests |
| 009 — trust-boundary audit | `docs/SECURITY-AUDIT.md` and the security tests |
| 010 — Bun portability | `docs/adr/ADR-0002-sqlport-async-before-networked-host.md`; Bun remains removed |
| 011 — free-only mode | `docs/adr/ADR-0005-free-only-mode.md` |
| 012 — native compute | `docs/research/NATIVE-COMPUTE-AUDIT.md` and `bench/native-audit/` |
| 013 — routing convergence | `docs/research/ROUTING-CONVERGENCE.md`, `docs/research/GO-QUOTA-FINDINGS.md`, ADR-0001 |
| 014 — dashboard | Deferred to Phase F3; do not rebuild before task/knowledge APIs exist |
| 015 — scale research | `docs/research/WHERE-WE-ARE-AND-WHERE-WE-GO.md` and the October research dossiers |
| 016 — complexity-aware routing | `docs/adr/ADR-0006-auto-router-compatibility.md` and tests |
| 017 — capability endpoint | `phoenix-core/src/capabilities.ts`, `capability-probes.ts`, `/api/v1/capabilities`, tests |

## New working agreement

- A task is a Markdown concept with OKF metadata, explicit dependencies, acceptance and source links.
- The roadmap owns sequence; the TODO index owns the queue.
- Completion is based on changed artifacts and verified acceptance, not a runner's exit code alone.
- Do not recreate the retired brief/report/end-marker protocol.
