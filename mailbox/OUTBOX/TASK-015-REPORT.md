# TASK-015 — Free-tier capacity math for 1M users

Research. Read-only on `projects/simorgh/`. Full report (598+ lines, every claim tagged
VERIFIED / REPORTED / INFERRED / UNVERIFIED) at
**`projects/simorgh-prd-research/one-million-users.md`**.

**Headline: 1M users at $0 is reachable under BYOK and is not reachable under pooled
accounts. The current architecture implies pooled accounts. The fork is not subtle and it is
not a close call.**

---

## 1. The answer, in one paragraph

Pooled accounts fail on three independent axes, any one of which is sufficient: **arithmetic**
(~10,000 Groq accounts needed for a 10M req/day workload), **contract** (OpenRouter and
Cloudflare each explicitly prohibit the multi-account pattern; Groq disclaims any obligation to
provide multiple accounts), and **platform** (Workers Free caps at 100,000 requests/day ≈ 10,000
users, so Workers Paid at $5/month is unavoidable — which breaks `monetary cost = 0` on its own,
independent of every provider decision). BYOK trivially clears the capacity bar: 1M users each
holding their own free account is two orders of magnitude above the workload. BYOK's problem is
distribution and value-proposition, not capacity — and that is a product question this research
cannot settle.

## 2. The finding that matters most, and it is narrower than "pooling is impossible"

**Every provider couples tenancy to quota. That coupling is the whole fork.**

Groq's Services Agreement §3.1/§3.2 (VERIFIED, fetched 2026-10-07) *explicitly permits* one
account serving many End Users — "make the Cloud Services and AI Model Services available to End
Users through your Customer Applications", with "Authorized Account Users" defined to include
"other authorized third parties permitted by Customer". But Groq's rate-limits page (VERIFIED)
says "**Rate limits apply at the organization level, not individual users**."

So: **one account serving 1,000,000 users still gets 1,000 requests/day.** Many users and more
capacity are *decoupled*. The only mechanism that reconnects them is holding many organizations —
which is exactly what Groq disclaims ("Groq has no obligation to provide multiple accounts to
Customer"), Cloudflare prohibits twice (§2.2.1(a) "sign up for the Services on behalf of a third
party"; §2.2.1(e) "produce multiple accounts"), and OpenRouter prohibits (§7.03: "create multiple
accounts as a single user, for purposes of bypassing or circumventing use limits … **or for any
other reason**"). Note that OpenRouter adds "we govern capacity globally" — pooling there is not
just prohibited, it is **futile**.

If any part of the repo's thinking treats "serve 1M users from our accounts" as equivalent to
"have 1M users' worth of free-tier capacity", that is wrong in this specific documented way. This
is the most common error in reasoning about free-tier federation and it belongs in the ADRs.

## 3. Provider free tiers — the two findings the lead needs immediately

| Provider | Status (all VERIFIED 2026-10-07/08, primary docs) |
|---|---|
| **Groq** | The strongest tier that exists. Free table: gpt-oss-120b/20b + qwen3.8-27b at 30 RPM / 1K RPD / 8K TPM / 200K TPD. Full `x-ratelimit-*` headers, always present; `retry-after` on 429 only. Per-org. No card for free. |
| **HuggingFace** | **The free inference tier is gone.** The rate-limits URL now serves Inference Providers pricing: "Free Users — Monthly Credits: **None** … Extra usage: yes (**credits purchase required**)". Under `FREE_ONLY`'s unknown-is-not-free rule, an HF inference bird **cannot be classified `free`**. Any belief that the flock's HF bird is free is now false. |
| **GitHub Models** | **RETIRED.** "As of July 30, 2026, GitHub Models has been fully retired. The playground, model catalog, inference API, and bring your own key (BYOK) are no longer available to any customer." Any config referencing it is dead. |
| **Cloudflare Workers AI** | Real, and small: **10,000 Neurons/day** free, both plans. On llama-3.2-1b (18,252 neurons/M output tokens) that is ~548K output tokens/day ≈ 500–1,000 requests/day per account. |
| **Google AI Studio** | Real free tier, but the per-model RPM/TPM/RPD table is **login-walled** and Google says "Specified rate limits are not guaranteed and actual capacity may vary." Hard cap: **10 projects per user**, which bounds Gemini pooling. |
| **OpenRouter** | 20 RPM / **50 RPD** (<10 credits all-time) or 1,000 RPD (≥10). Free-model counter is programmatically discoverable via `GET /api/v1/key`. `X-RateLimit-*` only on 429s. |

## 4. Deliverable B — what breaks at 1M, with documented limits

Starting point confirmed in code: `src/index.ts:151,316,416,443` and `src/flock.ts:165` resolve
`idFromName("global")` — **two global objects** (FlockCoordinator + DataTrustVault), one
`rate_limits` table, one `bird_health` table, one append-only `ledger`.

| Ceiling | Documented limit (source, date) | At 1M users |
|---|---|---|
| **DO throughput** | "An individual Object has a soft limit of **1,000 requests per second**" / "inherently single-threaded"; over-limit → `overloaded` (developers.cloudflare.com/durable-objects/platform/limits, **Last updated Jun 1, 2026**) | 10M req/day ≈ 116 req/s avg; a 10–20× diurnal peak is **1,200–2,300 req/s — over the ceiling.** First symptom is `overloaded`, not graceful degradation |
| **DO SQLite storage** | "Storage per Durable Object: **10 GB**"; Free plan **1 GB**; over → `SQLITE_FULL`, reads/deletes still work (same page) | Ledger is append-only "by design" (`phoenix-core/src/ledger.ts:19-24`). 10M rows/day at ~150–500 B = **1.5–5 GB/day → fills the Free object in under one day, Paid in 2–7 days.** No delete path exists in the schema |
| **Workers Free requests** | **100,000/day**, Error 1027 (workers/platform/limits, **Last updated Sep 5, 2026**) | Caps the Free plan at **~10,000 users** at 10 req/day — two orders short, before any provider is consulted |
| **Subrequests** | Free **50**/invocation; Paid 10,000 (same page) | An agentic execute (provider + KV + DO + tool loop) approaches 50. Paid is the only headroom → $5/month → breaks `monetary cost = 0` |

**Recommendation: shard per-tenant state by Durable Object; keep the flock coordinator global but
read-mostly.** DO-per-tenant (`idFromName("tenant:" + hash(userId))`) gives each tenant its own
1,000 req/s and contains ledger growth. **Rejected:** one object with row-level tenant keys — it
fixes nothing, because the 1,000 req/s and 1–10 GB ceilings are properties of the *object*, not
the schema. **Right long-term home for the ledger:** D1, at the cost of the append-only guarantee
becoming a retention policy rather than a schema invariant.

**The trade, named:** the current single-object design fails by **silent saturation** —
`overloaded` and `SQLITE_FULL` are indistinguishable from each other and from provider trouble at
the edge. The sharded design fails by **partial visibility** — a status view that is an unlabelled
aggregate. Simorgh's own doctrine ("degrade honestly") accepts the second and rejects the first.
**A recommendation without this trade is not a recommendation**, so it is stated: sharding converts
a dishonest failure into a merely imprecise one.

## 5. Deliverable C — the adjacent-project question, answered bluntly

**No real, maintained project does federated free-tier routing at multi-tenant scale. Simorgh
would be building something with no production reference implementation.**

The space is crowded one tier down — personal gateways for coding agents — and empty where
Simorgh sits:

- **OmniRoute** 74,033★, **MIT (VERIFIED — LICENSE fetched)**, active today, "359 providers
  (150+ free)… quota-aware auto-fallback". Single-user.
- **9router** 30,439★, **MIT (VERIFIED — LICENSE fetched)**, active today, "40+ providers.
  Auto-fallback". Single-user.
- **LiteLLM** 60,298★, MIT, active. Multi-tenant — but **paid** providers with BYOK only; no
  free-tier quota concept, no `FREE_ONLY` gate.
- The multi-tenant gateways solve tenancy and assume paid BYOK, because that is where the money
  is. **Multi-tenant + free-tier-only + quota-aware + $0 is unoccupied.**

**The uncomfortable corollary, which is also an opportunity:** GitHub search found an active
**mass-account-creation ecosystem** around 9router — `Add-Mass-Account-Antigravity-to-9Router`
(133★) and `gsuite2router` (79★, "bulk-add Google Workspace accounts to 9Router Antigravity
provider via automated OAuth login"). That is Simorgh's pooled model, productised and
star-counted. It proves the demand is real **and** that the ecosystem is operating where
Cloudflare §2.2.1(a)/(e) and OpenRouter §7.03 prohibit. **Simorgh's compliance posture is ahead
of its closest competitors on the dimension that decides whether it survives an enforcement
action. Do not "close that gap."**

## 6. What I could not verify

Full table in the report §6. The load-bearing gaps: **Gemini's per-model free-tier numbers**
(login-walled; Google publishes none); **live enforcement vs published limits** (not measurable
without sending traffic); **how many accounts an operator may legitimately hold** (providers
deliberately do not publish abuse thresholds); and **the on-device fraction in §2.3 of the
report, which is an explicitly labelled 10–30% guess with no 2026 primary source** — I found no
source that quantifies what share of agentic-gateway traffic is servable locally, and I did not
invent one.

Disclosure on method: `console.groq.com/docs/rate-limits`, `huggingface.co/docs/api-inference/rate-limits`
and `openrouter.ai/docs/api-reference/limits` all returned **403 / fetch-failed** to a plain HTTP
fetch. Each was then obtained by live browser fetch (`firecrawl_scrape`, `maxAge: 0`), and the
quotes are from those live fetches. I did not substitute a blog post for any blocked primary
source, and I did not drop a primary source because a bare HTTP client was blocked.

## 7. The strategic fork

**BYOK-at-scale vs pooled accounts.** Full statement with falsifiable conditions in the report's
final section. Neither side softened. The decisive asymmetry: **Side B has exactly one mechanism
that produces capacity — holding many organizations — and that mechanism is what every provider
declines, disclaims, or prohibits.** Side A's capacity condition is already satisfied; its
open question is distribution, which is not a research question.

**The evidence that would settle it, and it is one email:** ask any provider's sales team whether
it will sell one operator N organizations' worth of free-tier capacity, in writing. One affirmative
answer flips Side B from closed to obvious and the architecture should stay as built. One refusal
closes it permanently. Nothing else settles it — not a pilot, not a market survey. **Send that
email before any further capacity-layer work.**

Note the honest asymmetry in Side A's favour beyond capacity: users holding their own keys do not
trigger the SECURITY-AUDIT §4 void conditions (user-held keys are not operator-held credentials).
Side B at 10,000 credentials makes the operator a second principal holding other people's
credentials — which is precisely what §4's risk acceptance covers.

## 8. Constraints honoured

Read-only on `projects/simorgh/` — the only file written under it is this report. No test suite
run. No `git commit`/`push`/`rebase`. Deliverables: full report at
`projects/simorgh-prd-research/one-million-users.md`, intro at `mailbox/OUTBOX/TASK-015-INTRO.md`,
this summary at `mailbox/OUTBOX/TASK-015-REPORT.md`.

**One thing for the owner, unsoftened:** `monetary cost = 0` (ADR-0005) and 1M users are mutually
exclusive on today's Cloudflare pricing **independently of every provider decision**. 100,000
requests/day on Free is ~10,000 users; 1M users needs Workers Paid at $5/month. That conflict
sits above the whole provider question and should be resolved before more architecture is built on
the capacity layer.

TASK-015-END
