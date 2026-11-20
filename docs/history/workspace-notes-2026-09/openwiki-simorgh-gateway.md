---
type: "Historical Record"
title: "OpenWiki bundle summary — Simorgh Gateway v2 (2026-07-28)"
description: "Workspace OpenWiki summary of the v2 gateway: flow-engine and crew-engine modules, D1 tables and webhook routes."
tags:
  - "simorgh"
  - "history"
generated:
  by: "process:openwiki-2026-07"
  at: "2026-07-28T14:30:00+03:30"
status: "deprecated"
stale_after: "2027-02-01T00:00:00+03:30"
imported:
  by: "agent:codebuff"
  at: "2026-11-20T18:18:17+03:30"
  from: "~/personal/projects/docs/openwiki/bundles/simorgh-gateway.md"
---
<!-- Imported verbatim from ~/personal/projects/docs/openwiki/bundles/simorgh-gateway.md on 2026-11-20. -->


# Simorgh Gateway

Cloudflare Workers AI gateway (v2). Routes for AI inference + flux operations. Uses D1 for persistence, TypeScript strict.

## Status

- **Phase**: deployment ✓
- **State**: `~/.hermes/projects/simorgh-gateway/state.md`
- **Bundle**: `~/knowledge-bundles/simorgh-gateway/`
- **Conformance**: ✓ pass (M1-M6)
- **Repo**: `~/simorgh-gateway/v2/`

## Modules

- [flow-engine](../../knowledge-bundles/simorgh-gateway/modules/) — n8n-like, 11 node types
- [crew-engine](../../knowledge-bundles/simorgh-gateway/modules/) — CrewAI-like, 3 process models, 3 templates

## Gateway Routes

| Route | Purpose |
|-------|---------|
| `/api/flows/*` | Flow CRUD + execution |
| `/api/crews/*` | Crew CRUD + execution |
| `/webhook/flow/:id` | Flow webhook trigger |

## D1 Tables

`flows`, `flow_runs`, `crews`, `crew_runs`

## Telegram Bot

Commands: `/flow`, `/crew`

## See Also

- [Bundle index](../../knowledge-bundles/simorgh-gateway/index.md)
- [OpenWiki hub](../index.md)
- Skill: `simorgh-flow-crew-modules`
