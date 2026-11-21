---
type: "Native Module"
title: "simorgh-native — optional native acceleration modules"
description: "The first Rust code in the repository: the model-output shield ported faithfully from phoenix-core, with differential tests, benchmarks, and a C ABI. Never linked into the engine."
tags:
  - simorgh
  - native
  - rust
  - shield
  - okf
generated:
  by: "kilo/ernie-5.5-flash-preview"
  at: "2026-11-21T15:00:00Z"
status: "stable"
verified:
  by: "process:native-diff-2026-11-21"
  at: "2026-11-21T15:00:00Z"
stale_after: "2027-02-21T00:00:00Z"
sources:
  - id: ts-reference
    resource: "../phoenix-core/src/security.ts"
    title: "The TypeScript reference: sanitizeModelOutput and markUntrusted"
  - id: native-audit
    resource: "../docs/research/NATIVE-COMPUTE-AUDIT.md"
    title: "The audit that measured the shield as the only hotspot above 1% of request CPU"
  - id: adr-0010
    resource: "../docs/adr/ADR-0010-native-module-policy.md"
    title: "The policy this module obeys"
  - id: differential
    resource: "test/differential.mjs"
    title: "The differential test against the live TypeScript implementation"
---

# simorgh-native — optional native acceleration modules

> **TL;DR:** this workspace is the first Rust in the repository, and deliberately **not** a core.
> The engine (`@simorgh/phoenix-core`) stays TypeScript and runtime-agnostic; a native module is an
> *optional accelerator behind a port* that a host loads when it can and silently skips when it
> cannot. The first module is the model-output shield, ported faithfully from
> `phoenix-core/src/security.ts` and pinned to it by a differential test over 346 inputs (byte-identical
> text + findings order). Measured on this box, the Rust regex port is **1.5–1.7× slower than V8** on
> this workload — the audit's "no CPU win" verdict survives the native exploration, so the module ships
> **default OFF** as an FFI-ready artifact (cdylib + zero-import Wasm) for hosts without a JS engine.
> See `docs/adr/ADR-0010-native-module-policy.md` for the policy and the full reasoning.

## Layout

| Path | Role |
|---|---|
| `Cargo.toml` | The native workspace (member: `simorgh-native`) |
| `simorgh-native/src/shield.rs` | The shield port: `sanitize_model_output`, `mark_untrusted` |
| `simorgh-native/src/lib.rs` | The library root + the C ABI (`simorgh_native_*`) |
| `simorgh-native/src/bin/simorgh-native.rs` | The CLI: `sanitize`, `mark-untrusted`, `--batch` |
| `simorgh-native/src/bin/native-bench.rs` | The block-amortised Rust benchmark (mirrors `bench/native-audit` method) |
| `simorgh-native/tests/shield_vectors.rs` | 17 unit tests — the repo's own TypeScript fixtures, ported |
| `test/fixtures.json` | 46 differential fixtures (the repo's + adversarial + astral + truncation) |
| `test/differential.mjs` | The differential test: live TS reference vs Rust CLI, with a negative control |
| `test/bench-node.mjs` | The TS-vs-Rust benchmark orchestrator (both sides, identical inputs, one box) |

## Commands

```bash
cd native
cargo build --release                    # native cdylib + staticlib + CLI + bench
cargo test --release                     # 17 unit tests (the TS fixtures, ported)
cargo build --release --target wasm32-unknown-unknown   # the Wasm artifact (zero imports)

node native/test/differential.mjs        # rust === typescript, 346 inputs, negative control
node native/test/bench-node.mjs          # TS-vs-Rust comparison table (needs cargo build --release)
./target/release/native-bench --markdown # Rust-only table (correctness + negative control first)
```

The differential test requires Node ≥ 23 (native TypeScript type-stripping, which is how it imports
`phoenix-core/src/security.ts` unbuilt — the same property the whole engine relies on).

## The fidelity contract (why a port is allowed at all)

A second implementation of a security control is exactly the "two definitions, nothing comparing them"
trap this repository exists to avoid — so the port exists only with:

1. **A differential test against the live TypeScript reference** (`test/differential.mjs`): not a copy,
   not a re-implementation — the real `sanitizeModelOutput` imported from `phoenix-core/src/security.ts`.
   46 fixtures (the repo's own cases, plus astral-plane smuggling, bidi isolates, malformed tags, and
   truncation boundaries) + 300 seeded adversarial inputs, compared on **text bytes AND findings order**.
   The comparator self-tests with a planted difference (negative control) and refuses to pass if the
   sabotage is not caught.
2. **A reproducible benchmark** with the audit's method (block-amortised, empty-loop baseline, three
   passes): `test/bench-node.mjs` times both implementations over identical bytes on one box.
3. **A measured verdict, honestly recorded**: on this host (i5-3570, Node 26.11.1, rustc 1.99.0) the
   Rust port is 1.5–1.7× slower than V8 on this workload — V8's irregexp is exceptionally fast and the
   `regex` crate does not beat it here. The module is therefore **not wired into the request path**; it
   is an optional FFI artifact for hosts without a JS engine (Go via cgo, Node via the cdylib, any Wasm
   host), and the differential harness is the reusable machinery for the next native candidate.

The one intentional divergence is documented in `shield.rs`: JavaScript `slice` can split a surrogate
pair at the 32,000-unit cap; a Rust `String` cannot hold a lone surrogate, so the port truncates at the
largest char boundary within the cap. The outputs differ only when an astral char straddles the boundary
exactly (≤ 1 UTF-16 unit, never a byte of the same character twice); the fixtures avoid that boundary.

## The C ABI (FFI surface)

```c
uint32_t simorgh_native_abi_version(void);
size_t   simorgh_native_max_output_chars(void);
// Two-call sizing: pass NULL/0 first, then a buffer of the returned size.
size_t   simorgh_native_shield_sanitize(const uint8_t *input, size_t input_len,
                                        uint8_t *out, size_t out_cap);
size_t   simorgh_native_last_findings_json(uint8_t *out, size_t out_cap);
```

Verified end-to-end from Python ctypes on this box (2026-11-21): ABI version 1, cap 32,000,
`answer: <script>alert(1)</script> done` → `answer: alert(1) done` with findings `["tag:script"]`,
and the two-call sizing returns 21 without writing when `out_cap` is 0.

## Artifact evidence (REA, 2026-11-21)

| Artifact | Evidence |
|---|---|
| `libsimorgh_native.so` | REA `inspect_binary_hardening` (`ev_92866f20…`): NX enabled, RELRO (BIND_NOW) enabled, no RPATH/RUNPATH, not stripped |
| `simorgh_native.wasm` | Node `WebAssembly.Module.imports()`: **zero imports** — no WASI, no env; exports `memory` + the four FFI functions; 1.2 MB. It can run in any Wasm host with no I/O capability by construction |
| Go gateway (`/tmp/kilo/simorgh-gateway`) | REA `inspect_go_binary` (`ev_eeb697e0…`): go1.27.2, git revision `f3b0436` (main HEAD), deps `packages/{config,crypto,ledger,providers}` + `x/crypto v0.31.0` — evidence for the G2 convergence task |