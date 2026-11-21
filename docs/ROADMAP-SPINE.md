---
type: "Project Roadmap"
title: "Simorgh Roadmap — The Vertical Spine"
description: "Canonical architecture, phase order, dependencies and frozen non-goals for Simorgh. Re-baselined 2026-11-21 against the final MCP 2026-07-28 spec, the native-module policy (ADR-0010), and the in-flight C2 knowledge API."
tags:
  - simorgh
  - planning
  - roadmap
  - okf
generated:
  by: "kilo/ernie-5.5-flash-preview"
  at: "2026-11-21T15:00:00Z"
status: "stable"
stale_after: "2027-05-21T00:00:00Z"
sources:
  - id: deep-recon
    resource: "research/NOVEMBER-2026-DEEP-RECON.md"
    title: "November 2026 deep recon — the five facts that moved"
  - id: native-audit
    resource: "research/NATIVE-COMPUTE-AUDIT.md"
    title: "The native-compute audit"
  - id: adr-0010
    resource: "adr/ADR-0010-native-module-policy.md"
    title: "Native-module policy (evidence-gated Rust)"
  - id: mcp-spec
    resource: "https://modelcontextprotocol.io/specification/2026-07-28/changelog"
    title: "MCP 2026-07-28 final changelog"
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

## 0. Truth baseline (2026-11-21)

| Check | Result |
|---|---|
| `upm run test:workers` | ✅ verified 2026-11-20: 18 files / **188 tests passed** |
| `upm run test:node` | ✅ verified 2026-11-20: 29 files / **539 tests passed** |
| Go workspace (`bot gateway packages/* tools`) | 🟡 repository-reported: 6 modules build/test clean; 3 have no tests |
| A3 (credential-derived principal) | ✅ shipped 2026-11-16 (`e100bc6`) — execution, scheduling, rate-limit keys, ledger rows, MCP `ask` all resolve the principal from the credential |
| C1 (RetrievalPort + FTS5 baseline) | ✅ shipped 2026-11-20 — 17 tests, both hosts ship FTS5 |
| C2 (knowledge API) | ✅ **shipped 2026-11-21** — four identity-gated routes, chunked FTS5 indexing with passage-level provenance, replace-on-reindex, principal-scoped namespaces; 18 + 4 + 5 new tests, both suites green |
| Native module (shield) | ✅ built + differentially verified + benchmarked 2026-11-21 (`native/`, ADR-0010) — measured **1.5–1.7× slower than V8**, default OFF |
| `upm install --frozen-lockfile && upm run typecheck && upm test` | the acceptance gate for every task below |

### Phase ledger

```text
PHASE 0  Foundation            DONE   (phoenix-core runtime-agnostic engine)
PHASE 1  Routing               DONE   (complexity.ts, pickRoute, session-aware)
PHASE 2  Capability            DONE   (capabilities.ts + probes + /capabilities)
PHASE 3  Task model            DONE   (tasks.ts DAG validation + persistence)
PHASE 4  Durable execution     ACTIVE (B1 next: scheduled.ts DO state machine; quota NOT yet gating)
PHASE 5  Retrieval             PARTIAL (C1 + C2 done; C3/C4 next)
PHASE 6  Memory                NEXT   (C4: editable blocks + archival + provenance; no giant deps)
PHASE 7  Autonomous loop       NEXT   (D1: one evaluated research digest)
PHASE 8  Connectors            LATER  (Notion/Drive/Telegram/GitHub sync)
PHASE 9  UI                    NEXT   (G3: MCP Apps — the dashboard as a ui:// resource)
PHASE 10 Runtime convergence   NEXT   (G2: Go gateway on the core contract; G1: native shield optional)
PHASE 11 Onboarding            PLANNED (G4: secure setup and identity handoff)
PHASE 12 Global provider mesh  PLANNED (E2/E3: evidence-backed discovery, per-account probes, lifecycle)
```

## TL;DR

A3 is done. C2 shipped 2026-11-21 (knowledge routes, chunked FTS5, principal-scoped namespaces) —
**B1 is next**. Then B1–B4 (the execution spine is the critical path and nothing external changes
it), E1 against the now-final MCP 2026-07-28 spec, and the two new 2026 levers: **G2 Go-gateway
convergence** (the stranded Go runtime becomes a fleet core) and **G3 MCP Apps** (the existing
dashboard renders inside MCP conversations). C3/C4 memory and D1 digest follow. G4 adds a secure onboarding product after the current execution/MCP priorities: Pages launcher + localhost wizard, not a browser-held cloud token. See [ADR-0011](adr/ADR-0011-control-center-provisioning-boundary.md) and [G4](todo/G4-control-center-wizard.md). The native shield
(G1) is an optional, default-off FFI artifact — the Rust exploration measured honestly and the
audit's verdict stands. The executable queue is [`todo/index.md`](todo/index.md).

## 1. Explicit non-goals (freeze list)

```text
❌ A Rust/Wasm CORE replacing the engine   (unchanged; ADR-0010 keeps the rejection and the reason:
                                            no measured hotspot justifies it; the shield measured slower)
❌ Mem0 / Graphiti / Neo4j giant-memory deps
❌ 20-more-provider chase   (expansion = data through discovery/probe/eligibility, not code)
❌ Second task DB / second scheduler / Task-class circus
❌ Cloudflare-only substrate (self-host stays first-class; Workflows = adapter candidate later)
❌ Pooled free-provider credentials & autonomous account creation (BYOK-first)
🟡 Vercel dashboard as an optional frontend only; Cloudflare remains the API/control plane (ADR-0012)
❌ Full Agents SDK adoption, giant policy engine, giant PWA
❌ Wiring the native shield into the request path   (new: measured 1.5–1.7× slower than V8 on this
                                                     box; ADR-0010 gates any future revisit)
🟡 Go companion: frozen at conformance level until G2 lands; no semantic drift added meanwhile
```

Keep the native-compute **benchmark machinery** as engineering culture:
new CPU-heavy feature → benchmark → profile → only then consider native code. **Native modules are
allowed under ADR-0010** (optional accelerators behind ports, differentially tested, measured,
default OFF) — the first one is the output shield in `native/`.

## 1.5 Module adoption (ADR-0009, 2026-11-20) + native policy (ADR-0010, 2026-11-21)

The retrieval/memory gap is closed with a **port** and an FTS5 baseline, not a search server or a
vector database. Full decision and evidence: [ADR-0009](adr/ADR-0009-module-adoption-retrieval.md).
Native acceleration is allowed only under [ADR-0010](adr/ADR-0010-native-module-policy.md).

| Capability | Baseline (zero-dep) | Optional adapter | Refused |
|---|---|---|---|
| retrieval / lexical | SQLite **FTS5** over `SqlPort` — both hosts ship it | **Orama** (Apache-2.0, Node/local, vector/hybrid); **Cloudflare AI Search** (conditional) | Meilisearch / Typesense / Qdrant (servers); sqlite-vec on Workers |
| retrieval / semantic | FTS5 + (future) fastembed-rs behind the same port **only when the vector gap is measured** | — | any vector DB dependency |
| memory (C4) | SQLite + FTS5 + OKF artifact envelope | sleep-time consolidation (scheduled, optional) | Mem0 / Graphiti / Neo4j |
| durable execution (B1–B4) | DO alarms + `scheduled.ts` + `quota.ts` | — | Temporal / Inngest / Trigger.dev / BullMQ |
| native acceleration | TypeScript reference (canonical) | `native/simorgh-native` (cdylib / zero-import Wasm / C ABI), default OFF | a Rust core; wiring the slower shield |
| observability | structured console + ledger (Workers); `pino` (Node only) | — | collector/service in the engine |
| validation / CLI / MCP | hand-rolled, dependency-free | `zod` / `citty` / `@modelcontextprotocol/sdk` in the platform layer only | any of these in `phoenix-core` |

## 2. Epics (BMAD-ready)

### EPIC-A · Stabilize (Phase 0–1 weeks)

- **A1 Truth reconciliation** *(mostly done)* — this file + phase ledger; refresh
  sprint board mapping; mark stale epic claims historical in docs/prd.
- **A2 Toolchain canonicalization** *(mostly done)* — Node 22 pinned (.nvmrc), upm everywhere.
  **Open slices:** replace remaining doc `npx vitest/wrangler` invocations with `upx`/`upm run` where
  they are project workflow; evaluate stable TypeScript 7 (`tsc`) vs `@typescript/native-preview`
  (`tsgo`) in an isolated branch; verify `@cloudflare/vitest-pool-workers` ↔ Vitest 4/5 compatibility.
- **A3 AUTH-004 principal identity** ✅ shipped 2026-11-16 — credential → authenticated principal →
  `principalId` is the ONLY source of userId/quota/task/schedule/ledger ownership on both hosts.
  The seven-case list stays the acceptance target for the parts that do not exist yet: knowledge
  search and connector invocation arrive with C1/C2 and E.

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

- **C1 `RetrievalPort` in phoenix-core** ✅ shipped 2026-11-20 (ports.ts + FTS5 baseline + 17 tests).
- **C2 Knowledge API** ✅ shipped 2026-11-21 — four identity-gated routes
  (`POST /api/v1/knowledge`, `GET /api/v1/knowledge/:id`, `POST /api/v1/knowledge/search`,
  `DELETE /api/v1/knowledge/:id`) over the FTS5 adapter, with chunked indexing
  (`RETRIEVAL_CHUNK_CHARS = 1200`, code-point safe), passage-level provenance (`chunkId` on search
  hits), replace-on-reindex, and principal-scoped namespaces (`<subject>::<label>`). Results carry
  `{documentId, chunkId, source, title, text, score, timestamp, metadata, knowledgeNamespace}`.
- **C3 Tenant/agent namespaces** — Simorgh owns authorization ("who may access which namespace");
  the host prefixes the principal before the adapter sees the namespace (C2's `knowledge.ts` already
  encodes the rule). Principal personal NS + per-agent NS.
- **C4 Layered memory** — working → task/execution state → episodic → knowledge artifacts →
  semantic retrieval → procedural. OKF artifact envelope:
  `{id,type,principal,agent,created,updated,source,status,freshness,confidence,provenance}`.
  Optional 2026 addition: a scheduled "sleep-time" consolidation pass (Letta's idea) that rewrites
  memory during downtime — behind a port, no new dependency.

### EPIC-D · Swarm gets one real job

- **D1 Multi-source research digest** — Goal → discover sources → fetch×N ∥ retrieve prior
  knowledge → compare → synthesize → verify → write back to knowledge. Proves
  graph→swarm decomposition→quota planner→parallel allocation→aggregation→verification→memory→
  reschedule.
- **D2 Verification stage as a first-class task type** (not vibes).

### EPIC-E · External intelligence

- **E1 MCP modernization** — the spec is now **final (2026-07-28)**: implement the stateless path
  (`_meta` protocol version, `server/discover`, `Mcp-Method`/`Mcp-Name` routing, `ttlMs`/`cacheScope`),
  the **Tasks extension** (`tasks/get`/`update`/`cancel`, server-directed creation), and keep the
  legacy path only if explicitly tested. Expose task-shaped tools once B1 lands:
  `simorgh.task.create/status/cancel/wait`, `simorgh.goal.create`, `simorgh.knowledge.search`,
  `simorgh.agent.execute`. **No Sampling/Roots/Logging** (deprecated by the spec).
- **E2 Provider discovery pipeline** — discovery → probe → cost → quota → capabilities →
  freshness → eligibility → routing. "5 options per capability" = discovered, not hard-coded.
  Provider offers are evidence-backed and classified as recurring free, trial, promotional,
  free-model-pool or paid; no-card, phone, identity and region requirements are separate fields.
- **E3 Validation birds only** — start with providers whose API free-tier evidence is current.
  Gemini, Groq, OpenRouter, Workers AI, NVIDIA NIM and Cohere are candidates with distinct caveats;
  Mistral API, SambaNova and Cerebras are excluded from the no-payment set under current evidence.
- **E4 Global catalogue auditor** — GitHub Actions checks official docs, terms, model listings and
  offer freshness; emits evidence diffs and reviewable manifest updates without collecting keys.
- **E5 Per-deployment API health** — Cloudflare Cron tests only the user's configured accounts;
  classify 401/403/429/model-404/5xx separately; quarantine and recover by repeated evidence, never
  delete on one failed probe. Full decision: [ADR-0012](adr/ADR-0012-global-provider-catalog-and-cloud-topology.md).

### EPIC-F · Scale (only after B–D prove out)

- F1 DO sharding phases: global coordinator → principal coordinator → justified task shards.
- F2 Connectors sync (Notion/Drive/Telegram/GitHub). F3 portable PWA/dashboard around the existing
  Cloudflare API; Vercel is an optional personal frontend, not the control plane (ADR-0012).
- F4 Workflows-vs-DO benchmark → durable-execution interface with DO/alarm, Workflows, and
  Node/local implementations; default chosen by measurement, not faith.
- F5 Public multi-user deployment (post-A3 gate).

### EPIC-G · Native acceleration and runtime convergence (new, 2026-11-21)

Evidence and policy: [ADR-0010](adr/ADR-0010-native-module-policy.md),
[November 2026 deep recon](research/NOVEMBER-2026-DEEP-RECON.md).

- **G1 Native output shield (optional, default OFF)** ✅ built + verified — `native/simorgh-native`:
  faithful Rust port of `sanitizeModelOutput`/`markUntrusted`, 17 unit tests, 346-input differential
  test vs the live TS reference (negative control FIRED), C ABI + cdylib + zero-import Wasm,
  block-amortised benchmarks. **Measured 1.5–1.7× slower than V8 on this box** — the audit's
  "no CPU win" verdict survives; the module ships as an FFI-ready artifact for hosts without a JS
  engine. Revisit only if a hand-written (non-regex) scanner beats V8 under the ADR-0010 gates.
- **G2 Go-gateway convergence** — the biggest product lever. The Go runtime already answers, streams
  (SSE), models quota and seals keys, but speaks none of the core contract. Implement the contract on
  the Go host (`GET /health` core shape, `GET /api/v1/flock/status`, `POST /api/v1/agent/execute`,
  `GET /api/v1/user/{id}/logs`, `POST /mcp` with `simorgh_status`/`simorgh_ask`), pass the connector
  conformance kit against it, and let the fleet include it. REA build-info evidence (`ev_eeb697e0…`)
  confirms the asset is current (go1.27.2, revision `f3b0436`). Keep its unique capabilities
  (SSE, sealed keys, quota accounting) as the reason to converge — never a second wire contract.
- **G3 MCP Apps dashboard** — MCP Apps (2026-01-26, first official extension) lets a server ship an
  interactive `ui://` resource that hosts render in a sandboxed iframe. Simorgh's dashboard is
  already server-rendered HTML (`src/dashboard.ts`): expose the flock/quota/schedules view as an
  MCP Apps resource on the core's MCP surface, with tool metadata, so Claude/Copilot/Goose/Postman
  render it inside the conversation. No second UI stack.

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
2. [`docs/todo/index.md`](todo/index.md) owns the live queue. Each task is a separate OKF v0.3
   concept under `docs/todo/`, with evidence, explicit dependencies and acceptance checks.
3. BMAD remains an optional helper. Its generated artifacts may support execution but must not
   override the roadmap or TODO documents. Do not regenerate a plan from the historical 2026-08 PRD.
4. Every implementation task ends with `upm install --frozen-lockfile && upm run typecheck && upm test`
   green (+ per-module Go build/vet/test when Go is touched; `cargo test --release` +
   `node native/test/differential.mjs` when `native/` is touched).
5. Verify claims against real code/hosts where possible. Record what could not be run; repository-
   reported test counts are not a claim that this documentation pass reran the suites.
6. No new framework, second scheduler, second task database, provider-count chase, pooled free
   credentials, automatic account creation, Rust/Wasm core, or giant PWA without a new evidence-based
   decision. Native modules are allowed under ADR-0010 only.