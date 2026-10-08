# Perplexity Deep Research Prompt — Simorgh (2026-10)

> **How to use:** open Perplexity → choose **Deep Research** mode → paste everything between the
> `=== PROMPT START ===` and `=== PROMPT END ===` markers → let it run (it may take several minutes).
> When it finishes, copy the whole answer back to the coding agent verbatim (or save it as
> `docs/research/PERPLEXITY-ANSWER.md`) so it can be cross-checked against this repo.
>
> Tip: if Perplexity truncates, ask it in a follow-up: *"Continue from where you stopped, keep the
> same format."* You can also re-run once per section (B, C, D…) for deeper coverage of each.

---

=== PROMPT START ===

You are running a DEEP RESEARCH project as an unbiased technology analyst. I am the solo founder of an open-source edge project called **Simorgh**. Do not flatter the idea; your value is accurate, current (October 2026), source-backed information, including bad news, dead ends, and risks. Verify every free-tier claim against official provider pages and cite the URL + last-verified date for each. If something cannot be verified, say so explicitly rather than guessing.

## CONTEXT — what Simorgh is (assume this is true; research the ecosystem around it, not the idea itself)

Simorgh is a **free-to-run ($0/month), no-KYC (no credit card required), self-evolving agentic AI gateway** built on Cloudflare's edge: TypeScript 7 native-preview (`tsgo`), Hono, Durable Objects (SQLite-backed), Workers KV, Workers AI, Cron Triggers. Its founding metaphor: many small "birds" = free-tier LLM providers flying together as one Simorgh; when one bird tires (quota exhausted / rate-limited), the flock reroutes. It has a Go sidecar layer for quota probing, a Python eval/analytics layer (DuckDB/Polars over ledger exports), an MCP server surface, and strict human-in-the-loop gates before any external effect. Core invariant: only providers with a genuinely free tier reachable WITHOUT a credit card qualify as birds.

## RESEARCH QUESTIONS — answer all sections A–F with tables and citations

### A. THE FREE-TIER LANDSCAPE (most important — verify as of today)
Build a table of EVERY major and minor LLM/API provider offering a genuinely free tier as of October 2026, focused on ones usable by an automated gateway: OpenAI, Google Gemini, Groq, Mistral, Cohere, DeepSeek, OpenRouter, Hugging Face Inference, Cloudflare Workers AI, Cerebras, SambaNova, GitHub Models, Together AI, Fireworks, DeepInfra, Pollinations.ai, NVIDIA NIM, Azure AI Foundry, AWS Bedrock (free trial?), xAI/Grok, Alibaba Qwen/Tongyi, Moonshot, MiniMax, Zhipu/GLM, Ai21, Scaleway, OVHcloud AI, plus any NEW free offerings launched in the last 6 months I haven't listed.
For each: (1) exact free quota (requests/day, tokens/day, RPM limits, $credit amount & expiry), (2) credit-card required? yes/no — quote the signup page, (3) whether automated API access is permitted vs OAuth-only vs human-verification-gated, (4) ToS clauses about scraping/automated routing/reselling or aggregating access (flag anything that would make a *gateway that federates free tiers* a ToS violation), (5) rate-limit headers exposed, (6) OpenAI-compatibility of the API, (7) known reliability issues (frequent 429s, outages, model deprecations announced for late 2026/2027).
Then rank the top 12 "best birds" for my use case with reasoning, and identify which commonly-cited "free tiers" have quietly died or been gutted in 2025–2026 (with dates and sources).

### B. PROVIDER-SIDE COMPETITION & RISK
Research products launched or updated in 2025–2026 that already do "route across multiple free/provider tiers with fallback": OpenRouter, LiteLLM (proxy + router), Requesty, Unify.ai, Vercel AI Gateway, Portkey, Not Diamond, Near AI, Kong AI Gateway, Cloudflare AI Gateway itself, Azure AI Gateway/A2G, Higress, Cherryl Studio, One-API/New-API/VertexAI-Proxy (self-hosted aggregators), Anyrouter, and any newer entrants. For each: what's their free story, how do they handle quota exhaustion/failover, pricing model, traction (GitHub stars, adoption signals), and whether they already cover Simorgh's niche. Conclude: what differentiated wedge remains for a no-KYC, self-evolving, edge-native flock gateway in late 2026?
Also assess platform risk honestly: recent examples of platforms killing/limiting third-party gateways, OAuth abuse crackdowns, free-tier changes with <30-day notice, and Cloudflare-specific policy on AI/LLM proxying on Workers (acceptable-use + commercial terms, BYOK/AI Gateway restrictions).

### C. TECHNOLOGY CHOICES (latest stable as of Oct 2026 — I want newest-but-production-safe)
Current status, stability, and migration guidance for: TypeScript 7 native compiler (`tsgo` / @typescript/native-preview) — what works, what breaks, CI implications; Vitest 4.x with @cloudflare/vitest-pool-workers latest; Wrangler 4.x + Workers runtime features (workflows, artifacts, vectorize, Hyperdrive, Queues, Containers) and their FREE tiers/limits; Hono latest version + recommended middleware set; upm package manager maturity vs pnpm/bun; JSR publishing for Cloudflare Workers libs (any remaining blockers); Durable Objects SQLite storage state; Cloudflare Agents SDK / durable-object class API status; MCP spec latest revision (2026-07-28 or newer?) — sampling, elicitation, tasks/extensions status, registry/marketplace state, security best-practice doc updates; Node.js 24 LTS vs 26 status in Oct 2026 and Cloudflare Workers' Node compatibility flags level; Go 1.26 release status and what's new relevant to concurrency/profiling; DuckDB-WASM in-browser analytics limits; eval tooling (promptfoo, Langfuse, Braintrust, DSPy, Inspect AI) free tiers. Flag anything I'm using that is deprecated/deprecated-soon.

### D. FREE COMPUTE & INFERENCE BEYOND LLM APIs
Table of genuinely-free compute usable without a card in Oct 2026 for agents/quota-probing/sidecars: Cloudflare Workers/DO/KV/R2/D1/Queues/Containers free limits, Vercel, Netlify, Den Deploy, Supabase, Neon, Turso, Railway trial, Fly.io new-account policy (card now required?), Render, Glitch, Oracle Cloud Always-Free (ARM capacity reality), Google Cloud e2-micro free tier (still exists in 2026?), AWS free tier post-2025 changes, GitHub Actions free minutes, Hugging Face Spaces/Inference-DEDICATED credits, Kaggle notebooks GPU quotas, Lightning AI free tier, Paperspace trials, Colab reality-check (ToS on automation!), Scaleway Stardust, Raspberry Pi/self-host options, and decentralized compute (Akash, io.net, Gensyn status). Note card requirements and ToS-for-automation caveats per row. Recommend the optimal $0 stack to add to Cloudflare for: always-on background probes, a Python eval loop, and light model serving.

### E. MONETIZATION & DISTRIBUTION FOR THIS CATEGORY (fast, evidence-based)
Find real 2025–2026 precedents: open-source AI gateways/routers/aggregators that reached revenue (LiteLLM enterprise, Portkey funding + ARR signals, OpenRouter fee model + volume estimates, Requesty, Not Diamond acquisition?, Kilo Code, Roo/Cline monetization, Zed's business model as adjacent signal). What converted free OSS devs to paid (hosted dashboards, team seats, enterprise auth, observability)? Typical infra-cost-per-user for hosted gateways. Also: Cloudflare's own developer-platform incentives (Workers Paid perks, startup program, build partners, sponsorships, grant programs active in Oct 2026), grants/funding realistic for a solo dev in this space (NLnet, Sovereign Tech Fund, EF, Mozilla Builders status, YC for infra), and marketplace/distribution surfaces (Cloudflare Marketplace/AI Gateway catalog, MCP registry listings, VS Code/JetBrains extension angles). Give 3 concrete monetization paths ranked by effort-to-first-dollar for a solo dev, with comparable-company evidence.

### F. THREATS & OPEN QUESTIONS
List the 10 biggest ways this project fails in 12–18 months (platform dependence, free-tier collapse, MCP commoditization by OpenAI/Anthropic/Google/Microsoft gateways, legal/ToS exposure, security incident from acting as aggregator holding users' keys, single-maintainer burnout), each with a mitigation backed by what successful projects actually did. End with 5 questions ONLY live testing or direct provider contact could answer, which I should chase next.

## OUTPUT FORMAT (strict)
- Markdown document, one section per letter above, tables wherever comparing ≥3 items.
- Every factual claim gets an inline citation `[n]` linked to the source URL; prioritize official docs/pricing/ToS pages and changelogs over blogs; note publication dates because tiers change monthly.
- Mark confidence per section: 🟢 well-sourced · 🟡 mixed/single-source · 🔴 couldn't verify.
- Include a "What changed since early 2026" callout box per section where relevant.
- Executive summary at top: 10 bullets, brutal honesty included. Target length: comprehensive, not padded.

Start by briefly restating the scope in ≤5 bullets, then begin research immediately.

=== PROMPT END ===

---

## After you get the answer

Paste/save the full Perplexity output here and the agent will:
1. Cross-check Section A claims against `docs/research/SKILLSTACK-2026.md` and `GO-QUOTA-FINDINGS.md` (our probes beat secondhand docs — conflicts resolved in favor of live probe results).
2. Update the bird manifest candidates (`EveryBird` design plan) with newly verified no-KYC providers.
3. Turn Section E into a prioritized backlog and Section F into entries in `SECURITY.md`/SOUL.md guardrails.
