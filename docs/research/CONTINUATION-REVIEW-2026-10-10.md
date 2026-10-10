---
type: "Research Synthesis"
title: "Continuation Review — October 10, 2026"
description: "Distills the latest continuation report into the current implementation blockers, adoption decisions and execution order."
tags:
  - simorgh
  - continuation
  - roadmap
  - research
  - okf
generated:
  by: "agent:gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "stable"
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: security-audit
    resource: "SECURITY-AUDIT.md"
    title: "Security audit"
  - id: reference-architecture
    resource: "REFERENCE-ARCHITECTURE.md"
    title: "Open-source reference architecture"
---
# Continuation Review — October 10, 2026

## TL;DR

Simorgh's main gap is not missing frameworks. It is that the scheduler and quota planner are not
joined into the production execution path, actual usage is not written back, and authenticated identity
does not yet own every user-scoped action. Build one truthful vertical slice before expanding the
provider catalog or UI.

## Evidence boundary

This synthesis uses the user-provided continuation report pinned to repository commit 9687eb3 and the
existing code-referenced documents. Test counts and code findings below are **repository-reported at that
commit**; this documentation update did not rerun the test suites or perform a version-pinned audit of
the external tools.

## Findings that change the next action

1. **Identity is the gate.** The report identifies AUTH-004: execution still accepts a caller-selected
   user ID from the header/body. Derive principal identity from the credential and prove cross-principal
   denial on both Workers and Node before multi-user autonomous execution.
2. **Task and schedule exist, but are not one execution spine.** The scheduled path reaches the flock
   directly rather than rerunning the agent tool loop. Make the stored prompt the input to the agent
   loop, and persist a distinct execution attempt.
3. **Quota planning is disconnected.** The planner chain exists in the engine but production immediate,
   scheduled, and swarm paths do not all consult it. Add quota reservation/admission before every
   provider call, then reconcile actual request/token use and latency.
4. **Recovery must be honest.** A stale attempt must not finalize a newer attempt. A flock-exhausted
   result is not goal success. Retries must preserve completed work and avoid replaying effects unless
   the downstream operation supports idempotency.
5. **Retrieval and memory are absent.** Context offload and a transparency ledger are not RAG or memory.
   Add a RetrievalPort with a real local lexical fallback; treat Cloudflare AI Search as a conditional
   adapter until card eligibility, regional availability and over-quota behavior are checked.
6. **The first swarm job should prove the design.** Build one supplied-source research digest that fetches
   in parallel, compares evidence, verifies citations, persists an answer with provenance, and resumes
   after quota delay.
7. **Modernize interfaces after the vertical slice.** The declared MCP revision and session-oriented
   implementation disagree. Add the current stateless path while preserving any explicitly supported
   legacy path. Treat OpenAI-compatible client support as a separate, scoped spike.

## What to adopt from existing tools

| Need | Study / adapt | Do not import wholesale |
|---|---|---|
| Principal and budget ownership | LiteLLM's nested tenant/budget attribution | Its Python service and separate routing/database |
| Durable steps and idempotency | Inngest step results; attempt fencing | A second orchestration server inside the core |
| Capacity-aware concurrency | Trigger.dev's waiting releases slots | Another queue/runtime |
| Memory | Letta's small editable blocks + searchable archive | A new memory server and database |
| Graph checkpointing | LangGraph's explicit state and interrupt/resume semantics | The entire runtime; a checkpoint alone does not guarantee exactly-once external effects |
| Evaluation | promptfoo-style assertions and negative controls | Hosted eval infrastructure |
| Retrieval | namespace isolation, chunk citations, deletion invariants | A giant vector-stack dependency or Cloudflare-only core |

## Execution order

Follow [the roadmap](../ROADMAP-SPINE.md) and the [live TODO index](../todo/index.md):

**A3 → B1 → B2 → B3 → B4 → C1 → C2 → C3 → C4 → D1 → E1 → E2 → E3.**

Keep the non-goals: no Rust/Wasm core without a measured hotspot, no second scheduler or task database, no
pooled provider credentials, no automatic account creation, no provider-count chase, and no large PWA
before the real APIs exist.