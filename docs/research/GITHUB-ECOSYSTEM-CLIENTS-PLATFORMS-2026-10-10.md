# GitHub Ecosystem Map II — Clients & Platforms (2026-10-10)

Second dossier from the **`github-gold-finder`** skill, framed for the composition thesis:
*we are not building something for the first time — we are joining parts of different
architectures*. The question per project is never "copy this" but **which part joins where**.

**Method:** 12-query clients/platforms sweep (140-repo pool) + 26 targeted lookups on the known
client ecosystem + 15 README anchors. MCP fleet was degraded during this run (firecrawl proxy
refused, deepwiki flaky, websearch 403) — GitHub API carried it, as it has all session.

## §1 The finding that matters: three protocols are the whole join surface

Every discoverable client in this pass speaks at least one of three protocols natively:
**OpenAI `/v1/chat/completions`**, **Anthropic `/v1/messages`**, **MCP**. Simorgh's engine
already answers the first two shapes of request (REST + `/mcp` surface), which means
**distribution is a config block, not an integration project** — one `provider` entry in
opencode.json, one base-URL in open-webui, one "custom endpoint" in Cline. No client required
Simorgh-specific code in this entire pass. That is the product's distribution story, and it is
evidence-backed below, not asserted.

## §2 Clients — the adoption surface (point them at Simorgh tomorrow)

| Client | ★ | License | Last push | Join effort |
|---|---|---|---|---|
| **sst/opencode** (→ `anomalyco/opencode`) | 212k | MIT | 2026-10-10 | one `provider` block in `opencode.json` — **this CLI is already your daily driver** |
| open-webui | 154k | NOASSERTION ⚑ | 2026-10-10 | one base-URL in Connections |
| lobe-chat | 83k | NOASSERTION ⚑ | 2026-10-10 | one provider entry |
| cline | 70k | Apache-2.0 | 2026-10-10 | "OpenAI Compatible" provider, base URL + key |
| goose (→ `aaif-goose/goose`) | 55k | Apache-2.0 | 2026-10-09 | custom provider config; MCP-native |
| Cherry Studio | 52k | **AGPL-3.0** ⚠ | 2026-10-10 | model-service entry |
| LibreChat | 45k | MIT | 2026-10-09 | custom OpenAI endpoint |
| OpenHands | 90k | MIT | 2026-10-10 | LLM config pointer |
| Continue | 36k | Apache-2.0 | 2026-10-09 | custom API endpoint (pivoted extension→agent+CLI) |
| Kilo Code | 27.5k | MIT | 2026-10-10 | gateway/provider entry |
| Chatbox | 42k | **GPL-3.0** ⚠ | 2026-09-24 | custom provider |
| Tabby | 34k | NOASSERTION ⚑ | 2026-06-30 | self-hosted; endpoint config |

Cards — the three that lead:

**sst/opencode (anomalyco/opencode)** — ★212k · MIT
- Anchor: GhostBrain's README already ships the exact `opencode.json` provider block for a
  local OpenAI-compatible server (`{"ghost": {npm: "@ai-sdk/openai-compatible", baseURL, apiKey}}`).
- JOIN: Simorgh becomes provider `simorgh` in the same shape. The user's operator workflow
  (this CLI, all session) becomes Simorgh's own first client — dogfooding with zero new code.
- Risk: repo transferred off SST; pin the redirect target in any doc.

**cline** — ★70k · Apache-2.0 · "Autonomous coding agent as an SDK, IDE extension, or CLI"
- Anchor: README positioning (three delivery surfaces).
- JOIN: the "OpenAI Compatible" provider path is documented and stable; Cline is also an **SDK**
  — meaning Simorgh could embed Cline *as* the agent engine later rather than growing its own.
- Risk: SDK embedding is a real dependency decision; endpoint-mode first.

**goose (aaif-goose/goose)** — ★55k · Apache-2.0 · Rust · MCP-native desktop/CLI/API agent
- Anchor: README tagline + topics (mcp, acp).
- JOIN: MCP-native agents can consume Simorgh's `/mcp` directly, no REST translation. Goose
  is the lowest-friction *agent* client, versus chat UIs.
- Risk: moved to a Linux-Foundation-style org; governance change, watch activity.

**Cherry Studio** — ★52k · AGPL-3.0 — desktop studio, 300+ assistants, unified access.
- JOIN: consumer-grade client for demos. ⚠ **AGPL**: fine as a *user's* client (we don't
  distribute it), but never port its code into Simorgh (MIT posture).

**open-webui / lobe-chat** — ★154k/83k · ⚑ both report `NOASSERTION` via the API.
- JOIN: the two biggest drop-in web UIs — the demo surface for the platform layer.
- Risk: verify the actual license text (open-webui carries a branding-amended BSD-3) before any
  code-level borrowing; endpoint-only use is unaffected.

## §3 Platforms — the parts to join instead of rebuild

**Memory** (Simorgh has `session.ts`; none of these replace it, they answer *cross-session*):

**mem0ai/mem0** — ★66.9k · Apache-2.0 · "Memory layer for AI agents — drop-in infrastructure"
- Anchor: README banner + PyPI distribution.
- JOIN: the extraction/update/retrieval pipeline as a service beside the flock; Simorgh supplies
  the traffic, mem0 supplies the memory. Fits DO SQLite as the store behind it.
- Trigger: cross-session continuity is specced. Risk: managed-service gravity.

**topoteretes/cognee** — ★31.9k · Apache-2.0 · "The free open-source AI memory platform"
- JOIN: ingestion-pipeline-shaped memory (ETL over unstructured → graph), self-hostable — the
  Apache license and self-host story fit better than mem0's cloud gravity.
- Trigger: same as mem0; benchmark both then.

**getzep/graphiti** (adjacent find — `getzep/zep` is examples-only) — temporal knowledge-graph memory.
- JOIN: the OSS core under Zep Cloud; temporal graphs match a ledger's append-only nature.
- Trigger: memory lane starts.

**Observability** (Simorgh has the ledger; these are *query/UX* over it):

**langfuse/langfuse** — ★35.6k · TS · ⚑ NOASSERTION (core is MIT + EE dirs — verify)
- JOIN: traces/evals over Simorgh's ledger export; the self-host option keeps $0.
- Trigger: the ledger is queried for anything beyond audit (same trigger as ADR-0007 row 2).

**comet-ml/opik** — ★22.5k · Apache-2.0 — evals + monitoring, Python.
**Helicone/helicone** — ★6.2k · Apache-2.0 — observability + **agent tracing + LLM routing with
automatic fallbacks**: the closest observability *and* failover hybrid to Simorgh's own shape;
its one-line proxy integration is the pattern to copy for a trace-only sidecar.
**maximhq/bifrost** — ★8.7k · Apache-2.0 · Go — enterprise AI gateway, "50× LiteLLM", adaptive
load balancing. Reference only: a competitor-shaped gateway, useful as a benchmark, not a source.

**Tools & agents:**

**ComposioHQ/composio** — ★30.5k · MIT — 1000+ toolkits, tool search, context management, auth,
sandboxed execution.
- JOIN: Simorgh's `tools.ts` allow-list is deliberately small; Composio is the
  "many tools, one auth surface" answer if agentic breadth is ever wanted. Trigger: tool breadth
  outgrows the allow-list.

**omnara-ai/omnara** — ★2.9k · Apache-2.0 · Go — self-hostable managed-agent platform
("alternative to Claude Managed Agents").
- JOIN: young but the only repo found that runs agents *as a managed service* self-hosted —
  the pattern Simorgh's platform layer could inverse (cores as managed units).

**Automation & durable execution:**

**activepieces** — ★25k (API: NOASSERTION ⚑; badge: MIT — verify) — Zapier-class automation with
~400 bundled MCP servers. JOIN: the workflow trigger layer for catalog refresh / quota probes.
**windmill** — ★18k · ⚑ NOASSERTION — scripts→workflows, Rust.
**restatedev/restate** — ★4.5k · ⚑ NOASSERTION · Rust — durable execution tolerating infra
failure; the *concept* Simorgh implements with DO SQLite + Workflows. Reference only.

**BaaS — the one already in the building:**

**pocketbase/pocketbase** — ★61.3k · MIT · Go — "realtime backend in 1 file".
- JOIN: **oudiverse already runs PocketBase** (workspace AGENTS.md documents its JSVM
  patterns and pitfalls). A Simorgh fleet store / dashboard backend behind it is a
  known-quantity join, not a new dependency. Trigger: the platform layer needs persistent
  non-edge state (fleet inventory, dashboards).

## §4 Refusals & flags

| Item | Verdict |
|---|---|
| mckaywrigley/chatbot-ui | **kill** — last push 2024-08; two years stale despite 33k★. The star-farm lesson. |
| Roo-Code / Aider / Void / Tabby | survive the 12-month rule but are low-momentum (2026-05/06) — demote, watch. |
| Cherry Studio (AGPL), Chatbox (GPL-3.0) | copyleft — fine as external clients, never as code sources. |
| NOASSERTION cluster (open-webui, lobe-chat, langfuse, activepieces, windmill, restate, Memori, Tabby) | license-text verification required before any code-level join; endpoint use is unaffected. |
| bifrost | competitor-shaped; benchmark only. |
| `trigger.dev` | repo 404 (org renamed); noted, not carded. |
| MCP registries (smithery/glama/mcp.so/pulsemcp) | web-service-shaped, zero GitHub repos in the sweep — the distribution question is *listing Simorgh's MCP surface*, a to-do, not a repo to join. |

## §5 What Simorgh does with this (composed, not copied)

1. **Ship the connect matrix** — one doc, ~12 config snippets: opencode.json, open-webui,
   LibreChat, Cline, goose, Chatbox, Kilo. Distribution unlock with zero engine changes; the
   protocols already exist.
2. **Dogfood on the daily driver** — Simorgh as a provider block in the user's own opencode
   config is the acceptance test this whole session has been building toward.
3. **Memory/observability lanes are joins, not builds** — mem0/cognee/graphiti and
   langfuse/opik/helicone each attach to the existing ledger; pick at spec-time, not now.
4. **PocketBase is a known-quantity platform join** for the fleet store — the only platform here
   whose pitfalls this workspace has already paid to learn.

Nothing adopted. Cards with fired triggers (the connect matrix, #1) are implementation work and
go in as their own commits.
