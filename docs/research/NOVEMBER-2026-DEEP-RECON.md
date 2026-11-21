---
type: "Research Synthesis"
title: "November 2026 Deep Recon — what Simorgh must be today"
description: "A dated reconnaissance pass over the current agent-gateway landscape (MCP 2026-07-28, Go gateways, free providers, agent memory), the repository's own evidence (REA artifact inspections, native-module benchmarks), and the resulting roadmap reorder."
tags:
  - simorgh
  - research
  - roadmap
  - mcp
  - native
  - okf
generated:
  by: "kilo/ernie-5.5-flash-preview"
  at: "2026-11-21T15:00:00Z"
status: "stable"
stale_after: "2026-12-21T00:00:00Z"
sources:
  - id: mcp-spec
    resource: "https://modelcontextprotocol.io/specification/2026-07-28/changelog"
    title: "MCP 2026-07-28 changelog — stateless core, Tasks extension, deprecation policy"
  - id: mcp-rc-blog
    resource: "https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/"
    title: "The 2026-07-28 release candidate announcement"
  - id: mcp-apps
    resource: "https://modelcontextprotocol.io/extensions/apps/overview"
    title: "MCP Apps — the first official extension, server-rendered UIs"
  - id: bifrost
    resource: "https://dev.to/pranay_batta/best-open-source-ai-gateway-in-2026-2flb"
    title: "Bifrost (Go): 11µs overhead at 5,000 RPS — maintainer-reported"
  - id: truefoundry
    resource: "https://www.truefoundry.com/blog/bifrost-ai-gateway-review"
    title: "Independent Bifrost benchmark review (challenges 'fastest' claims)"
  - id: free-apis
    resource: "https://apidog.com/blog/free-ai-api/"
    title: "Free AI APIs, October 2026 — provider roster and limits"
  - id: openrouter-free
    resource: "https://openrouter.ai/blog/tutorials/free-llm-apis-compared/"
    title: "Free LLM API comparison (OpenRouter)"
  - id: rmcp
    resource: "https://docs.rs/rmcp"
    title: "rmcp — the official Rust MCP SDK"
  - id: rust-mcp-sdk
    resource: "https://github.com/rust-mcp-stack/rust-mcp-sdk"
    title: "rust-mcp-sdk — 2026-07-28 stateless protocol, conformance-tested"
  - id: fastembed
    resource: "https://github.com/Anush008/fastembed-rs"
    title: "fastembed-rs — local embeddings and reranking in Rust"
  - id: memory-state
    resource: "https://mem0.ai/blog/state-of-ai-agent-memory-2026"
    title: "State of AI agent memory 2026 (benchmarks and gaps)"
  - id: native-audit
    resource: "NATIVE-COMPUTE-AUDIT.md"
    title: "The repository's own native-compute audit"
  - id: native-module
    resource: "../../native/README.md"
    title: "The first native module: the output shield, ported and measured"
  - id: adr-0010
    resource: "../adr/ADR-0010-native-module-policy.md"
    title: "The native-module policy this pass created"
  - id: fleet
    resource: "https://github.com/modelcontextprotocol/modelcontextprotocol"
    title: "MCP specification repository"
---

# November 2026 Deep Recon — what Simorgh must be today

> **TL;DR (2026-11-21).** Five external facts moved this week, and each one lands on a roadmap task:
> **(1) MCP 2026-07-28 is final** — stateless core, `server/discover`, Tasks as an official extension,
> MCP Apps as the first official UI extension, roots/sampling/logging deprecated. Simorgh's E1 is no
> longer "chase the spec", it is "implement the final spec". **(2) The Go gateway is a stranded asset
> and the 2026 evidence says Go gateways are a performance category** — Bifrost reports 11 µs overhead
> at 5,000 RPS (maintainer-reported; independently reviewed as fast, not magic). Converging simorgh's
> own `gateway/` on the core contract is the single biggest product lever available. **(3) The free-tier
> roster is stable and wide** — Gemini, Groq, OpenRouter, Mistral, Workers AI, NVIDIA, Cohere,
> SambaNova, Cerebras all publish no-card free tiers as of October 2026; the flock's problem is no
> longer *access*, it is *governance* (quota admission, usage reconciliation, honest degradation) —
> which is exactly EPIC-B. **(4) Rust MCP SDKs and local-inference crates are production-grade** (rmcp,
> rust-mcp-sdk with 2026-07-28 conformance, fastembed-rs), so a native path exists where it is *earned*.
> **(5) The repo's own native exploration measured the shield honestly**: the Rust port is byte-identical
> to the TypeScript reference across 346 differential inputs, but **1.5–1.7× slower than V8** on this
> box — the audit's "no CPU win" verdict survives, so the shield ships as an optional FFI artifact
> (zero-import Wasm, cdylib, C ABI), default OFF, and the native policy (ADR-0010) is evidence-gated.
>
> **The reorder in one line:** land the in-flight C2 knowledge API → B1–B4 execution spine →
> stateless-MCP E1 → **G2 Go-gateway convergence** (new) → MCP Apps dashboard (new, G3) → C3/C4
> memory → D1 digest → E2/E3 discovery. Native shield (G1) is optional and default-off.

## 1. Method and evidence boundary

- **Primary sources fetched live** (2026-11-21): the MCP 2026-07-28 changelog and release-candidate
  announcement (modelcontextprotocol.io), the MCP Apps overview, rmcp/rust-mcp-sdk/fastembed-rs
  documentation, and three independent 2026 free-tier/provider comparisons.
- **Repository evidence**: REA inspections of artifacts built *in this session* — the Go gateway binary
  (`inspect_go_binary`, evidence `ev_eeb697e0…`: go1.27.2, git revision `f3b0436`, full dep graph) and
  the Rust cdylib (`inspect_binary_hardening`, evidence `ev_92866f20…`: NX + RELRO, no RPATH); Node
  `WebAssembly.Module.imports()` → `[]` for the Wasm artifact; a Python ctypes end-to-end FFI check;
  the differential test (346 inputs, negative control FIRED) and the TS-vs-Rust benchmark.
- **Fleet note**: the Firecrawl and Tavily MCP bridges in the local fleet are configured with a proxy at
  `127.0.0.1:10809` that is not listening in this session (the operator's note: no proxy, direct
  connection). Research used `open-websearch` (DuckDuckGo) and direct `webfetch` instead; the fleet
  itself is healthy (29 running, 420 tools). Fix the bridge proxy config or disable it — details in
  `harnesses/skillset/mcp-fleet/mcp-fleet.yaml` (not touched here).
- **What this pass does NOT claim**: no provider terms were re-verified live (the free-tier roster is
  from October 2026 secondary sources — E2's job is the evidence-gated catalogue); Bifrost's numbers are
  maintainer-reported and were not independently reproduced here; the shield benchmark is one box, one
  session, with the method documented (block-amortised, baseline-subtracted, three passes).

## 2. The five external facts that moved

### 2.1 MCP 2026-07-28 is final — and Simorgh's E1 is now a spec implementation, not a chase

Fetched from the official changelog (primary):

- **Stateless core**: `initialize`/session removed; every request carries `_meta` protocol version +
  client capabilities; `server/discover` is a MUST; `Mcp-Method`/`Mcp-Name` headers are required on
  Streamable HTTP; list results carry `ttlMs`/`cacheScope`.
- **Tasks graduated to an official extension** (`io.modelcontextprotocol/tasks`): server-directed task
  creation, `tasks/get` polling, `tasks/update`, `tasks/cancel`; `tasks/list` removed.
- **MCP Apps** (first official extension, 2026-01-26): servers ship interactive HTML via `ui://`
  resources; hosts render in a sandboxed iframe; UI actions ride the same JSON-RPC audit path.
- **Deprecated**: roots, sampling, logging (12-month lifecycle); HTTP+SSE transport.
- **MRTR**: server asks mid-call via `InputRequiredResult` + `inputRequests`, client retries with
  `inputResponses` — no sticky sessions.

**Simorgh impact:** `docs/todo/E1-mcp-current-revision.md` was written against the RC; the final spec
matches its plan (stateless path + task-shaped tools). The `Mcp-Session-Id`-based core MCP server and
the pre-2026-07-28 platform MCP server are now *legacy paths to keep only if tested*. E1's acceptance
should additionally assert: `server/discover` answers, `Mcp-Method`/`Mcp-Name` routing works, and
`tasks/*` tools are exercised by a real SDK client (the official TypeScript SDK).

### 2.2 The Go gateway is a stranded asset; the market says converge it

Simorgh's own `gateway/` (verified in this session): 328-line server, SSE streaming
(`/v1/chat/completions`), aggregated `/v1/models`, `/health` with `{status, uptime, providers[]}`,
`/status` with quota, AES-256-GCM sealing (packages/crypto), latency-EMA failover. It answers **none**
of the core contract, so it cannot join the fleet. REA build-info evidence (this session):
go1.27.2, revision `f3b0436` (main HEAD), deps `packages/{config,crypto,ledger,providers}` +
`x/crypto v0.31.0`.

The 2026 landscape (secondary, maintainer + independent review):
- Bifrost (Go, open source): **11 µs overhead at 5,000 RPS** (maintainer-reported); an independent
  TrueFoundry review confirms the throughput class but disputes "fastest" marketing.
- Multiple 2026 comparisons (LiteLLM/Portkey/Bifrost/Envoy AI Gateway) converge on: Python gateways
  cap out on throughput; Go gateways are the performance tier; LiteLLM wins ecosystem breadth.

**Simorgh impact (new task G2):** implement the core contract on the Go runtime (health shape,
`/api/v1/flock/status`, `/api/v1/agent/execute`, `/api/v1/user/{id}/logs`, `/mcp` with
`simorgh_status`/`simorgh_ask`), pass the connector conformance kit against it, and let the fleet
include it. The Go gateway's SSE + sealed keys + quota accounting are the *reason* to converge, not
compete. This is a bigger product lever than any provider addition.

### 2.3 The free-tier roster is stable and wide; the problem is governance

October 2026 sources (apidog, OpenRouter, dreamprompting) agree on the no-card free roster: Gemini,
Groq, OpenRouter, Mistral, Workers AI, NVIDIA API catalog, Cohere, SambaNova, Cerebras. Limits and
model availability shift monthly (dreamprompting: "the live set is always visible at /models").

**Simorgh impact:** the flock (8 birds) is not the bottleneck; EPIC-B (quota admission, usage
reconciliation, honest degradation) is. E2's catalogue must treat every limit as *provisional with a
last-verified date*, exactly as designed. No new provider chase (freeze stands).

### 2.4 Rust is production-grade *where it is earned*

- **rmcp** (official Rust MCP SDK, Apache-2.0): async on Tokio, typed tools via macros, full MCP
  surface.
- **rust-mcp-sdk**: implements the 2026-07-28 stateless protocol, claims 100% official conformance.
- **fastembed-rs** (Apache-2.0): local embeddings + reranking via ONNX Runtime — the candidate for a
  future *semantic* retrieval adapter behind `RetrievalPort` (C1's vector gap) with **zero API cost**,
  at the price of a first-use model download (documented, cached).

**Simorgh impact:** the native policy (ADR-0010) can point at real crates when a native module is
earned; the shield was the first candidate and measured *slower than V8*, so it stays optional.
fastembed is the next candidate *if* C1's vector/hybrid gap becomes a measured need (it is not yet:
FTS5 baseline shipped, C2 routes in flight).

### 2.5 Agent memory: the interface is not settled, the pipeline is

State-of-2026 sources (mem0 benchmark roundup, Letta): multi-layer memory (editable blocks + searchable
archive + provenance) is the settled *shape*; the *store* is not (Mem0/Letta/Zep/Hindsight all
differ). Letta's sleep-time compute (rewrite memory during downtime) is the interesting 2026 idea for
C4's "rethink" operation.

**Simorgh impact:** C4's design (editable blocks + archival retrieval behind a port, OKF envelope,
no giant memory deps) is confirmed correct; add "sleep-time" as an optional scheduled consolidation
pass, not a new dependency.

## 3. Repository evidence generated this session

### 3.1 The native shield: built, differentially verified, honestly measured

- `native/simorgh-native`: faithful Rust port of `sanitizeModelOutput` + `markUntrusted`
  (`phoenix-core/src/security.ts`), with the audit's DEFERred candidate as the target.
- **Correctness**: 17 unit tests (the repo's own TS fixtures, ported) + 346-input differential test
  against the *live* TypeScript implementation (46 fixtures + 300 seeded adversarial), byte-identical
  text AND findings order, comparator negative control FIRED.
- **Performance** (same box, same inputs, one session; block-amortised, baseline-subtracted, 3 passes):

| input | kind | TS median | Rust median | Rust/TS |
|---|---|---|---|---|
| 1 KB | clean | 3.1 µs | 4.7 µs | 1.49× |
| 4 KB | clean | 11.0 µs | 17.7 µs | 1.61× |
| 16 KB | clean | 43.7 µs | 71.4 µs | 1.64× |
| 16 KB | adversarial | 764.0 µs | 1159.8 µs | 1.52× |
| 32 KB (cap) | adversarial | 1474.0 µs | 2443.6 µs | 1.66× |
| 128 KB | adversarial | 1473.0 µs | 2563.6 µs | 1.74× |

  **Verdict: the Rust regex port is 1.5–1.7× slower than V8 on this workload.** The audit's rejection
  of a native core stands; the shield ships as an optional FFI artifact (cdylib + zero-import Wasm +
  C ABI), default OFF. The differential harness is the reusable machinery.
- **Artifact evidence**: Wasm `imports: []` (no I/O by construction); cdylib hardening NX + RELRO (REA
  `ev_92866f20…`); FFI verified end-to-end via Python ctypes (sanitize + findings + two-call sizing).

### 3.2 The Go gateway audit (REA)

`inspect_go_binary` on a fresh build: go1.27.2, `github.com/shaiinarab/simorgh/gateway`, revision
`f3b0436`, deps as committed, CGO_ENABLED=1. The binary is real and current — the convergence task
(G2) starts from a maintained asset, not a fork.

## 4. Adoption matrix (what to adopt, what to refuse)

| Capability | Adopt | Refuse | Seam |
|---|---|---|---|
| MCP 2026-07-28 | stateless path, `server/discover`, Tasks extension, `Mcp-Method` routing | the deprecated roots/sampling/logging surface | E1 |
| MCP Apps | `ui://` resource for the existing dashboard (flock status card) | a second UI stack | G3 |
| Go gateway | converge on the core contract; keep SSE + sealed keys + quota | a second wire contract forever | G2 |
| Native acceleration | FFI-ready shield, evidence-gated policy (ADR-0010) | a Rust core; wiring the slower shield | G1 |
| Retrieval | FTS5 baseline (shipped); fastembed only when the vector gap is measured | Meilisearch/Qdrant/Mem0/Graphiti | C1/C4 |
| Memory | editable blocks + archival + sleep-time consolidation, behind a port | giant memory deps (freeze stands) | C4 |
| Providers | evidence-gated catalogue, provisional limits | provider-count chase | E2/E3 |

## 5. The reorder (full detail in `../ROADMAP-SPINE.md`)

1. **Land C2** (the in-flight knowledge API is uncommitted in the tree: `phoenix-core/src/knowledge.ts`,
   `src/knowledge-vault.ts`, routes in `src/index.ts`) + C3 namespaces.
2. **B1 → B2 → B3 → B4** (the critical path is unchanged; nothing native changes it).
3. **E1** against the final 2026-07-28 spec (now unblocked).
4. **G2 Go convergence** (new — biggest product lever).
5. **G3 MCP Apps dashboard** (new — the dashboard already exists as server-rendered HTML).
6. **C4 memory** → **D1 digest** → **E2/E3 discovery**.
7. **G1 native shield** stays optional/default-off; revisit only if a hand-written scanner beats V8
   (the gates in ADR-0010 define what "beats" must prove).

## 6. What would change this document

- A provider announcing a paid-only policy for a flock bird (E2 evidence).
- MCP publishing a post-2026-07-28 revision (12-month lifecycle makes this unlikely before late 2027).
- A measured hotspot above 1% of request CPU that is *not* the shield (re-run the audit's method).
- The Go gateway diverging further from the core contract (G2 becomes urgent, not strategic).