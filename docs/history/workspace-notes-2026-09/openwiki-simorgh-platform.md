---
type: "Historical Record"
title: "OpenWiki bundle summary — Simorgh Platform (2026-09-01)"
description: "Workspace OpenWiki summary of the standalone platform repo: flock table, API surface and the PRD's 13 epics / 63 stories claim."
tags:
  - "simorgh"
  - "history"
generated:
  by: "process:openwiki-2026-09"
  at: "2026-09-01T00:00:00+03:30"
status: "deprecated"
stale_after: "2027-02-01T00:00:00+03:30"
imported:
  by: "agent:codebuff"
  at: "2026-11-20T18:18:17+03:30"
  from: "~/personal/projects/docs/openwiki/bundles/simorgh-platform.md"
---
<!-- Imported verbatim from ~/personal/projects/docs/openwiki/bundles/simorgh-platform.md on 2026-11-20. -->


# Simorgh Platform

Standalone Cloudflare Workers agentic AI gateway (`/home/shai/simorgh-platform`). The primary implementation moved out of `simorgh-gateway/v2` into this repo. Flock federation + Intent Shield + Data Trust + BMAD×OKR PRD.

## Status

- **Phase**: testing ✓
- **State**: `~/.hermes/projects/simorgh-platform/state.md`
- **Bundle**: `~/knowledge-bundles/simorgh-platform/`
- **Conformance**: pending OKF audit (new bundle 2026-09-01)
- **Repo**: `/home/shai/simorgh-platform/`

## Source Map

- `src/index.ts` — Hono app, Intent Shield, tool loop, Data Trust, Context Offload
- `src/flock.ts` — bird adapters + FlockCoordinator DO (Swarm-State)
- `src/data-trust.ts` — DataTrustVault DO (transparency ledger)
- `src/dashboard.ts` — 30-Bird Mission Control (inline HTML/CSS/JS, no build)
- `src/models.ts` — Auto-Wrapper model catalog
- `test/index.test.ts` — core contract tests (vitest)
- `docs/prd/PRD.md` — 13 epics, 63 stories (v2.0, approved 2026-08-31)
- `docs/research/2026-08-round2.md` — MCP + free-tier + search deep dive

## The Flock

| id | Bird | Provider | Model | Key | Priority |
|----|------|----------|-------|-----|----------|
| `shahin` | 🦅 Shāhīn | Groq (OpenAI-compat) | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | 10 |
| `bulbul` | 🐦 Bulbul | HuggingFace Router | `meta-llama/Llama-3.3-70B-Instruct` | `HF_TOKEN` | 20 |
| `homa` | 🕊️ Homā | Cloudflare Workers AI | `@cf/meta/llama-3.2-3b-instruct` | *none* | 30 (**always on → zero-KYC guarantee**) |

## API Reference

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/v1/agent/execute` | Run the agent (tool loop + flock failover). |
| `GET`  | `/api/v1/flock/status` | Live Swarm-State. |
| `GET`  | `/api/v1/context/:refId` | Offloaded request payload. |
| `GET`  | `/api/v1/user/:userId/logs` | Data-Trust ledger. |
| `GET`  | `/dashboard` | Mission Control UI. |
| `GET`  | `/` | Health text. |

## See Also

- [Bundle index](../../knowledge-bundles/simorgh-platform/index.md)
- [OpenWiki hub](../index.md)
- [Simorgh Gateway bundle](simorgh-gateway.md)
