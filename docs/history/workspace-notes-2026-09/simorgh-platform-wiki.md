---
type: "Historical Record"
title: "Workspace wiki note — simorgh-platform (retired path)"
description: "Workspace ops-wiki entry for `/home/shai/simorgh-platform`, the standalone repo this repository replaced. Records the paths and entrypoints that existed then."
tags:
  - "simorgh"
  - "history"
generated:
  by: "process:workspace-wiki-2026-07"
  at: "2026-07-28T00:00:00+03:30"
status: "deprecated"
stale_after: "2027-02-01T00:00:00+03:30"
imported:
  by: "agent:codebuff"
  at: "2026-11-20T18:18:17+03:30"
  from: "~/personal/projects/docs/wiki/projects/simorgh-platform.md"
---
<!-- Imported verbatim from ~/personal/projects/docs/wiki/projects/simorgh-platform.md on 2026-11-20. -->

# Project: simorgh-platform

Path: /home/shai/simorgh-platform
Git root: /home/shai/simorgh-platform
Branch: main
README: /home/shai/simorgh-platform/README.md

Purpose: Cloudflare Workers agentic AI gateway with multi-provider flock routing, Intent Shield, Data Trust, and BMAD×OKR PRD.

Stack:
- TypeScript 7 (tsgo — `@typescript/native-preview`) / Hono / Wrangler
- Durable Objects (SQLite) + KV
- package-lock.json not checked in this pass; package.json present

Entrypoints:
- src/index.ts
- src/flock.ts
- src/data-trust.ts
- src/dashboard.ts
- src/models.ts

Scripts:
- typecheck: tsgo --noEmit
- dev: wrangler dev --local --port 8787
- test: vitest run
- deploy: tsgo --noEmit && wrangler deploy

Git status:
- Active standalone repo.
- BMAD phase artifacts under `.bmad/phases/`.
- No commits yet reported in this pass; repo has `.git` at `/home/shai/simorgh-platform/.git`.

Activity: Active (current primary implementation).
Safest next action: Do not modify. Run npm install later under explicit approval; keep BMAD state under `~/.hermes/projects/simorgh-platform/state.md` field-patched only.
