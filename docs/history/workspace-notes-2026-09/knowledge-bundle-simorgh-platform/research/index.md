
# Simorgh Platform — Research

## Latest Research

- Research Round 2 — 2026-08-31 (repo doc: `~/simorgh-platform/docs/research/2026-08-round2.md`)
  - MCP 2026-07-28 spec verified (stateless core, header-based routing, MRTR, CIMD auth, SSE deprecated)
  - DDG Instant Answer API deprecated → story 4.1 needs Brave Search fallback
  - Cloudflare Workers AI free tier: 10,000 Neurons/day, no card, Homā verified
  - Candidate birds verified: Gemini (no card), Cerebras (~1M tok/day), GitHub Models (GitHub account), Mistral (free-mode trains ⚠️), OpenRouter Free Models Router (Feb 2026)

## Candidate Birds (Epic 10)

| Bird | Provider | Free tier (2026) | Card required? | Caveat |
|------|----------|------------------|----------------|--------|
| `morgh-e-safed` | Google Gemini | Free tier in AI Studio; ~15 RPM ceiling | No | Rate limits per project; tightened Apr 2026 |
| `simorgh-e-javani` | Cerebras | ~1M tokens/day | No | Very fast (~2,000 tok/s) |
| `ghodrat` | GitHub Models | Free with GitHub account | No (GitHub account = KYC-ish) | Rate-limited |
| `dastan` | Mistral | Free mode: $10/mo credits, no card | No | ⚠️ Free-mode prompts may train Mistral models — Data-Pact consent implication |
| `pari` | OpenRouter | 20+ free models; Free Models Router (Feb 1, 2026) | No | One bird, many models |

## Web Search (Story 4.1)

- DDG Instant Answer (`api.duckduckgo.com`) is effectively deprecated/abandoned; empty responses are common and documented.
- Recommended fallback: Brave Search API (2,000 queries/month free, email only, no card) as a dormant bird-style key (`BRAVE_API_KEY`).
- Keep DDG as zero-key default for facts/definitions only.

## Cloudflare Workers AI (Homā)

- 10,000 Neurons/day free on Workers Free plan, resets daily, no credit card.
- Rate limits per model + task type (docs updated Aug 2026).
- Homā's model choice should be revisited when tuning cost/latency.

## MCP 2026-07-28

| Change | Detail | Simorgh impact |
|--------|--------|----------------|
| Stateless protocol core | `initialize`/`initialized` handshake; `Mcp-Session-Id` retired; every request self-describing via `_meta` | Huge win — Workers are stateless; no session storage needed |
| Header-based routing | `Mcp-Method` and `Mcp-Name` HTTP headers on every request | Direct fit for Intent Shield — vet tool calls on headers at the edge |
| MRTR | Replaces server-initiated sampling/elicitation/roots; server returns `resultType: "input_required"` + requests; client retries with `inputResponses` | Enables mid-flight user confirmation over stateless transport |
| Cacheable list results | `tools/list`, `prompts/list`, `resources/list` + `resources/read` return `ttlMs` + `cacheScope` | Cache tool catalogs; stable prompt caches |
| Authorization hardening | RFC 9207 `iss` validation; client credentials bound to issuer; DCR deprecated → CIMD (Client ID Metadata Documents) | Guides BYOK key vault design |
| Tasks extension | Poll-based `tasks/get`, new `tasks/update` (SEP-2663) | Long-running agent work |
| Deprecations (12-month offramp) | `roots`, `sampling`, `logging`, legacy HTTP+SSE transport deprecated | Simorgh must target streamable HTTP only; do not build on SSE |
| SDKs | TypeScript, Python, Go, C# (Tier 1); Rust in beta; Cloudflare Agents SDK supports 2026-07-28 from day zero | Story 8.2/9.2: use Cloudflare Agents SDK MCP bindings |

## Sources

- blog.modelcontextprotocol.io/posts/2026-07-28/
- modelcontextprotocol.io/specification/2026-07-28
- blog.cloudflare.com/mcp-v2/
- developers.cloudflare.com/workers-ai/platform/pricing, /limits
- openrouter.ai/blog/tutorials/free-llm-apis-compared/
- github.com/mnfst/awesome-free-llm-apis

## Open Questions (Round 3)

1. Data Pact monetization — benchmark "pay with data" models (Brave/Perplexity ad-rev share, Lumerin-style data marketplaces, Europe's data-altruism under GDPR Art. 83 / DGA 2024).
2. Durable Objects free-tier economics 2026 — DO request/GB-hour limits on Workers Free plan for Swarm-State scale planning.
3. KV vs DO vs Hyperdrive for Context Offload under high concurrency.
4. Cloudflare Agents SDK MCP support specifics — exact API surface for Story 9.2 (in-Worker MCP server).

## See Also

- [Source map](../source/index.md)
- [Architecture](../architecture/index.md)
- [Planning](../planning/index.md)
- [Simorgh Platform index](../index.md)
