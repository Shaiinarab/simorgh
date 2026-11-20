---
type: "Historical Record"
title: "Workspace wiki note — simorgh-gateway v2 architecture and risk list"
description: "Read-only 2026-07-28 analysis of the v2 gateway: module map plus eleven named technical risks. Kept because the risk list is the only written record of that codebase."
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
  from: "~/personal/projects/docs/wiki/projects/simorgh-gateway-v2.md"
---
<!-- Imported verbatim from ~/personal/projects/docs/wiki/projects/simorgh-gateway-v2.md on 2026-11-20. -->

# Project: simorgh-gateway-v2
Path: /home/shai/simorgh-gateway/v2
Status: active
Source: read-only analysis 2026-07-28

## Architecture
- Single Cloudflare Worker entrypoint: `src/gateway/index.ts` (`Hono`)
- Multi-platform adapter layer: Telegram/Slack/Discord (`src/gateway/adapters.ts`)
- Agent loop + tool orchestration: `src/tools/loop.ts`, `src/tools/builtin.ts`
- Provider registry + adapters: `src/providers/index.ts`, `src/providers/*.ts`
- MCP bridge: `src/mcp/bridge.ts`, `src/mcp/client.ts`
- Flow engine: `src/modules/flow-engine/` (n8n-like DAG)
- Crew engine: `src/modules/crew-engine/` (CrewAI-like multi-agent)
- Memory: Vectorize (`src/gateway/memory.ts`) + Supabase (`src/gateway/store.ts`)
- Crypto: `src/shared/crypto.ts`
- Evolution workflow: `src/evolution/workflow.ts`
- Admin tool: `src/admin/main.go`

## Entrypoints
- Worker: `src/gateway/index.ts`
- Admin CLI: `src/admin/main.go`
- Scripts: `scripts/setup-supabase.sh`

## Package Manager / Scripts
- package manager: npm
- scripts: dev/typecheck/build/deploy via wrangler + tsgo
- Go admin scripts: admin:build / admin:dev / go:check / go:build / go:test
- package.json present; no lockfile checked in this pass

## Technical Risks
- hardcoded cron secret `changeme` (`src/gateway/index.ts:190`)
- MCP token field mapped to undefined, never decrypted (`src/gateway/store.ts:56`)
- `read_url` lacks SSRF protection (`src/tools/builtin.ts:102`)
- `google_search` leaks key in URL (`src/tools/builtin.ts:131`)
- Evolution workflow deploys raw LLM-generated code (`src/evolution/workflow.ts:92`)
- Crypto fallback to `dev-key` if `ENCRYPTION_KEY` unset (`src/shared/crypto.ts:7`)
- Vectorize memory not injected into agent loop context (`src/tools/loop.ts`)
- `clearMemory` no-op (`src/gateway/memory.ts:66-68`)
- schema init race (`src/gateway/index.ts:490-496`)
- `/flow` and `/crew` switch fall-through (`src/gateway/index.ts:374-375`)
- monolith Worker (~651 lines) with no tests
- CRUD endpoints accept raw JSON without Zod despite zod dep
- merge-node readiness bug in flow executor
- crew hierarchical mode is stub
- Discord truncation double-slice

## Known Missing / Weak
- zero tests
- missing input validation on flow/crew CRUD
- no authn/authz on webhooks beyond bot tokens
- dual memory backend without sync
- no rate limiting
- no observability/tracing
