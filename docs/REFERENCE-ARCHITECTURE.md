# Reference Architecture — what the studied systems contribute to the spine

> **What this document is.** The 2026-10-09/10 reconnaissance pass studied ~50 systems
> (dossiers: `docs/research/adoption/`, `docs/research/GITHUB-INSPIRATION-2026-10-10.md`,
> `docs/research/GITHUB-ECOSYSTEM-CLIENTS-PLATFORMS-2026-10-10.md`). This file converts them
> from a link-dump into an **architecture cross-walk**: for every stage of the spine
> (`docs/ROADMAP-SPINE.md`), which working system is the precedent, what it proves, what
> Simorgh borrows, what it refuses, and the code seam the stage lands in.
>
> **The thesis the evidence leaves standing:** none of the spine is novel. Every stage has
> at least one working, starred, current implementation. The architecture's originality is
> the *composition* — all of it under free-to-signup/no-KYC constraints with honest
> degradation — not any single stage. Reinventing a stage is only justified when the
> precedent violates the constraints; the refusals section records where that happened.

## 1. The target, restated as an ecosystem

```
provider adapters ──▶ API/MCP mesh ──▶ agent swarms ──▶ parallel, quota-gated runs
   (wire-shape           (REST +          (bounded          (one pool, sequential
    ports)                MCP tools)       fan-out)          placement, never
                                                             over-commit)
```

- **"Connects all providers"** = the `Provider` port with one factory per *wire shape*
  (OpenAI-compatible / Gemini / Workers AI), not one per vendor. `provider.ts` already works
  this way; three independent systems converged on the same shape (§2.1).
- **"Modular API/MCP-based"** = the port is the modularity unit. `ports.ts` declares seven;
  a host binds what it has; the engine imports nothing. MCP is the external face of the
  same ports (§2.3).
- **"Swarms of agents"** = `swarm.ts`: decompose a goal into bounded leaves, capabilities
  narrow, spending is conserved (§2.4). Already built, not yet driven end-to-end (EPIC-D1).
- **"Parallel runs"** = quota-gated placement: leaves are placed *sequentially against a
  shared pool* so N individually-correct answers are not collectively an over-commit
  (`swarm.ts` + `planTaskRun`, EPIC-B2). Parallel means *concurrent execution of admitted
  leaves*, never independent scheduling.

## 2. The cross-walk

### 2.1 Provider+Account+Model — the connection layer

**Precedents:** `Godde3s/omnirouter` (registry of bridges + custom providers; `model="auto"`
chains; alias maps; named chains), `Godde3s/GhostBrain` + `deepseek/qwen/gemini/glm-free-api`
family (one adapter per provider surface; multi-account round-robin with 429 cooldown),
`yolorouter/yolorouter` (one binary, four chat wire protocols + key pooling),
`piyush-tyagi-13/llm-keypool` (pool + per-key capability tagging).

**What the convergence proves:** three independently-written systems all reached *adapter per
wire protocol, never per vendor* — omnirouter's bridges, the *-free-api family's per-provider
bridges, yolorouter's four-protocol support. Simorgh made the same decision first
(`openAiCompatibleProvider` exists precisely so OpenRouter "is not special, it is
OpenAI-compatible plus two headers"). The account layer — rotation, cooldown, capability
tags — is the one real addition these systems carry that Simorgh's `Provider.accountId`
anticipates but `flock.ts` does not yet use.

| Take | Refuse | Seam |
|---|---|---|
| Alias maps (`public → upstream`) and `model="auto"` chains as *catalog* concepts (ADR-0007 row 9) | The bridges themselves: playwright/uTLS/WASM web-account automation violates the flock's honesty + the audit's ToS findings | `provider.ts`, `models.ts`, future `catalog.ts` |
| Account pool rotation with 429 cooldown (GhostBrain `:1820-1860`, llm-keypool) | Browser-profile persistence stores | `flock.ts` + new `accounts.ts`, needs a secrets-*enumeration* port first |
| Per-key capability tagging (llm-keypool) as a sharper `servesTiers` | — | `provider.ts`, `complexity.ts` |

### 2.2 Quota/Cost plan and failover — what makes parallel runs safe

**Precedents:** omnirouter's seven failover rules (retryable = 429/401/403/5xx/transport;
first byte flushed = no failover; cooldown benching; all-cooling second pass),
`swarm.ts`'s own research notes (Trigger.dev slot accounting; Inngest's steps-vs-runs;
BullMQ's rate-vs-concurrency), quota.ts (already built).

**What it proves:** every working system bounds its parallelism *somewhere*, and the
sophisticated ones bound it with a *capacity planner*, not a client-side counter. Simorgh's
version is stronger than the precedents on one axis: `swarm.ts` folds each placement back
into the pool before the next leaf (sequential allocation), which omnirouter's
retry-then-bench does not model.

| Take | Refuse | Seam |
|---|---|---|
| The retryable-failure taxonomy as a *definition* (done — `failures.ts`) | omnirouter's "cooldown is a preference, not a block" second pass — contradicts `health.ts`'s documented 429 semantics and risks limit extension | `flock.ts`, `health.ts`, `failures.ts` |
| "First byte flushed commits the stream" (when streaming exists) | Retrying a rate-limited bird — spends the scarce thing | `execute.ts` (with SSE work) |
| Trigger/Inngest *ideas* | The runtimes themselves: a server, a service, or a worker fleet cannot live inside `phoenix-core`'s boundary | `swarm.ts` (already decided) |

### 2.3 Tools/MCP/Retrieval — the ecosystem's connective tissue

**Precedents:** `morluto/rea` (contract-first MCP tool catalog, generated and CI-pinned),
`seyed-ali-002/Dana-MCP-Server` (a whole machine exposed over MCP with tokenized URLs +
Tailscale), `ComposioHQ/composio` (1000+ toolkits, one auth surface), `activepieces`
(~400 bundled MCP servers), `block/goose` (MCP-native agent).

**What it proves:** MCP has won the tool-integration layer. The shape that survived contact
with users is *task-shaped tools over one authenticated endpoint* — exactly EPIC-E1's
`simorgh.task.create/status/cancel/wait`, `simorgh.goal.create`, `simorgh.knowledge.search`,
`simorgh.agent.execute`. REA's discipline is the missing process: a contract file as the
source of truth, a generated catalog, a test pinning live `tools/list` to it — the two
handwritten tool lists in this repo today are the duplication that pattern eliminates.

| Take | Refuse | Seam |
|---|---|---|
| Contract → generated catalog → pinned test (ADR-0007 row 3) | — | `simorgh-platform/src/mcp/toolContracts.ts` + `scripts/` |
| MCP 2026-07-28 spec (stateless core, header routing); **no Sampling** (deprecated) | Handshake-era assumptions | `mcp/server.ts` (E1) |
| Composio's "many tools, one auth surface" *as an option* behind the allow-list | Adopting the catalog wholesale — a tool is a product decision here (`agent.ts` says so) | `tools.ts` via `AgentTool` union |

### 2.4 Swarms and verification

**Precedents:** `swarm.ts`'s own precedent research is the record. `doofzoff/SIMURG`
(the namesake: streaming-integrity monitoring with conformal-calibrated false alarms),
`agent-stream-doctor` (stream diagnosis: empty streams, reasoning-only, truncated tool
calls), `block/goose` + `All-Hands-AI/OpenHands` + `omnara-ai/omnara` (agent runtimes as
products), `activepieces`/`n8n` (supervised automation).

**What it proves:** the swarm *pattern* is settled — decompose → place → run → aggregate —
and the interesting engineering is in the bounds (cap, narrowing, sequential placement),
which this repo already has. The genuinely missing stage is **verification as a first-class
task type** (EPIC-D2): the precedents treat it as vibes; the namesake repo is the only one
that treats stream integrity as a *detector with a false-alarm budget*.

| Take | Refuse | Seam |
|---|---|---|
| Verification-as-task-type with a detector discipline (negative control required) | Treating verification as a synthesis step | `tasks.ts`, EPIC-D2 |
| Stream-integrity detection with a calibrated budget | — | with the SSE work (ADR-0008) |
| hermes-stack's supervisor pattern (exponential backoff, no crash-loop hammering) | Its single-target deploy premise (dead — see §3.4) | `scheduled.ts` |

### 2.5 Memory/knowledge and the knowledge loop

**Precedents:** `mem0ai/mem0`, `topoteretes/cognee`, `getzep/graphiti` (+Zep),
`MemoriLabs/Memori`, `supermemoryai/supermemory` — the 2026 memory-layer wave, all
attach-as-infrastructure, all Apache-2.0 or permissive-flag.

**What it proves:** memory is won by the *pipeline* (extract → update → retrieve with
provenance), not the store. The spine's C1→C4 (RetrievalPort first, then layered memory)
is the right order; every precedent confirms that a memory layer bolted onto a system
with no retrieval is a graveyard. The 32k★ spread across five projects says "the
interface is not settled" — which is exactly why this repo's non-goal ("no giant-memory
deps") is right and why the port pattern owns the interface.

| Take | Refuse | Seam |
|---|---|---|
| Retrieval provenance in every result (C2's field list) | Any of the five as a dependency — the port owns the interface; the library is an adapter | `ports.ts` (C1), C4 |
| The OKF artifact envelope idea for layered memory | Giant graph stores (non-goal, unchanged) | memory port (C4) |

### 2.6 Deploy, and the lesson that reshaped the wizards

**Precedents:** `Godde3s/hermes-stack` (compose router+agent+supervisor+backups onto one
free host; the client-side GitHub-Pages wizard), `jaavid/api-access-gateway` (KV-routed
control plane on the same Workers substrate), `seyed-ali-002/Dana-MCP-Server` (expose a
machine over MCP via Tailscale Funnel).

**What it proves, and what it cost:** hermes-stack is the closest precedent to the whole
vision — and its free-deploy premise **died**: since 2026-07-08 HF returns 402 for new
Gradio/Docker Spaces on free cpu-basic (evidence: the 2026-10-09 debug session export,
HF docs). The durable lesson is architectural: **deploy targets are data with dated
verified-free citations, re-verified in CI** — the bird-catalog discipline applied to
infrastructure (ADR-0008 §4). A wizard that hardcodes one target inherits that target's
policy risk.

## 3. The decisions the evidence forces (and where they already live)

1. **The port is the modularity unit — never the library.** Every system that grew a
   provider concept converged on adapter-per-wire-shape; every system that grew a memory or
   retrieval concept is still rewriting it. Ports own the interface; precedents are
   adapters. (Lives: `ports.ts`, `boundary.test.ts`.)
2. **MCP is the ecosystem's API, and its tools are task-shaped.** REA's contract→catalog→
   pinned-test discipline is the missing process; EPIC-E1's tool names are the right shape.
   (Lives: `mcp/server.ts`, E1.)
3. **Capacity is an input to every parallel run, not an afterthought.** Precedents bound
   parallelism with planners; `swarm.ts` improves on them with sequential folded placement;
   EPIC-B2 wires it into production so "nothing spends provider quota until the capacity
   planner says it can". (Lives: `swarm.ts` + `planTaskRun`.)
4. **Verification is a stage with detectors, not a paragraph.** The only precedent that
   treats it as engineering is the namesake repo; the negative-control rule applies to
   every detector. (Lives: EPIC-D2.)
5. **Deploy honesty**: targets are verified data, wizards are target-matrix, HF is
   Static-only with the PRO gate displayed. (Lives: ADR-0008 §4, Epics 16–17.)

## 4. Gaps between this map and the vision (honest list, in spine order)

| Gap | Spine item | Why it matters to "swarms + parallel runs" |
|---|---|---|
| `planTaskRun` not wired into the claim path | B2 | today a claim flies without asking the capacity brain — parallel runs are ungoverned in production |
| No RetrievalPort | C1 | the spine's knowledge half is a hole; swarms currently can't retrieve |
| Layered memory not built | C4 | `ContextStore` is session state, not memory |
| MCP on the pre-2026-07-28 shape; no task-shaped tools | E1 | the "MCP-based ecosystem" is not yet task-shaped |
| Swarm plans but does not drive execution | D1/B4 | no end-to-end proof: Goal → DAG → parallel placement → aggregate → verify |
| Account pool rotation absent | ADR-0007 row 7 | multi-account parallelism (the free-quota multiplier) needs the secrets-enumeration port first |
| Chat gateways/wizards | ADR-0008, Epics 14–17 | the surface doors — real work, but they sit *on* the spine, not under it |

## 5. What "swarms of agents and parallel runs" means in this codebase, concretely

```text
Goal ──▶ Task DAG (tasks.ts, validated) ──▶ swarm.ts decompose (cap ≤ maxSubtasks,
        capabilities narrow, spend conserved) ──▶ planTaskRun per leaf, sequentially
        against the shared pool ──▶ scheduled.ts claims (DO alarms) ──▶ execute.ts
        (agent loop → tools/MCP → ledger) ──▶ verification ──▶ persist ──▶ memory
        ──▶ next task wake
```

A swarm is N *admitted* leaves running concurrently, never N independent schedules. The
next slice that moves the vision is B2 (govern the claim path), then D1 (one real
end-to-end swarm job) — in that order, per the spine's own order of attack.
