# ADR-0007 — What Simorgh adopts from working open source, and what it refuses

- **Status:** accepted
- **Date:** 2026-10-09
- **Decides:** which patterns from six studied repositories (plus the Godde3s stack) enter
  `phoenix-core` / `simorgh-platform`, in what order, and which are refused outright
- **Depends on:** [ADR-0001](ADR-0001-go-workspace-role.md) (two runtimes, one contract),
  [ADR-0003](ADR-0003-free-compute-capacity.md) (capacity), [ADR-0005](ADR-0005-free-only-mode.md)
  (free-only), [ADR-0006](ADR-0006-auto-router-compatibility.md) (routing vocabulary)
- **Research basis:** four reverse-engineering passes, 2026-10-09, full clones read at source
  level. Findings and anchors: `docs/research/adoption/*-ADOPTION.md` in this directory tree.

## 1. Context

The operator's directive was explicit: **modularize toward what already works, do not reinvent**.
Six repositories were studied against Simorgh's architecture — `phoenix-core` as a
runtime-agnostic engine and `simorgh-platform` as a Cloudflare-Worker control plane around it:

| Repo | What it is | Verdict in one line |
|---|---|---|
| `Godde3s/GhostBrain` | one-file free-Gemini-web → OpenAI/Anthropic API, multi-account rotation | adopt its *mechanisms*, in trigger order (§4) |
| `Godde3s/omnirouter` | Go router over GLM+Qwen+DeepSeek+ custom APIs, one compatible endpoint | adopt its *taxonomy*, never its bridges |
| `Godde3s/hermes-stack` | the whole stack on one free HF Space (deploy UX, backups, keep-alive) | strategic reference for the platform's deploy story |
| `jaavid/api-access-gateway` | Cloudflare Worker allowlisted gateway + probe control plane | same-platform sibling; adopt the probe/health *shape* |
| `morluto/rea` (MIT, ~41k★) | agent-driven reverse-engineering platform | adopt its MCP contract→catalog→test discipline |
| `Mohammad-Hasan-Kaman/agent-stream-doctor` | zero-dep SSE stream diagnostics (MIT) | adopt as a *dependency*, not a port |
| `seyed-ali-002/Dana-MCP-Server` | self-hosted MCP server exposed over Tailscale | refused now; separate trust boundary |
| `RezaEsmailGol/lahne-man` | Persian tone-preserving text-editing skill | unrelated domain; refused |

## 2. Decision

**Adopt proven mechanisms as engine modules behind existing ports, one trigger at a time —
and adopt the one definition-level defect the research exposed, now.**

The first slice is `phoenix-core/src/failures.ts`: the omnirouter research surfaced that three
hosts each carried `error === "rate_limit"`, which is the "two definitions, nothing comparing
them" trap `ledger.ts` documents with one copy per host. The string contract itself
(`"rate_limit"`, `"http_<status>"`, matched literally, never by pattern — `provider.ts`) stays
exactly as designed; what changes is that its one consumer question now has one definition both
hosts import. The richer omnirouter classifier (429/401/403/5xx/transport → retryable) is
**parked in §4 with its trigger**, because a taxonomy without a consumer is an abstraction and
this repo does not ship those.

## 3. Refusals, with reasons (the load-bearing half of this ADR)

| Refused | Why |
|---|---|
| omnirouter's playwright / uTLS / WASM proof-of-work **web bridges** | They automate logged-in web sessions — the exact "route subscription credentials" pattern the October audit (§B.2, official + press sources) shows platforms banning first and documenting after, and the repo's compliance line already forbids. Scraped capacity is not a bird. |
| omnirouter's pass-2 **"cooldown is a preference, not a block"** | Directly contradicts `health.ts`'s documented intent ("a 429 means come back later, so it waits") and risks extending limits on already-rate-limited free accounts — the audit's §F.1 failure mode #1. |
| omnirouter's live dashboard CRUD over providers | Runtime mutation of config belongs in typed ports + `SecretReader`, not a dashboard; a second config source is the two-definitions trap again. |
| Flat `.env` string chains (`AUTO_CHAIN`) | The engine's typed catalog + `servesTiers`/complexity ordering (ADR-0006) is the modular form already chosen. |
| api-access-gateway's **open egress proxy** | Simorgh federates *its own* birds; there is no `APIRoutes` KV and no open-forwarding need. Only the probe/health response shape and header-strip discipline are portable. |
| Dana's Tailscale-Funnel exposure of an MCP surface | A separate trust boundary with its own auth story; the platform fleet's remote access deserves its own ADR, not an import. |

## 4. The queue, each with the trigger that earns it

Ordered by evidence strength × effort. Nothing below is built; each row names what must be true
first. Anchors are in the research specs under `docs/research/adoption/`.

| # | Pattern (source) | Lands in | Trigger |
|---|---|---|---|
| 1 | Failure-vocabulary one definition (omnirouter insight, Simorgh shape) | `phoenix-core/src/failures.ts` | **done, this ADR** |
| 2 | Per-bird probe endpoint shape `{ok, reachable, upstream_status, latency_ms}` + header-strip helper (AAG, MIT © 2025 Jaavid — attribution required) | `simorgh-platform/src/bird-probe.ts` | an operator asks "is bird X reachable *right now*" and capability-probes' answered-shape is not enough |
| 3 | MCP contract file → generated catalog → pinned test (rea) | `simorgh-platform/src/mcp/toolContracts.ts` + `scripts/` + one test | the next MCP tool ships; the two handwritten `tools/list` lists (node.ts, mcp/server.ts) are already a divergence waiting |
| 4 | Classifier with a consumer: 401/403 → bird-scoped longer cooldown (omnirouter rule 3) | `failures.ts` + `health.ts` | a mid-flight secret-rotation story, or a measured request-waste from bad keys |
| 5 | Tool-call extraction + JSON-repair ladder (GhostBrain `:523-593`, MIT — attribution required) | `phoenix-core/src/tool-calls.ts` | the agent loop emits tool calls and a malformed call silently poisons a turn |
| 6 | History dedup (GhostBrain TokenMiser, `:320-351`) | `phoenix-core/src/history.ts` | measured history blowup — not before |
| 7 | Multi-account pool rotation (GhostBrain `:1820-1860`) | `flock.ts` + new `accounts.ts` + a secrets-*enumeration* port | one provider's free quota becomes the binding constraint and a second account is configured |
| 8 | Dual-protocol SSE shaper with sniff window + heartbeat (GhostBrain `:2328-2383`) | `phoenix-core/src/sse.ts` | the first streaming endpoint is specced |
| 9 | Catalog layer: `provider/model` addressing, aliases, named chains, TTL refresh (omnirouter §a/d) | new `catalog.ts` | two providers serve the same public model id |
| 10 | `agent-stream-doctor` as a pip dependency of the probe tooling (MIT) | probe requirements | first stream-level misbehavior report |
| 11 | **One-click "your own AI server" deploy**: free-Space bootstrap, hourly state backups to a private dataset, keep-alive ping, self-healing supervisor (hermes-stack, MIT) | `simorgh-platform/src/deploy/*` | the platform's deploy story is specced — this is the proven shape of it, and it is the row closest to the operator's stated product vision |

## 5. Attribution and license posture

Every deferred row that copies *code* (not ideas) carries its MIT notice in the derived file and a
`NOTICE` entry at the repo root, naming source repo and author — already recorded per row in
`docs/research/adoption/`. Row 1 copies no code and needs none; that distinction is deliberate and
each future row states its own.

## 6. Consequences

- The engine gained one 20-line module and zero ports; `boundary.test.ts` is untouched (the
  module is pure arithmetic plus a string comparison).
- The next five rows are *ready* — trigger, target file, and anchor all pre-agreed, so the
  eventual implementation is a port, not a design exercise.
- The refusals are as load-bearing as the adoptions: they are the answer to "why doesn't Simorgh
  just scrape free web accounts like omnirouter's bridges do", asked once, answered here.

## 7. Verification

`phoenix-core/test/failures.test.ts` — 4 tests, Node suite, no runtime bindings. Negative control
run and reverted: `isRateLimitError` was changed to `return false` and the suite went red on
exactly the two tests that claim the literal contract
(`matches the literal the providers emit`, and the cooldown-split test), with the real-world
symptom visible — every 429 would have benched a bird for 15s instead of 60s.
