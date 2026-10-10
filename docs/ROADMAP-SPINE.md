---
type: "Project Roadmap"
title: "Simorgh Roadmap — The Vertical Spine"
description: "Canonical architecture, phase order, dependencies and frozen non-goals for Simorgh."
tags:
  - simorgh
  - planning
  - roadmap
  - okf
generated:
  by: "agent:gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "stable"
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: security-audit
    resource: "SECURITY-AUDIT.md"
    title: "Security audit"
  - id: reference-architecture
    resource: "REFERENCE-ARCHITECTURE.md"
    title: "Reference architecture"
  - id: continuation-review
    resource: "research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# Simorgh Roadmap — The Vertical Spine

> **North star:** one executable spine, no new frameworks:
> `Principal → Goal → Task DAG → Capability → Quota/Cost Plan → Provider+Account+Model →
> Execution → Tools/MCP/Retrieval → Result → Verification → Persist → Memory/Knowledge → Next Task`
>
> This document is the **canonical planning baseline** for BMAD (`bmad-sprint-planning`,
> `bmad-create-epics-and-stories`, `bmad-build`). It supersedes the epic list in
> `_bmad-output/implementation-artifacts/sprint-status.yaml` as a *statement of current truth*;
> old epics are reclassified below, not deleted.

## 0. Truth baseline (repository-reported at commit 9687eb3; not rerun in this docs pass)

| Check | Result |
|---|---|
| `upm install --frozen-lockfile` | ✅ 93 pkgs, exit 0 |
| `upm run typecheck` (tsgo ×3 projects) | ✅ exit 0 |
| `upm run test:workers` (workerd/vitest) | 🟡 repository-reported: 14 files / **138 tests passed** |
| `upm run test:node` (Node 22/vitest) | ✅ 27 files / **500 tests passed** |
| Go workspace (`bot gateway packages/* tools`) | 🟡 repository-reported: 6 modules build/test clean; 3 have no tests |
| `.gitignore` now excludes `package-lock.json`; stray lock removed | ✅ ADR-0004 enforced |
| `package.json` `test` script now uses `upm run …` (was `npm run …`) | ✅ self-referential npm remnant fixed |
| BMAD Method installed (`_bmad/`, `.claude/skills/`, `.agents/skills/`, 29 bmad-* skills) | ✅ |

### Phase ledger

```text
PHASE 0  Foundation            DONE   (phoenix-core runtime-agnostic engine)
PHASE 1  Routing               DONE   (complexity.ts, pickRoute, session-aware)
PHASE 2  Capability            DONE   (capabilities.ts + probes + /capabilities)
PHASE 3  Task model            DONE   (tasks.ts DAG validation + persistence)
PHASE 4  Durable execution     ACTIVE (scheduled.ts DO state machine; NOT yet quota-gated)
PHASE 5  Retrieval             NEXT   (biggest product hole — nothing real exists)
PHASE 6  Memory                NEXT   (ContextStore ≠ memory; layered model needed)
PHASE 7  Autonomous loop       NEXT   (swarm plans but does not drive execution)
PHASE 8  Connectors            LATER  (Notion/Drive/Telegram/GitHub sync)
PHASE 9  UI                    LATER  (PWA only after tasks/goals/knowledge APIs exist)
```

## TL;DR

A3 is the gate. Then make the existing task model actually execute through quota admission and
correct usage accounting. Only after one durable end-to-end task works should retrieval, layered
memory, the research swarm, current-revision MCP and provider discovery expand. The executable queue
is [`todo/index.md`](todo/index.md).

## 1. Explicit non-goals (freeze list)

```text
❌ Rust/Wasm core          (bench: scheduler 0.7µs, request 66–109µs — no hotspot justifies it)
❌ Mem0 / Graphiti / Neo4j giant-memory deps
❌ 20-more-provider chase   (expansion = data through discovery/probe/eligibility, not code)
❌ Second task DB / second scheduler / Task-class circus
❌ Cloudflare-only substrate (self-host stays first-class; Workflows = adapter candidate later)
❌ Pooled free-provider credentials & autonomous account creation (BYOK-first)
❌ Vercel migration, full Agents SDK adoption, giant policy engine, giant PWA
🟡 Go companion: frozen at conformance level (build/test green); no semantic drift added
```

Keep the native-compute **benchmark machinery** as engineering culture:
new CPU-heavy feature → benchmark → profile → only then consider native code.

## 2. Epics (BMAD-ready)

### EPIC-A · Stabilize (Phase 0–1 weeks)

- **A1 Truth reconciliation** *(partially done)* — this file + phase ledger; refresh
  sprint board mapping (below); mark stale epic claims historical in docs/prd.
- **A2 Toolchain canonicalization** *(mostly done)* — Node 22 pinned (.nvmrc), upm everywhere,
  package.json test script fixed. **Open slices:** replace remaining doc `npx vitest/wrangler`
  invocations with `upx`/`upm run` where they are project workflow (audit trail: DEPLOY.md §evidence
  lines may keep `npx` as *historical evidence*, not instruction); evaluate stable TypeScript 7
  (`tsc`) vs `@typescript/native-preview` (`tsgo`) in an isolated branch — do NOT mix with features;
  verify `@cloudflare/vitest-pool-workers` ↔ Vitest 4/5 compatibility before bumping.
- **A3 AUTH-004 principal identity** 🔴 — credential → authenticated principal → `principalId`
  is the ONLY source of userId/quota/task/schedule/memory/retrieval/connector/credential/ledger
  ownership. Client-chosen `X-Simorgh-User-Id` must never be believed by `/api/v1/agent/execute`
  (see docs/SECURITY-AUDIT.md:49–54, src/index.ts:368, phoenix-core/src/security.ts:293).
  Required negative tests: A cannot execute/schedule/read/consume/search/invoke as B (7 cases).
  **Gate: multi-user autonomous execution is forbidden until A3 ships.**

### EPIC-B · Make the existing architecture execute (the spine)

- **B1 Unify Task/Schedule/Execution** — `Task` = what, `Execution` = one attempt,
  `Schedule` = eligibility. One canonical model over tasks.ts + scheduled.ts. No new stores.
- **B2 Wire `planTaskRun()` into production** — invariant:
  **nothing spends provider quota until the capacity planner says it can.**
  claim → load quota states → planTaskRun → {run | delay(wake) | unavailable}.
  Today: claim → fly, and the quota brain only does algebra in tests.
- **B3 Close the usage loop** — provider result → actual tokens/requests → `recordUsage()` →
  health observation → ledger. Reset-aware scheduling becomes real here.
- **B4 First end-to-end durable task** — one workload proven through
  Task → quota → DO alarm → execution → verification → persisted outcome → next-task wake.

### EPIC-C · Knowledge (Retrieval, then Memory)

- **C1 `RetrievalPort` in phoenix-core** (ports.ts pattern) — hosts adapt, core never imports
  `env.AI_SEARCH`. Adapters: Cloudflare AI Search (hybrid/BM25+vector, built-in storage,
  namespace isolation), local/self-hosted fallback, future Vectorize/external DB.
  Budget note: AI Search Free ≈ 1k semantic + 1k full-text queries/mo; billing starts 2026-11-01.
- **C2 Tiny first slice** — `POST /knowledge`, `GET /knowledge/:id`, `POST /knowledge/search`;
  results carry `{documentId, chunkId, source, title, text, score, timestamp, metadata,
  knowledgeNamespace}` — retrieval provenance, same rigor as routing provenance.
- **C3 Tenant/agent namespaces** — Simorgh owns authorization ("who may access which namespace");
  AI Search is only substrate. Principal personal NS + per-agent NS.
- **C4 Layered memory** — working → task/execution state → episodic → knowledge artifacts →
  semantic retrieval → procedural. OKF artifact envelope:
  `{id,type,principal,agent,created,updated,source,status,freshness,confidence,provenance}`.

### EPIC-D · Swarm gets one real job

- **D1 Multi-source research digest** — Goal → discover sources → fetch×N ∥ retrieve prior
  knowledge → compare → synthesize → verify → write back to knowledge. Proves graph→swarm
  decomposition→quota planner→parallel allocation→aggregation→verification→memory→reschedule.
- **D2 Verification stage as a first-class task type** (not vibes).

### EPIC-E · External intelligence

- **E1 MCP modernization** — compat layer for the 2026-07-28 revision; **no Sampling** (deprecated).
  Expose task-shaped tools once B1 lands: `simorgh.task.create/status/cancel/wait`,
  `simorgh.goal.create`, `simorgh.knowledge.search`, `simorgh.agent.execute`.
- **E2 Provider discovery pipeline** — discovery → probe → cost → quota → capabilities →
  freshness → eligibility → routing. "5 options per capability" = discovered, not hard-coded.
- **E3 Validation birds only** — Gemini + OpenRouter `:free` (strongest current evidence), each
  declaration carrying cost/quota/reset/capabilities/privacy/training/region/eligibility/freshness/
  source/confidence.

### EPIC-F · Scale (only after B–D prove out)

- F1 DO sharding phases: global coordinator → principal coordinator → justified task shards.
- F2 Connectors sync (Notion/Drive/Telegram/GitHub). F3 PWA around real APIs.
- F4 Workflows-vs-DO benchmark → durable-execution interface with DO/alarm, Workflows, and
  Node/local implementations; default chosen by measurement, not faith.
- F5 Public multi-user deployment (post-A3 gate).

## 3. Old-epic disposition map (for sprint-status regeneration)

| Old epic | Disposition |
|---|---|
| 1–5 (agent loop, flock, dashboard, tools, state) | **done/historical** — keep as record |
| 6 policy engine | ⚠️ descoped to A3 + per-op ownership checks (no giant engine) |
| 7 consent/PII/ledger | 🕗 deferred; ledger hooks already exist (B3 completes its loop) |
| 8–9 MCP/vault | → E1 (+ BYOK credential vault inside A3/E3 scope) |
| 10 extra birds | → E3 (Gemini/OpenRouter only, evidence-gated) |
| 11 observability | partially live (structlog/health/metrics); rest folded into B3 |
| 12 rate-limit/auth | → **A3** (AUTH-004 is the survivor of this epic) |
| 13 docs | ongoing; A1 refreshes STATE-OF-PROJECT/ARCHITECTURE against this file |

## 4. Working agreement

1. This roadmap owns architecture, phase order, dependencies and the freeze list.
2. [`docs/todo/index.md`](todo/index.md) owns the live queue. Each task is a separate OKF v0.2
   concept under `docs/todo/`, with evidence, explicit dependencies and acceptance checks.
3. BMAD remains an optional helper. Its generated artifacts may support execution but must not
   override the roadmap or TODO documents. Do not regenerate a plan from the historical 2026-08 PRD.
4. Every implementation task ends with `upm install --frozen-lockfile && upm run typecheck && upm test`
   green (+ per-module Go build/vet/test when Go is touched).
5. Verify claims against real code/hosts where possible. Record what could not be run; repository-
   reported test counts are not a claim that this documentation pass reran the suites.
6. No new framework, second scheduler, second task database, provider-count chase, pooled free
   credentials, automatic account creation, Rust/Wasm core, or giant PWA without a new evidence-based
   decision.