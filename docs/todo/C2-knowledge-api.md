---
type: "Implementation Task"
title: "C2 — Knowledge ingestion, search and deletion"
description: "Expose a small identity-gated knowledge API with chunk-level source provenance."
tags:
  - simorgh
  - todo
  - knowledge
  - retrieval
  - api
  - epic-c
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "stable"
work_status: "done"
priority: "P1"
depends_on:
  - A3
  - C1
stale_after: "2027-01-21T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# C2 — Knowledge ingestion, search and deletion

## TL;DR

**Done 2026-11-21.** The knowledge surface shipped: four identity-gated routes
(`POST /api/v1/knowledge`, `GET /api/v1/knowledge/:id`, `POST /api/v1/knowledge/search`,
`DELETE /api/v1/knowledge/:id`) over the C1 FTS5 adapter, with passage-level provenance
(chunked indexing, `chunkId` on search hits), replace-on-reindex semantics, and
principal-scoped namespaces (`<subject>::<label>`) that make cross-principal access
structurally impossible. Verified: 18 parser/namespace unit tests + 4 chunking tests +
5 route-level tests against the real KnowledgeVault DO (workers 19 files / 193 tests,
node 30 files / 561 tests, typecheck all 3 configs, `platform:smoke` green).

## Shipped (2026-11-21)

- `phoenix-core/src/knowledge.ts` — validation, namespace rules, the four parsers, the
  principal-prefixing (`knowledgeNamespaceFor`), and the public-hit mapping. Pure over its
  input; no runtime import.
- `src/knowledge-vault.ts` — the KnowledgeVault DO: FTS5 over `ctx.storage.sql`, schema
  ensured under `blockConcurrencyWhile`.
- `src/index.ts` routes — the four routes, gated by `requireIdentity` (the credential is
  the only source of the subject).
- `wrangler.toml` v3 migration + `env.d.ts` binding (both `Env` and `Cloudflare.Env`).
- `phoenix-core/src/retrieval.ts` — chunked indexing (`RETRIEVAL_CHUNK_CHARS = 1200`,
  code-point safe, no overlap), replace-on-reindex, passage-level search hits,
  whole-document `get`.
- Tests: `phoenix-core/test/knowledge.test.ts` (18), chunking tests in
  `phoenix-core/test/retrieval.test.ts` (4), `test/knowledge-routes.test.ts` (5, real DO).

## Acceptance

- [x] Search results carry the full provenance envelope (documentId, chunkId, source,
      title, text, score, timestamp, metadata, namespace label).
- [x] An owner can retrieve and delete their document; deleted material stops appearing
      in future search (route test pins both).
- [x] A principal cannot fetch, search or delete another principal's knowledge
      (route test pins all three, with the same label under a different principal).
- [x] Local and hosted adapters satisfy the same contract — the adapter is pure over
      `SqlPort`, tested on real Node SQLite; the Workers host runs the same adapter over
      DO SQLite through the KnowledgeVault DO.
