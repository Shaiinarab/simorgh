# PRD research programme — August 2026

The research that fed the August PRD, imported here on 2026-11-20 from an out-of-repo workspace
folder (`~/personal/projects/projects/simorgh-prd-research`). It is kept because it is the only
written record of two things the code cannot answer: **why the platform was scoped the way it was**,
and **what the free-tier capacity arithmetic actually is**.

Read it as records, not as current state. The repository is the source of truth; where a record and
the code disagree, the code wins and the record is stale.

* [Shared research context](SHARED-CONTEXT.md) — the brief that opened the programme: vision, flock
  concepts, milestone status. Describes the retired standalone `/home/shai/simorgh-platform` repo.
* [Architecture epics and stories](01-architecture-epics.md) — six candidate epics with stories,
  acceptance criteria and risks. Superseded as a queue by [../../todo/index.md](../../todo/index.md).
* [The free-tier capacity math for one million users](one-million-users.md) — **the decision-grade
  one.** 1M users at $0 is reachable under BYOK and not under pooled accounts; the single global
  Durable Object saturates; the ledger fills a 1 GB object in under a day.
* [The landscape a digital religion would have to exist in](digital-religion-landscape.md) —
  source-graded brief on the long-term vision, and what it would owe to whom.
* [prompts/](prompts/) — the three outbound prompts, kept so the research can be re-run.

## Why this folder exists

It was consolidated because the same material sat in a sibling workspace folder, a set of ops-wiki
pages and an OpenWiki bundle, all pointing at paths that no longer exist. One copy, inside the repo
it is about, is the only one that can stay honest. The out-of-repo originals are preserved at
`_archive/simorgh-docs-merged-2026-11-20/` in the workspace.

## See also

* [..](../index.md) — research index
* [../../prd/index.md](../../prd/index.md) — the PRD these records were written to feed
