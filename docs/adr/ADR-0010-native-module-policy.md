---
type: "Architecture Decision Record"
title: "ADR-0010 — Native modules behind ports (evidence-gated Rust policy)"
description: "Replaces the blanket Rust/Wasm freeze with an evidence-gated native-module policy: optional accelerators behind ports, differentially tested, measured, default OFF."
tags:
  - simorgh
  - adr
  - native
  - rust
  - policy
generated:
  by: "kilo/ernie-5.5-flash-preview"
  at: "2026-11-21T15:00:00Z"
status: "accepted"
stale_after: "2027-05-21T00:00:00Z"
sources:
  - id: native-audit
    resource: "../research/NATIVE-COMPUTE-AUDIT.md"
    title: "The audit that rejected a Rust/Wasm core and DEFERRED the output shield"
  - id: native-module
    resource: "../../native/README.md"
    title: "The first native module: the output shield, ported and differentially tested"
  - id: bifrost
    resource: "https://dev.to/pranay_batta/best-open-source-ai-gateway-in-2026-2flb"
    title: "Bifrost (Go): 11µs overhead at 5,000 RPS — the strategic Go-gateway precedent"
  - id: mcp-spec
    resource: "https://modelcontextprotocol.io/specification/2026-07-28/changelog"
    title: "MCP 2026-07-28: stateless core, Tasks extension, MCP Apps"
---

# ADR-0010 — Native modules behind ports

**Status:** accepted (2026-11-21). **Supersedes:** the `❌ Rust/Wasm core` freeze-list line in
`ROADMAP-SPINE.md` §1 (replaced by the policy below; the rejection of a *core* is unchanged and
restated). **Does not change:** the engine stays TypeScript; `phoenix-core`'s boundary test is untouched.

## Context

`docs/research/NATIVE-COMPUTE-AUDIT.md` (2026-10-10) measured six request-path candidates and rejected
a Rust/Wasm **core**: the quota scheduler is 0.701 µs of unwired code, JSON parsing is already native,
auth is a platform digest, the ledger is I/O-bound by contract. One candidate was **DEFERRED rather than
rejected** — the output shield (`sanitizeModelOutput`), the only measured hotspot above 1% of the
Workers Free per-request CPU budget: at the 32 KB answer cap, adversarial content costs ~10–14% of the
10 ms budget per request.

The project owner then directed a native exploration (2026-11-21): *use REA and Rust to add something to
Simorgh as a module or a core part*. Two further pieces of evidence re-opened the question the audit had
closed:

1. **The Go gateway is a stranded second runtime.** `gateway/` answers, streams (SSE), models quota and
   seals provider keys at rest — but it cannot join the platform fleet because it speaks none of the core
   contract (`/health` core shape, `/api/v1/flock/status`, `/api/v1/agent/execute`, `/mcp`). The 2026
   landscape says Go gateways are a *performance category of their own*: Bifrost (Go) reports 11 µs
   overhead at 5,000 RPS (maintainer-reported; an independent TrueFoundry review disputes "fastest"
   claims but confirms the throughput class). Convergence, not a rewrite, is the opportunity.
2. **MCP 2026-07-28 is now the stable spec** (stateless core, `server/discover`, Tasks as an official
   extension, MCP Apps as the first official UI extension, roots/sampling/logging deprecated). Simorgh's
   E1 task was written against the release candidate; the spec is now final, which unblocks it.

## Decision

**Native modules are allowed, under a strict policy. A native core is not.**

1. **The engine stays TypeScript and runtime-agnostic.** `phoenix-core` never links native code; the
   boundary test is not weakened. A native module is reached only through a host-side adapter that
   implements an existing or new port.
2. **A native module ships only when all four gates pass:**
   - *Pure computation* — no I/O, no network, no filesystem; Wasm-compatible by construction.
   - *Differentially tested* against the TypeScript reference it accelerates (byte-identical outputs,
     findings order included, with a negative control in the comparator). "Two definitions, nothing
     comparing them" is the failure mode this gate exists to prevent.
   - *Measured* against the TypeScript implementation on this box with the audit's method (block-
     amortised, empty-loop baseline, three passes), and the measurement recorded honestly — including
     when the native side is **slower** (which is what happened for the shield; see §3).
   - *Optional* — a host that cannot load the module keeps the TypeScript implementation and loses
     nothing but the (measured) delta. Default OFF in the request path.
3. **The first native module is the output shield** (`native/simorgh-native`), the audit's DEFERred
   candidate. It ships as: a Rust crate (lib + cdylib + staticlib), a CLI, 17 unit tests (the repo's own
   TS fixtures, ported), a 346-input differential test against the live TS implementation, and a
   TS-vs-Rust benchmark orchestrator.
4. **The Go gateway's future is convergence, not competition** (task G2): implement the core contract on
   the Go runtime so it can join the fleet as a first-class core, and keep its unique capabilities (SSE
   streaming, sealed keys, quota accounting) as the *reason* to converge. REA `inspect_go_binary` on a
   real build (2026-11-21: go1.27.2, revision `f3b0436`) is the audit trail for this decision.

## Consequences

- **Rejected: a Rust/Wasm core.** Unchanged from the audit: no measured hotspot justifies replacing the
  engine, and the boundary test would (correctly) refuse it.
- **Accepted: a native module workspace** (`native/`) with its own CI commands (`cargo test --release`,
  `node native/test/differential.mjs`, `node native/test/bench-node.mjs`). It is not part of `upm test`;
  a change to `phoenix-core` that would affect the shield must re-run the differential test.
- **The shield is NOT wired into the request path.** Measured on this box: Rust regex is 1.5–1.7×
  *slower* than V8 on this workload. Wiring it would be a regression dressed as an optimization. The
  module's value today is the FFI-ready artifact (Go/Node/Wasm hosts without a JS engine) and the
  differential harness. A future hand-written scanner (no regex) could revisit this; the gates above
  define what "revisit" must prove.
- **Go convergence becomes a roadmap epic (G2)** with its own acceptance: the Go gateway answers the
  core contract and passes the connector conformance kit; `simorgh_status`/`simorgh_ask` MCP tools work
  against it; the fleet can include it.

## Verification

- `cd native && cargo test --release` — 17/17 (the TS fixtures, ported).
- `node native/test/differential.mjs` — 346/346 byte-identical (text + findings), negative control FIRED.
- `node native/test/bench-node.mjs` — TS-vs-Rust table (both sides, identical inputs, one box).
- FFI: Python ctypes end-to-end (sanitize + findings + two-call sizing) — verified 2026-11-21.
- Wasm: `WebAssembly.Module.imports()` → `[]` (zero imports); exports the four FFI functions.
- REA: `inspect_binary_hardening` on the cdylib (NX, RELRO, no RPATH); `inspect_go_binary` on the Go
  gateway (build info + revision + deps).