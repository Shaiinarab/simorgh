---
type: "Research Record"
title: "The free-tier capacity math for one million users (2026-10-08)"
description: "Evidence-graded capacity report: 1M users at $0 is reachable under BYOK and not under pooled accounts; the single global Durable Object saturates near the 1,000 req/s soft limit, and the append-only ledger fills a 1 GB object in under a day."
tags:
  - "simorgh"
  - "research"
generated:
  by: "process:simorgh-prd-research-2026-08"
  at: "2026-10-08T10:29:00+03:30"
status: "stable"
stale_after: "2027-02-01T00:00:00+03:30"
imported:
  by: "agent:codebuff"
  at: "2026-11-20T18:18:17+03:30"
  from: "~/personal/projects/projects/simorgh-prd-research"
---
<!-- Imported verbatim from ~/personal/projects/projects/simorgh-prd-research on 2026-11-20. -->

# The free-tier capacity math for 1 million users

**Research report for the Simorgh project — 2026-10-08**
TASK-015. Read-only on the repository; this file and `mailbox/OUTBOX/TASK-015-REPORT.md` are the only
outputs. Every claim below is tagged with what was actually established:

- **VERIFIED** — the primary source (official docs / pricing / ToS page) was fetched and is quoted or
  precisely cited, with URL and access date (all fetches 2026-10-07/08).
- **REPORTED** — a secondary source says so; it was not confirmed upstream. Named as such.
- **INFERRED** — arithmetic or reasoning from verified facts; the reasoning is shown.
- **UNVERIFIED** — could not be confirmed (login wall, 404, moved page, dynamic JS). Listed in §8
  rather than dropped.

A plausible number is not a verified fact. Where two sources disagree, both are shown.

---

## 0. How to read this report

Simorgh's stated goal is **1 million users at monetary cost = 0** (`ADR-0005`: `FREE_ONLY` is the
default; unknown cost ≠ free). This report asks whether that is arithmetically reachable, and under
which of three capacity models: **(a) BYOK** (every user brings their own key), **(b) pooled accounts**
(the operator holds N accounts and routes across them — the shape today's architecture implies), and
**(c) local / on-device** (the user's own machine serves what it can).

The answer, up front: **1M users at $0 is reachable under BYOK and is not reachable under pooled
accounts.** The pooled path fails on arithmetic (tens of thousands of accounts would be needed), on
contract (OpenRouter and Cloudflare explicitly prohibit the multi-account pattern — Cloudflare twice —
and Groq disclaims any obligation to provide multiple accounts), and on the platform side (Workers
Free caps at 100,000 requests/day ≈ 10,000 users, so Workers Paid at $5/month is unavoidable, which
by itself breaks `monetary cost = 0`).

The single most important thing this report found is narrower and sharper than "pooling is
impossible": **every provider couples tenancy to quota.** Groq will let one account serve a million
End Users — that is what its Agreement is written around — but meters limits "at the organization
level", so a million users on one account still get one account's quota. Many users and more
capacity are *decoupled*; the only thing that reconnects them is holding many organizations, which
is precisely what Groq disclaims, Cloudflare prohibits twice, and OpenRouter prohibits. The fork at
the end of this report is that decoupling, and it can be settled by one email to one provider's
sales team.

A note on what this report is *not*: it does not measure live enforcement. Published limits are what
a provider says; enforcement is what a provider does. Only the former is publicly verifiable, and only
the former is used here.

---

## 1. Deliverable A — the current free tiers, provider by provider

### 1.1 The summary table

| Provider | Free tier exists? | Free models (published) | Requests/day | Tokens/min | Tokens/day | Credit card? | Rate-limit discoverable? | Authoritative headers? | Last activity |
|---|---|---|---|---|---|---|---|---|---|
| **Groq** | Yes ("Free tier"; "Developer tier" is the paid upgrade) | 10 models listed on the rate-limits page (gpt-oss-120b, gpt-oss-20b, qwen3.8-27b, whisper-large-v3(-turbo), llama-prompt-guard-2-22m/86m, orpheus ×2, gpt-oss-safeguard-20b) | 1,000 (gpt-oss-120b/20b, qwen3.8-27b); 14,400 (prompt-guard); 100 (orpheus); 2,000 (whisper) | 8K (gpt-oss-120b/20b, qwen3.8-27b); 15K (prompt-guard); 1.2K (orpheus) | 200K (gpt-oss family); 500K (prompt-guard); 3.6K (orpheus) | **No** — card required only to upgrade to Developer tier | Yes — per-org limits page + response headers | Yes — `x-ratelimit-*` + `retry-after` | Docs fetched 2026-10-07; models page current (gpt-oss-120b featured) |
| **HuggingFace** | **The free Inference API is gone.** `huggingface.co/docs/api-inference/rate-limits` now redirects to Inference Providers pricing; free users get **no** monthly credits and must purchase credits for pay-as-you-go | n/a at $0 (hf-inference provider is pay-as-you-go; "As of July 2025, hf-inference focuses mostly on CPU inference") | n/a | n/a | n/a | n/a (no $0 tier to gate) | Hub API still emits `RateLimit`/`RateLimit-Policy` headers (free user: 1,000 API req / 5-min window) — but that is the Hub, not inference | Yes (Hub only) | Docs fetched 2026-10-07; hub rate-limits page dated "September '25" |
| **Cloudflare Workers AI** | Yes — 10,000 Neurons/day free, on both Free and Paid Workers plans | Full catalog priced in Neurons; text generation 300 RPM default; "paid models" 20 RPM (standard billing) or 50 RPM (prepaid AI Gateway credits) | Not published as requests/day — the binding cap is **10,000 Neurons/day** (≈ 0.5M output tokens/day on the cheapest model, llama-3.2-1b — INFERRED arithmetic) | 300 RPM (text generation, free models) | 10,000 Neurons/day | **No** card for Workers Free plan ("By default, users have access to the Workers Free plan") | Yes — limits page + dashboard | Not documented on the limits page | Limits page "Last updated Sep 17, 2026"; pricing "Last updated Oct 1, 2026"; "Workers AI is now Generally Available" |
| **Google AI Studio / Gemini** | Yes — free tier covers Flash-family models (23 of 35 model entries "Free of charge" per the pricing page) | Gemini 3.8/3.7/3.6/3.5 Flash, 3.5/3.1 Flash-Lite, 2.5 Pro/Flash/Flash-Lite, Live, Transcribe, TTS, Embedding 2, Gemma 4 (per pricing page) | **Not published.** Per-project numbers are shown only in AI Studio (login-walled). REPORTED secondary figures conflict (see §1.3) | Not published (same) | Not published (same) | **No** — free tier needs a Google account + Cloud project; AI Studio auto-creates a default project + key | Partially — AI Studio rate-limit page (login-walled) | Not documented | Rate-limits page "Last updated 2026-09-02"; api-key page "Last updated 2026-10-06" |
| **OpenRouter** | Yes — free model variants (`:free` suffix); 50 RPD if <10 credits purchased all-time, 1,000 RPD if ≥10 | Any model with a `:free` variant (list is dynamic, JS-rendered — UNVERIFIED for a specific snapshot) | 50 (<10 credits) / 1,000 (≥10 credits) | 20 | n/a (free models are not metered in tokens, only requests) | **No** card documented for free use; account via email/OAuth | Yes — `GET /api/v1/key` returns `free_model_daily_requests` | `X-RateLimit-*` on 429 errors only; not on successful responses | Docs fetched 2026-10-07 |
| **GitHub Models** | **RETIRED.** "As of July 30, 2026, GitHub Models has been fully retired. The playground, model catalog, inference API, and bring your own key (BYOK) are no longer available to any customer." | n/a | n/a | n/a | n/a | n/a | n/a | n/a | docs.github.com/en/github-models, fetched 2026-10-07 |

### 1.2 Groq — the strongest free tier, and the one that matters most

**VERIFIED** (console.groq.com/docs/rate-limits, fetched 2026-10-07):

- "Rate limits apply at the organization level, not individual users."
- Free-tier model limits (the page's table; the page notes these are "the base limits for the
  Developer plan" — see the ambiguity note below):

| Model | RPM | RPD | TPM | TPD |
|---|---|---|---|---|
| openai/gpt-oss-120b | 30 | 1,000 | 8K | 200K |
| openai/gpt-oss-20b | 30 | 1,000 | 8K | 200K |
| openai/gpt-oss-safeguard-20b | 3 | 1,000 | 2K | 200K |
| qwen/qwen3.8-27b | 30 | 1,000 | 8K | 200K |
| meta-llama/llama-prompt-guard-2-22m | 30 | 14,400 | 15K | 500K |
| meta-llama/llama-prompt-guard-2-86m | 30 | 14,400 | 15K | 500K |
| canopylabs/orpheus-arabic-saudi | 10 | 100 | 1.2K | 3.6K |
| canopylabs/orpheus-v1-english | 10 | 100 | 1.2K | 3.6K |
| whisper-large-v3 | 20 | 2,000 | – | 7.2K ASH / 28.8K ASD |
| whisper-large-v3-turbo | 20 | 2,000 | – | 7.2K ASH / 28.8K ASD |

- Headers (VERIFIED, same page): `retry-after`, `x-ratelimit-limit-requests`,
  `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`, `x-ratelimit-limit-tokens`,
  `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`. "The other headers are always
  included"; `retry-after` only on a 429.
- Credit card (VERIFIED via console.groq.com/docs/billing-faqs): "To upgrade from the Free tier to
  the Developer tier, you'll need to provide a valid payment method (credit card, US bank account, or
  SEPA debit account)." The Free tier itself requires no card.
- **Ambiguity note (VERIFIED text, INFERRED reading):** the rate-limits page says its table shows "the
  base limits for the Developer plan," while the billing FAQ describes Free → Developer as a paid
  upgrade, and the models page shows "RATE LIMITS (DEVELOPER PLAN)" of 1K RPM / 250K TPM for
  gpt-oss-120b — 33× the table's 30 RPM. The table's values match what secondary sources report as the
  *free* tier (REPORTED: eesel.ai 2026-06-08 and grizzlypeaksoftware 2026-03-27 both list 30 RPM /
  1K RPD / 8K TPM for gpt-oss-120b as free-tier). Conclusion: the table is the free tier; the page's
  "Developer plan" wording is loose. Flagged because the page itself is ambiguous.
- **REPORTED** (secondary, not confirmed upstream): the free list is broader than the 10-row table —
  llama-3.1-8b-instant (30 RPM / 14.4K RPD / 6K TPM), llama-3.3-70b-versatile, llama-4-scout,
  kimi-k2, qwen3-32b, groq/compound, allam-2-7b appear in secondary free-tier tables. Treat the
  official 10-row table as the verified floor, not the ceiling.

### 1.3 HuggingFace — the free inference tier has decayed to pay-as-you-go

**VERIFIED** (huggingface.co/docs/api-inference/rate-limits, fetched 2026-10-07): the URL now
serves the **Inference Providers** pricing page. Its billing table:

| Account Type | Monthly Credits | Extra usage |
|---|---|---|
| Free Users | **None** | "yes (credits purchase required)" |
| PRO Users | $2.00 | yes (pay-as-you-go) |
| Team / Enterprise | $2.00 per seat | yes (pay-as-you-go) |

- The old free serverless Inference API is gone as a free surface: "This service used to be called
  'Inference API (serverless)'… As of July 2025, hf-inference focuses mostly on CPU inference."
- What still exists and is free is the **Hub** (model/dataset hosting), with Hub rate limits
  (VERIFIED, huggingface.co/docs/hub/rate-limits, page dated "September '25"): free user = 1,000 API
  requests per 5-minute window, 5,000 resolver requests, 200 page requests; `RateLimit` and
  `RateLimit-Policy` headers; 429 on exceed. None of this is LLM inference.
- **Consequence for Simorgh: HuggingFace is no longer a $0 inference provider.** Under `FREE_ONLY`
  with unknown-cost-not-free, an HF inference provider cannot be classified `free` on current
  evidence. This is a direct contradiction of any assumption that the flock's HF bird is free.

### 1.4 Cloudflare Workers AI — a hard daily token budget, not a request budget

**VERIFIED** (developers.cloudflare.com/workers-ai/platform/pricing/, "Last updated Oct 1, 2026"):

- "Our free allocation allows anyone to use a total of **10,000 Neurons per day at no charge**."
- "All limits reset daily at 00:00 UTC. If you exceed any one of the above limits, further operations
  will fail with an error."
- Paid: $0.011 / 1,000 Neurons above the free allocation.
- Text generation rate limit (VERIFIED, workers-ai/platform/limits/, "Last updated Sep 17, 2026"):
  "300 requests per minute, unless the model requires the Workers Paid plan"; paid models: "Standard
  Workers AI billing: 20 requests per minute; Prepaid AI Gateway credits: 50 requests per minute."
- **INFERRED arithmetic:** Neurons are per-token. On the cheapest text model
  (@cf/meta/llama-3.2-1b-instruct: 18,252 neurons per 1M output tokens), 10,000 neurons ≈ **548K
  output tokens/day** (or ≈ 4.1M input tokens at 2,457/M). At a gateway-typical ~1K tokens per
  request, one CF account serves **~500–1,000 requests/day**. The 300 RPM cap is not the binding
  constraint; the daily Neuron budget is.
- Credit card: not required for the Workers Free plan (VERIFIED, workers/platform/pricing/: "By
  default, users have access to the Workers Free plan").

### 1.5 Google AI Studio / Gemini — a real free tier with login-walled numbers

**VERIFIED** (ai.google.dev/gemini-api/docs/rate-limits, "Last updated 2026-09-02"):

- "Rate limits are applied per project, not per API key. Requests per day (RPD) quotas reset at
  midnight Pacific time."
- "Rate limits depend on a variety of factors (such as your usage tier) and can be viewed in Google
  AI Studio… **Specified rate limits are not guaranteed and actual capacity may vary.**"
- The per-model free-tier RPM/TPM/RPD table is **not published** — it is shown per project in AI
  Studio (login-walled). Any specific free-tier number found online is therefore REPORTED at best.
- Free tier models (VERIFIED, ai.google.dev/gemini-api/docs/pricing, fetched 2026-10-07): the
  pricing page shows "Free of charge" input and output for the Flash family, 2.5 Pro, Live,
  Transcribe, TTS, Embedding 2, Gemma 4 — 23 of 35 model entries (a secondary source,
  glamdringresearch 2026-09-28, counted the same 23/35 split — REPORTED, consistent with the official
  page).
- Credit card: **not required** for the free tier (VERIFIED, ai.google.dev/gemini-api/docs/api-key,
  "Last updated 2026-10-06"): "If you are a new user, Google AI Studio automatically creates a
  default Google Cloud project and API key after you accept the Terms of Service."
- **Project cap (VERIFIED, same page):** "You can create a maximum of 10 projects at a time from the
  Google AI Studio Projects page." This is the hard ceiling on Gemini pooling per user account.
- **REPORTED secondary figures (conflicting — do not plan on them):** pecollective (2026-04-21) lists
  Gemini 3 Flash at 10 RPM / 250K TPM / 1,500 RPD and 3.1 Flash-Lite at 15 RPM / 1,000 RPD;
  aifreeapi (2026-03-17) lists 2.5 Pro at 5 RPM / 100 RPD; aipromptshub (2026-06-27) lists 2.5 Pro
  at 5 RPM / **25** RPD. The RPD figures disagree by 4×. Google's own docs publish none of them.

### 1.6 OpenRouter — small free quotas, and pooling is explicitly prohibited

**VERIFIED** (openrouter.ai/docs/api_reference/limits, fetched 2026-10-07):

- Free-model limits: "If you're using a free model variant (with an ID ending in `:free`), the
  following limits apply: Less than 10 credits purchased (all time): 20 requests per minute, 50
  requests per day. At least 10: 20 requests per minute, 1,000 requests per day."
- **The load-bearing quote for the pooled model:** "Making additional accounts or API keys will not
  affect your rate limits, as we govern capacity globally."
- Discoverability: `GET /api/v1/key` returns `free_model_daily_requests {used, limit, remaining}`.
  Headers: "Successful inference responses do not include `X-RateLimit-*` headers. When OpenRouter
  itself returns a `429`… the error response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
  `X-RateLimit-Reset`."
- Credit card: not documented as required for free use; account creation is email/OAuth (VERIFIED,
  openrouter.ai/docs/guides/overview/auth/oauth).
- Free-model list: dynamic (`:free` variants; the models page is JS-rendered). The *mechanism* is
  VERIFIED; any specific snapshot of free models is UNVERIFIED.

### 1.7 GitHub Models — retired

**VERIFIED** (docs.github.com/en/github-models, fetched 2026-10-07): "GitHub Models has been
retired. As of July 30, 2026, GitHub Models has been fully retired. The playground, model catalog,
inference API, and bring your own key (BYOK) are no longer available to any customer." The docs now
point to Azure AI Foundry. Any Simorgh configuration referencing a GitHub Models bird is dead.

### 1.8 Terms of Service — the quotes that decide the pooled model

**OpenRouter ToS, §7 Prohibited Conduct** (VERIFIED, openrouter.ai/terms, fetched 2026-10-07):

> "03. create a false identity, mispresent your identity, or create multiple accounts as a single
> user, for purposes of bypassing or circumventing use limits on the Site or Site or Service or any
> other reason;
> 04. access the Service for purposes of reselling API access to Models or otherwise developing a
> competing service;"

(Quoted verbatim from §7; item 03's "or any other reason" is not limited to limit-circumvention.)
Combined with the limits page — "we govern capacity globally" — OpenRouter pooling is both
**contractually prohibited and technically futile**.

**Groq Services Agreement, §3.2 Accounts** (VERIFIED, console.groq.com/docs/legal/services-agreement,
fetched 2026-10-07):

> "Customer must have an Account to use the Cloud Services and is responsible for the information it
> provides to create the Account, the security of its passwords for the Account (including any keys
> for Groq's APIs), and for any use of its Account. **Groq has no obligation to provide multiple
> accounts to Customer.** Customer will only make its Account available to Authorized Account Users…
> **Customer may not resell or lease access to its Account.**"

Groq does not prohibit multiple accounts outright, but disclaims any obligation to provide them, and
limits are per organization — so pooling depends on creating many separate customer relationships,
each of which Groq may refuse or terminate at will (the Agreement's termination provisions apply).

**The distinction that decides the pooled model, and which the §3.2 quote alone hides** (VERIFIED,
same page, §3.1 Scope and §3.2 "Authorized Account Users" definition):

> "…the right to use Groq's APIs to integrate the Cloud Services and AI Model Services into your
> Customer Application and to make the Cloud Services and AI Model Services available to End Users
> through your Customer Applications."

> ""Authorized Account Users" means the individuals who are permitted by Customer, to access or use
> the Cloud Services and AI Model Services under the Account, including employees of Customer
> Affiliates and **other authorized third parties permitted by Customer**."

Read together, Groq's position is precise and it is **not** what a skim of §3.2 suggests:

- **Multi-tenant on ONE account is explicitly permitted.** Serving many end users through one
  Groq account is the shape the Agreement is written around — that is what a "Customer Application"
  with "End Users" *is*.
- **Reselling or leasing the account itself is prohibited.** You may serve users; you may not sell
  them access to the account.
- **Pooling N accounts is disclaimed, not banned.** "Groq has no obligation to provide multiple
  accounts to Customer" is a refusal to promise, not a prohibition — but combined with per-**organization**
  limits (VERIFIED, rate-limits page: "Rate limits apply at the organization level, not individual
  users") it has a hard consequence: **one account serving 1M users gets one account's quota
  (1,000 RPD).** Multi-tenancy buys Simorgh nothing in capacity. Only N separate organizations buy
  capacity, and that is exactly the thing Groq declines to provide and that the abuse heuristics
  target. **This is the precise point at which the pooled model dies: it is not that Groq forbids
  many users per account — it permits that — it is that quota is per-org, so "many users" and
  "more capacity" are decoupled, and only illegitimate account multiplication reconnects them.**

**Cloudflare Self-Serve Subscription Agreement, §2.2.1** (VERIFIED, cloudflare.com/terms, "Last Updated
September 12, 2025"):

> "(c) access or use the Services in a manner that violates or is intended to circumvent
> Service-specific usage limits, quotas, or other restrictions set forth in the Agreement;
> …
> (e) introduce software or automated agents or scripts into the Services so as to **produce multiple
> accounts**, generate automated searches, requests or queries, or to strip or mine data from the
> Services;

Cloudflare explicitly prohibits producing multiple accounts. The Workers AI free allocation is
therefore a one-account-per-customer resource.

**A second, independent prohibition the pooling analysis must also clear** (VERIFIED, same section
— it does not depend on §2.2.1(e) at all):

> "(a) rent, lease, loan, export, or sell access to the Services to any third party, **or sign up
> for the Services on behalf of a third party**;"

Two consequences. (1) Reselling Workers AI access to end users is prohibited outright — which
forecloses the "one Cloudflare account, many paying users" shape that Groq explicitly permits
(above). The two providers disagree on the central question of whether one operator account may
serve many third parties, and Cloudflare's answer is no. (2) The "sign up … on behalf of a third
party" clause independently forbids the automated account-farm pattern that the 9router ecosystem
ships tooling for (§4).

**Gemini API Additional Terms** (VERIFIED, ai.google.dev/gemini-api/terms, "Effective March 23, 2026",
page "Last updated 2026-04-28"):

> "Use of Google AI Studio and Gemini API is for developers building with Google AI models for
> professional or business purposes, not for consumer use."

and, on unpaid services:

> "When you use Unpaid Services… Google uses the content you submit to the Services and any
> generated responses to provide, improve, and develop Google products and services… **Do not submit
> sensitive, confidential, or personal information to the Unpaid Services.**"

Making an API client available to users on unpaid quota is permitted (professional/business use), so
Gemini pooling is not expressly prohibited — but it is bounded by the 10-projects-per-user cap and by
Google's standard anti-abuse posture, and the free-tier numbers themselves are unpublished and
"not guaranteed."

**HuggingFace ToS** (VERIFIED, huggingface.co/terms-of-service, "Effective Date: September 15, 2022"):
no multi-account clause found; "we reserve the right to suspend or terminate your access to the
Services anytime with or without cause." Moot for inference at $0 since the free inference tier no
longer exists (§1.3).

---

## 2. The three capacity models — the arithmetic

**Workload assumption (INFERRED, stated so the arithmetic can be re-run):** 1M users, each making
**10 requests/day** = **10M requests/day** total. (At 1 request/day/user the totals are 10× smaller;
the conclusions do not change.) A "request" is one agent execute, not one token.

### 2.1 Model (a) — BYOK: every user brings their own key

- **Capacity:** 1M users × their own free accounts. Even at a conservative 100 RPD per user, that
  is 100M RPD of aggregate free capacity — two orders of magnitude above the 10M RPD workload.
  Capacity is **not** the constraint. (INFERRED from the per-account limits in §1.)
- **What Simorgh provides that `curl` does not:** multi-provider failover when one provider 429s;
  quota-aware scheduling across the user's own providers (`planQuotaRun`); one OpenAI-shaped
  endpoint; the transparency ledger; the MCP surface; honest degradation instead of a bare 429.
  That is a real feature set — but it is a **resilience and ergonomics** advantage, not a capacity
  advantage. A user with one Groq key and a shell can already `curl` Groq.
- **Is that enough for 1M installs?** Honest answer: **unknown, and unknowable from published
  evidence.** The capacity math is trivially satisfied; the distribution math (will one million users
  install a gateway and register keys?) is a product question, not a research one. What the evidence
  *does* say: the compliance risk of BYOK is the lowest of the three models — every account belongs
  to the user, so no provider ToS is implicated by the operator, and the SECURITY-AUDIT §4 void
  conditions (second principal, credentials from outside the operator's environment) are **not**
  triggered by users holding their own keys.
- **Verdict:** arithmetically reachable; the bottleneck is distribution and value-proposition, not
  capacity.

### 2.2 Model (b) — pooled accounts: the operator holds N accounts

Per-account daily capacity (VERIFIED limits from §1, except where noted):

| Provider | RPD per account | Accounts needed for 10M RPD | ToS posture on pooling |
|---|---|---|---|
| Groq | 1,000 (gpt-oss-120b) | **10,000** | "No obligation to provide multiple accounts"; per-org limits; no resale/lease |
| Gemini | ~1,500 REPORTED (unpublished, login-walled) | **~6,700** (→ 670 user accounts at the 10-project cap) | Not expressly prohibited; professional/business use only; data used for improvement |
| OpenRouter | 50 (<10 credits) | **200,000** | **Explicitly prohibited** ("multiple accounts… for any other reason") + "we govern capacity globally" |
| CF Workers AI | ~500–1,000 (10K Neurons/day, INFERRED) | **10,000–20,000** | **Explicitly prohibited** ("produce multiple accounts") |
| HuggingFace | n/a (no $0 inference) | n/a | n/a |
| GitHub Models | n/a (retired) | n/a | n/a |

**The arithmetic is unforgiving:** serving 10M RPD from Groq alone requires ~10,000 accounts.
A mixed pool of 50 accounts across providers yields roughly 25–50K RPD — enough for **~2,500–5,000
users** at 10 req/day. That is the honest ceiling of the current architecture's shape: **three orders
of magnitude short of 1M**, before considering that two providers forbid the pattern outright and a
third may refuse the accounts.

**Verdict: 1M users at $0 via pooled accounts is not reachable.** It fails on arithmetic (tens of
thousands of accounts needed), on contract (OpenRouter and Cloudflare explicitly prohibit
multi-account pooling; Groq disclaims the obligation to provide it), and on operations (account
creation at that scale is fraud-system bait by any provider's abuse heuristics — UNVERIFIED as to
specific thresholds, which providers deliberately do not publish).

### 2.3 Model (c) — local / on-device

- **What the evidence supports:** on-device inference in 2026 can serve small models locally
  (llama.cpp / MLX / browser runtimes exist), which covers cache hits, simple classification,
  formatting, and other trivial tasks.
- **What it cannot cover:** the core reasoning workload of an agentic gateway. No verified 2026
  source establishes what fraction of a real agent's requests are servable on-device; any number
  would be a guess. **INFERRED, no verified basis:** a generous estimate is that 10–30% of requests
  in a cache-heavy deployment could avoid the network; the remaining 70–90% still need a provider.
- **Verdict:** local serving raises the effective ceiling by shaving the trivial tail; it does not
  change the order-of-magnitude answer. Even at a 50% local fraction, the network still needs ~5M
  RPD — which takes us straight back to §2.2's impossible pooling arithmetic.

### 2.4 What would make 1M users at $0 reachable

1. **BYOK-at-scale** — capacity is then a non-issue (§2.1); the problem becomes distribution.
2. **A provider explicitly permitting operator pooling at scale** — none of the six found; two
   explicitly forbid it.
3. **A large on-device fraction** — not supported by evidence for reasoning workloads (§2.3).
4. **Paid capacity** — violates `monetary cost = 0` by definition. (For scale: Workers Paid is
   $5/month and removes the 100K requests/day cap — VERIFIED, workers/platform/pricing/ — but that
   is a cost, and it does not fix provider-side free-tier limits.)

---

## 3. Deliverable B — what breaks at scale in the current architecture

The blocker named in the brief is real and verified in the code: `src/index.ts:151,316,443` and
`src/flock.ts:165` resolve the FlockCoordinator as `idFromName("global")`, and `src/index.ts:416`
resolves the DataTrustVault as `idFromName("global")`. **Two objects, each a single global instance.**
The FlockCoordinator holds `rate_limits`, `bird_health`, `quota_state`, `scheduled_task`, `task`
(VERIFIED, phoenix-core schema constants); the DataTrustVault holds the append-only `ledger`
(VERIFIED, src/data-trust.ts:39–51).

### 3.1 Durable Object throughput — the single-threaded ceiling

**VERIFIED** (developers.cloudflare.com/durable-objects/platform/limits/, "Last updated Jun 1, 2026"):

- "An individual Object has a soft limit of **1,000 requests per second**."
- "Each individual Object is inherently single-threaded."
- "A Durable Object that receives too many requests will, after attempting to queue them, return an
  **overloaded** error to the caller."

**At 1M users (INFERRED arithmetic):** 10M requests/day ≈ 116 req/s average. A diurnal peak of
10–20× average puts the sustained peak at **~1,200–2,300 req/s** — above the 1,000 req/s soft limit,
before any burst. Every one of those requests lands on the same object, because the rate-limit check
(`checkRateLimit("execute:" + userId, 20, 60_000)` — VERIFIED, src/index.ts:316–320) is a call on
the global FlockCoordinator stub. The first symptom is `overloaded` errors under peak load, not
graceful degradation.

### 3.2 DO SQLite — storage and the write path

**VERIFIED** (same page, "Last updated Jun 1, 2026"):

- "Storage per Durable Object: **10 GB**" on Workers Paid; the FAQ states the Free-plan figure: "Each
  SQLite-backed Durable Object has a storage limit of 10 GB on a Workers Paid plan" and "(10 GB on
  Workers Paid, or **1 GB on the Free plan**)."
- "When a SQLite-backed Durable Object reaches its maximum storage limit… write operations… will fail
  with… `database or disk is full: SQLITE_FULL`."
- SQL limits: 100 columns/table, 2 MB row size, 100 KB statement, 100 bound parameters — none binding
  at Simorgh's schema sizes.
- Also VERIFIED (workers/platform/pricing/, "Last updated Oct 2, 2026"): "Workers Free plan can only
  create and access **SQLite-backed** Durable Objects" — Simorgh's choice of SQLite is the only
  option on Free, so this is a constraint already correctly satisfied.

**At 1M users (INFERRED arithmetic):** the ledger is append-only "by design" (VERIFIED,
phoenix-core/src/ledger.ts:19–24 — "there is no path that updates or deletes a row, by design"). At
≥1 row per execute and ~150–500 bytes/row (columns: id, user_id, tier, ref_id, timestamp, action,
details — VERIFIED schema), 10M requests/day write **1.5–5 GB/day**. Against the Free plan's 1 GB
per-object limit, **the ledger alone fills the DataTrustVault in under one day**; against Paid's
10 GB, in ~2–7 days. Reads and deletes still work when full (VERIFIED), but there is no delete path
in the schema — so "freeing space" means migrating the table, not pruning it.

### 3.3 The shared `rate_limits` table — 1M hot rows in one object

**VERIFIED** (phoenix-core/src/rate-limit.ts:15–21): `rate_limits(key, window_start, count)`, keyed
by `"execute:" + userId` (src/index.ts:318). At 1M users the table holds **≥1M rows**, and every
request performs a read-modify-write on one of them, inside the single-threaded global object. The
table has no TTL or eviction in the schema (VERIFIED — no such column or cleanup path exists in the
code read). Storage is not the problem (~50 MB, INFERRED); **throughput and write contention are** —
this table is the single hottest structure in the system, and it is the one the 1,000 req/s soft
limit is measured against.

### 3.4 The shared `bird_health` table — small, but on the same critical path

`bird_health(bird_id, status, consecutive_failures, cooldown_until, last_ok, total_calls,
total_failures)` (VERIFIED, phoenix-core/src/health.ts:36–44) — one row per provider, so tens of
rows. Not a scale problem by itself; it is a problem because every request reads and writes it on
the same global object as §3.1–§3.3, adding latency and write traffic to the saturated critical path.

### 3.5 Subrequest limits — the free plan's other hard wall

**VERIFIED** (developers.cloudflare.com/workers/platform/limits/, "Last updated Sep 5, 2026"):

| Limit | Workers Free | Workers Paid |
|---|---|---|
| Requests | 100,000/day | No limit |
| Subrequests per invocation | **50** | 10,000 (up to 10M) |
| Subrequests to internal services | 1,000 | Matches configured limit |
| CPU time per HTTP request | 10 ms | 5 min (default 30 s) |

**At 1M users (INFERRED arithmetic):** the 100,000 requests/day cap alone caps the Free plan at
**~10,000 users at 10 req/day** — two orders of magnitude short of 1M, before any provider limit is
even consulted. And a single agentic execute that fans out to a provider plus a KV write plus the
DO call plus a tool-call loop can approach the 50-subrequest Free cap; the Paid plan's 10,000 is the
only headroom. Workers Paid is $5/month minimum (VERIFIED, workers/platform/pricing/) — a real cost,
and a direct collision with `monetary cost = 0`.

### 3.6 The recommendation — and the trade being made

**Recommended shape: shard the per-tenant state by Durable Object, keep the flock coordinator global
but read-only where possible.**

- **DO-per-tenant (or DO-per-user-bucket):** each tenant's `rate_limits` rows and ledger live in a
  keyed object (`idFromName("tenant:" + hash(userId))`). This removes the single-object throughput
  ceiling (each object gets its own 1,000 req/s — VERIFIED scaling model) and contains ledger growth
  per tenant. **The trade you are making away:** cross-tenant operations (a global status page, a
  fleet-wide "which provider is healthy" view, and the quota scheduler's pool-wide `postSpendValue`
  optimization) no longer see one consistent snapshot — they become eventually-consistent aggregates
  across objects. Simorgh's own doctrine ("degrade honestly instead of fabricating") says that is an
  acceptable trade *if* the aggregation is labeled as an estimate; it is an unacceptable trade if
  `/api/v1/flock/status` presents a partial view as the whole truth.
- **One object with row-level tenant keys** (keep `global`, add `tenant_id` to every table): the
  smallest change, and it fixes *nothing* at 1M users — the single-threaded 1,000 req/s ceiling and
  the 1–10 GB storage ceiling are properties of the object, not of the schema. Rejected.
- **SQL sharding (D1/Hyperdrive per tenant):** moves storage out of the DO entirely and is the right
  long-term home for the ledger (D1 Free: 5M rows read / 100K rows written per day, 5 GB — VERIFIED,
  workers/platform/pricing/). **The trade:** the ledger's append-only, no-delete guarantee becomes a
  retention-policy decision instead of a schema invariant, and the engine's `SqlPort` must become
  tenant-aware — which `ADR-0002`/`ADR-0003` explicitly deferred.

**The failure mode being traded away, named:** the current single-object design fails by **silent
saturation** — `overloaded` errors and `SQLITE_FULL` are indistinguishable from each other and from
provider trouble at the edge. The sharded design fails by **partial visibility** — a status view that
is an unlabeled aggregate. The second failure is honest if labeled; the first is not. That is the
argument for sharding.

---

## 4. Deliverable C — does federated free-tier routing at multi-tenant scale already exist?

**Blunt answer: no — not with Simorgh's specific shape (free-tier federation + quota-aware
scheduling + multi-tenant + $0).** What exists is adjacent, and the adjacency is instructive.

| Project | Stars (VERIFIED 2026-10-08) | License | Maintained? | What it does | What it is not |
|---|---|---|---|---|---|
| **OmniRoute** (diegosouzapw/OmniRoute) | 74,033 | **MIT — VERIFIED**, `LICENSE` fetched: "MIT License / Copyright (c) 2026 diegosouzapw" | Active (`updated_at` 2026-10-08) | "Free MIT AI gateway: one endpoint, 359 providers (150+ free), 1200+ models… **Quota-aware auto-fallback**, RTK+Caveman compression… MCP/A2A" | A personal-use gateway for coding agents (Claude Code/Codex/Cursor), not a multi-tenant hosted service; no per-tenant isolation, no transparency ledger. Note: `ADR-0003` documents a local OmniRoute install on this box whose quota tables are **all empty** — "a schema, not a system" |
| **LiteLLM** (BerriAI/litellm) | 60,298 | **MIT** (VERIFIED — LICENSE file fetched 2026-10-08) | Active (updated 2026-10-07) | AI gateway: 100+ LLM APIs, load balancing, virtual keys, cost tracking, multi-tenant teams | Aggregates **paid** providers with BYOK; has no concept of *free-tier* quotas or a `FREE_ONLY` cost gate |
| **new-api** (QuantumNous/new-api) | 49,361 | **not verified** | Active (updated 2026-10-07) | "Unified AI model hub for aggregation & distribution", multi-tenant, channels, quotas | Same: paid-provider aggregation; quota = spending buckets, not free-tier windows |
| **9router** (decolua/9router) | 30,439 | **MIT — VERIFIED**, `LICENSE` fetched: "MIT License / Copyright (c) 2024-2026 decolua and contributors" | Active (`updated_at` 2026-10-08) | "Unlimited FREE AI coding. Connect Claude Code, Codex, Cursor, Cline, Copilot, Antigravity to FREE Claude/GPT/Gemini via 40+ providers. Auto-fallback…" | The closest in spirit — free-tier federation with failover — but single-user (one operator's accounts), no multi-tenancy, no quota awareness (VERIFIED via `ADR-0003`: "no `quota`/`limit`/`rate`/`budget`/`credit` key exists anywhere in its settings") |
| **Portkey-AI/gateway** | 13,144 | not verified | Active (updated 2026-10-07) | AI gateway, 1,600+ LLMs, guardrails | Paid-provider focus; no free-tier federation |
| **openrelay** (romgX/openrelay) | 2,309 | not verified | Active (updated 2026-10-07) | "Hundreds of free AI model quotas, one-click access" | Free-quota aggregation for personal use; no multi-tenant serving |
| **tuxevil-rotator** (tuxevil/tuxevil-rotator) | 69 | not verified | Active (updated 2026-10-07) | "Multi-provider, **multi-account** AI proxy rotator with per-model routing, quota tracking" | The exact pooled-account shape — at 69 stars, single-operator scale, and its multi-account pattern is the one OpenRouter/Cloudflare ToS prohibit |
| **omniroute-rs** (chalaha728-lab/omniroute-rs) | 3 | not verified | Active (updated 2026-09-28) | "Pure Rust rewrite of OmniRoute — OpenAI-compatible AI gateway with 40 providers, combos, MCP, A2A, compression, guardrails, webhooks, **multi-tenant**" | The only project found that names free-tier routing *and* multi-tenancy — at 3 stars and ~10 days old, it is a prototype, **not** a reference implementation |

**The finding the star counts hide: a mass-account-tooling ecosystem exists, and it is the direct
operational expression of the pooled model this report is arguing against.** (VERIFIED by GitHub
search, 2026-10-08, in the `9router` topic ecosystem — all active, all within the last ~3 months):

| Repo | Stars | What it automates |
|---|---|---|
| `defryarhinsa/Add-Mass-Account-Antigravity-to-9Router` | 133 | Bulk-adding accounts to the 9router Antigravity provider |
| `mhiqrambg/gsuite2router` | 79 | "CLI tool to **bulk-add Google Workspace accounts** to 9Router Antigravity provider via **automated OAuth login**, and clean up quota-exhausted connections" |

These are not curiosities. They are the pooling mechanism, productised, published, and
star-counted. Their existence is simultaneously the strongest evidence that the pooled-account
demand is real *and* the clearest demonstration that the ecosystem operates in the territory the
Cloudflare ToS §2.2.1(a)–(e) clauses above prohibit ("sign up for the Services on behalf of a third
party"; "produce multiple accounts"). Simorgh's own rule — never evade bans, rate limits, account
verification, or contractual restrictions — places it on the other side of that line from its own
closest competitors. **That is a real strategic asset and should be said out loud, not hidden: the
demand is proven, and Simorgh's compliance posture is the differentiator.**

**What to learn from them:** (1) the free-tier federation space is crowded at the *personal gateway*
tier — OmniRoute, 9router, and openrelay all prove the demand; (2) none of them solve multi-tenant
serving, because their users are one person with many accounts; (3) the multi-tenant gateways
(LiteLLM, new-api, Portkey) solve tenancy but assume paid BYOK, because that is where the business
model is. **Simorgh's specific intersection — multi-tenant + free-tier-only + quota-aware scheduling
+ $0 — is unoccupied.** That is a genuine finding, not a comfortable one: it means the capacity
layer (`quota.ts`, `ADR-0003`, `ADR-0005`) is building something with no production reference
implementation, and the compliance questions (§1.8) have no precedent to cite.

---

## 5. What this report contradicts in the repository's current beliefs

1. **GitHub Models is dead.** Any configuration, provider list, or planning artifact that includes a
   GitHub Models bird is retired as of 2026-07-30 (VERIFIED). The flock should drop it.
2. **HuggingFace is not a $0 inference provider anymore.** The free Inference API redirects to
   pay-as-you-go Inference Providers; free users get zero credits (VERIFIED). Under `FREE_ONLY`'s
   unknown-is-not-free rule, an HF inference bird cannot be classified `free` on current evidence.
3. **The pooled-accounts path to 1M is arithmetically and contractually closed.** ~10,000 Groq
   accounts (or equivalent) would be needed for 10M RPD; OpenRouter and Cloudflare explicitly
   prohibit multi-account pooling; Groq disclaims the obligation to provide multiple accounts
   (all VERIFIED, §1.8, §2.2). The current architecture's implied scaling path does not exist.
4. **The platform itself caps at ~10,000 users on the Free plan** (100,000 requests/day, VERIFIED) —
   before any provider limit is consulted. 1M users requires Workers Paid ($5/month), which violates
   `monetary cost = 0` as stated in `ADR-0005`.
5. **The single-global-DO shape breaks within days at 1M users** — the append-only ledger alone
   writes 1.5–5 GB/day against a 1 GB (Free) or 10 GB (Paid) per-object limit (INFERRED arithmetic on
   VERIFIED limits, §3.2).
6. **Multi-tenancy buys Simorgh no provider capacity at all, and the repository may believe
   otherwise.** If any part of the current thinking treats "serve 1M users from our accounts" as
   equivalent to "have 1M users' worth of free-tier capacity," that is wrong in a specific,
   documented way: Groq permits one account serving many End Users (§3.1/§3.2, VERIFIED) but meters
   "at the organization level" (VERIFIED), so all 1M users would share **1,000 RPD**. Tenancy and
   quota are decoupled; only illegitimate account-multiplication reconnects them. This is the
   single most common error in reasoning about free-tier federation and it is worth writing into the
   ADRs.
7. **Simorgh's closest OSS competitors are shipping the thing Simorgh's rules forbid — and that is
   a differentiator, not a gap.** Two active repositories in the 9router ecosystem (133★ and 79★)
   automate bulk account creation for free-tier pooling (VERIFIED, §4). Simorgh's compliance posture
   is therefore *ahead* of the field on the dimension that will decide whether it survives a provider
   enforcement action. Do not "close that gap."

**The one to act on this week:** contradiction 4 and the Cloudflare `$5/month` floor mean
**`monetary cost = 0` and 1M users are, on today's Cloudflare pricing, mutually exclusive
independently of every provider decision.** That is a product/goal conflict the owner needs to see
before any further capacity work — it does not depend on Groq, OpenRouter, or anything in §1.

---

## 6. Could not verify, and how to verify it

| What | Why not | How to verify |
|---|---|---|
| Gemini free-tier RPM/TPM/RPD per model | Login-walled in AI Studio; Google publishes no table ("can be viewed in Google AI Studio… not guaranteed") | Read the AI Studio rate-limit page for a live project, with a date; treat as a snapshot, not a spec |
| Live enforcement vs published limits (all providers) | Only measurable with live traffic; a read-only research task must not fake it | One read-only request per provider from the operator's own accounts, comparing observed 429/headers to published limits |
| How many accounts an operator can *legitimately* hold | Providers deliberately do not publish abuse thresholds | Direct written confirmation from each provider's trust & safety / sales; absent that, assume the strictest reading |
| The exact free-model list on OpenRouter | Dynamic, JS-rendered; only the `:free` mechanism is documented | `GET /api/v1/models` and filter `id` ending `:free`, dated |
| Whether 1M users will install and register keys (BYOK) | A product question, not a research question | A live pilot with install→registration conversion metrics |
| Groq's free-tier model list beyond the official 10-row table | Secondary sources disagree with each other and the official table is ambiguous ("base limits for the Developer plan") | The `GET https://api.groq.com/openai/v1/models` endpoint with a free-tier key, filtered to models the key can actually call |
| Licences for new-api, Portkey, openrelay, tuxevil-rotator, omniroute-rs | Not fetched — **only OmniRoute and 9router were licence-verified this pass** | Fetch each repo's `LICENSE` before recommending any of them; do not infer from the README |
| Real per-request token distribution in Simorgh's workload | Not measured; the 10 req/day assumption is stated, not measured | Instrument the live deployment and re-run §2's arithmetic with measured tokens/request |
| **The on-device fraction in §2.3** | **No 2026 primary source was found that quantifies what share of agentic-gateway traffic is servable locally.** The 10–30% in §2.3 is an explicitly labelled guess, not a finding | Benchmark a real agent workload against a local runtime (llama.cpp / MLX / WebGPU) and count requests that never leave the machine |
| Per-model Groq ITPM/OTPM split | Documented as a *possible* configuration ("If these limits are configured on your account, you'll see your TPM value on the Limits page") — not a published free-tier number | Read `console.groq.com/settings/limits` on a free account |

**On the fetch failures encountered, disclosed rather than papered over:** `console.groq.com/docs/rate-limits`
and `huggingface.co/docs/api-inference/rate-limits` both returned **HTTP 403 / fetch-failed** to a
plain fetch on 2026-10-08, and `openrouter.ai/docs/api-reference/limits` failed likewise. All three
were subsequently obtained through a rendering browser (`firecrawl_scrape`, `maxAge: 0`, i.e. a live
fetch rather than a cache hit) and the quoted text above is from those live fetches. Where a plain
`webfetch` cannot reach a page, this report says so rather than substituting a blog post — but it
also does not drop a *primary* source merely because a bare HTTP client is blocked by it.

---

## 7. The single most important strategic fork

> **The single most important strategic fork Simorgh faces on the way to 1M, and what has to be
> true for each side of it to be the right choice.**

**Side A — BYOK-at-scale.** Every user brings their own provider keys; Simorgh federates, schedules,
and fails over across *the user's own* accounts. For this to be the right choice, the following must
be true: (i) the distribution problem is solvable — one million users will actually install the
gateway and register keys, which is a product/marketing fact no research can settle; (ii) the value
over `curl` (failover, quota-aware scheduling, ledger, MCP) is worth the install friction to users;
(iii) the operator accepts that Simorgh's capacity is then bounded by *users' own* free tiers, not
by anything the operator controls. The evidence that would settle it: a live pilot measuring
install→key-registration conversion, and the SECURITY-AUDIT §4 void conditions staying clear (they
do — user-held keys are not operator-held credentials).

**Side B — pooled accounts.** The operator holds N accounts and routes all users across them. For
this to be the right choice, the following must be true: (i) N can be made large enough — the
arithmetic says ~10,000 accounts for 10M RPD on the best free tier, which is operationally absurd;
(ii) the pooling is contractually permitted — it is not, at OpenRouter and Cloudflare, and Groq
disclaims the obligation to provide multiple accounts; (iii) the platform cost stays $0 — it does
not, because 1M users requires Workers Paid at $5/month. The evidence that would settle it: a
provider explicitly permitting operator pooling at scale (none exists today), or a published
multi-account program.

**The evidence that settles it — and it is more specific than "run a pilot."** This research
found one asymmetry that decides Side B on its own, and it is worth separating from the rest:

> **Multi-tenancy and capacity are decoupled at the provider, and only account-multiplication
> reconnects them.** Groq *permits* one account serving many End Users (§3.1, §3.2 — VERIFIED) but
> meters limits "at the organization level" (rate-limits page — VERIFIED). So Side B has exactly one
> mechanism that produces capacity, and it is the mechanism Groq disclaims, Cloudflare prohibits
> ("produce multiple accounts"; "sign up for the Services on behalf of a third party"), and
> OpenRouter prohibits ("create multiple accounts as a single user, for purposes of bypassing or
> circumventing use limits … or for any other reason"). Meanwhile a published OSS ecosystem already
> productises that mechanism (§4: `Add-Mass-Account-Antigravity-to-9Router`, 133★;
> `gsuite2router`, 79★ — "bulk-add Google Workspace accounts … via automated OAuth login").
>
> **Therefore the test is not "can we hold 10,000 accounts" — it is "does any provider sell, in
> writing, multi-org capacity to one operator."** One affirmative written answer flips Side B from
> closed to obvious, and nothing else does. One refusal from Groq sales closes it permanently. This
> is a single email, it is cheap, and it should be sent before any further architecture work on the
> capacity layer.

**What would have to be true for each side — stated as falsifiable conditions, not aspirations:**

| | Side A (BYOK-at-scale) | Side B (pooled accounts) |
|---|---|---|
| **Capacity condition** | Users' own free tiers must sum to the workload. **Already satisfied** — 1M users × their own accounts exceeds 10M RPD by two orders of magnitude (§2.1) | N accounts must reach ~10,000 for Groq alone. **Currently ~10,000× short of legitimate supply** |
| **Contractual condition** | No provider ToS is implicated — every account belongs to its owner. **Satisfied today** | Every provider must permit operator pooling. **Fails at OpenRouter (prohibited), Cloudflare (prohibited ×2), Groq (disclaimed)**; Gemini is silent and bounded by a 10-project cap |
| **Cost condition** | Platform must serve 1M users at $0. **Fails**: Workers Free caps at 100,000 req/day → ~10,000 users | Same failure, and it is not fixable by pooling — it is a Cloudflare limit, not a provider limit |
| **Compliance condition** | SECURITY-AUDIT §4 void conditions stay clear. **Satisfied** — user-held keys are not operator-held credentials | Operator becomes a second principal holding 10,000 credentials. **Triggers the §4 risk acceptance and its void conditions** |
| **The thing it costs you** | Capacity you do not control. You are a nicer `curl`. The operator's leverage over service quality is limited to routing | Your own rule — never evade bans, rate limits, account verification, or contractual restrictions — is violated at the exact scale where the model works. Simorgh becomes a project whose stated method is the thing its rule forbids |

**The fork, stated without softening.** Side A is privacy-safe, federates nothing a Cloudflare-style
router cannot, and makes 1M users a distribution problem rather than a capacity problem — but it
makes Simorgh a nicer `curl`. Side B is the only path to *operator-controlled* capacity advantage,
and it is bounded by what ToS permits and by how many accounts an operator can legitimately hold —
which the evidence shows is "very few, and fewer than 1M users requires." **The honest summary is
that Side A is not the winner by default; it is the winner *conditional on one email*.** Send it.
If a provider answers in writing that it will sell one operator N organizations' worth of free-tier
capacity, Side B becomes correct and the architecture should stay as built. Until that answer
exists, the repository's own compliance rule and its own capacity math point the same direction, and
they point at Side A.

**What you are buying if you take Side A anyway:** you keep the ledger, the MCP surface, honest
degradation, quota-aware scheduling across a user's own heterogeneous keys, and — per §4 — a
compliance posture no competitor in this space can honestly claim. The value is not capacity. It is
that it is the only one of these designs you could describe to a user without lying.

**The fork, in one line:** the question is not "BYOK or pooled accounts" in the abstract — it is
**"is there a written provider agreement that decouples tenancy from quota?"** Today every provider
couples them, which is why Side B cannot scale and Side A can. That coupling is the whole fork.

TASK-015-RESEARCH-END
