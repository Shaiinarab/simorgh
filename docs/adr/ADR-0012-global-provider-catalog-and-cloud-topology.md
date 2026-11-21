---
type: "Architecture Decision Record"
title: "ADR-0012 — Global provider catalogue, health lifecycle and cloud topology"
description: "Defines a global, evidence-backed catalogue of cardless international AI APIs, per-deployment API conformance probes, automatic provider lifecycle, and the GitHub/Cloudflare/Vercel/Telegram split."
tags: [simorgh, adr, providers, free-tier, cloudflare, github-actions, vercel, telegram]
generated:
  by: "human:shahin"
  at: "2026-11-21T00:00:00Z"
status: "stable"
stale_after: "2027-05-21T00:00:00Z"
sources:
  - id: groq-limits
    resource: "https://console.groq.com/docs/rate-limits"
    title: "Groq API rate limits"
  - id: gemini-pricing
    resource: "https://ai.google.dev/gemini-api/docs/pricing"
    title: "Gemini Developer API free and paid tiers"
  - id: openrouter-free
    resource: "https://openrouter.ai/collections/free-models"
    title: "OpenRouter free-model collection and limits"
  - id: cloudflare-ai
    resource: "https://developers.cloudflare.com/workers-ai/platform/pricing/"
    title: "Workers AI free daily allocation"
  - id: cloudflare-limits
    resource: "https://developers.cloudflare.com/workers/platform/limits/"
    title: "Workers Free plan runtime limits"
  - id: github-runners
    resource: "https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job"
    title: "GitHub-hosted runner availability for public repositories"
  - id: vercel-terms
    resource: "https://vercel.com/legal/terms"
    title: "Vercel Hobby non-commercial-use restriction"
  - id: nvidia-nim
    resource: "https://docs.api.nvidia.com/nim/docs/product"
    title: "NVIDIA NIM developer access and hosted API catalog"
  - id: cohere-limits
    resource: "https://docs.cohere.com/docs/rate-limits"
    title: "Cohere evaluation-key limits"
  - id: cerebras-pricing
    resource: "https://www.cerebras.ai/pricing"
    title: "Cerebras developer tier and payment-method requirement"
  - id: mistral-limits
    resource: "https://docs.mistral.ai/admin/billing-usage/usage-limits"
    title: "Mistral API Free mode and billing activation"
---

# ADR-0012 — Global provider catalogue, health lifecycle and cloud topology

- **Status:** accepted as architecture; implementation is not yet shipped.
- **Date:** 2026-11-21.
- **Decision:** Simorgh is a globally hosted, Telegram- and personal-web-app-oriented agent platform. It uses a public, continuously audited provider catalogue and per-deployment credential-aware probes. GitHub Actions audits the public ecosystem; each user's Cloudflare deployment tests the APIs it can actually authenticate to. Vercel is an optional dashboard frontend, not the control plane.

## 1. Context and correction

Simorgh is not a local-first desktop agent. Its intended user experience is a Telegram bot plus a personal web application, backed by a user's own deployment. Iranian users are part of the global audience and may have international network access, including VPN connectivity. The provider catalogue must therefore be international and must not be limited to Iranian vendors.

The catalogue must exclude providers headquartered in Iran or China, as requested by the project owner. A VPN changes network reachability; it does not override a provider's terms, export controls, sanctions, account eligibility, or country restrictions. Simorgh must display region-policy evidence and must not market a VPN as a way to bypass a provider's contractual restrictions.

The word "free" is not a sufficient eligibility test. Offers must be distinguished as:
- recurring free API quota;
- limited evaluation/trial access;
- free model routed through an aggregator;
- free infrastructure allowance;
- promotional credit;
- paid API with a free consumer app.

Likewise, "no card" does not prove "no KYC". Every provider record must independently track payment-method, phone-verification, identity-verification, region and terms evidence. Unknown means unknown, never "no KYC".

## 2. Product topology

```text
Telegram ───────────────┐
                       ├── Cloudflare Worker API / webhook ── Durable Objects + storage
Personal Web App ──────┘                 ▲
                                        │
Vercel Dashboard (optional frontend) ───┘
                                        │
                           Provider router + account quotas
                                        │
              ┌─────────────────────────┼────────────────────────┐
              ▼                         ▼                        ▼
        Global LLM APIs           Search / embeddings       User-selected tools
        (free/cardless tiers)     (free/cardless tiers)     (MCP / APIs)

GitHub repository:
  source + issues + CI + public provider manifest + scheduled ecosystem audit
  GitHub Actions runners: ephemeral CI/probe workers, never the 24/7 agent runtime
```

Responsibilities:

| Surface | Owns | Must not own |
|---|---|---|
| GitHub | Source of truth, tests, release artifacts, public provider manifest, scheduled metadata audits | User prompts, provider keys, durable user sessions, always-on agent runtime |
| Cloudflare Workers | Public API, Telegram webhook, auth, routing, scheduled per-instance probes, edge orchestration | Long-running CPU-heavy inference or unbounded synchronous agent loops |
| Durable Objects / D1 / KV / R2 | Canonical user/task state, quota ledger, health history, cache and artifacts according to existing ports | A second independent task database or duplicated scheduler |
| Vercel | Optional dashboard UI and thin server functions if needed | Canonical state, provider secret vault, Telegram polling, the only control plane |
| Telegram | User-facing chat channel and commands | Agent execution or durable business state |

The existing Workers host remains the canonical deployment target for the first implementation because it already contains the Hono API, Telegram webhook, Durable Objects, provider router and dashboard endpoint. A Vercel dashboard is a separate frontend that calls the same authenticated Cloudflare API; it does not justify migrating the agent runtime.

**Vercel plan constraint:** Vercel's current Hobby terms limit Hobby use to personal or non-commercial use. A personal dashboard deployment may fit that boundary; a commercial Simorgh service or a shared service offered to third parties must not rely on Hobby. Keep the dashboard portable so the same frontend can be hosted on Cloudflare Pages or another static host.

## 3. Global provider catalogue

The current hand-maintained `PROVIDERS` arrays in `src/flock.ts` and `simorgh-platform/src/runtimes/providers.ts` are the runtime adapter roster, not a sufficient global catalogue. The target design separates:

1. **Provider definition:** vendor, endpoint families, protocol adapters, terms, regions, free-plan evidence and official documentation.
2. **Model offers:** model ID, modality, context, tool calling, structured output, streaming, deprecation and free-tier eligibility.
3. **Account installation:** a user's own credential reference, provider account, local quota and capabilities.
4. **Health observations:** timestamped results, probe type, region, latency, status code class and confidence.
5. **Eligibility decision:** whether a given offer is usable by a given deployment under its local configuration and policy.

The public manifest contains no secrets and is versioned in Git. Runtime health and per-account quota are stored only in that user's deployment. The catalogue is data-driven: adding an OpenAI-compatible vendor should normally be a manifest entry plus conformance tests, not a new provider factory.

### Required provider metadata

```ts
type EvidenceState = "verified" | "unverified" | "unknown" | "disputed";
type FreeOffer = "recurring" | "trial" | "promotional" | "free-model-pool" | "none" | "unknown";

interface ProviderManifestEntry {
  id: string;
  displayName: string;
  headquartersCountry?: string;
  endpoint: string;
  protocol: "openai-chat" | "openai-responses" | "gemini" | "anthropic" | "native";
  modelsUrl?: string;
  healthUrl?: string;
  docsUrl: string;
  pricingUrl: string;
  termsUrl: string;
  freeOffer: FreeOffer;
  freeQuota?: { requests?: number; tokens?: number; neurons?: number; period?: string };
  paymentMethod: EvidenceState;
  phoneVerification: EvidenceState;
  identityVerification: EvidenceState;
  regionEligibility: EvidenceState;
  dataTrainingPolicy: EvidenceState;
  lastEvidenceCheck: string;
  evidenceExpiresAt: string;
  status: "candidate" | "active" | "degraded" | "quarantined" | "retired";
}
```

No provider becomes "verified no-KYC" unless its signup and current terms have actually been checked. Provider eligibility is a user-visible combination of evidence, not a marketing label.

### Initial international candidate set

This is a research shortlist, not a promise that every account can register from every country. All identity and regional requirements remain independently unverified unless explicitly documented.

| Provider | Evidence as of 2026-11-21 | Classification / decision |
|---|---|---|
| Google Gemini Developer API | Official pricing documents a free tier for selected models and free input/output tokens; the free tier has different data-use terms from paid | **Candidate.** Card/KYC and region eligibility must be checked per signup/account. Free-tier data may be used to improve Google's products. |
| Groq | Official model-specific rate-limit table includes free-tier quotas such as GPT-OSS 120B and 20B | **Candidate.** Confirm current account onboarding, payment-method requirement and region policy; quotas vary by model and organization. |
| OpenRouter | Official free-model pool; `:free` models are capped at 20 RPM and 50 RPD without a credit purchase | **Candidate.** Excellent fallback adapter, but not an unlimited autonomous backbone. Failed calls count toward the daily cap. |
| Cloudflare Workers AI | Official free allocation of 10,000 Neurons/day; some models require a paid plan or prepaid credits | **Candidate / platform-native fallback.** Track model-level billing eligibility; do not label every model free. |
| NVIDIA NIM API Catalog | NVIDIA documents free Developer Program access to hosted endpoints for prototyping; limits and model availability vary | **Candidate.** Verify the current endpoint's free status, payment requirement and region before activation. |
| Cohere | Evaluation keys are free but limited; trial keys are capped at 1,000 API calls/month for the documented v2 cases | **Trial candidate**, not a permanent free backbone. |
| Mistral API | Current usage-limit docs state Free mode does not include API access; API keys require billing activation/pay-as-you-go | **Exclude from no-payment API roster** until official terms change. A free chat product is not a free API. |
| SambaNova Cloud | Current Free plan asks users to add a payment method and purchase credits | **Exclude from no-payment roster.** |
| Cerebras Inference | Current Developer tier's $5 promotional credit requires a valid payment method and expires after 30 days | **Exclude from no-payment recurring roster.** It may be shown separately as a card-required trial. |

Chinese and Iranian providers are deliberately excluded from the default international shortlist. Third-party lists may suggest additional services, but a listing alone is not sufficient evidence of free API access, no-card signup, no identity checks, or acceptable terms.

## 4. Automated testing and provider lifecycle

A single central probe cannot prove that every user's API key works. Some providers require authentication for even their model-list endpoint, and the central project must never collect user credentials. The solution has two independent test planes.

### A. Public ecosystem auditor (GitHub Actions)

Run on a schedule and on manifest changes. It:
- checks official docs, pricing, terms and public model-catalogue endpoints;
- validates that endpoints resolve and expected protocol metadata is present;
- detects model deprecations, renamed IDs, removed free offers and policy changes;
- records source URL, retrieval timestamp, content hash and a machine-readable diff;
- opens a reviewable pull request when catalogue facts change;
- marks stale evidence as `unknown` after its expiry date.

It does **not** send synthetic traffic to every provider's inference endpoint, create provider accounts, bypass signup, or store keys. A failed public docs URL is not proof that the inference API is dead.

### B. Per-deployment API conformance monitor (Cloudflare Cron)

Each user's deployment tests only providers for which that user has configured a key or enabled a keyless service. It:
- runs at onboarding, after key rotation, and on a conservative schedule (default: every 6 hours, with jitter);
- first checks a low-cost authenticated model-list or metadata endpoint where available;
- otherwise sends a tiny, deterministic canary request with a strict output cap;
- tests the exact capabilities Simorgh intends to use: authentication, chat completion, streaming, JSON/structured output and tool calls;
- stores only status, latency, model/capability results, quota headers and redacted error classes;
- never stores prompt/response content or emits credentials into logs;
- supports manual "Test now" from the dashboard, protected by the user's own identity and rate limits.

A provider's user-specific key status must never change the global provider's public status. One user's expired key is not a global outage.

### C. Failure classification

| Result | Interpretation | Action |
|---|---|---|
| 2xx with valid schema | Healthy for tested capability | Mark account/provider capability healthy |
| 401 | Invalid, revoked or missing credential | Mark this account `needs_attention`; do not retire provider |
| 403 | Account, region, policy or permission restriction | Mark this account ineligible; surface provider policy evidence |
| 404 model | Model ID retired or endpoint changed | Refresh model catalogue; retire the model offer only after confirmation |
| 429 | Rate/quota limit | Read Retry-After and quota headers; cool down this account/model, not provider |
| 5xx / timeout / DNS | Potential service incident | Retry with bounded exponential backoff and jitter |
| malformed 2xx | Protocol regression or unexpected response | Quarantine this adapter/model capability after repeated failures |

### D. State machine and removal policy

```text
candidate → active ↔ degraded → quarantined → retired
                 ↑                 │
                 └── recovery ─────┘
```

- One failed probe never removes a provider.
- 429, 401 and 403 are not global outage signals.
- Quarantine requires repeated transport/server failures, for example 3 consecutive failures over at least 30 minutes, with at least two independent probe regions where available.
- Recovery requires two successful checks separated in time.
- Retire a provider only after sustained confirmed unavailability (default 7 days), explicit vendor shutdown, or verified loss of the free API offer.
- Retired entries remain as tombstones with history and a replacement pointer; they are not hard-deleted.
- A model can be retired while its provider stays active.
- Every status exposes `lastChecked`, `confidence`, `reason` and evidence links. Stale observations are not shown as healthy.

This avoids the classic monitoring mistake: interpreting a rate limit, a temporary 503, or one bad API key as the death of an entire service.

## 5. Free online compute allocation

Use free resources according to their actual workload fit, not as a pile of interchangeable servers.

| Resource | Best Simorgh use | Important boundary |
|---|---|---|
| GitHub Actions on this public repository | Typecheck/tests, cross-runtime tests, manifest validation, daily provider/docs audit, scheduled model deprecation checks, release artifacts | Standard hosted runners are free for public repositories. They are ephemeral CI runners, not an always-on production agent host. |
| GitHub Pages | Public docs, status snapshots, onboarding guide, provider catalogue browser | Static hosting only; never accept provider keys or user bearer tokens. |
| Cloudflare Workers Free | API, Telegram webhook, auth, lightweight routing, scheduled orchestration | 100,000 requests/day, 10 ms CPU per request and 128 MB memory on Free; design bounded request handlers. |
| Cloudflare Durable Objects | Per-user durable state, task coordination, quotas, idempotency and health history | Use existing DOs and shard only when measured; don't create one DO per provider call. |
| Cloudflare Workers AI | Always-available baseline inference and optional embeddings | 10,000 Neurons/day free allocation; model-level eligibility differs and usage beyond the allowance requires paid plan. |
| Cloudflare KV / R2 / D1 | Cached public manifest, static snapshots, user state/artifacts where the existing storage design calls for them | Respect write/request/storage limits; SQLite/DO remains authoritative for transactional state. |
| Vercel Hobby | Optional personal dashboard frontend and previews | Personal/non-commercial only. Do not use Hobby as a shared commercial service or as the only backend. |
| External free API tiers | Inference, search, embeddings, reranking and specialist tools | Every offer has limits, terms, privacy rules, regions and expiry; no quota is assumed to be unlimited. |

The objective is maximum useful work per free allowance, not maximum raw request volume. Probe traffic must be budgeted and jittered so monitoring does not consume the quota it is meant to monitor.

## 6. Dashboard and Telegram contract

- Telegram continues to call the Cloudflare webhook. Bot token and webhook secret stay in Cloudflare secrets.
- The personal web app and optional Vercel dashboard call the same versioned Cloudflare REST API.
- The dashboard shows provider catalogue status separately from the user's account status and quota.
- Provider setup is a dynamic capability picker, not a four-key form. It recommends a minimum viable set, then discovers more options.
- Provider keys are submitted directly to the user's Cloudflare secret/configuration path; never to GitHub Pages, public catalogue endpoints, query strings, analytics or Git commits.
- The Vercel frontend must not become the source of truth. If Vercel is unavailable, Telegram and the Cloudflare API continue to operate.
- Use short-lived, scoped dashboard sessions or a carefully reviewed pairing flow; do not place long-lived API keys in localStorage by default.

## 7. Implementation sequence

1. **E2.1 Manifest schema:** introduce the provider/model/free-offer/evidence schema; keep the current runtime roster as an adapter projection during migration.
2. **E2.2 Provider adapter conformance:** standard tests for OpenAI-compatible chat, Gemini, model listing, streaming, JSON and tool calls.
3. **E2.3 Public ecosystem auditor:** GitHub Actions schedule, official-source fetchers, evidence hashes, expiry and PR generation.
4. **E2.4 Per-account probes:** extend the existing capability probe layer with scheduled, low-cost checks using only the user's configured credentials.
5. **E2.5 Lifecycle state machine:** account-local health and global catalogue state kept separate; quarantine/recovery/tombstones.
6. **E2.6 Dashboard:** show global catalogue, account health, model availability, quotas, privacy and region evidence.
7. **E2.7 Vercel frontend:** deploy the dashboard as an optional, portable frontend that talks to Cloudflare; preserve Cloudflare Pages as a fallback host.
8. **E2.8 Provider expansion:** add new providers only when evidence and conformance tests pass. No arbitrary provider-count target.

## 8. Consequences

- Simorgh can add and remove model offers without a code release when the manifest is refreshed, while protocol adapters remain reviewed code.
- One provider outage no longer requires a maintainer to edit a static array manually.
- The system can honestly distinguish "service is down", "this key is invalid", "this model was retired", "quota exhausted", and "not available in this region".
- Public GitHub automation never needs user credentials; private user API checks remain in the user's own deployment.
- The current static roster, current `/api/v1/capabilities` endpoint and current dashboard remain useful during migration. This ADR does not claim the global registry, scheduled probes, or Vercel frontend are already implemented.
