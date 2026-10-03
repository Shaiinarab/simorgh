# Host portability — evaluating Vercel, and the `SqlPort` finding behind it

**Written:** 2026-09-22 · **Status:** evaluation complete, implementation deliberately not started

> This document exists because "add a Vercel adapter" is the obvious next step and **the obvious next
> step is the wrong one**. Running the evaluation turned up a constraint in the engine's own port
> surface that no host adapter can work around. It is recorded here, and as
> [`adr/ADR-0002`](adr/ADR-0002-sqlport-async-before-networked-host.md).

## 1. The claim being tested

`README.md` and `docs/STATE-OF-PROJECT.md` say the engine runs unchanged on multiple runtimes, and that
`phoenix-core/test/boundary.test.ts` enforces it. That claim has been tested against **two** hosts so
far: Cloudflare workerd, and Node with `node:sqlite`.

Vercel was proposed as host three because it is neither of those. That is the right instinct — a
portability claim tested only on the runtimes it was designed against is not tested.

## 2. What a host must supply

From `phoenix-core/src/ports.ts`, the engine needs exactly six things:

| Port | Node supplies | Cloudflare supplies | Vercel |
|---|---|---|---|
| `fetch` | `globalThis.fetch` | `globalThis.fetch` | ✅ available |
| `sha256` | `node:crypto` | `crypto.subtle` | ✅ available |
| `randomUUID` | `node:crypto` | `crypto.randomUUID` | ✅ available |
| `now` | `Date.now` | `Date.now` | ✅ available |
| `ContextStorePort` | `memoryContextStore` (a `Map`) | KV | ⚠️ per-invocation only |
| **`SqlPort`** | `node:sqlite` `DatabaseSync` | DO `SqlStorage` | ❌ **see §4** |

So five of six ports are trivial. The HTTP seam — the part one would expect to be hard — is not the
problem at all.

## 3. The parts that *do* break, and are already known

These are real but secondary; none of them is the blocker.

**a. There is no long-lived process.** `simorgh-platform/src/runtimes/node.ts` is a real
`node:http` server with a `setInterval` health sweep:

```ts
const sweepTimer = setInterval(() => { sweepStale(sql, ports.now()); }, 60 * 60 * 1_000);
```

Serverless functions are per-invocation handlers, so this becomes a **Cron Job** that has to call an
HTTP route. Vercel's own docs cap the Hobby plan at crons that run **once per day** (the per-project
*count* was raised to 100 on all plans in Jan 2026, but the Hobby *frequency* limit stands). That is a
behavioural regression, not a portability failure: the sweep exists so a provider that failed once and
was never dialled again does not read "tired" forever. Hourly → daily means a bird can read "tired" for
up to 24 hours after it recovered. Acceptable, but it must be **stated**, not discovered.

**b. `memoryContextStore` changes from weak to actively misleading.** Today it is an honest `Map` for a
single-process host, and the engine's own comment says a host wanting durability should pass its own
port. On serverless the process is recycled, so `/api/v1/context/{ref}` would return `404` for a
reference the same client received seconds earlier. A wrong answer is worse than a slow one.

**c. The rate limiter keys on SQL.** `consumeRateLimit(sql, "execute:" + userId, …)` — so it shares the
fate of §4.

## 4. The finding: `SqlPort` is synchronous, so it cannot be backed by a network database

```ts
export interface SqlPort {
  exec<T extends SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}
export interface SqlCursor<T extends SqlRow> {
  toArray(): T[];
  readonly rowsWritten: number;
}
```

`exec` returns a **cursor**, synchronously, and `toArray()` reads it **synchronously**. No promise
appears anywhere in the interface.

That is not an oversight — it is what both current implementations actually offer:
`node:sqlite`'s `DatabaseSync` is synchronous by name, and Cloudflare's `SqlStorage.exec` returns a
`SqlStorageCursor` with a synchronous `toArray()`.

**The consequence is the point.** Vercel's documented answer to "can I use SQLite here?" is *no*: its
own KB says storage is ephemeral in a serverless environment, so the single permanent file SQLite
assumes does not exist. The correct fix is a network database (Turso/libSQL, Neon, D1 over HTTP,
Upstash) — and **every one of those is asynchronous**, so none of them can implement `SqlPort`.

A host would have to block the event loop to satisfy the interface (`Atomics.wait` over a worker, or a
synchronous socket). That is unavailable in a serverless function and would be a serious defect
anywhere else.

So the honest statement of the portability claim is narrower than the docs imply:

> `phoenix-core` is portable across runtimes **that can supply a synchronous SQL implementation** —
> not across hosts in general.

That is still a real achievement: it covers workerd, Node, and Deno 2
(`node:sqlite`). It excludes every serverless host without durable local storage, which is most of them.
**`SqlPort`'s shape, not a missing adapter, is what stands between the engine and a networked host.**

## 5. Options

| # | Option | Cost | What it proves | Verdict |
|---|---|---|---|---|
| A | Write a Vercel adapter with a file-backed SQLite in `/tmp` | low | nothing — the DB is per-instance and wiped, so it is not a core, it is a demo that silently loses the ledger | **reject.** It would make the transparency ledger — an architectural contract — quietly best-effort. |
| B | Make `SqlPort` async, add a Turso/Neon port, then a Vercel host | medium — ripples through every statement in the engine | genuinely: the engine runs where storage is remote | **defer**, but this is the real work. See ADR-0002. |
| C | Test portability on **Deno 2** first | low | that the engine is not implicitly Node-shaped (no `node:` leakage, no Node-only global, no Node-only SQL dialect assumption) | **do this next** |
| D | Skip Vercel; keep two hosts | zero | nothing new | honest fallback if C finds nothing |

### Why C before B

B is a change to the engine's central data interface — the largest blast radius in the repo — bought to
serve a host nobody has asked for yet. C costs an afternoon, uses the same suite, and tests the cheaper
and more likely failure: **that the engine is accidentally Node-shaped.** The `nodeSqlPort` adapter
already sniffs a dialect difference (`RETURNS_ROWS` — `node:sqlite` splits `all()`/`run()` where
Cloudflare fuses them into `exec`), and that sniff is per-adapter, so a second non-Cloudflare host is
exactly what puts it under pressure.

If C passes cleanly, the portability claim is **earned on three hosts** and B becomes a decision about
Vercel specifically rather than a leap of faith. If C fails, you have found a boundary bug cheaply —
which is the whole reason to do it first.

## 6. Recommendation

1. **Do not build the Vercel adapter yet.**
2. ~~**Do C**: add a Bun or Deno 2 host and run `vitest.node.config.ts` against it.~~ **Done** for
   Bun via `TASK-010` — `bun:sqlite` satisfied `SqlPort` with no engine change, which is the
   finding C existed to produce. The host was later removed by owner decision (commit `5c53dfe`
   has it); Deno 2 is still untested. If the engine needs
   changes to fit a third *local-storage* runtime, that is the boundary finding worth having, and it is
   cheap.
3. **Then decide on B** with ADR-0002's cost known, and only if a serverless host is actually wanted.
   Note that `phoenix-core` already exposes async at the outer layer — `LedgerPort.logEntry` and
   `getUserLogs` both return promises — so the async-ness exists one level up and the refactor is
   about threading it through the statements, not inventing a new abstraction.
4. **If Vercel is wanted for the platform rather than a core**, that is a different and much easier
   question: the platform is stateless apart from `fleet-store.ts`, which reads a config file. Do not
   conflate the two — "can Vercel host Simorgh" has two different answers depending on which half.

## 7. Evidence

```bash
sed -n '/export interface SqlPort/,/^}/p' phoenix-core/src/ports.ts     # synchronous, no Promise
grep -n 'DatabaseSync\|node:sqlite' phoenix-core/src/node/index.ts      # the sync assumption, twice
grep -n 'setInterval\|sweepStale' simorgh-platform/src/runtimes/node.ts # the long-lived process
grep -n 'memoryContextStore' phoenix-core/src/node/index.ts             # the Map, and its own caveat
```

External, checked 2026-09-22:

- Vercel KB, *Is SQLite supported in Vercel?* — "In a serverless environment, this central single
  permanent storage is not available because storage is ephemeral with serverless functions."
- Vercel docs, *Cron Jobs — Usage & Pricing* — Hobby accounts are limited to cron jobs that run once
  per day.
- Vercel changelog, Jan 2026 — cron count raised to 100 per project on every plan (so the *count* is no
  longer the constraint; the Hobby *frequency* is).


> **Update 2026-10-03 — the Bun host was removed by owner decision.** The finding
> below still stands and is still the reason this document exists: `bun:sqlite` proved
> `SqlPort` is not Node-shaped, with no change to `phoenix-core`. What changed is the
> artifact, not the conclusion — `simorgh-platform/src/runtimes/bun.ts` and its e2e script
> are deleted, and are recoverable at commit `5c53dfe`. **Bun is not part of the toolchain:**
> there is no `bun.lock`, no `bunfig`, no `bun install`, and no script that invokes it.
