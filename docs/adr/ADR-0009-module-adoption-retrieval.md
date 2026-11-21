---
type: "Architecture Decision Record"
title: "ADR-0009 — Retrieval is a port with an FTS5 baseline; modules are adopted per capability"
description: "Evidence-based module adoption: FTS5 as the zero-dependency retrieval baseline, Orama as an optional Node adapter, AI Search as a conditional hosted adapter, and a refusal list for search servers and memory engines."
tags:
  - simorgh
  - adr
  - retrieval
  - modules
  - okf
generated:
  by: "kiro/kiro-cli"
  at: "2026-11-20T17:40:00Z"
status: "stable"
stale_after: "2027-05-20T00:00:00Z"
sources:
  - id: retrieval-module
    resource: "../../phoenix-core/src/retrieval.ts"
    title: "The FTS5 adapter and query normalizer"
  - id: retrieval-port
    resource: "../../phoenix-core/src/ports.ts"
    title: "The RetrievalPort contract"
  - id: c1-task
    resource: "../todo/C1-retrieval-port.md"
    title: "EPIC-C1 acceptance"
  - id: cf-fts5
    resource: "https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/"
    title: "Cloudflare Durable Objects SQLite — FTS5 listed as supported"
  - id: orama
    resource: "https://github.com/oramasearch/orama"
    title: "Orama — Apache-2.0, zero-dependency, vector/hybrid/full-text"
  - id: minisearch
    resource: "https://github.com/lucaong/minisearch"
    title: "MiniSearch — MIT, in-memory full-text"
  - id: sqlite-vec
    resource: "https://github.com/asg017/sqlite-vec"
    title: "sqlite-vec — MIT/Apache-2.0, native extension"
  - id: ai-search-limits
    resource: "https://developers.cloudflare.com/ai-search/platform/limits-pricing/"
    title: "Cloudflare AI Search — free tier 1k semantic + 1k full-text queries/month"
---

# ADR-0009 — Retrieval is a port with an FTS5 baseline; modules are adopted per capability

- **Status:** accepted
- **Date:** 2026-11-20
- **Decides:** how Simorgh adopts external modules for the retrieval/memory gap (EPIC-C), what the
  zero-dependency baseline is, which modules are optional adapters, and which are refused
- **Amends:** [ADR-0007](ADR-0007-adopted-patterns-from-working-open-source.md) — adds the
  retrieval/memory rows to the adoption cross-walk. Its refusal list and attribution rule are
  unchanged.
- **Relates to:** [ADR-0003](ADR-0003-free-compute-capacity.md) (capacity), [ADR-0005](ADR-0005-free-only-mode.md)
  (free-only), [EPIC-C1](../todo/C1-retrieval-port.md)

## Context

The 2026-10-08 scan called retrieval "the single biggest gap": the product is a RAG, and the project
had zero RAG. `swarm.ts` was built but inert, `planQuotaRun` had no non-test caller, and the only
retrieval-adjacent surface was `CONTEXT_STORE` (a KV blob store) and `DataTrustVault` (an append-only
ledger). EPIC-C1 asks for a `RetrievalPort` with a local lexical implementation and a conditional
Cloudflare AI Search adapter.

The obvious way to close that gap is to pull in a search engine or a vector database. This ADR records
why that is the wrong first move, and what the evidence says is the right one.

**Constraints that decide the shape:**

1. `phoenix-core` has **zero dependencies** and must stay that way: `boundary.test.ts` fails the build
   on any `cloudflare:` import, any `node:` import outside `src/node/`, or any bare runtime global.
2. The engine must bundle into a Cloudflare Worker and run on bare Node. A module that only works on
   one host is an adapter, not a core dependency.
3. The freeze list (ROADMAP-SPINE §1) already refuses Mem0 / Graphiti / Neo4j, a second scheduler, and
   a provider-count chase. A search *service* is a second deployment, which is the same class of thing.
4. "5 options per capability" (the everybird plan) is a **discovery** problem, not a catalogue problem.
   The capability vocabulary already has `vector` and `embeddings`; the port is the unit, not the
   vendor.

**What the research found (2026-11-20):**

| Candidate | License | Runtime fit | Verdict |
|---|---|---|---|
| **SQLite FTS5** | public domain (SQLite) | Cloudflare Durable Object SQLite **lists FTS5** in its SQL API docs; Node `node:sqlite` ships it — **verified on Node 26.11.1** with `CREATE VIRTUAL TABLE … USING fts5` and `MATCH` | **baseline** |
| **Orama** | Apache-2.0 | zero dependencies; browser/server/edge; full-text + vector + hybrid; <2 KB core | **optional Node/local adapter** |
| **MiniSearch** | MIT | zero dependencies; in-memory full-text; Node/browser | optional, but no vector/hybrid |
| **sqlite-vec** | MIT/Apache-2.0 | native C extension; **not supported on Durable Object SQLite** (community request open); `node:sqlite` extension loading is not a safe default | **refuse as baseline** |
| **Cloudflare AI Search** | commercial, free tier | hosted; **1,000 semantic + 1,000 full-text queries/month** free on all Workers plans; billing begins 2026-12-01 (docs) / 2026-11-01 (blog); 100 instances, 100k files/instance | **conditional Workers adapter** |
| **Meilisearch / Typesense / Qdrant** | various | servers, not embeddable libraries | **refuse** (second deployment) |
| **Mem0 / Graphiti / Neo4j** | various | memory graph engines / graph DB | **refuse** (freeze list) |

The decisive fact is FTS5: it is **already in both SQLite builds**. That means the baseline needs no
new dependency at all, works on both hosts, and is the cheapest thing that can be tested today. Orama
is the better *vector/hybrid* engine, but it is Apache-2.0 and belongs in the host layer, not the
zero-dependency engine. AI Search is the hosted option, but its free tier is metered and its billing
date has moved twice — it is an adapter whose eligibility must be probed, not a substrate.

## Decision

**Retrieval is a port. The baseline adapter is FTS5. Everything else is an adapter, chosen by the host
and reported by a probe.**

### Rule 1 — `RetrievalPort` is declared once, in `ports.ts`

```ts
export interface RetrievalPort {
  index(document: RetrievalDocument): Promise<void>;
  search(query: RetrievalQuery): Promise<RetrievalHit[]>;
  delete(namespace: string, documentId: string): Promise<void>;
}
```

`RetrievalHit` carries `{documentId, namespace, title?, text, score, source, timestamp?, metadata?}`.
`score` is **higher-is-better** so a host can merge adapters without knowing the substrate's native
rank direction (FTS5's `rank` is negative). `source` names the adapter (`"fts5"`, `"orama"`,
`"ai-search"`) because a result without provenance is a claim without evidence.

### Rule 2 — the baseline is `createFts5Retrieval(sql, now)`, zero dependencies

`phoenix-core/src/retrieval.ts` creates an FTS5 virtual table over the `SqlPort` the engine already
has. It is pure over the port: no `node:` import, no `cloudflare:` import, no runtime global. Both
hosts satisfy it with what they already have:

| Host | `SqlPort` | FTS5 |
|---|---|---|
| Cloudflare Workers | Durable Object `SqlStorage` | documented |
| Node | `nodeSqlPort(DatabaseSync)` | verified 2026-11-20 |

The query normalizer quotes every token and joins with `OR`. That is an injection guard, not a
style choice: FTS5's query language has operators, and user text must be data, never syntax. A query
with no tokens returns `""` and the adapter returns `[]` — never "match everything".

### Rule 3 — Orama is an optional Node/local adapter, not a core dependency

Orama (Apache-2.0, zero dependencies) is the preferred **vector/hybrid** adapter when a host wants
more than lexical search. It lives in the host/platform layer, is loaded only when configured, and
must carry its Apache-2.0 attribution. It is not imported by `phoenix-core` and not added to the
Workers bundle by default. MiniSearch (MIT) remains a lighter lexical-only alternative.

### Rule 4 — Cloudflare AI Search is a conditional Workers adapter

AI Search is bound only when an operator configures it, and its eligibility comes from first-party
limits (1k semantic + 1k full-text queries/month free; billing 2026-12-01). The adapter must:

- report `unavailable` with a stable reason when the binding is absent or the account is over quota;
- degrade to the FTS5 adapter, not to a fabricated answer;
- keep the same `RetrievalHit` shape, including `source: "ai-search"`.

### Rule 5 — memory (C4) builds on the same substrate

Layered memory is working → task state → episodic → knowledge artifacts → semantic → procedural, with
the OKF artifact envelope `{id,type,principal,agent,created,updated,source,status,freshness,
confidence,provenance}`. It uses the same `RetrievalPort` and SQLite tables. It does **not** add
Mem0, Graphiti, Neo4j, or a second memory service. A memory layer that cannot be read by the same
port is a second truth.

### Rule 6 — durable execution stays on DO alarms + `scheduled.ts`

No Temporal, Inngest, Trigger.dev, BullMQ, or Dagster. `tasks.ts` already records the evaluation: each
is a durable-execution *runtime* (a server, queue, worker fleet, or hosted control plane) and cannot
live inside a Worker with no bindings. B1–B4 wire the existing `tasks.ts` + `scheduled.ts` +
`quota.ts` + DO alarms. A benchmark can revisit this only with a new evidence-based decision.

### Rule 7 — observability uses what the runtime already has

`pino` (MIT) is a Node-host-only structured logger; it is not added to the engine or the Workers
bundle. Workers keeps structured `console.error(JSON.stringify(...))` plus `X-Request-Id`. The ledger
is the telemetry; the cheapest next step is a query surface over existing tables, not a collector.

### Rule 8 — validation, CLI and MCP stay hand-rolled in the engine

`parseExecuteBody()`, the 11 CLI subcommands, and the MCP server are dependency-free by design. `zod`,
`citty`, and `@modelcontextprotocol/sdk` are reasonable **platform-layer** adoptions later, but they
are refactors, not capabilities. They do not enter `phoenix-core`.

### Rule 9 — REA is not a module-integration tool

REA reverse-engineers shipped artifacts (native binaries, managed code, browser pages, runtimes). It
does not fetch or integrate open-source source modules, and it was not used for this decision.
Source-level adoption uses the licenses, docs, and code above; artifact-level questions (e.g. "what
does this shipped binary do?") are REA's job.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Orama as the engine baseline** | It is the best vector/hybrid engine here, but it is a dependency in the zero-dependency engine and Apache-2.0. The FTS5 baseline ships on both hosts with no bundle cost; Orama is the optional upgrade. |
| **MiniSearch as the baseline** | MIT and tiny, but lexical-only. It would duplicate FTS5 rather than add vector capability, and it would still be a dependency. |
| **sqlite-vec as the baseline** | Native C extension; unavailable on Durable Object SQLite and not a safe default for `node:sqlite`. It is a future Node-only adapter, not the portable baseline. |
| **Cloudflare AI Search as the baseline** | Metered free tier (1k + 1k/month), a moving billing date, and a hard dependency on Cloudflare. It is the hosted adapter, not the floor. |
| **Meilisearch / Typesense / Qdrant** | Servers. A second deployment is exactly what the "tiniest provider" constraint forbids. |
| **Mem0 / Graphiti / Neo4j** | Freeze list. They are memory *products*, not a memory *port*; the layered model can be built on SQLite + the same retrieval port. |
| **Temporal / Inngest / Trigger.dev** | Durable-execution runtimes; already evaluated and rejected in `tasks.ts`. B1–B4 use DO alarms. |
| **`pino` in the engine** | Node-oriented, and the engine must not depend on a logging library. It is a host-layer concern. |
| **`zod` in the engine** | Hand-written validation is the engine's zero-dependency contract; `zod` is a platform-layer option, not a core dependency. |

## Consequences

**What it costs**

- Two adapters to maintain at first (FTS5 baseline, Orama optional), plus a conditional AI Search
  adapter. Each must return the same `RetrievalHit` shape and name its `source`.
- FTS5's query language is not exposed; `normalizeFtsQuery` is the only search grammar. That is a
  deliberate safety trade, and it means no `NEAR`, no column filters, no prefix syntax until a
  structured query type is added.
- Orama's Apache-2.0 license requires attribution when it is vendored or bundled. That is a
  documentation obligation, not a code one.

**What it prevents**

- A search server or vector database in the deployment path. The baseline is a virtual table in a
  database the host already runs.
- A second memory truth. C4 uses the same port and the same SQLite substrate.
- A silent bundle regression. `boundary.test.ts` still passes because `retrieval.ts` imports only
  `ports.ts`.

**Known gaps**

- The Workers baseline is lexical only. Vector/hybrid on Workers requires the AI Search adapter or a
  future Vectorize adapter; Orama is not in the Workers bundle by default.
- The C2 routes (`POST /knowledge`, `GET /knowledge/:id`, `POST /knowledge/search`) are not wired in
  this slice. This ADR ships the port, the FTS5 adapter, and the tests; the HTTP surface is C2.
- Ranking is BM25 only. `mergeRetrievalHits` is ready for a second adapter, but no vector adapter is
  wired yet.
- `Capabilities` still reports `inference | embeddings | vector | sync | scheduler`; retrieval is
  observed through `vector`/`embeddings` probes until C2 adds a `retrieval` probe.

## Verification

`phoenix-core/test/retrieval.test.ts` — 17 tests, Node suite, real SQLite via `node:sqlite`:

| Claim | Test |
|---|---|
| schema is idempotent | `creates its schema idempotently` |
| index → search returns provenance | `indexes a document and returns it with provenance` |
| namespaces are isolated | `isolates namespaces` |
| empty/operator-only query returns `[]` | `returns [] for a query with no searchable tokens` |
| FTS5 operators are literal text | `treats FTS5 operators as literal text, not syntax` |
| ranking is best-first | `orders by relevance, best first` |
| limit is capped | `caps the limit and never returns more than asked` |
| delete is namespace-scoped | `deletes one document without touching its namespace` |
| metadata round-trips | `round-trips metadata as JSON` |
| timestamp falls back to the clock | `falls back to the injected clock when the document has no timestamp` |
| query normalizer strips syntax | `strips FTS5 syntax characters` |
| query normalizer keeps Persian/Arabic | `keeps non-ASCII tokens intact` |
| merge keeps the best duplicate | `keeps the best-scoring occurrence of a duplicate document` |
| merge is deterministic | `breaks score ties by timestamp, newest first` |
| merge applies the limit | `applies the limit after merging` |

**Full suites after the change:** typecheck exit 0; workers **18 files / 188 tests** green; node
**29 files / 539 tests** green (was 28 / 522). `boundary.test.ts` still passes: the new module imports
only `./ports.ts`.

**Negative control, run and reverted.** `normalizeFtsQuery` was changed to pass the raw input through.
The suite went red on the operator and injection tests, which is the real-world symptom: a query
containing `*` or `:` would either error or change meaning. Restored and green. A guard that has never
fired is not evidence.