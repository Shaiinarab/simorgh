# Where Simorgh is, and where it can go — a decision-grade scan

- **Written:** 2026-10-08 · **Author:** LongCat 2.5 Preview Free session (lead), with mcp-fleet / Firecrawl
- **Scope:** "what is the app now", "what is deployable today", "what should it become given free-tier
  constraints", "does it need a Rust core"
- **Evidence rule:** every platform claim below traces to a first-party doc fetched this run, with the
  page's own `Last updated` date. Project-state claims trace to repo reads. Anything not evidenced is
  labelled `[UNVERIFIED]` and is not load-bearing for any recommendation.

---

## 0. The one-paragraph answer

Simorgh is a **routing engine with an excellent memory of how to fail honestly**, and the product you
described is a **retrieval-and-orchestration system with a GUI**. Those are not the same thing, and the
gap between them is not a feature list — it is a different centre of gravity. The engine is real,
tested (129 workerd + 368 node), and genuinely good at what it does. But the thing that would make
people *use* it — a persistent, multi-source, swarm-ish RAG with a setup GUI — is ~80% unbuilt, and the
single most important finding of this scan is that **three of the four pieces you want now exist as
first-party Cloudflare primitives** (AI Search, Workflows, Browser Run) that were not in the project's
vocabulary when its ADRs were written.

---

## 1. Where the app actually is today

### What exists (repo reads, 2026-10-08)

| Layer | Size | State |
|---|---|---|
| `phoenix-core/` engine | 3,950 LOC, 16 files | Routing, quota/planning, agent tool loop, security, ledger, health, swarm, tasks |
| `src/` edge host | 2,457 LOC, 12 files | Hono router, 2 Durable Objects, dashboard (656 LOC inline HTML), Telegram, platform routes |
| `simorgh-platform/` | control plane | Targets, REST/MCP connectors + conformance, deploy preflight, fleet, CLI |
| `gateway/ packages/` Go | 8 modules | A **second** answering runtime with its own routing policy; cannot join the fleet |
| Tests | 497 green | 129 workerd + 368 node |

### The four structural facts that matter for your intent

1. **There is no retrieval layer at all.** I grepped `phoenix-core/src`, `src`, and
   `simorgh-platform/src` for `embed|vector|Vectorize|rag|chunk|retriev`. Zero hits on an actual
   vector store. What exists that is *retrieval-adjacent* is `CONTEXT_STORE` (Workers KV) used as a
   context offload keyed by a reference id (`src/index.ts:392`, `src/agent-service.ts:99-101`) — a
   blob store, not a search index. `DataTrustVault` (`src/data-trust.ts:33`) is 61 LOC and is a
   transparency/append-only record, not a memory.

   **This is the single biggest gap.** Your product is a RAG. The project has zero RAG.

2. **Swarm exists as scheduling logic, not as running agents.** `phoenix-core/src/swarm.ts` (334 LOC)
   is well-reasoned — it caps fan-out, forbids capability widening down the tree, and folds each
   placement back into the shared quota pool before considering the next leaf. But `planQuotaRun`'s
   only caller chain (`tasks.ts:431`) **has no non-test caller**, which the `bench/native-audit` lane
   found independently. So the swarm is built, bounded, and currently inert.

3. **Multi-provider exists and is real.** Three birds (Groq / HuggingFace / Workers AI) behind a
   `Provider` port, with `FREE_ONLY` mode as a real gate (ADR-0005: *unknown cost is not free*), and a
   quota planner that is one of the better pieces of code here. The routing-reason vocabulary that
   makes a swarm legible (TASK-016) is **not yet built**.

4. **The dashboard is a single 656-line inline HTML string.** No build step, no framework — a
   deliberate constraint that is load-bearing for "no new dependency", but it is not a GUI you can do
   connector setup and sync-state in.

### What the project already decided that constrains everything

From `AGENTS.md`, `docs/EXTERNAL-REVIEW-BRIEF.md` §8, and the ADRs:

- `phoenix-core` must stay **runtime-agnostic** (no `cloudflare:`, no `node:`), machine-enforced by
  `boundary.test.ts`.
- No KYC, no payment is a **product premise**, not a temporary state.
- Solo operator: every design must *reduce* maintenance load.
- Node is the only JS runtime (Bun removed 2026-10-03).

---

## 2. What changed in the world since those decisions (all VERIFIED this run)

This is the part that matters, because ADR-0002 rejected a Vercel host in 2026 and the ground has moved
under it.

### 2.1 Cloudflare grew the exact primitives you need

| Primitive | State (fetched 2026-10-08) | Why it changes the decision |
|---|---|---|
| **AI Search** (was AutoRAG) | Managed RAG: built-in storage + vector index, uploads auto-indexed, `ai_search_namespaces` binding creates/deletes instances **at runtime from a Worker**. Files per instance 100k (Free) / 1M. Hybrid search + relevance boosting. | Docs page last updated **2026-10-01**. This is a *managed RAG primitive on the same edge runtime you already deploy to*. |
| **AI Search data sources** | Built-in storage, **Website** (own a domain), **R2 bucket**. Ingests PDF, Office, HTML, CSV, images w/ OCR, plus ~30 code/text formats. Runs `toMarkdown` internally. | Doc last updated **2026-10-01**. Your "RAG like but improved" is now a binding, not a project. |
| **Workflows** | Durable multi-step: `step.do`, `step.sleep`, `step.waitForEvent` (pause for approval/webhook), auto-retry, unlimited wall time per step, 3,000 steps/day Free. | Page last updated **2026-09-18**. This is the "24/7 running" primitive — `waitForEvent` with a timeout is exactly a persistent agent waiting. |
| **Browser Run** (was Browser Rendering) | Headless Chrome on the edge. Quick Actions (screenshot, PDF, markdown, JSON-by-prompt, crawl) **need no deployment**; or Playwright/Puppeteer/CDP sessions. Free plan available. | Page last updated **2026-08-11**. Gives you scraping + PDF render + a JSON-extraction endpoint with no code. |
| **Agents SDK** | `Agent` class w/ durable identity, local SQL, WebSockets, scheduling, **fibers** (durable execution), MCP + Browser + Sandbox + AI Search tools, `callable()` methods. Starter needs **no API keys** (Workers AI default). | Page last updated **2026-09-18**. |
| **Queues** | 10,000 ops/day Free, 24h retention. | Workers pricing page, last updated **2026-10-02**. |

**The strategic consequence:** ADR-0002 rejected Vercel because `SqlPort` was synchronous and no
networked DB could satisfy it. That reasoning about *your own engine* still holds. But it is no longer
a reason to have **no retrieval layer**, because AI Search sits behind a Worker binding, not behind a
port you have to model.

### 2.2 The free tier is genuinely usable — with two hard ceilings

| Resource | Free (VERIFIED) | Paid ($5/mo) |
|---|---|---|
| Workers requests | 100,000/day | 10M/mo included |
| CPU per invocation | **10 ms** | 30 s default, 5 min configurable |
| Durable Objects | 100,000 req/day, 13,000 GB-s/day | 1M/mo, 400,000 GB-s/mo |
| DO SQLite storage | 5 GB total | unlimited per account, 10 GB/object |
| DO soft throughput | **1,000 req/s per object** | same |
| DO classes | 100 | 500 |
| **Workers AI** | **10,000 Neurons/day** | same + $0.011/1k |
| **Vectorize** | 30M queried dims/mo, 5M stored dims | 50M + $0.01/M |
| **AI Search** | 1,000 semantic + 1,000 full-text queries/mo; 5M ingestion tokens; 10 GB-mo; 100 instances | same included, then billed **from 2026-11-01** |
| Workflows | 100,000 req/day (shared w/ Workers), 3,000 steps/day, 1 GB-mo | 500k steps/mo |
| R2 | 10 GB-mo, 1M Class-A, 10M Class-B, **free egress** | |
| KV | 100k reads/day, **1,000 writes/day**, 1 GB | |

Two of these are the ones that will actually bite you, and neither is about CPU:

- **`Workers AI` free = 10,000 Neurons/day.** That is not "unlimited free inference". Concretely:
  `@cf/baai/bge-base-en-v1.5` costs 6,058 neurons / M input tokens → **~1.65 M embedding tokens/day**.
  `bge-m3` costs 1,075/M → ~9.3 M tokens/day. A 20k-token doc corpus is ~4 docs/day at `bge-base`.
  **Embedding cost, not inference cost, is your bottleneck** — and it is why AI Search's *included*
  5M ingestion tokens/month matters more than its query limit.
- **KV writes = 1,000/day on Free.** Any design that writes conversation turns, memories, or sync
  state to KV will die at 1,000 writes/day. Durable Object SQLite is the free-tier store with real
  headroom (100k rows written/day, 5 GB).

### 2.3 Durable Objects: the 1,000 req/s object is now a documented number, not folklore

`durable-objects/platform/limits` (last updated **2026-06-01**) states the soft limit plainly:
*"An individual Object has a soft limit of 1,000 requests per second."* And on saturation:
*"A Durable Object that receives too many requests will, after attempting to queue them, return an
`overloaded` error."* Storage-per-object is 10 GB paid / 1 GB free.

This **confirms** the conclusion TASK-015 already reached (`docs/research/ROUTING-CONVERGENCE.md`
reached it independently from the ToS side): the project resolves its coordinator as
`idFromName("global")` — **one** object, one shared rate-limit table, one health table, one ledger.
Row-level tenant keys inside one object do not fix this, because the ceiling is a property of the
*object*, not the schema. DO-per-tenant does.

And the trade is now nameable from the docs rather than inferred:
single-object fails by **silent saturation** (`overloaded` / `SQLITE_FULL` indistinguishable at the edge);
sharded fails by **partial visibility** (aggregate queries span objects). Simorgh's own doctrine —
"a scheduler that silently drops candidates is indistinguishable from one that lost them" — already
prefers the second failure mode.

### 2.4 Vercel: Hobby is fine, and Vercel Connect is the answer to your "digital bureaucracy"

| Item | Hobby (VERIFIED, page updated 2026-09-14) |
|---|---|
| Functions | 1,000,000 invocations/mo, 4 CPU-hrs, 360 GB-hrs memory |
| Max duration | 300 s |
| Projects | 200 · Deployments/day 100 |
| **Vercel Connect** | 500 token requests/mo, 1,000 triggers/mo |
| Workflows | 50,000 events/mo, 1 GB written |
| Storage | Vercel Blob |

**Vercel Connect is the finding that matters most for your stated goal.** Page last updated
**2026-09-18**, GA. It gives: managed OAuth for **Slack, GitHub, Microsoft, Linear, Discord, Notion,
Telegram** (per the chat-sdk cross-link), **Custom OAuth** for anything else, API-key storage,
**multi-tenant installations** (one connector serving many tenants), **verified webhook triggers**, and
`getToken()` for short-lived scoped credentials — so *"no provider API key ever lives in your environment
variables."* Adapters exist for AI SDK, TanStack AI, MCP clients, Chat SDK, Better Auth, Auth.js.

Your complaint was "minimize digital bureaucracy and setup-specific knowledge." That is literally the
product Vercel built. 500 token requests/month free is tight for a real user base, but it is the
single biggest reduction in setup work available, and it is exactly the kind of thing to adopt
*per-provider* rather than rebuild.

### 2.5 Connectors you named, with verified limits

**Notion** (`developers.notion.com/reference/request-limits`, fetched 2026-10-08) — fully verified:
- Per-connection: **180 req/min** (all plans except Business/Enterprise at 600).
- Per-workspace: a **separate shared budget**, so you can be rate-limited while under your own limit.
- Distinct `rate_limit_reason` values matter: `public_api_request_rate_limit` (back off) vs
  `public_api_space_request_rate_limit` (workspace-wide) vs **`public_api_request_blocked` (retrying
  will not help)** vs `mcp_tool_rate_limit` (usually <10 s).
- **529 = overloaded**, retry exactly like 429. Honour `Retry-After`; it is also mirrored in
  `additional_data.retry_after` for clients that can't read headers.
- **A write can return 503 *after saving*.** The body carries `retry_guidance: ["Read the object
  again", "Do not repeat the write"]` and `committed_resource_id`. Retrying blindly double-applies.
  This is a real idempotency hazard that a sync layer must handle explicitly.
- Payload caps: 1,000 block elements / 500 KB overall; rich text 2,000 chars; 100-element arrays.
- Free workspace **block limits take effect 2026-09-08** (already in force).

**Google Drive** — `[PARTIAL]`: search results confirm quota is per-app (default 1,000 req/100 s per
user), that `changes.watch`/`files.watch`/`channels.stop` **count against quota** while notification
*delivery* does not, that there is no daily cap if you stay in the per-minute band, and — from a
developer-discuss thread, so `REPORTED` not `VERIFIED` — that **watch channels are temporary and expire
within hours or days**, so they need renewal. `developers.google.com` returned HTTP 403 to both my
fetch attempts through two different fetchers, so I could not first-party-verify the exact quota
numbers or the current expiry window. **Do not design the Drive sync against a channel lifetime you have
not confirmed; treat it as a poll-with-occasional-push hybrid by default.**

**Telegram** — `[PARTIAL]`: search confirms a `getUpdates` `offset` parameter is the durable-checkpoint
mechanism and `limit` maxes at 100 per call; existing `src/telegram.ts` already uses KV for a 24 h
dedupe key. I did not first-party-verify current Bot API quotas this run.

---

## 3. The Rust question, answered with the number that decides it

`bench/native-audit` already answered this with measurement, and its answer is **no**. I am reporting it
rather than re-litigating, because the reasoning is the transferable part:

- Whole synchronous CPU of one Simorgh request: **66–109 µs = 0.66–1.09% of the 10 ms Free budget.**
- `planQuotaRun`: **0.701 µs** at N=1.09M — and it has **no non-test caller**.
- Even an infinitely fast Rust core buys ~0.007% on the one function the brief nominated.

Platform facts that reinforce it (`workers/runtime-apis/webassembly`, last updated 2026-04-23):
- **Threading is impossible** on Workers — single-threaded per isolate. A Rust core cannot give you
  parallelism inside a request.
- WASI support is **experimental**, partial syscalls only.
- Wasm Workers are **larger**, and "the larger your Worker is, the longer it may take your Worker to
  start" — a per-isolate cost you pay on every cold start, forever.
- SIMD *is* supported, so the theoretical win exists. It is just irrelevant when the total is 1% of
  budget.

**Verdict: REJECT the Rust core.** Not because Rust is bad — because Simorgh's hot path is I/O-bound
and its CPU headroom is ~10×. The one place Rust *would* earn its keep is the response sanitizer
(TASK-012 found it is 39–61% of request CPU), and even there the fix that landed was a **length cap**,
not a faster loop, because the cost was linear in an adversary-chosen length.

**What would change this answer:** if you adopt AI Search and do *local* re-ranking or *local*
hybrid-search scoring over retrieved chunks in the hot path, you create genuine CPU work that did not
exist before. That is the one scenario where a Wasm hot loop becomes defensible — and it should be
re-measured when it exists, not pre-built.

---

## 4. The strategic fork, and the recommendation

### The finding that reframes everything

TASK-015 (committed yesterday, `projects/simorgh-prd-research/one-million-users.md`) reached this and
it deserves to be stated plainly rather than buried:

> **Pooled accounts — the architecture Simorgh is built for — is closed.** OpenRouter §7.03 bars
> multiple accounts "for any other reason" and governs capacity globally. Cloudflare bars it twice
> (§2.2.1(e) produce multiple accounts, §2.2.1(a) on behalf of a third party). And the load-bearing
> discovery: **every provider couples tenancy to quota.** Groq explicitly permits one account serving
> unlimited end users — but limits are "at the organization level," so 1M users on one account still
> get 1,000 RPD. *Many users ≠ more capacity.*

Also from that lane: **GitHub Models is fully retired** (2026-07-30), **HuggingFace's free inference
tier is gone** (free users get zero credits, so an HF bird cannot be classified `free` under
`FREE_ONLY` — meaning **your current three-bird roster is already down to two viable birds**, Groq and
Workers AI), and `monetary cost = 0` and 1M users are mutually exclusive on Cloudflare pricing alone
(100k req/day ≈ 10k users → Workers Paid $5/mo).

### The recommendation

**Stop being a gateway that wants to be a RAG. Become a RAG that happens to route.** Concretely:

| Move | What | Why | Cost |
|---|---|---|---|
| **1. Adopt AI Search as the retrieval primitive** | Bind `ai_search_namespaces`. Per-tenant instances created at runtime from the Worker. Website + R2 sources immediately; Drive/Notion/Telegram as sync-into-R2. | It is the managed RAG primitive on the runtime you already deploy to. You get hybrid search, OCR, `toMarkdown`, and runtime instance creation for free — and you skip an entire epical worth of RAG engineering. | Binding + sync workers. **Watch 2026-11-01**: AI Search billing starts then; the included 5M ingestion tokens/mo is the thing to stay inside. |
| **2. Make the engine the differentiator, not the plumbing** | `phoenix-core` already has quota-aware planning, honest failure, and a transparency ledger. Add TASK-016's **routing-reason vocabulary** so retrieval and generation are both auditable ("why this chunk, why this bird"). | This is the thing nobody else has and the reason to run your own. The ledger already exists; exposing *why* is a small, high-leverage change. | ~1 story. TASK-016 already specced it. |
| **3. Use Workflows for the 24/7 part** | `step.waitForEvent` + `step.sleep` for scheduled sync, digest, and swarm orchestration. 3,000 steps/day Free is generous for one operator. | Durable multi-step with approval pauses is exactly your "persistent, swarm-ish, 24/7". Do **not** reimplement durable execution. | New — but replaces hand-rolled `scheduled.ts` work. |
| **4. Adopt Vercel Connect per-provider for OAuth** | Managed OAuth + multi-tenant installations + verified webhook triggers for Notion/Google/Slack/Telegram. **Do not build your own OAuth for these.** | This is the "digital bureaucracy" problem, already solved, with a Hobby free tier. Your `simorgh-platform` connectors stay for *Simorgh cores*, not for third-party SaaS. | 500 token req/mo free is the ceiling. |
| **5. Ship the GUI as a separate deployable** | Mobile-first PWA on Cloudflare Pages (or Vercel), talking to the same Worker API. Connector setup + sync status + a real metrics panel (TASK-014). | Pages is free and static; the 656-line inline-HTML constraint stops being a constraint the moment the dashboard is its own app. Desktop + mobile from one codebase. | New surface. Highest user-visible payoff. |
| **6. Do NOT add Rust/Wasm** | — | 1.09% CPU utilisation. Threading impossible on Workers. Larger bundle, longer cold start. | — |

### What I would explicitly *not* do

- **Do not converge the Go gateway onto the core contract** (D1). TASK-013 confirmed all three ADR-0003
  claims and found the Go side is a divergent second policy that *cannot join the fleet anyway*. With
  AI Search + Workflows arriving, spending a solo operator's time converging a second runtime is the
  single best example of "a week on the wrong thing." Archive the interest; keep the code.
- **Do not chase 1M users on pooled accounts.** The ToS says no and the arithmetic says ~10,000 Groq
  accounts. If you want scale, the answer is BYOK, and the one email that settles it is *"will you sell
  me N organizations' worth of free-tier capacity, in writing?"*
- **Do not build a vector store.** AI Search is managed, hybrid, and on-runtime. A hand-rolled one is
  the single largest avoidable cost in this list.
- **Do not run 24/7 on a free Workers CPU budget expecting it to hold.** Cron + Workflows + DO alarms
  cover it, but "always-on" should mean *durable and resumable*, not *a process that never stops*.

---

## 5. The three questions only you can answer

These change the recommendation materially, so I'd rather ask than guess:

1. **Who is the first user — you alone, or the public?** BYOK-for-one is a weekend. Multi-tenant with
   OAuth and per-tenant isolation is a quarter. Everything above is scoped by this answer.
2. **Is 1M users still the goal, or was that the old framing?** TASK-015 says the current architecture
   cannot reach it legally or arithmetically. If the goal is now "a genuinely good free-tier agent
   system for a few thousand people", the plan above is very achievable and the security highs
   (AUTH-002/003 IDOR) stop being acceptable deferrals.
3. **Do you want to depend on Cloudflare primitives or stay portable?** AI Search + Workflows +
   Agents SDK is a large, deliberate bet on one platform. `phoenix-core`'s runtime-agnostic boundary
   *can* absorb it — the ports exist for exactly this — but only if you put retrieval behind a port and
   keep AI Search as one adapter among several. Which is a design decision, not a research finding.

---

## 6. Evidence index

| Claim | Source | Page date |
|---|---|---|
| DO 1,000 req/s soft limit; `overloaded`; 10 GB/object | developers.cloudflare.com/durable-objects/platform/limits | 2026-06-01 |
| Workers Free 100k req/day, 10 ms CPU; KV 1k writes/day; DO/Queues/Workflows/Vectorize/AI Search/R2 tables | developers.cloudflare.com/workers/platform/pricing | 2026-10-02 |
| Vectorize 30M queried / 5M stored dims Free | developers.cloudflare.com/vectorize/platform/pricing | 2026-04-21 |
| Workers AI 10,000 Neurons/day Free; per-model neuron costs (bge-base 6,058/M, bge-m3 1,075/M) | developers.cloudflare.com/workers-ai/platform/pricing | 2026-10-01 |
| Workers AI rate limits by task type (embeddings 3,000/min; text-gen 300/min) | developers.cloudflare.com/workers-ai/platform/limits | 2026-09-17 |
| AI Search runtime instances via binding; hybrid search | developers.cloudflare.com/agents/tools/ai-search | 2026-06-03 |
| AI Search data sources, ingest formats, file limits | developers.cloudflare.com/ai-search/configuration/data-source | 2026-10-01 |
| AI Search 1k semantic + 1k full-text queries, 5M ingestion tokens, billing starts 2026-11-01 | developers.cloudflare.com/ai-search/platform/limits-pricing | 2026-10-01 |
| Workflows: waitForEvent, sleep, 3,000 steps/day Free, unlimited step wall time | developers.cloudflare.com/workflows | 2026-09-18 |
| Agents SDK: Agent class, fibers, callable, no-API-key starter | developers.cloudflare.com/agents | 2026-09-18 |
| Browser Run: Quick Actions need no deployment; free plan | developers.cloudflare.com/browser-run | 2026-08-11 |
| Wasm: no threading, experimental WASI, larger bundle → slower start, SIMD supported | developers.cloudflare.com/workers/runtime-apis/webassembly | 2026-04-23 |
| Rust on Workers via workers-rs; wasm-opt; startup implications | developers.cloudflare.com/workers/languages/rust | 2026-04-23 |
| Vercel Hobby allowances; Connect 500 token req/mo | vercel.com/docs/plans/hobby | 2026-09-14 |
| Vercel Connect: managed OAuth set incl. Notion/Telegram/Discord, custom OAuth, installations, triggers | vercel.com/docs/connect | 2026-09-18 |
| Notion 180/min per-connection + workspace budget, 429 reasons, 529, 503-saved-write hazard | developers.notion.com/reference/request-limits | fetched 2026-10-08 |
| CPU measurements, no-test-caller finding, sanitizer share of CPU | `bench/native-audit/results.json`, `docs/research/NATIVE-COMPUTE-AUDIT.md` | 2026-10-07 |
| Go/TS routing divergence + 3× ADR-0003 confirmed | `docs/research/ROUTING-CONVERGENCE.md`, `GO-QUOTA-FINDINGS.md` | 2026-10-08 |
| Pooled accounts closed; HF tier gone; GitHub Models retired | `projects/simorgh-prd-research/one-million-users.md` | 2026-10-08 |

### Not verified this run

- Google Drive exact quotas and current `changes.watch` channel lifetime — `developers.google.com`
  returned 403 to two fetchers. Treated as `[REPORTED]`.
- Telegram Bot API current quota envelope — search only. Existing `src/telegram.ts` precedent noted.
- Whether AI Search's included quota is per-account or per-instance — docs say "every account receives
  the following included usage each month", so account-level, but the per-instance fairness under it
  is not stated.