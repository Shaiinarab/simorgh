# TASK-015 — Research: the free-tier capacity math for 1M users

- Owner: any
- Status: open
- Depends on: nothing · Estimate: 150–240 min · Runner: **research specialist** agent

## 0. Start here: introduce yourself

Your **first** action is a short introduction into
`mailbox/OUTBOX/TASK-015-INTRO.md` (≤40 lines):

- Who you are, and the research role you are taking.
- **Your sourcing discipline**: how you decide a claim is verified vs reported vs inferred.
  This matters more for you than for any other specialist on this project.
- Which tools you reach for first and why (official docs over blog posts? primary sources
  only? how do you handle a page that 404s?).
- Your honest read on whether this question is **answerable** with public evidence, and which
  parts you expect will not be.
- What you would need from a maintainer to finish.

## 1. Orient yourself before you search

**Read first:**

1. `AGENTS.md` — especially **Environment traps** and the **verification discipline** section.
   The rule *"a green suite is not a verified system"* has a research twin: **a plausible
   number is not a verified fact.**
2. `docs/adr/ADR-0003-free-compute-capacity.md` and `docs/adr/ADR-0005-free-only-mode.md` —
   these are the design decisions your research either validates or invalidates. ADR-0005
   states the project's goal as `monetary cost = 0` and makes **unknown cost ≠ free**.
3. `phoenix-core/src/quota.ts` — read enough to know what facts the capacity layer actually
   consumes. **Your report is only useful if it answers the questions this code asks.**
4. `docs/SECURITY-AUDIT.md` §4 — the risk acceptance, and its **void conditions**. You will
   need them.

**Skills worth loading** (catalog at `/home/shai/personal/projects/docs/skills-catalog.md`;
read each SKILL.md before use):

- `research-ops` or `deep-research` — evidence-first current-state research. Start here.
- `source-driven-development` — grounds decisions in official documentation.
- `database-lookup` — for reproducible, cited fact retrieval from a named source.
- `open-source-detective` — for the "does this already exist?" half of the brief.
- `firecrawl-search` / `firecrawl-scrape` / `firecrawl-crawl` — primary web tooling.

**Harnesses and repos worth your time:**

- `/home/shai/personal/projects/harnesses/agents/personas/fil.md` — the workspace's own
  **research persona**. Read it. It defines the expected standard: bulk fetches, explicit
  triggers, named MCPs. That is the house style you are being held to.
- `/home/shai/personal/projects/harnesses/9router-provider/` — a **provider** harness with
  39 accounts. Read its README before you say anything about multi-account economics.
- `/home/shai/personal/projects/harnesses/knowledge-vault/` — for durable notes if this spans
  sessions.
- `/home/shai/personal/projects/harnesses/self-bench/RESULTS.md` — a worked example of how
  this workspace wants claims evidenced.

**Reporting standard — non-negotiable.** Label every load-bearing claim:

- `VERIFIED` — you fetched a primary source and can quote it.
- `REPORTED` — a secondary source says so; you did not confirm it upstream.
- `INFERRED` — your reasoning from verified facts. Show the reasoning.
- `UNVERIFIED` — you could not confirm it. Say so rather than dropping it.

**Never invent a limit, a price, a date, or an API shape.** A short verified list beats a
long speculative one, and one fabricated number discredits everything else you wrote.

## 2. The question (why it exists)

The owner's stated goal is **1 million users**. Simorgh is a gateway that federates free-tier
model providers and refuses to spend money it was not told about.

**Your job is to find out whether that is arithmetically reachable, and under what model.**
This is the highest-leverage research in the project, because the answer determines whether
the architecture should be built for pooled accounts (today's shape) or for per-user keys
(a different shape entirely). Do not round in Simorgh's favour.

## 3. Deliverable A — the capacity math

For each major provider (**Groq, HuggingFace, Cloudflare Workers AI, Google AI Studio /
Gemini, OpenRouter, GitHub Models**, and any others you find), fetch the **current** published
free tier:

- model names included, requests/day, tokens/min, tokens/day
- whether a **credit card is required** — several "free" tiers silently require one
- whether rate-limit state is **discoverable programmatically** or must be guessed
- whether they emit authoritative headers (`RateLimit`, `x-ratelimit-*`, `retry-after`)
- last activity signal — docs date, changelog, repo last commit. Flag anything abandoned.

Then do the arithmetic for **three models**, explicitly:

| Model | Shape | Arithmetic |
|---|---|---|
| **(a) BYOK** | every user brings their own key → 1M keys | What does Simorgh provide that `curl` does not? Is that enough for 1M installs? |
| **(b) Pooled accounts** | operator holds N accounts, routes across them | What N is needed for 1M users? **And quote each provider's ToS on multiple accounts, automated use, and account sharing.** |
| **(c) Local / on-device** | the user's own machine serves what it can | What fraction of requests never needs a network provider in 2026? |

Model (b) is the one Simorgh's current architecture implies, and it is also the one with a
compliance dimension. **Quote the Terms of Service.** Simorgh's own rule is that it never
evades bans, rate limits, account verification, or contractual restrictions, and that
legitimate multi-account is modelled only where a provider explicitly permits it. Your
research decides how much of (b) is permissible — that is a load-bearing output, not
context.

**If the honest answer is "1M users at $0 is not reachable", say exactly that**, with the
arithmetic, and say what would make it reachable.

## 4. Deliverable B — what breaks at scale

Reason concretely about the current architecture. The blocker you must start from:
`src/index.ts` resolves the Durable Object as `idFromName("global")` — **one** object holding
**one** shared rate-limit table, **one** shared health table, and **one** shared transparency
ledger.

For each, state the **actual documented limit** (with a date and a source) and what it does
at 1M users:

- Durable Object throughput and hot-spot ceilings
- DO SQLite: storage per object, query throughput, write batching
- the shared `rate_limits` and `bird_health` tables
- ledger growth, and the KV context offload
- **subrequest limits** on the free and paid Workers plans

Then research how comparable systems shard per-tenant state on Cloudflare — DO per tenant vs
SQL sharding vs one object with row-level tenant keys — and **recommend a shape**, naming the
failure mode you are trading away. A recommendation without a named trade is not a
recommendation.

## 5. Deliverable C — the adjacent-project question

Find any **real, maintained** open-source project already doing federated free-tier routing at
multi-tenant scale. Use `open-source-detective` and GitHub search.

**Be blunt if none exists** — "Simorgh would be building something that does not exist" is a
genuinely valuable finding and you must not soften it. Equally, if something does exist, say
what to learn from it. Check licences before recommending anything.

## 6. Deliverable D — write it down

Write the report to **`/home/shai/personal/projects/projects/simorgh-prd-research/one-million-users.md`**.

Read the existing files in that directory first and **match their format and citation style**.
Also write `mailbox/OUTBOX/TASK-015-REPORT.md` as a summary — **the last non-empty line MUST
be exactly `TASK-015-END`.**

Your report **MUST** end with:

> **The single most important strategic fork Simorgh faces on the way to 1M, and what has to
> be true for each side of it to be the right choice.**

Two options, both stated, neither softened: **BYOK-at-scale** (privacy-safe, federates
nothing Cloudflare-style routers cannot, and 1M installs of a nicer `curl`) versus
**pooled accounts** (real capacity advantage, but bounded by what ToS permits and by how many
accounts an operator can legitimately hold). Name the evidence that would settle it.

## 7. Constraints

- **Read-only on the repository.** Do not modify any file in `projects/simorgh/`. The one
  exception is your two output files above.
- Do **not** run the test suite or `git commit`/`git push`/`git rebase`.
- If a source is behind a login, paywall, or 404s, **say so** rather than substituting a
  blog post silently.
- Prefer official pricing/limits/ToS pages over third-party summaries, and say which you used.

## 8. Acceptance

- [ ] `projects/simorgh-prd-research/one-million-users.md` exists and matches the existing
      format in that directory
- [ ] every provider's limits carry a `VERIFIED` / `REPORTED` / `INFERRED` / `UNVERIFIED` label
- [ ] every ToS claim is **quoted**, not paraphrased
- [ ] the three capacity models have arithmetic, not adjectives
- [ ] "what breaks at scale" cites a documented Cloudflare limit with a date
- [ ] `mailbox/OUTBOX/TASK-015-REPORT.md` ends with `TASK-015-END`
- [ ] an explicit list of what you could **not** verify, and how you would verify it

## 9. Report

Beyond the summary above, state plainly: **what you found that contradicts what the
repository currently believes.** If a provider's free tier has decayed, if the free-tier
landscape is collapsing, if a "free" tier now requires a card — the lead needs that
immediately and unsoftened.

TASK-015-BRIEF-END