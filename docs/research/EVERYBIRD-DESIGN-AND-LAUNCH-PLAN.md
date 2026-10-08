# Simorgh — the "everybird" design and the 11 October launch

- **Written:** 2026-10-08 · **Author:** LongCat 2.5 Preview Free session (lead)
- **Trigger:** Shai set three constraints — (1) public launch **11 Oct**, his birthday; (2) 1M users is not
  the current goal, ship first then build the revolution; (3) Cloudflare is *optional*, everything must
  also run locally or in a private repo.
- **Stated goal:** *"unify all computing providers for AI swarmish workflow — at least 5 options for
  every area/category, and make Simorgh deployable using even the tiniest of them."*
- Companion: `WHERE-WE-ARE-AND-WHERE-WE-GO.md` (the platform research this plan is built on).

---

## 0. What your three answers actually change

Answer 3 is the load-bearing one and it inverts part of what I recommended an hour ago.

I said "adopt AI Search, adopt Workflows." **That was wrong under your constraint.** If a user must be
able to run Simorgh on their laptop or in a private GitHub repo with no Cloudflare account, then
Cloudflare cannot be *the* substrate — it can only be *one adapter*. The good news is that your
architecture already made this possible and nobody used it: **`phoenix-core` is runtime-agnostic with
every capability behind a port**, machine-enforced by `boundary.test.ts`. The engine was built for
portability; the strategy just never exploited it.

So the reframe is:

> **Simorgh is not a Cloudflare app with a fallback. It is a capability-negotiating runtime with 5+
> adapters per capability, where the host is itself just another capability.**

That is one idea, and it is the whole product. Everything below is that idea applied.

---

## 1. The core design: **5 options is a discovery problem, not a catalogue problem**

The naive reading of "5 options per category" is a big `switch` statement with five branches that grows
a sixth every time a provider appears. That is how a solo project dies of maintenance — and your own
constraint #3 ("solo, uncompensated operator") says reduce maintenance, not add it.

The alternative: **the runtime probes what is actually available, then composes.**

```
   ┌──────────────────────────────────────────────────────────────┐
   │  DECLARE  what a capability IS (pure interface, 0 deps)       │
   │    Embedder · VectorStore · Inference · ObjectStore ·         │
   │    Scheduler · Secrets · Connector                            │
   └──────────────────────────────────────────────────────────────┘
                              ▲ implements
   ┌──────────────────────────┴───────────────────────────────────┐
   │  DISCOVER  every registered adapter that answers /probe()      │
   │  honestly:  {ok, cost, limits, dims, freshness, requires}     │
   └──────────────────────────────────────────────────────────────┘
                              ▲ feeds
   ┌──────────────────────────┴───────────────────────────────────┐
   │  PLAN     quota.ts already does this for capacity. Extend it  │
   │  to capabilities: cheapest-that-works, with an honest         │
   │  degradation ladder and a REASON for every choice.            │
   └──────────────────────────────────────────────────────────────┘
```

**Why this is the right shape, not a cute one:** `phoenix-core` already contains the hard part. It
already (a) declares ports with no dependencies, (b) has a planner that ranks candidates against a
finite shared budget, (c) fails closed and says *why*. The swarm, the ledger, the reason vocabulary
TASK-016 specced — those are **routing machinery that already exists and is waiting for more
categories to route across.** Your "5 options everywhere" is not new work; it is the existing engine
pointed at a wider surface.

**The honest-degradation ladder is the product.** Right now a missing provider means `flock_exhausted`.
Tomorrow, a user with one Cloudflare account and one laptop should see:

```
embedding  → local model (free, slow, private)      [was: none → refuse]
vector     → local file index                       [was: none → refuse]
inference  → whatever probe() says is healthy       [unchanged]
sync       → whichever connectors are configured     [was: none → refuse]
```

Failing over *down* a ladder and *saying so* is what makes "unify all providers" true rather than
aspirational. And it is precisely what "deployable on the tiniest provider" means.

### The one rule that keeps this from rotting

**A capability may be satisfied by zero adapters, and the runtime must say so at startup.** No
"pluggable" system that pretends everything is available. Simorgh's own doctrine — *"a scheduler that
silently drops candidates is indistinguishable from one that lost them"* — is the spec for this. A
`/simorgh/capabilities` endpoint that prints the real, probed, honest matrix is the deliverable, and it
is also the demo.

---

## 2. The catalogue: 5+ per category, with what is actually free today

Every row marked ✅ is verified this run. `[R]` = reported by secondary sources only — verify before
depending on it.

### 2.1 Embeddings — **the actual bottleneck, and the reason the product is hard**

| # | Adapter | Free allowance | Dims | Card? |
|---|---|---|---|---|
| 1 | **Cloudflare Workers AI** `bge-base` / `bge-m3` | 10,000 Neurons/day → `bge-base` ≈ **1.65M tok/day**; `bge-m3` ≈ 9.3M | 768 / 1024 | no |
| 2 | **Google Gemini Embedding** | 1,500 req/day, 10M tokens/min ✅ | 3,072 | no |
| 3 | **Jina Embeddings v4** | 1M tokens/**month** ✅, one-time 10M grant `[R]` | 2,048 → Matryoshka to 128 | no |
| 4 | **Voyage AI** | 200M free tokens (one-time, not renewing) `[R]` | varies | no |
| 5 | **Pinecone Inference** | 5M tokens/**month** on Starter ✅ | — | no |
| 6 | **OpenRouter** `liquid/lfm-2.5-embedding-350m:free` | 50 req/day free ✅ | small | no |
| 7 | **Local** — `node-llama-cpp` / `fastembed` (ONNX) | unlimited, **but this box has no AVX2** | — | — |

**The uncomfortable fact:** most of these are one-time grants, not renewing allowances. Voyage's 200M
and Jina's 10M do not refill. So a *sustainable* free embedding pipeline is mostly Workers AI
(renewing daily) plus Gemini (renewing daily), with the rest as burst/top-up capacity. **The planner must
know the difference**, which is exactly why `/probe()` returns `renewing: boolean`. This is a real
design requirement that only showed up because you asked for 5 options.

**And the no-AVX2 problem has a consequence worth stating plainly:** a local embedding adapter is
architecturally right and *empirically useless on this machine*. Ship the adapter anyway — a user's
laptop has AVX2 — but do not build the launch around it.

### 2.2 Vector store

| # | Adapter | Free | Self-host | Note |
|---|---|---|---|---|
| 1 | **Cloudflare Vectorize** | 30M queried dims/mo, 5M stored ✅ | no | 50k namespaces `[R]` |
| 2 | **Cloudflare AI Search** | 1k semantic + 1k full-text queries, 5M ingestion tok/mo ✅ | no | Managed RAG; billing starts **2026-11-01** |
| 3 | **pgvector** | free ext; Neon 0.5GB × 100 projects, 100 CU-hr ✅ | **yes** | The default when Postgres exists |
| 4 | **sqlite-vec / Turso** | 100 DBs, 5 GB, 500M reads/mo `[R]` | **yes** | Cheapest per-vector by a wide margin |
| 5 | **Qdrant** | 1 GB forever `[R]` | **yes** | Rust; best free OSS tier |
| 6 | **Weaviate** | self-host free; Cloud 14-day trial only `[R]` | **yes** | Native hybrid (BM25+vector) |
| 7 | **Local in DO SQLite** | with 5 GB DO storage on Free ✅ | **yes** | No vector index, but honest fallback |

**The ladder is natural here:** try Vectorize/AI Search if a CF account exists → pgvector if a Postgres
does → sqlite-vec if a file system does → DO SQLite as the always-available floor. Four rungs, and
the bottom rung works on a laptop.

### 2.3 Inference — this is where you already win

| # | Adapter | Free | Commercial OK? |
|---|---|---|---|
| 1 | Groq | standing free key ✅; **needs phone verification** `[R]` | yes |
| 2 | Cloudflare Workers AI | 10,000 Neurons/day ✅ | yes ✅ |
| 3 | Google Gemini API | standing free tier ✅ | yes ✅ (but free-tier data may improve Google products) |
| 4 | OpenRouter | 25+ free models, **50 req/day, 20 RPM** ✅; 1,000/day after $10 preload | yes, but **Jul 2026 ToS prohibits reselling API access or building a competing service** `[R]` |
| 5 | Mistral free mode | free by default, no card ✅ | "unclear for free mode" `[R]` |
| 6 | SambaNova, Cerebras, Together, W&B Inference ($100/mo credits `[R]`) | varies | — |

⚠️ **Two of your five current birds are already unusable** (from TASK-015): HuggingFace's free tier is
gone (free users get zero credits → cannot be classified `free` under `FREE_ONLY`), and GitHub Models
is fully retired. Adding Gemini + OpenRouter gets you to five.

⚠️ **OpenRouter's ToS is a trap for your stated goal.** "Prohibits reselling API access or building a
competing service" `[R]` — if Simorgh becomes a public federating gateway, OpenRouter is the adapter
you must be most careful with. Worth a deliberate decision, not an oversight.

### 2.4 Host / compute — constraint #3 lives here

| # | Target | Free | Simorgh effort |
|---|---|---|---|
| 1 | **Local Node** | free, the floor | **already works** — `phoenix-core/src/node/` + `platform:smoke` |
| 2 | **Cloudflare Workers** | 100k req/day, 10 ms CPU ✅ | **already works** — the deployed path |
| 3 | **Vercel Hobby** | 1M invocations/mo, 300 s max, 200 projects ✅ | new adapter; `SqlPort` sync is the blocker |
| 4 | **Deno Deploy** | free tier | engine is runtime-agnostic — likely the *easiest* new host |
| 5 | **Docker / VPS / GitHub Actions** | self | new adapter |
| 6 | **GitHub Pages** | free | for the **GUI only** — static, separate deployable |

**The `SqlPort` blocker is now the highest-leverage unlock you have.** ADR-0002 rejected Vercel because
`SqlPort` is synchronous. But: Neon and Supabase both have **free Postgres** with HTTP drivers, and
SQLite exists everywhere. If `SqlPort` gains an async variant (as a second interface, not a breaking
change), you unlock Vercel + Neon + Supabase + Turso + any networked DB in one move — and the
retrieval layer needs a real DB anyway. This is D4 from your own external-review brief, and retrieval
has just made it blocking.

### 2.5 Connectors — **do not rebuild OAuth**

Vercel Connect (GA, 2026-09-18) already provides managed OAuth for **Slack, GitHub, Microsoft, Linear,
Discord, Notion, Telegram** plus Custom OAuth for anything else, multi-tenant installations, and
verified webhook triggers. 500 token requests/mo free on Hobby. `[R]` for the Notion/Telegram/Discord
connector list — that came from a chat-sdk cross-link, verify before relying on it.

Notion's own limits, verified this run: **180 req/min per connection** + a *separate workspace-wide
budget*, 429 with six distinct reasons (`public_api_request_blocked` means retrying will not help),
**529 = overloaded**, and the nasty one — **a write can return 503 *after saving***, with
`retry_guidance: ["Do not repeat the write"]` in the body. A sync layer must handle that explicitly or it
will double-apply every timed-out write.

Drive `[R]`: per-app quota (1,000 req/100 s per user), and **watch channels are temporary and expire
within hours or days**, so they need renewal. `developers.google.com` 403'd both my fetchers — I could
not first-party-verify, so **do not design Drive sync against an unconfirmed channel lifetime.** Poll-first
is the safe default.

### 2.6 Orchestration / scheduler

| # | Adapter | Free |
|---|---|---|
| 1 | Local timers (Node) | free — the floor |
| 2 | **Cloudflare Workflows** | 3,000 steps/day, `waitForEvent`, unlimited step wall time ✅ |
| 3 | Cloudflare DO alarms + cron | 15 min wall per cron/alarm ✅ |
| 4 | Cloudflare Queues | 10,000 ops/day ✅ |
| 5 | GitHub Actions cron | free for public repos |
| 6 | Deno Cron, Vercel Cron, Supabase pg_cron | — |

This category has the cleanest answer: `Workflows` for durability, cron/alarms for the floor, and the
engine's existing `scheduled.ts` abstraction is already the seam.

---

## 3. The launch cut — 11 October, three days

Being blunt: **you cannot launch the full vision in three days, and attempting to will produce
something that fails publicly on your birthday.** So the cut has to be about what is *true*, not what is
*complete*.

### The launch thesis (one sentence)

> **Simorgh runs on whatever compute you have — laptop, Cloudflare, or your own server — routes every
> request to whatever model provider is healthy, and tells you exactly why it chose each one.**

That sentence is **already ~70% true today**. That is the launch. Not the RAG. Not the GUI. Not the swarm.

### Ships on 11 Oct

| Item | Why it's in the cut | Status |
|---|---|---|
| The **existing** core + platform + honest degradation | It is genuinely good and fully tested (497 green) | ✅ done |
| **A real README + a live `/capabilities` probe endpoint** | This *is* the "5 options" story, honestly told | 2 h |
| **Add Gemini + OpenRouter as birds** (→ 4 working inference options) | Cheap, and revives the roster TASK-015 damaged | 3 h |
| **A `/simorgh doctor` that prints the probed capability matrix** | The demo. Turns "pluggable" from a claim into evidence | 3 h |
| **Deployment docs for 3 hosts**: local Node, Cloudflare, Docker | Constraint #3, made concrete | 3 h |
| Fix **AUTH-002 / AUTH-003** (IDOR on `/user/:id/logs`, `/context`) | **You are going public.** A stranger can read any user's ledger. Not acceptable to defer | 4 h |
| A birthday-appropriate name/landing page | It's your birthday | 2 h |

### Explicitly NOT in the cut — and why that's a feature

- **Retrieval/RAG.** The honest reason: your embedding budget is the binding constraint and most free
  tiers are *one-time grants*. Shipping a RAG on 11 Oct means shipping one that stops working when
  Voyage's 200M runs out. Better to launch a gateway that never lies, then add retrieval in week 2 with
  a renewable provider as the default.
- **The GUI.** A PWA is a week, not a weekend. Ship a *good* dashboard (TASK-014 is small and the data
  already exists) and promise the setup GUI.
- **The swarm.** It has no non-test caller. Launching "swarmish" as a claim would be the one thing that
  isn't true.
- **Mobile.** Same reason.

**Framing for the launch:** *"Simorgh is the honest federating gateway. Retrieval, swarms, and a setup
GUI are next — here is the roadmap, here is the code, come back."* A project that says "here's what
isn't built yet, and here's why" gets more contributors than one that overpromises and 503s.

---

## 4. The build order after launch — cheapest unlocks first

| # | Move | Unlocks | Cost | Risk |
|---|---|---|---|---|
| **1** | **`SqlPort` async variant** as a *second* interface, `SyncSqlPort` kept | Vercel + Neon + Supabase + Turso + any networked DB. **Also unblocks retrieval.** | ~2 days | Touches the engine boundary everything depends on — do it behind the existing test, never weakening `boundary.test.ts` |
| **2** | **Retrieval behind a port** + 4-rung vector ladder | The RAG, on any host | ~1 week | Embedding budget (see §2.1) |
| **3** | **`/capabilities` probe → capability planner** in `quota.ts` | "5 options everywhere" becomes automatic rather than hardcoded | ~3 days | This is TASK-016's reason vocabulary, generalised |
| **4** | **Give the swarm a caller** — one real use (scheduled multi-source digest) | Makes "swarmish" true | ~2 days | Bounded by existing `maxSubtasks` |
| **5** | **GUI as separate PWA** on Pages/Vercel, mobile-first | Connector setup + sync status + metrics | ~1 week | Needs real endpoints to exist first (2) |
| **6** | **Connector adapters** (Notion → R2 → index; Drive via polling; Telegram) | Your actual "multiple providers for different jobs" | ~1 week | The Notion 503-after-save hazard must be handled |
| **7** | **Job routing**: route *by job type* per connector | "different providers for different jobs" | ~3 days | Builds on 3 |
| **8** | DO-per-tenant coordinator | The 1,000 req/s wall (now a documented number) | ~2 days | Trades silent saturation for partial visibility — the trade you already prefer |

**Note the ordering:** (1) before (2) before (5). Async storage is the keystone — it unlocks hosts
*and* the database retrieval needs *and* is the one thing that is impossible to retrofit cheaply.

---

## 5. What "best results" means, since that's your stated goal

You said: set everything up and use them **for best results**. That's a different goal from "free", and
the planner is where it becomes real. Two rules:

1. **Never route to a provider you cannot verify.** Your `FREE_ONLY` + *unknown-is-not-free* doctrine
   (ADR-0005) is already the right shape. Extend the same discipline to *capabilities*: a vector store
   that reports 768-dim embeddings is not interchangeable with one reporting 3,072, and a store that
   cannot tell you which is which will silently destroy recall. **`/probe()` must return dimensions and
   freshness, and the planner must refuse to mix incompatible indexes.** This is a real correctness
   bug waiting to happen otherwise.
2. **Rank by outcome, not price.** Cheapest-that-works is right for a `get_server_time` tool call and
   wrong for a 100k-token research job. TASK-016 already specced complexity-aware routing as "order,
   never exclude" — that rule is exactly what makes multi-provider *best-result* rather than
   cheapest-wins.

---

## 6. The one thing I'd push back on

Your goal says *"at least 5 options for every area/category."* As a **catalogue** that is right and
aspirational. As a **shipping commitment** it is the thing most likely to make you miss your own
birthday — because the 6th, 7th and 8th adapters are where the maintenance tax lands, and constraint #3
says reduce maintenance.

The reframe resolves it: **the runtime discovers options, it does not enumerate them.** Ship 3 per
category and write the probe. Then a user with a Qdrant instance and a Weaviate cluster and a Turso DB —
who is not you and never will be — plugs them in and gets 8 options with no code from you. The goal is
met *better* by a probe than by a switch statement, and it is achievable in three days instead of three
months.

---

## 7. Immediate next actions (pick one, I'd suggest the first)

1. **Fix AUTH-002/AUTH-003** — you ship to the public in 3 days and these are live data leaks.
2. **Add Gemini + OpenRouter birds** — revives the roster to 4 in ~3 hours.
3. **Build `/capabilities` probe + `/simorgh doctor` matrix** — the demo and the launch story.
4. **Write the 3-host deploy doc** — makes constraint #3 true on paper.

Say which and I'll start. If you want, I'll draft the `SqlPort` async seam design first, because
everything else on the roadmap is downstream of it and it is the one decision that gets expensive if
deferred.

---

## Evidence index (this document)

| Claim | Source | Date |
|---|---|---|
| Workers AI 10,000 Neurons/day; per-model neuron costs | developers.cloudflare.com/workers-ai/platform/pricing | 2026-10-01 |
| Vectorize 30M/5M dims Free | developers.cloudflare.com/vectorize/platform/pricing | 2026-04-21 |
| AI Search 1k+1k queries, 5M ingestion tok, billing 2026-11-01 | developers.cloudflare.com/ai-search/platform/limits-pricing | 2026-10-01 |
| Workflows 3,000 steps/day, waitForEvent | developers.cloudflare.com/workflows | 2026-09-18 |
| Browser Run free plan, no-deploy Quick Actions | developers.cloudflare.com/browser-run | 2026-08-11 |
| Wasm: no threading, experimental WASI, slower start | developers.cloudflare.com/workers/runtime-apis/webassembly | 2026-04-23 |
| DO 1,000 req/s soft limit | developers.cloudflare.com/durable-objects/platform/limits | 2026-06-01 |
| Workers Free 100k/day, 10 ms CPU, KV 1k writes/day | developers.cloudflare.com/workers/platform/pricing | 2026-10-02 |
| Vercel Hobby allowances; Connect GA + 500 token req/mo | vercel.com/docs/plans/hobby · vercel.com/docs/connect | 2026-09-14 · 2026-09-18 |
| Notion 180/min + workspace budget; 503-after-save hazard | developers.notion.com/reference/request-limits | fetched 2026-10-08 |
| Gemini embedding 1,500 req/day, 3,072 dims, no card | edenai.co aggregation `[R]` | 2026 |
| Jina 1M tok/month free | edenai.co `[R]` · openrouter blog | 2026 |
| OpenRouter 50 req/day, 20 RPM; $10 preload → 1,000/day | kdnuggets `[R]` · merginit `[R]` | 2026 |
| OpenRouter ToS bars reselling / competing service | freellmapihub (github) `[R]` — **verify directly** | verified 2026-08-02 upstream |
| Voyage 200M one-time; Pinecone Inference 5M/mo | freellmapihub (github) `[R]` | 2026-08-14 |
| Vector DB free tiers (Qdrant 1GB, sqlite-vec, Weaviate trial) | firecrawl.dev · liveblocks · olostep `[R]` | 2026 |
| Neon 100 projects × 0.5 GB + 100 CU-hr; Supabase 500MB/2 projects/pauses 1wk; D1 5 GB | getautonoma · tanstackship `[R]` | 2026 |
| CPU 1.09% of budget; sanitizer is 39–61%; no-test-caller | bench/native-audit/results.json | 2026-10-07 |
| HF free tier gone; GitHub Models retired; pooled accounts closed | projects/simorgh-prd-research/one-million-users.md | 2026-10-08 |
| Go/TS routing divergence; 3× ADR-0003 confirmed | docs/research/ROUTING-CONVERGENCE.md | 2026-10-08 |

**Not verified — do not design against these without checking:** Google Drive quota numbers and
`changes.watch` lifetime (403 from two fetchers); Telegram Bot API current quota envelope; whether
AI Search's included quota is per-account or per-instance; Vercel Connect's exact connector list
(Notion/Telegram/Discord came from a chat-sdk cross-link).