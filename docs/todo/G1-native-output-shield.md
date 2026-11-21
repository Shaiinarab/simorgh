---
type: "Implementation Task"
title: "G1 — Native output shield (optional, default OFF)"
description: "The first native module: a faithful Rust port of the model-output shield, differentially tested against the TypeScript reference and measured honestly."
tags:
  - simorgh
  - todo
  - native
  - rust
  - shield
  - epic-g
generated:
  by: "kilo/ernie-5.5-flash-preview"
  at: "2026-11-21T15:00:00Z"
status: "stable"
work_status: "done"
priority: "P3"
depends_on: []
stale_after: "2027-02-21T00:00:00Z"
sources:
  - id: adr-0010
    resource: "../adr/ADR-0010-native-module-policy.md"
    title: "Native-module policy"
  - id: native-module
    resource: "../../native/README.md"
    title: "The module"
  - id: ts-reference
    resource: "../../phoenix-core/src/security.ts"
    title: "The TypeScript reference"
---

# G1 — Native output shield (optional, default OFF)

## TL;DR

**Done 2026-11-21.** `native/simorgh-native` ports `sanitizeModelOutput` + `markUntrusted` from
`phoenix-core/src/security.ts` to Rust with a byte-identical contract (findings order included),
17 unit tests, a 346-input differential test against the *live* TS implementation (negative control
FIRED), a C ABI + cdylib + zero-import Wasm artifact, and block-amortised benchmarks. **Measured
1.5–1.7× slower than V8 on this box** — the audit's "no CPU win" verdict survives, so the module is
**not wired into the request path** and ships default OFF as an FFI-ready artifact for hosts without
a JS engine.

## What shipped (2026-11-21)

- `native/Cargo.toml` + `native/simorgh-native/` — lib + cdylib + staticlib + CLI + bench.
- `shield.rs` — the port (Cow-based, allocation-free on the no-op path; byte-level prefilter for the
  tag pass; documented surrogate-boundary divergence).
- `tests/shield_vectors.rs` — the repo's own TS fixtures, ported (17 tests).
- `test/fixtures.json` + `test/differential.mjs` — 46 fixtures + 300 seeded adversarial, TS-vs-Rust
  byte comparison with comparator negative control.
- `test/bench-node.mjs` — both implementations, identical inputs, one box, one session.
- C ABI (`simorgh_native_shield_sanitize`, `simorgh_native_last_findings_json`,
  `simorgh_native_abi_version`, `simorgh_native_max_output_chars`) verified via Python ctypes.
- Wasm artifact verified via `WebAssembly.Module.imports()` → `[]` (zero imports).

## Acceptance

- [x] `cd native && cargo test --release` — 17/17.
- [x] `node native/test/differential.mjs` — 346/346 byte-identical, negative control FIRED.
- [x] `node native/test/bench-node.mjs` — TS-vs-Rust table recorded (1.5–1.7× slower, honest).
- [x] FFI end-to-end verified (ctypes).
- [x] Default OFF: nothing in `phoenix-core/src` or `src/` imports the module.

## Revisit trigger

Only if a hand-written (non-regex) scanner demonstrably beats V8 on this workload under the ADR-0010
gates. The differential harness is the machinery that makes any future port checkable.