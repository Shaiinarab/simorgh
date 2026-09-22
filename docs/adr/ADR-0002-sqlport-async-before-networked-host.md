# ADR-0002 — Prove portability on a local-storage runtime before making `SqlPort` async

**Status:** Accepted · **Date:** 2026-09-22 · **Supersedes:** nothing
**Depends on:** [ADR-0001](ADR-0001-go-workspace-role.md) (unrelated, but same review pass)

**Decision in one line:** do **not** build a Vercel host yet. First prove the engine on **Bun or
Deno 2** — a runtime that can supply a *synchronous* SQL implementation — because that tests the real
risk cheaply. Make `SqlPort` asynchronous only when a networked-storage host is actually wanted.

---

## 1. Context

`docs/HOST-PORTABILITY.md` records the evaluation this decision comes from. The short version:

- The engine needs six ports. Five (`fetch`, `sha256`, `randomUUID`, `now`, the context store) are
  trivial on any runtime.
- `SqlPort` is **synchronous** by construction:

  ```ts
  exec<T extends SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
  toArray(): T[];
  ```

  Both implementations justify that — `node:sqlite`'s `DatabaseSync`, and Cloudflare's
  `SqlStorageCursor` with its synchronous `toArray()`.
- Vercel has no durable filesystem, so a core there needs a **networked** database. Every candidate
  (Turso/libSQL, Neon, D1-over-HTTP, Upstash) is **asynchronous**, so none can implement `SqlPort`.

Therefore the portability claim is narrower than the documentation implies — *portable across runtimes
that can supply a synchronous SQL implementation*. No host adapter can work around that; the interface
itself is the constraint.

## 2. Decision

1. **Vercel is not the next host.** A file-backed SQLite in `/tmp` is explicitly rejected: it would make
   the transparency ledger — an append-only architectural contract, written *before* the flight —
   silently best-effort and per-instance. A ledger that quietly loses rows is worse than no ledger.
2. **Next portability test: Bun or Deno 2.** Same suite (`vitest.node.config.ts`), same engine, a
   runtime neither of the two current hosts is. This is the cheap test of the likelier failure — that
   the engine is accidentally Node-shaped (a `node:` leak, a Node-only global, a dialect assumption) —
   and it costs an afternoon rather than a refactor.
3. **`SqlPort` becomes async only when a networked-storage host is actually wanted**, at which point
   this ADR is superseded with the measured cost.

## 3. Why this order

**Making `SqlPort` async touches every statement in the engine** — the ledger, the health upserts, the
cooldown reads, the rate-limit counter — for a host nobody has asked for. The measured asymmetry:

| | Cost | Scope of change | What it proves |
|---|---|---|---|
| Bun/Deno host | ~1 day | one new adapter file, no engine change | that the engine is not Node-shaped |
| Async `SqlPort` | days | the engine's entire data layer + every host | that the engine runs where storage is remote |

Do the cheap test first. If it passes, the portability claim is earned on **three** hosts and the async
refactor becomes a decision about one host rather than a leap of faith. If it fails, the cheaper test
has found a boundary bug — which is the reason to run tests.

Two specific pressures make Bun/Deno a real test rather than a formality:

- `phoenix-core/src/node/index.ts` already carries a **dialect sniff** (`RETURNS_ROWS`) because
  `node:sqlite` splits reads (`all()`) from writes (`run()`) while Cloudflare fuses them into `exec`.
  The abstraction over that difference has exactly **one** non-Cloudflare implementation today. A second
  one is what puts it under pressure.
- `phoenix-core/test/boundary.test.ts` forbids `node:` imports outside that adapter. A new runtime
  either satisfies the same port or exposes a place where the boundary leaked.

## 4. Consequences

**Good.** The portability claim gets tested where it is weak rather than where it is convenient. No
engine-wide refactor is bought speculatively. The rejection of the `/tmp` SQLite is written down, so it
does not get re-proposed as an easy win later.

**Costs.** Vercel remains unusable for a *core*, so a "deploy Simorgh to Vercel" request keeps its
current answer: not until ADR-0002's successor. Anyone wanting Vercel sooner must bring the async
`SqlPort` first, not an adapter.

**Explicitly not decided here.** Whether a serverless core is desirable *at all* — a host with no
long-lived process changes the health-sweep cadence (Vercel Hobby crons are daily, a 24× coarsening of
"tired" recovery) and costs the in-process context store. That is a product question, not a portability
one, and it deserves its own answer before the refactor.

## 5. Follow-up, in dependency order

1. Add a Bun or Deno 2 host under `simorgh-platform/src/runtimes/`, serving the same core contract.
2. Run `vitest.node.config.ts` against it. Any engine change it forces is the finding.
3. Add the runner to `npm test` or a fourth script, so the third runtime is a **standing** test rather
   than a one-off — an untested runtime is not a portability guarantee.
4. Revisit the async `SqlPort` only with a named serverless target and the above done.

## 6. Evidence

Every claim is reproducible; see `docs/HOST-PORTABILITY.md` §7 for the exact commands and the two
Vercel documents, checked 2026-09-22.
