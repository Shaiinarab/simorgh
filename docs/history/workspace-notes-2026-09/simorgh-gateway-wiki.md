---
type: "Historical Record"
title: "Workspace wiki note — simorgh-gateway v1 (retired path)"
description: "Workspace ops-wiki entry for `/home/shai/simorgh-gateway`, the v1 gateway. Records the paths that existed then, including a git root that wrongly resolved to the home directory."
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
  from: "~/personal/projects/docs/wiki/projects/simorgh-gateway.md"
---
<!-- Imported verbatim from ~/personal/projects/docs/wiki/projects/simorgh-gateway.md on 2026-11-20. -->

# Project: simorgh-gateway
Path: /home/shai/simorgh-gateway
Git root: /home/shai
Branch: main
README: /home/shai/simorgh-gateway/README.md

Purpose: Cloudflare Workers agentic AI gateway with multi-provider flock routing.

Stack:
- TypeScript / Hono / Wrangler
- Durable Objects + KV
- package-lock.json present

Entrypoints:
- src/index.ts

Scripts:
- typecheck: tsgo --noEmit
- dev: wrangler dev
- check: tsgo --noEmit && wrangler deploy --dry-run
- deploy: tsgo --noEmit && wrangler deploy

Git status:
- Untracked home-directory contents visible because git root appears to be /home/shai.
- No commits yet reported on main in prior check.

Activity: Active (legacy reference).
See [simorgh-platform](simorgh-gateway-v2.md) for current primary implementation.
Safest next action: Do not modify. Run npm ci or pnpm install later under explicit approval.
