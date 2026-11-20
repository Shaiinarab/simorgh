---
type: "Historical Record"
title: "Workspace notes about Simorgh's earlier homes (2026-07 → 2026-10)"
description: "Provenance note for six workspace-side notes and one attic knowledge bundle that described the standalone repos this repository replaced. Imported 2026-11-20 so no description of Simorgh lives outside the repo."
tags:
  - "simorgh"
  - "history"
generated:
  by: "agent:codebuff"
  at: "2026-11-20T19:10:00+03:30"
status: "deprecated"
stale_after: "2027-02-01T00:00:00+03:30"
---

# Workspace notes about Simorgh's earlier homes

These files were written **outside** this repository, between July and October 2026, about
`/home/shai/simorgh-gateway`, `/home/shai/simorgh-gateway/v2` and `/home/shai/simorgh-platform`.
None of those paths is this repository. Every one of them describes code that no longer exists here,
and several describe it as "the current primary implementation" — which was true when written and is
not true now.

They are imported, unedited below their frontmatter, for one reason: they are the only written
record of the retired gateway's module map and its risk list. Do not update them to match the current
tree — that would destroy the only evidence of what was there.

| File | What it is | Written against |
|---|---|---|
| [simorgh-platform-wiki.md](simorgh-platform-wiki.md) | Ops-wiki entry: paths, entrypoints, scripts | `/home/shai/simorgh-platform` |
| [simorgh-gateway-wiki.md](simorgh-gateway-wiki.md) | Ops-wiki entry for v1 | `/home/shai/simorgh-gateway` |
| [simorgh-gateway-v2-wiki.md](simorgh-gateway-v2-wiki.md) | Module map plus eleven named technical risks | `/home/shai/simorgh-gateway/v2` |
| [openwiki-simorgh-platform.md](openwiki-simorgh-platform.md) | OpenWiki bundle summary, flock table and API surface | standalone platform repo |
| [openwiki-simorgh-gateway.md](openwiki-simorgh-gateway.md) | OpenWiki summary: flow-engine, crew-engine, D1 tables | v2 gateway |
| [longcat-playbook-SIMORGH.md](longcat-playbook-SIMORGH.md) | An agent harness's playbook for this repo | **this** repo, 2026-10-07 |
| [knowledge-bundle-simorgh-platform/](knowledge-bundle-simorgh-platform/) | Six-page OKF bundle of the standalone repo's facts | standalone platform repo |

The LongCat playbook is the odd one out: it targets this repository, but its test counts, command
list and epic numbering are a 2026-10-07 snapshot. `AGENTS.md` and `docs/todo/index.md` supersede it.

## Where the originals are

Byte-identical copies are preserved at `_archive/simorgh-docs-merged-2026-11-20/workspace-notes/` in
the workspace, with the ops-wiki, OpenWiki and knowledge-bundle copies in their own subdirectories so
same-named files do not collide.

## See also

* [..](../index.md) — history index
* [../coordination-retirement-2026-10-10.md](../coordination-retirement-2026-10-10.md) — the same
  treatment for a retired framework's conclusions
