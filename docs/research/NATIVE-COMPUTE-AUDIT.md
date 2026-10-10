---
type: "Engineering Audit"
title: "Native Compute Audit"
description: "Measured CPU-cost study deciding whether any Simorgh request-path component justifies a native rewrite."
tags:
  - simorgh
  - benchmark
  - performance
  - no-rust
  - okf
generated:
  by: "agent:gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "stable"
stale_after: "2027-01-10T00:00:00Z"
sources:
  - id: native-audit-harness
    resource: "../bench/native-audit/run.mjs"
    title: "Benchmark harness"
  - id: roadmap-spine
    resource: "ROADMAP-SPINE.md"
    title: "Current freeze list"
---
# Native Compute Audit

> **TL;DR:** no Rust/Wasm core now. The measured scheduler is negligible and quota planning is not
> wired into production. First fix the execution path and the uncapped-input risk; re-measure only
> after retrieval/reranking creates a real CPU hotspot.

**Question:** does Simorgh need a Rust/Wasm core?
**Answer:** no. Six candidates measured; five REJECT, one DEFER with a named trigger.
The DEFER is not about Rust — it is about an uncapped input.

---

## 1. Method, and why it is not the obvious one

`bench/native-audit/run.mjs` imports the real functions from `phoenix-core/src/*.ts`.
No function is copied: a copied function measures the copy, not the code. Plain Node,
`node:perf_hooks` only, no network, no dependency added.

**Machine** (every number below is from this box):

| | |
|---|---|
| CPU | Intel Core i5-3570 @ 3.40 GHz, 4 cores |
| RAM | 15.6 GiB |
| OS | linux 5.15.0-198-generic, x64 |
| Node | v26.7.0 |
| Load average at pass A | 2.42 / 2.47 / 2.02 — a busy box; reported, not corrected for |

**Timing: block-amortised, because single-call timing is wrong here.** The first version of
this harness wrapped one `performance.now()` around one call. It produced pass-A/pass-B median
ratios from **0.70 to 1.60** and a mean 2–4× the median. That is not machine noise. A 40 ns
timer cannot see a 40 µs kernel preemption, so a 50 ns call gets charged the time the scheduler
stole, and on a box at loadavg 2.4 that happens constantly.

The fix is amortisation. Each **sample** is a **block** of K calls sized so a block lasts ~500 µs —
long enough that one preemption moves a sample by <10%. Per-call cost is `blockElapsed / K`. N
reported is total *calls*, not samples, because a number without its sample size is not a
measurement. An empty-loop baseline is measured through the identical path and subtracted
(`0.001 µs/call`, N=24.7M); it is three orders of magnitude below the smallest candidate and is
reported rather than assumed. Warmup and calibration are budgeted in **time**, not call count,
because a fixed count costs 1.8 s on the 128 KB sanitizer and is wasted on the sub-microsecond rows.

### Negative control — required, and there are two

1. **The assertions can fail.** 21 correctness assertions run before any timing, covering
   `windowRemaining` (fresh / rolled / unpublished), `capacityFor` (ready / impossible),
   `planQuotaRun` (picks the abundant account / refuses paid / allows paid under `PAID_ALLOWED`),
   `postSpendValue` ordering, the sanitizer (strips a planted `<script>` *and* leaves clean text
   byte-identical *and* records the finding), `parseExecuteBody` (32 000 accepted, 32 001 rejected),
   `constantTimeEqual` (match / mismatch through the injected port), `describeFlock`,
   `flockRetryAfterSeconds`, `nextLatencyEma`. Then one deliberately wrong expectation
   (`check("planted", 1, 2)`) is pushed through the same `check()` and **confirmed to throw**.
   `results.json` records `negativeControl: FIRED`. If that string ever reads `DID NOT FIRE`, the
   21 assertions prove nothing and the run is void.
2. **The timing is stable.** Three full passes in-process: worst median spread **12.8%**, most
   candidates under 3%. And across two *separate processes*, `sanitize.clean.16KB` measured
   **44.272 µs** then **44.256 µs** — 0.04% apart.

---

## 2. CPU inventory — what is actually on the request path

Read from the code, not assumed:

| Site | In the `/api/v1/agent/execute` path? |
|---|---|
| `parseExecuteBody` (`security.ts:104`) | yes — router, before the pipeline |
| `constantTimeEqual` (`security.ts:54`) | yes — auth |
| `runToolRound` → `truncate` (`agent.ts:113`) | yes — ≤4 iterations (`MAX_TOOL_ITERATIONS`) |
| `buildSynthesisPrompt` → `markUntrusted` (`agent.ts:146`, `security.ts:494`) | yes |
| `sanitizeModelOutput(result.answer)` (`execute.ts:166`) | yes |
| `sanitizeModelOutput(o.result)` × ≤4 (`execute.ts:210–213`) | yes |
| `contextStore.put`, `ledger.logEntry`, `provider.call` | yes — **I/O, not CPU** |
| `describeFlock` (`flock.ts:190`) | no — `/api/v1/flock/status` only |
| **`planQuotaRun` (`quota.ts:463`)** | **NO — see below** |

**The brief's primary candidate is not wired.** `planQuotaRun` is called from exactly one place,
`tasks.ts:446` inside `planTaskRun`, and `planTaskRun` has **no non-test caller** anywhere in
`phoenix-core/src` or `src`. The deployed Cloudflare app never calls it. The Durable Object's own
scheduler (`src/flock.ts:472–487`) is a lease/due-state machine — `nextDueTasks` → `claimTask` →
`finishTask`, all SQL — and never consults quota rows, although it stores them (`src/flock.ts:383`).
So the scheduler is exported, tested, and not on the hot path at all.

**Real input sizes** (not synthetic worst cases): 3 providers is the shipped default; 8 is a busy
self-hosted deployment; 64 is deliberately past any real one. Answers are prose. Tool results are
hard-capped at `MAX_TOOL_RESULT_CHARS = 2_000`, and iterations at `MAX_TOOL_ITERATIONS = 4`, so the
tool-result work per request is bounded at ~8 KB no matter what the tools do.

---

## 3. Measurements

Median / p95 / p99 in microseconds. **N is total calls.** Pass A. Full data in
`bench/native-audit/results.json`.

| candidate | median µs | p95 µs | p99 µs | N | 3-pass spread |
|---|---|---|---|---|---|
| `planQuotaRun.n=3` | **0.701** | 0.871 | 1.041 | 1,089,600 | 12.8% |
| `planQuotaRun.n=8` | 1.648 | 2.270 | 5.288 | 588,000 | 9.3% |
| `planQuotaRun.n=64` | 12.935 | 19.577 | 30.059 | 84,000 | 1.3% |
| `planQuotaRun.urgent.n=8` | 1.747 | 2.722 | 3.431 | 566,400 | 4.3% |
| `postSpendValue` | 0.192 | 0.317 | 0.353 | 5,025,600 | 8.9% |
| `windowRemaining` | 0.007 | 0.007 | 0.007 | 27,676,800 | 0% |
| `capacityFor` | 0.190 | 0.341 | 0.584 | 5,020,800 | 4.2% |
| `nextLatencyEma` | 0.010 | 0.011 | 0.016 | 19,608,000 | 0% |
| `sanitize.clean.1KB` | 3.076 | 3.169 | 3.907 | 381,600 | 1.4% |
| `sanitize.clean.4KB` | 11.302 | 11.590 | 11.917 | 105,600 | 1.4% |
| `sanitize.clean.16KB` | 44.256 | 48.503 | 54.761 | 26,400 | 1.6% |
| `sanitize.clean.128KB` | 350.320 | 404.465 | 457.606 | 2,400 | 0.3% |
| `sanitize.adversarial.4KB` | 126.964 | 169.033 | 201.233 | 9,600 | 2.7% |
| `sanitize.adversarial.16KB` | 507.598 | 692.407 | 777.201 | 2,400 | 2.0% |
| `parseExecuteBody.8192chars` | 6.436 | 8.770 | 10.753 | 141,600 | 7.6% |
| `parseExecuteBody.31990chars` | 17.177 | 24.116 | 27.775 | 64,800 | 1.2% |
| `buildSynthesisPrompt.4x2KB` | 9.721 | 16.523 | 24.118 | 117,600 | 4.4% |
| `markUntrusted.8KB` | 7.058 | 12.019 | 16.953 | 153,600 | 8.4% |
| `constantTimeEqual.sha256` | 8.715 | 11.643 | 36.938 | 93,600 | 3.8% |
| `describeFlock.n=8` | 0.528 | 1.294 | 1.743 | 2,025,600 | 4.8% |

### The composite: one whole request, measured

Rather than sum separately-timed rows, the whole synchronous CPU of one execute request was timed
as a unit, **with and without the shield**, so the shield's share is a measured difference:

| answer size | request CPU, with shield | without shield | shield costs | share |
|---|---|---|---|---|
| 1 KB | 66.356 µs | 40.478 µs | 25.878 µs | 39.0% |
| 4 KB | 74.707 µs | 40.094 µs | 34.613 µs | 46.3% |
| 16 KB | 109.096 µs | 42.609 µs | 66.487 µs | 60.9% |
| 128 KB | 428.906 µs | — | — | — |
| **128 KB adversarial** | **4,714.457 µs** (p95 6,956.484, **p99 11,720.251**) | — | — | — |

The in-situ difference (25.9 µs at 1 KB) is *lower* than the sum of the standalone rows
(48.4 µs) because a tight composite loop keeps the regexes and the strings cache-warm, while each
standalone row pays its own colder path. The in-situ number is the one the request actually pays,
so it is the one used below.

---

## 4. The ceiling — this is what decides everything

Two verified Cloudflare facts, both from `developers.cloudflare.com/workers/platform/limits`:

- **CPU time per HTTP request: 10 ms (Free), 30 s default / 5 min max (Paid).**
- **"Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does
  not count toward CPU time."**

The second is the load-bearing one. It means the provider `fetch` — the term the brief guessed at
900 ms — contributes **zero** to the budget that native compute would ever consume. Making the inner
loop faster cannot touch it.

So the denominator is the CF CPU budget, and I can compute against it with **no assumption at all**:

| candidate | median | as % of the **10 ms Free** CPU limit |
|---|---|---|
| `planQuotaRun.n=3` | 0.701 µs | **0.0070%** |
| `planQuotaRun.n=8` | 1.648 µs | 0.0165% |
| `planQuotaRun.n=64` | 12.935 µs | 0.1294% |
| whole request, 16 KB answer | 109.096 µs | 1.09% |
| whole request, 128 KB adversarial | 4,714.457 µs | 47.1% (p95 69.6%, **p99 117%**) |

**A scheduler that is not even called.** `planQuotaRun(3 providers)` costs 0.701 µs. The request it
would sit inside costs 66.4 µs of CPU. So it is **1.06% of the request's own CPU** — and that CPU
is 0.66% of the smallest budget Cloudflare offers. Multiplying: an *infinitely fast* Rust scheduler
buys **0.007% of one request**. That argument needs no external number and no assumption about
provider latency.

**A break-even, stated instead of a guess.** For the scheduler to be worth 1% of a request, the
request would have to take 70 µs — less than the request's own measured CPU. For the *whole* measured
JS path to matter at all on a real request, the provider call would have to be ~1 ms. Remote LLM
inference is structurally far above that, so the ceiling stays under 0.1% on any plausible wall time.

---

## 5. Candidates

```
CANDIDATE: Quota scheduler (the brief's primary candidate)
HOTSPOT:                 phoenix-core/src/quota.ts:463 (planQuotaRun), :330 (postSpendValue),
                         :229 (windowRemaining), :291 (capacityFor)
CURRENT IMPLEMENTATION:  A single pass over the candidate array (quota.ts:478) plus one linear
                         pickMax/pickUrgent; the urgent path copies and sorts (quota.ts:553).
                         One Math.exp per window in postSpendValue (quota.ts:343).
MEASURED COST:           n=3: 0.701 / 0.871 / 1.041 µs, N=1,089,600.
                         n=8: 1.648 / 2.270 µs, N=588,000.
                         n=64: 12.935 / 19.577 µs, N=84,000.
                         Node v26.7.0, i5-3570 @3.40GHz, 4 cores, loadavg 2.42.
REAL INPUT SIZE:         3 provider rows at the shipped default; 8 when busy. 64 rows is past
                         any real deployment.
EXPECTED BENEFIT AT BEST: 0.0070% of the Workers Free per-request CPU limit at n=3. planQuotaRun
                         has NO non-test caller: it is reached only via planTaskRun (tasks.ts:431),
                         which nothing in phoenix-core/src or src calls. There is no per-request
                         CPU for it to occupy.
WASM COMPATIBLE:         Yes — pure computation, no I/O, no filesystem, no network.
BUNDLE IMPACT:           A Rust/Wasm module is typically LARGER than the JS it replaces
                         (verified, developers.cloudflare.com/workers/runtime-apis/webassembly).
                         It would also break phoenix-core's runtime-agnostic rule as enforced by
                         boundary.test.ts unless added as a separate package behind a port.
CROSS-RUNTIME REUSE:     None. The Go gateway has its OWN, separate scheduler
                         (packages/providers/adapter.go:187 Registry.Select) and no Wasm runtime is
                         present in the Go workspace (no wazero/wasmtime). Reuse would mean porting
                         the policy to Go too.
MAINTENANCE COST:         Two schedulers to keep in agreement (ADR-0001 already records Go/TS
                         policy drift), plus a Rust toolchain and a cross-language boundary.
OSS CORE AVAILABLE:      No. Searched; only generic single-key rate limiters exist
                         (tokio-rate-limit, rate-guard-core). "Choose the account leaving the most
                         post-spend capacity, weighted by exp(-untilReset/horizon)" is bespoke
                         policy with no OSS equivalent.
VERDICT:                 REJECT
REASON:                  0.701 µs of unwired code cannot be 0.007% of anything, because it is
                         never called on the request path.
```

```
CANDIDATE: Output shield — sanitizeModelOutput
HOTSPOT:                 phoenix-core/src/security.ts:376, scrubTags :432, TAG_TOKEN :308
CURRENT IMPLEMENTATION:  Four sequential regex passes over the whole string, then a tag-aware pass
                         whose callback runs three more regexes per tag match. Deliberately returns
                         its input by identity when nothing matched (security.ts:392).
MEASURED COST:           clean 1KB: 3.076 / 3.169 µs, N=381,600.
                         clean 4KB: 11.302 / 11.590 µs, N=105,600.
                         clean 16KB: 44.256 / 48.503 µs, N=26,400.
                         clean 128KB: 350.320 / 404.465 µs, N=2,400.
                         adversarial 4KB: 126.964 / 169.033 µs, N=9,600  (11.3x clean).
                         adversarial 16KB: 507.598 / 692.407 µs, N=2,400  (11.5x clean).
                         In situ: 25.9-66.5 µs = 39-61% of one request's measured CPU.
                         Same machine as above.
REAL INPUT SIZE:          Prose answers, normally 1-16 KB. Tool results are already capped at
                         2,000 chars x 4 iterations, so that part is bounded. THE ANSWER ITSELF IS
                         NOT CAPPED — provider.ts:122 returns data.choices[0].message.content
                         verbatim.
EXPECTED BENEFIT AT BEST: At a realistic 16 KB answer the shield is 66.5 µs of a 109.1 µs request,
                         but that request is 1.09% of the Free CPU limit, so the entire shield is
                         ~0.66% and Rust would buy at most that much. A 2.73 µs/KB linear scan is
                         also already competitive with the OSS alternative on its own numbers
                         (ammonia 4.2.1 benchmarks itself at 87.5 µs for a small document).
WASM COMPATIBLE:          Yes — pure computation.
BUNDLE IMPACT:            As above: larger than the JS it replaces; longer isolate startup.
CROSS-RUNTIME REUSE:      None needed — the shield is TS-only. But that also means a Wasm core
                          would serve exactly one caller and could not be shared with Go.
MAINTENANCE COST:         High for the gain. This is the security boundary: the rules are argued in
                          40 lines of comments, the identity-on-no-match guarantee is load-bearing,
                          and `findings` drives a ledger row (execute.ts:186) and a dashboard.
                          A Rust port would move that policy behind an FFI edge where the repo's
                          own test story cannot see it.
OSS CORE AVAILABLE:       YES, and mature. `ammonia` v4.2.1, Apache-2.0, released 2026-10-03
                          (verified via GitHub releases feed), actively maintained with security
                          fixes shipping in 2026-07 and 2026-10. `lol_html` v3.0.1, BSD-3-Clause,
                          released 2026-07-29, maintained by Cloudflare. Neither is a drop-in:
                          ammonia is a whitelist HTML sanitizer whose policy differs from this
                          shield's tag-token removal, and lol_html is a streaming rewriter, not a
                          neutraliser. Adopting either would be a POLICY change, not a speed change.
VERDICT:                  DEFER
REASON:                  At every realistic input size the whole shield is under 1% of the Workers
                         Free CPU limit, but at 128 KB of planted payload one request costs 4.71 ms
                         (p95 6.96 ms, p99 11.72 ms) = 47%/70%/117% of that limit, and provider.ts:122
                         does not cap the answer that feeds it.
TRIGGER:                 Cap the answer length before sanitizing, or observe any provider returning
                         over 64 KB. Revisit only if BOTH are true: a real answer above 64 KB AND
                         the shield above 1 ms measured in situ. The fix for the finding is a
                         length cap, not a faster inner loop.
```

```
CANDIDATE: Request-body parser — parseExecuteBody
HOTSPOT:                 phoenix-core/src/security.ts:104
CURRENT IMPLEMENTATION:  JSON.parse plus a per-tool allowlist loop (security.ts:160) and an
                         identifier pattern test (security.ts:192). 32_000-char body cap,
                         12_000-char prompt cap, 8-tool cap.
MEASURED COST:           8 KB body: 6.436 / 8.770 µs, N=141,600.
                         31,990 chars (just under the cap): 17.177 / 24.116 µs, N=64,800.
REAL INPUT SIZE:         One request body. Under the cap by construction; a 32 KiB body is a 413
                         before the parser runs, so 31,990 is the true worst legal input.
EXPECTED BENEFIT AT BEST: 0.17% of the Free CPU limit at the cap. JSON.parse is native code
                         already; the JS around it is the allowlist loop over at most 8 tools.
WASM COMPATIBLE:          No reason to. Handing JSON.parse to Wasm would add a boundary around the
                         fastest primitive in the runtime.
BUNDLE IMPACT:            A Wasm JSON layer would be larger than JSON.parse and slower.
CROSS-RUNTIME REUSE:      N/A.
MAINTENANCE COST:         A hand-written JSON parser in Rust is a correctness liability against a
                         native primitive that never regresses.
OSS CORE AVAILABLE:       `serde_json` exists but is not a Wasm-friendly improvement over JSON.parse.
VERDICT:                  REJECT
REASON:                  The input is capped at 32 KB by the same request it serves, so the cost is
                         already bounded at 0.17% of the budget with nothing left to win.
```

```
CANDIDATE: Auth token comparison — constantTimeEqual
HOTSPOT:                 phoenix-core/src/security.ts:54
CURRENT IMPLEMENTATION:  Takes the digest as an INJECTED PORT (`Sha256`, security.ts:54-59), so the
                         engine never hashes. The host supplies it — node:crypto at
                         phoenix-core/src/node/index.ts:71-72. Then a fixed-length XOR loop.
                         The brief asked me to check whether hashing is already delegated: it is.
MEASURED COST:           8.715 / 11.643 µs, N=93,600 — two SHA-256 of a short token through the
                         node host's port.
REAL INPUT SIZE:          Two strings of ~12 bytes (an API key), once per authenticated request.
EXPECTED BENEFIT AT BEST: 0.087% of the Free CPU limit, and ~99% of it is inside node:crypto's
                         native SHA-256, which a Wasm module cannot beat — V8's crypto is already
                         native and already the platform's.
WASM COMPATIBLE:          Yes, and pointless: it would replace a native OpenSSL-backed digest with
                         a slower portable one.
BUNDLE IMPACT:            Worse — a Rust SHA-256 adds a module to save 0.08%.
CROSS-RUNTIME REUSE:      The Go gateway compares tokens in Go. No shared artefact.
MAINTENANCE COST:         Replacing a platform digest with a hand-rolled one on an auth path is a
                         downgrade in reviewability and in audit surface.
OSS CORE AVAILABLE:       `sha2` (RustCrypto) is excellent and audited — which is precisely why it
                         is not needed here.
VERDICT:                  REJECT
REASON:                  87% of an already-negligible cost is a native digest the engine does not
                         even own, and the port boundary that keeps it swappable is already correct.
```

```
CANDIDATE: Agent-loop string work — buildSynthesisPrompt + markUntrusted
HOTSPOT:                 phoenix-core/src/agent.ts:146 (buildSynthesisPrompt),
                         phoenix-core/src/security.ts:494 (markUntrusted)
CURRENT IMPLEMENTATION:  Array .join + two split/join passes to neutralise the frame tokens
                         (security.ts:495-499), then a lines.join.
MEASURED COST:           buildSynthesisPrompt, 4 x 2 KB observations: 9.721 / 16.523 µs, N=117,600.
                         markUntrusted on 8 KB: 7.058 / 12.019 µs, N=153,600.
REAL INPUT SIZE:          Bounded by construction: 4 iterations x 2,000-char truncated results =
                         ~8 KB, whatever the tools return (MAX_TOOL_ITERATIONS, MAX_TOOL_RESULT_CHARS).
EXPECTED BENEFIT AT BEST: 0.17% of the Free CPU limit, and the input is hard-capped.
WASM COMPATIBLE:          Yes.
BUNDLE IMPACT:            Not worth a module.
CROSS-RUNTIME REUSE:      None; TS-only.
MAINTENANCE COST:         Split/join on a fixed 28-char and 30-char delimiter is already the fast
                         shape. A hand-written scanner would be slower and less obviously correct.
OSS CORE AVAILABLE:       None needed.
VERDICT:                  REJECT
REASON:                  The input is hard-capped at ~8 KB by the same module, so the cost is
                         bounded and small, and split/join is already the right primitive.
```

```
CANDIDATE: Flock status assembly — describeFlock
HOTSPOT:                 phoenix-core/src/flock.ts:190
CURRENT IMPLEMENTATION:  One pass building a per-bird view, plus the soonest-cooldown reduction
                         (flockRetryAfterSeconds, :170).
MEASURED COST:           0.528 / 1.294 µs at 8 birds, N=2,025,600.
REAL INPUT SIZE:          The operator's declared flock — 8 birds here, 3 by default.
EXPECTED BENEFIT AT BEST: 0.005% of the Free CPU limit, and it is not on the execute path at all;
                         it serves /api/v1/flock/status.
WASM COMPATIBLE:          Yes.
BUNDLE IMPACT:            Not worth it.
CROSS-RUNTIME REUSE:      None.
MAINTENANCE COST:         Not worth any.
OSS CORE AVAILABLE:       N/A.
VERDICT:                  REJECT
REASON:                  0.528 µs for an 8-bird status view on a route that is not the hot path.
```

```
CANDIDATE: Ledger and quota SQL — createLedger / readAllQuota / declareQuota
HOTSPOT:                 phoenix-core/src/ledger.ts:83, :86, :118; phoenix-core/src/quota.ts:789
CURRENT IMPLEMENTATION:  Synchronous SqlPort execs. SqlPort is synchronous by contract, which
                         ADR-0002 records as the portability boundary.
MEASURED COST:           NOT MEASURED, deliberately. There is no SQL in this harness and no
                         SqlPort to measure against: SqlPort is synchronous, so a networked database
                         cannot implement it, and the real per-request cost is the DO RPC and the
                         storage write, not the JavaScript that issues them.
REAL INPUT SIZE:          One INSERT per request (execute.ts:133), plus a conditional second for a
                         shield block (execute.ts:186); one read per scheduled task.
EXPECTED BENEFIT AT BEST: N/A — the cost is the I/O round trip. On Cloudflare, waiting on a
                         database query does not count toward CPU time at all (verified). No inner
                         loop exists to accelerate.
WASM COMPATIBLE:          N/A — a Wasm module cannot touch the network or the filesystem.
BUNDLE IMPACT:            N/A.
CROSS-RUNTIME REUSE:      N/A.
MAINTENANCE COST:         N/A.
OSS CORE AVAILABLE:       N/A.
VERDICT:                  REJECT
REASON:                  I/O-bound by contract, and Cloudflare excludes the wait from CPU time, so
                         there is no CPU term to reduce.
```

---

## 6. Cross-cutting assessment of Rust/Wasm

| axis | finding |
|---|---|
| **CPU cost** | Nothing to win. 0.007% (scheduler) to 1.09% (the entire measured request path) of the 10 ms Free budget, and 117% only in an adversarial 128 KB case that is a bug, not a workload. |
| **Determinism** | Already deterministic. The arithmetic is float64 with no accumulation order that matters at n≤64, and no candidate is in a loop whose result depends on timing. Wasm buys nothing here. |
| **Memory** | 128 MB isolate limit (verified). A Wasm module reserves linear memory per isolate; the measured working set of a request is one ~32 KB body plus one answer string. Wasm memory overhead exceeds the working set. |
| **Bundle size** | Verified: "Workers that use WebAssembly are typically larger than an equivalent Worker written in JavaScript. The larger your Worker is, the longer it may take your Worker to start." |
| **CF cold start** | `WebAssembly.instantiate()` happens at module scope, **per isolate** (verified), and `instantiateStreaming` is not supported. Every cold isolate pays module compile + instantiate for code that is idle most of its life. |
| **Cross-runtime reuse** | None available. The Go gateway has a separate scheduler (`Registry.Select`) and no Wasm runtime in the workspace. |
| **Maintenance** | Two runtimes' policies must agree (ADR-0001 already records drift), plus a Rust toolchain, plus an FFI seam across the one boundary this repo machine-enforces (`boundary.test.ts`). |
| **Mature OSS Rust** | Exists and is healthy for the *sanitizer* only: `ammonia` 4.2.1, Apache-2.0, 2026-10-03; `lol_html` 3.0.1, BSD-3-Clause, 2026-07-29. Nothing exists for the quota scheduler. Neither is a drop-in — both would change the security *policy*, which is the one thing this shield's comments argue for at length. |

**Verdict: REJECT the Rust/Wasm core.** The repo's own principle — own the orchestration and
composition layer, spend effort where there is leverage — points the same way. Adding a Rust core
here buys under 1% of the smallest budget Cloudflare offers, at the price of a second language, a
second scheduler, a per-isolate startup cost, and an FFI seam across a boundary this repo tests for.

---

## 7. What I could NOT verify

1. **Provider call latency.** Unmeasurable here and unmeasured in the repo — `docs/OBSERVIBILITY.md`
   records that "provider latency is recorded nowhere on the TypeScript side (while the Go side
   keeps an EMA)" (`docs/STATE-OF-PROJECT.md:357`). So I did **not** assert the brief's 900 ms
   example. The ceiling in §4 is computed against the CF CPU budget instead, which needs no
   latency assumption. *How to verify:* record `provider.call` duration in the TS ledger and read
   the p50/p95.
2. **The exact per-module Wasm size limit** (commonly quoted as 1 MiB Free / 10 MiB Paid). I got
   the CPU limits, the 128 MB memory limit, the instantiate-per-isolate behaviour and the
   "Wasm Workers are larger" statement from Cloudflare's docs; I did **not** get a first-party
   number for the per-module cap. *How to verify:* `wrangler deploy --dry-run` with a stub `.wasm`,
   or the limits page directly.
3. **Real answer-size distribution.** I established that `provider.ts:122` does not cap the answer,
   and measured the sanitizer across 1 KB–128 KB. I did **not** observe what real providers actually
   return. *How to verify:* sample the ledger's stored answers, or log `result.answer.length`.
4. **Any per-isolate startup measurement.** I reasoned from the documented "larger = slower start"
   and per-isolate instantiation. I did not measure Simorgh's own cold start, so no
   before/after bundle or cold-start figure is claimed.
5. **Go-side cost.** The Go gateway's `Registry.Select` was read but not benchmarked. Given the TS
   scheduler is sub-microsecond, that is very unlikely to change the verdict, but it is unmeasured.

---

## 8. What I found but did NOT fix (outside my allowlist)

1. **`provider.ts:122` returns an uncapped answer.** `data.choices?.[0]?.message?.content ?? ""`
   with no length bound, and that string goes straight to `sanitizeModelOutput` (execute.ts:166)
   and to the per-observation re-sanitize (execute.ts:210-213). Measured: a 128 KB answer carrying
   every planted rule costs **4.71 ms** (p95 6.96, p99 11.72) — 47%/70%/**117%** of the Workers
   Free per-request CPU limit. Tool results are already capped at 2,000 chars; the answer is not.
   This is the single highest-value finding in the audit and it is a one-line guard. I did not add
   it: `phoenix-core/**` is read-only for this task.
2. **`planQuotaRun` is dead code on the deployed app.** Exported from the core's public API, tested,
   reachable only from `planTaskRun` (`tasks.ts:431`), which nothing calls. Either wire it or stop
   exporting it — an untested-in-production scheduler that looks load-bearing is worse than no
   scheduler. Not fixed: outside the allowlist, and the decision is the Lead's.
3. **Adversarial sanitize is ~11.4× clean at every size** (126.964/11.302 at 4 KB, 507.598/44.256 at
   16 KB). It is linear in input — 2.73 µs/KB clean — so this is a constant factor from
   `scrubTags` (security.ts:432) running three regexes plus a string build per tag match, not
   catastrophic backtracking. Not fixed: the constant factor is the cheapest remaining win in the
   whole codebase if the uncapped answer is ever closed.
4. **Provider latency is recorded nowhere on the TS side** (`docs/STATE-OF-PROJECT.md:357`), which
   is why item 5 in §7 could not be closed. Reported, not touched.

---

## 9. Acceptance

```bash
cd /home/shai/personal/projects/projects/simorgh
node --version
ls -R bench/native-audit
node bench/native-audit/run.mjs
```

Reproduces `bench/native-audit/results.json`. Runs offline in ~2.5 min, exits 0, 21 assertions pass,
negative control FIRES, worst 3-pass median spread 12.8%. Read-only on `phoenix-core/**` and
`src/**`; no dependency added; no Rust, `wasm-pack` or toolchain introduced; no git commit, push
or rebase.

**One-line summary:** six candidates measured; the entire synchronous CPU of one request is 66–109 µs
at realistic sizes — **0.66–1.09% of the Workers Free per-request CPU limit** — while
`planQuotaRun`, the brief's primary candidate, is 0.701 µs of code nothing calls. REJECT the Rust/Wasm
core; DEFER the shield behind a named trigger that is really an uncapped-input bug, not a
speed problem.

TASK-012-END