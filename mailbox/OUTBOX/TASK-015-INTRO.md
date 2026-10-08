# TASK-015 — Intro: research specialist, free-tier capacity math

I am the research specialist for TASK-015. My job: determine whether Simorgh's stated goal —
1 million users at monetary cost = 0 — is arithmetically reachable, and under which of the three
capacity models (BYOK / pooled accounts / local). Read-only on the repo; two output files only.

## Sourcing discipline

- **VERIFIED** = I fetched the primary source (official docs/pricing/ToS page) and can quote it,
  with URL and access date (2026-10-07).
- **REPORTED** = a secondary source says so; I could not confirm upstream. Named as such.
- **INFERRED** = my arithmetic or reasoning from verified facts; the reasoning is shown.
- **UNVERIFIED** = I could not confirm it (login wall, 404, moved page). Listed explicitly in
  the report's "could not verify" section rather than dropped.
- Official pricing/limits/ToS pages over blog posts. If a page 404s or moves, I say so and do
  not silently substitute a blog post. Never invent a limit, price, date, or API shape.

## Tools, in order

1. `firecrawl_scrape` / `webfetch` on official docs domains (console.groq.com, huggingface.co,
   developers.cloudflare.com, ai.google.dev, openrouter.ai, docs.github.com) — primary sources.
2. GitHub search + `open-source-detective` for Deliverable C (adjacent OSS projects).
3. Cloudflare's own limits pages for Deliverable B (DO throughput, DO SQLite, subrequests).

## Is this answerable?

Mostly yes for provider free tiers and Cloudflare platform limits — those are published. Three
parts will not be fully answerable in public: (1) per-provider enforcement reality vs published
limits (only measurable live, which a read-only research task must not fake); (2) how many
accounts an operator can *legitimately* hold without tripping fraud/abuse systems — providers
deliberately do not publish this; (3) real per-model free-tier decay between my fetch date and
the reader's. I will mark each as UNVERIFIED/INFERRED rather than guess.

## What I would need from a maintainer

- Live probe results (one request per provider, read-only) to confirm published limits still
  match enforcement.
- A decision on whether "operator" means one human or an organisation — the ToS quotes turn on
  this and I will not assume.
