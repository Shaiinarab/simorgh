# GitHub Inspiration Dossier — 2026-10-10

Found with the **`github-gold-finder`** skill (sweep → dual-score → triage → extract → register).
**Method:** 15 paced GitHub-API queries (gold pass: star-sorted, recency-floored across
`llm-gateway`/`ai-gateway`/`openai-compatible`/`llm-router`/`llm-proxy`/`mcp-server`/
`cloudflare-workers`/`workers-ai`/`agent-framework`/`rate-limiting`/`durable-*`; hype pass:
update-velocity-sorted). Pool: **295 unique repos → 256 after kill rules → 24 anchored cards**.
Kill rules applied: already-studied set, no pushes in 12+ months, no/ambiguous license,
awesome-lists/tutorials, star-farmed forks. Score axes: **fit** (domain keywords), **gold**
(log-stars + fork ratio), **hype** (stars/month).

## Already studied (dedup — not re-carded)

Godde3s family (`omnirouter`, `GhostBrain`, `hermes-stack`, `*-free-api` ×4, `opencode-edge`),
`morluto/rea`, `jaavid/api-access-gateway`, `agent-stream-doctor`, `Dana-MCP-Server`,
`lahne-man`, plus the known baseline (`litellm`, `new-api`, `kong`, `9router`,
`CLIProxyAPI`, `OmniRoute`) — see `docs/research/adoption/` (ADR-0007).

## Scored shortlist (top of pool, fit × gold × hype)

| ★ | Repo | License | Fit | Note |
|---|------|---------|-----|------|
| 17189 | lidge-jun/opencodex | MIT | 5 | protocol proxy for coding CLIs |
| 31172 | supermemoryai/supermemory | MIT | 5 | memory/context engine |
| 7082 | katanemo/plano | Apache-2.0 | 5 | AI-native data plane for agents |
| 5578 | weave-os/router | Apache-2.0 | 5 | agentic model router (README unverifiable — see rejections) |
| 2205 | theagentrouter/agent-router | Apache-2.0 | 6 | ex-Envoy AI Gateway control plane |
| 1737 | Continuum-AI-Corp/OrcaRouter-Lite | MIT | 6 | BYOK router, `model="auto"`, 403 tests |
| 1032 | kittors/CliRelay | MIT | 7 | CLI gateway, per-key caps (split verdict) |
| 1226 | ENTERPILOT/GoModel | MIT | 5 | Go gateway/control plane, HN-front-page |
| 564 | smg-project/smg | Apache-2.0 | 5 | Rust engine-agnostic gateway |
| 317 | thushan/olla | Apache-2.0 | 5 | Go LLM load balancer (llama.cpp/vLLM aware) |
| 264 | ferro-labs/ai-gateway | Apache-2.0 | 5 | 30+ providers, SQLite/PG |
| 205 | RelayPlane/proxy | MIT | 7 | per-run cost metering + kill-switch |
| 2050 | upstash/ratelimit-js | MIT | 5 | HTTP rate limiting for Workers |
| 215 | yolorouter/yolorouter | Apache-2.0 | 6 | 4 wire protocols + key pooling in one binary |
| 182 | api7/aisix | Apache-2.0 | 5 | Rust AI gateway by APISIX creators |
| 176 | GetBusbar/busbar | Apache-2.0 | 7 | execution boundary for AI systems |
| 100 | CassiopeiaCode/CosyRedactGateway | Apache-2.0 | 7 | egress credential redaction |
| 101 | doofzoff/SIMURG | Apache-2.0 | 6 | **namesake**: streaming-integrity monitor |
| 204 | ClawLabsAI/free-ai-models | MIT | 5 | CI-refreshed free-model catalog |
| 66 | piyush-tyagi-13/llm-keypool | MIT | 6 | free-tier key pool + capability tagging |
| 202 | youssefvdel/qwengate | MIT | 6 | free-web bridge (rejected mechanism) |
| 60 | Tsuev/opencode-deepseek | MIT | 5 | free-web bridge (rejected mechanism) |
| 561 | askalf/dario | MIT | 5 | subscription router (rejected — see below) |
| 208 | wavezync/durable | MIT | 5 | Elixir durable workflow engine |

## The cards

**piyush-tyagi-13/llm-keypool** — ★66 · 1mo · MIT · Python · free-tier key pool
- Pattern: round-robin key pool with 429-cooldown + transparent retry; **capability tagging per key** (`agentic`/`fast`/`code`/`vision`/`large_context`); OpenAI-compatible proxy + LangChain drop-in as delivery surfaces.
- Anchor: README "What it does" section (multi-provider pooling, capabilities tagging).
- Port shape: **adapt** — capability tagging is a sharper version of Simorgh's `servesTiers`; the cooldown+retry loop is GhostBrain's mechanism proven a second time in Python.
- Trigger: a second free account per provider is configured (ADR-0007 row 7).
- Risk: young, single-visible-maintainer; 429 semantics are provider-specific.

**RelayPlane/proxy** — ★205 · MIT · npm
- Pattern: per-request pricing, cost rolled up **per run and per agent**, budget cap + kill before a loop becomes a bill.
- Anchor: README opening + dashboard description.
- Port shape: **adapt** — Simorgh already has `quota.ts` + the ledger; this is the missing *rollup* axis (run/agent, not just provider).
- Trigger: multi-agent fan-out on the flock (the audit's F.1 #10 scarcity spiral).
- Risk: local-first product; check whether rollups are in-memory only.

**CassiopeiaCode/CosyRedactGateway** — ★100 · Apache-2.0
- Pattern: **high-entropy credential detection** (catches non-`sk-` random secrets, not just known prefixes), stateless redaction before egress, JSON **and SSE** stream restoration.
- Anchor: README hero + badges (streaming-compatible, Apache-2.0).
- Port shape: **adapt** — sits naturally in front of `provider.ts`'s fetch; SOUL.md's "first loyalty is to the person who owns the data" argues for this.
- Trigger: the first request path where user content can carry an operator secret.
- Risk: young; entropy thresholds need a negative control before it gates real traffic.

**Continuum-AI-Corp/OrcaRouter-Lite** — ★1737 · MIT
- Pattern: BYOK router with `model="auto"` absorbing a provider outage with no client change; 403-test suite; failover recorded in `DEMO.md`.
- Anchor: README badges + DEMO.md reference.
- Port shape: **reference** — closest architectural twin to the flock; compare its failover demo against `flock.test.ts` coverage.
- Trigger: always-on reference; adopt its test/demo discipline if a gap shows.
- Risk: none material (MIT, tested).

**theagentrouter/agent-router** — ★2205 · Apache-2.0
- Pattern: the Envoy AI Gateway lineage: credentials, routing, quotas, failover, **usage attribution** in one control plane; MCP servers as first-class upstreams.
- Anchor: README control-plane paragraph.
- Port shape: **reference** — its feature list is the checklist the platform layer should be measured against; nothing to copy (Envoy-scale infra).
- Trigger: platform-layer quarterly review.
- Risk: heavyweight by design; contrast, not cargo-cult.

**yolorouter/yolorouter** — ★215 · Apache-2.0 · Go
- Pattern: one binary speaking four chat wire protocols + OpenAI Images/Videos APIs; **pools upstream keys**; multi-user admin console; cost optimization.
- Anchor: README protocols/cost-optimization sections.
- Port shape: **adapt (Go lane)** — Simorgh's `gateway/` Go workspace can field-test key pooling there first, behind `go.work`.
- Trigger: ADR-0007 row 7 (account pool) fires.
- Risk: young; protocol breadth is attack surface.

**katanemo/plano** — ★7082 · Apache-2.0
- Pattern: AI-native **data plane** decoupled from agent frameworks; agentic signals/traces "for continuous improvement"; guardrail filters; smart routing APIs; language-agnostic.
- Anchor: README intro + docs.planoai.dev.
- Port shape: **reference** — the traces-as-improvement-loop framing is what Simorgh's ledger could grow into.
- Trigger: when the ledger is queried for anything beyond audit.
- Risk: product surface is large.

**ENTERPILOT/GoModel** — ★1226 · MIT · Go
- Pattern: "last AI gateway" feature surface; HN front-page traction (Apr 2026) = verified hype.
- Anchor: README + HN badge.
- Port shape: **reference** — use as a feature checklist for gap analysis.
- Risk: marketing-led README; verify claims against source before trusting any.

**api7/aisix** — ★182 · Apache-2.0 · Rust
- Pattern: route / govern / secure / cache / observe from one static binary; single OpenAI-compatible API in front of every model; APISIX lineage.
- Anchor: README opening.
- Port shape: **reference** — the five-verb taxonomy is a clean scaffold for the platform layer's later decomposition.
- Risk: none material.

**GetBusbar/busbar** — ★176 · Apache-2.0
- Pattern: "self-hosted execution boundary": control where AI goes, what it may use, **what authority it receives, what it may cost, what evidence is retained — before it acts**.
- Anchor: README tagline.
- Port shape: **reference** — that triad (authority/cost/evidence) is ADR-0005 + the ledger + ports expressed as a product; worth a side-by-side.
- Trigger: before the next external-effect feature ships.
- Risk: young, commercial-backed.

**lidge-jun/opencodex** — ★17189 · MIT
- Pattern: universal provider proxy making fixed-protocol CLIs (Codex, Claude Code, Grok Build) run any pointed-at LLM; two-command UX.
- Anchor: README banner + quickstart.
- Port shape: **reference** — the client-compat translation surface, if Simorgh ever serves coding CLIs directly.
- Trigger: a CLI-facing endpoint is specced.
- Risk: verify it never routes subscription OAuth (the category's usual sin) before treating as clean.

**doofzoff/SIMURG** — ★101 · Apache-2.0 · Python/numpy
- Pattern: **streaming-integrity monitor** — detects decoding corruption inside the hold window, aborts mid-stream within ~590 chars of onset so the host regenerates; conformal-calibrated false-alarm budget; 197k chars/sec CPU.
- Anchor: README table (throughput/latency/false-alarm/footprint).
- Port shape: **reference** — the namesake; pairs with `agent-stream-doctor` (ADR-0007 row 10) as the stream-health toolkit.
- Trigger: first streaming endpoint.
- Risk: numpy-only, young; the calibration method deserves scrutiny before trust.

**ClawLabsAI/free-ai-models** — ★204 · MIT
- Pattern: daily-updated free-model catalog refreshed **by GitHub Actions** from OpenRouter/Pollinations — zero hand-maintenance.
- Anchor: README badges (dynamic count from `data/models.json`, "updated daily").
- Port shape: **adapt** — this is the concrete mechanism for the audit's "model IDs are cattle" finding and ADR-0007 row 9's future catalog.
- Trigger: the bird catalog's first staleness incident.
- Risk: community-sourced data; needs the probe layer's verification before it's truth.

**upstash/ratelimit-js** — ★2050 · MIT
- Pattern: connectionless HTTP rate limiting built for Cloudflare Workers/serverless; multiple algorithms.
- Anchor: README target-environment list.
- Port shape: **reference/benchmark** — compare against `rate-limit.ts`; adopt only if a real gap shows (Simorgh's own module likely covers the need).
- Risk: none material.

**supermemoryai/supermemory** — ★31172 · MIT
- Pattern: memory/context engine as an API (npm + pip + self-host).
- Port shape: **reference** — for `session.ts`'s future; adopting a whole engine is a decision, not a port.
- Trigger: cross-session memory is specced.
- Risk: large product surface.

**thushan/olla** — ★317 · Apache-2.0 · Go
- Pattern: LLM load balancer/proxy with native llama.cpp/vLLM awareness — bridges self-hosted inference into an OpenAI surface.
- Port shape: **reference (Go lane)** — the Go workspace's gateway is the natural home if self-hosted models ever join the flock.
- Risk: different problem class (local inference).

**ferro-labs/ai-gateway** — ★264 · Apache-2.0 · Go
- Pattern: 30+ providers behind one OpenAI API; SQLite **or** Postgres storage; one-click Railway/Render.
- Port shape: **reference** — provider breadth as checklist; storage-choice parity is a nice-to-have note.
- Risk: breadth over depth.

**smg-project/smg** — ★564 · Apache-2.0 · Rust
- Pattern: engine-agnostic gateway, full OpenAI **and** Anthropic compat, shipped as binary + pip + docker.
- Port shape: **reference** — multi-runtime packaging pattern for anything Simorgh wants distributable.
- Risk: Rust; concept only.

**wavezync/durable** — ★208 · MIT · Elixir
- Pattern: resumable workflows with Postgres persistence + LiveView dashboard.
- Port shape: **reference** — durability patterns for `tasks.ts`/`scheduled.ts` (Simorgh's equivalent is DO SQLite).
- Trigger: workflow-resume semantics are revisited.
- Risk: foreign stack; concept only.

## Refusals (with reasons — the load-bearing half)

| Repo | Refused because |
|---|---|
| **askalf/dario** | Routes paid **subscriptions** (Claude/ChatGPT) into third-party tools. This is the exact pattern the October audit documents being banned (Anthropic Jan+Apr 2026 crackdowns, Antigravity ToS §6) and the repo's compliance line forbids. The ecosystem's cautionary tale: greatest GitHub momentum, worst ToS posture for this project. |
| **youssefvdel/qwengate**, **Tsuev/opencode-deepseek** | Browser-automated free-web bridges. Same category as GhostBrain; ADR-0007 §3 already refuses the mechanism (ban risk + dishonest degradation). Carded only as evidence the pattern is spreading — two more this quarter. |
| **kittors/CliRelay** (split) | **Rejects** its subscription-pooling use case (see dario). **Keeps**: per-key caps + automatic failover when an account runs dry + multi-tenant panel — those are the account-pool mechanics of ADR-0007 row 7 minus the ToS problem. |
| **weave-os/router** | README is 30k chars of SVG path data — unverifiable without source reading. Demoted to hypothesis per the skill's anchor rule; re-run against its source tree before it earns a card. |
| **affaan-m/ECC** (★275k) | The agent-harness system already installed on this box as the `ecc-*` skills — not a Simorgh pattern source; noted for provenance. |
| NOASSERTION pool | `theopenco/llmgateway`, `voidmind-io/voidllm`, `Mirrowel/LLM-API-Key-Proxy`, `sina2266/Gozar`, `LAGcomcom/zen-gate`, `Francis1998/nexus-llm-router` — license unclear on a permissive-posture repo; verify before any port. |
| AGPL pool | `chigwell/llm7.io` (the audit's LLM7 bird — interesting for that reason alone), `LeenHawk/gproxy`, `toby-bridges/api-relay-audit` — copyleft needs a deliberate decision, not an import. |

## What to advance next (proposals, not decisions)

1. **llm-keypool's capability tagging** → propose as an ADR-0007 row-7 companion when the account
   pool fires (tag keys, not just providers).
2. **ClawLabsAI's CI catalog refresh** → the concrete mechanism for the audit's "model IDs are
   cattle" mandate; propose when the first catalog-staleness incident happens.
3. **RelayPlane's per-run cost rollup** → a real gap versus `quota.ts`'s provider-level accounting;
   propose with the multi-agent fan-out work.
4. Re-run `sweep.py` monthly (the skill is registered; queries are in this dossier's method line).
