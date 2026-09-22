# TASK-010 — prove the engine on Bun, a third runtime with its own SQL dialect

- Owner: any
- Status: open
- Depends on: nothing · Estimate: 60–90 min · Runner: codex lane (headless)

## Why this exists

`docs/HOST-PORTABILITY.md` and `docs/adr/ADR-0002` concluded that **Vercel is the wrong next host**, and
that the cheap, load-bearing test is a runtime that can still supply a **synchronous** SQL
implementation. `bun` **1.4.0 is installed on this box**, so this is that test.

The portability claim has only ever been tested against the two runtimes it was designed on: Cloudflare
workerd, and Node with `node:sqlite`. Both are embedded and synchronous. A third implementation is what
puts the abstraction under pressure — specifically this line in
`phoenix-core/src/node/index.ts`:

```ts
const RETURNS_ROWS = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i;
```

That sniff exists because `node:sqlite` splits reads (`all()`) from writes (`run()`) while Cloudflare
fuses both into `exec`. It has exactly **one** non-Cloudflare implementation today. `bun:sqlite` is a
**third** dialect (`db.query(sql).all()`, `db.query(sql).run()`, `db.run(sql)`), so this task is where
the abstraction either holds or is exposed as Node-shaped.

## Read first

- `simorgh-platform/src/runtimes/node.ts` — **the template.** Copy its route table, error shapes,
  request-id handling, auth, MCP handler and rate-limit headers *exactly*. A client must not be able to
  tell which runtime it is talking to.
- `phoenix-core/src/node/index.ts` — the SQL adapter and the dialect bridge. Read the
  `RETURNS_ROWS` comment in full before writing your own.
- `phoenix-core/src/ports.ts` — `SqlPort`, `SqlCursor`, `SqlValue`, `PhoenixPorts`
- `phoenix-core/src/index.ts` — the exact export list the Node runtime imports; use the same names
- `docs/HOST-PORTABILITY.md` §2 — the six ports a host must supply
- `docs/adr/ADR-0002` §2–3 — what this task is and is not for

## Deliverable 1 — `simorgh-platform/src/runtimes/bun.ts` (new)

Export `startBunRuntime(options)` returning `{ host, port, url, server, close() }`, plus a `main()`
guarded the same way the Node runtime guards its own (`process.argv[1]?.endsWith("bun.ts")`) so it can
also be imported by a test.

Requirements:

- **Serve with `Bun.serve`**, not `node:http`. This is the point: the HTTP layer is the easy part and it
  should stay easy.
- **`SqlPort` over `bun:sqlite`.** `bun:sqlite` has **no `DatabaseSync`** — it is `import { Database } from
  "bun:sqlite"` and `new Database(path)`. Whether it is synchronous is the question your report must
  answer with evidence. Note the engine's `SqlPort.exec` returns a cursor **synchronously** with a
  synchronous `toArray()`; if `bun:sqlite` cannot satisfy that shape, **that is the finding** — report it,
  do not paper over it with a change to the engine.
- The **same route table**: `/`, `/health`, `/api/v1/flock/status`, `/api/v1/agent/execute`,
  `/api/v1/user/{id}/logs`, `/api/v1/context/{ref}`, `/mcp`.
- The **same MCP handler** (initialize / notifications/initialized / tools/list / tools/call with
  `simorgh_status` and `simorgh_ask`), with `Mcp-Session-Id` on initialize.
- The **same auth** via `authenticateServiceRequest`, and the same **fail-closed** 503 when
  `SIMORGH_API_KEY` is absent.
- The **same headers**: `X-Request-Id`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, CORS handling via `isAllowedOrigin`, and the `X-RateLimit-*` trio.
- A **health sweep**. `Bun.serve` has no `setInterval` prohibition, so keep the same hourly
  `sweepStale`, and say in your report how it differs from a serverless host.
- `createNodePorts` is reusable as-is (it only touches `node:crypto`) — **verify that claim by trying
  it**, and if Bun needs its own `PhoenixPorts`, write one and say why.

**Do not modify `phoenix-core`.** If the engine needs a change to run on Bun, that is the boundary
finding this task exists to produce — write it up with the exact error and the minimal proposed change,
and **leave the engine alone**. The Lead decides.

## Deliverable 2 — `simorgh-platform/scripts/e2e-bun.ts` (new)

A runnable proof, in the spirit of the existing `scripts/e2e-ask.ts`. Boot the Bun runtime **as a
subprocess** (`bun run simorgh-platform/src/runtimes/bun.ts --port <ephemeral>`) and drive it over HTTP:

1. `GET /health` → 200, `status: "ok"`
2. `GET /api/v1/flock/status` → 200, parses, and reports provider state
3. `POST /api/v1/agent/execute` **without** a token → **503** (the fail-closed path), then **with**
   `SIMORGH_API_KEY` set and a token → 200 or an honest 502, never a fabricated answer
4. `POST /mcp` `initialize` → returns a protocol version and a `Mcp-Session-Id`
5. `POST /mcp` `tools/list` → **exactly** two tools, `simorgh_status` and `simorgh_ask` — assert
   equality, not containment
6. Kill the subprocess cleanly and assert exit

Print one `[ok]`/`[FAIL]` line per check and a final count, exit non-zero on any failure.

**Two environment facts, both load-bearing:**
- `export NO_PROXY=127.0.0.1,localhost` — a global proxy env var intercepts localhost on this box.
- The child must be started with a **`Bun`-resolved** command. `bun` is at
  `/home/shai/.local/bin/bun` (confirm with `command -v bun`); do not assume it is on the PATH of a
  spawned process.

## Deliverable 3 — `package.json` (two scripts only)

```json
"runtime:bun": "bun run simorgh-platform/src/runtimes/bun.ts",
"e2e:bun": "bun simorgh-platform/scripts/e2e-bun.ts"
```

Change **nothing else** in `package.json` — not the workspaces, not the other scripts.

## Allowlist — touch nothing else

```
simorgh-platform/src/runtimes/bun.ts     (new)
simorgh-platform/scripts/e2e-bun.ts      (new)
package.json                             (the two scripts above, only)
```

**Do NOT touch `phoenix-core/**` at all.** Do not touch `node.ts`, `smoke.ts`, `providers.ts`, or any
test file. Do not add a dependency. Do not run `bun install`.

## Acceptance — run these and paste the output verbatim

```bash
cd /home/shai/personal/projects/projects/opensource/simorgh-platform
export NO_PROXY=127.0.0.1,localhost
bun --version
bun run simorgh-platform/src/runtimes/bun.ts --port 8899 &     # then curl the routes, then kill it
curl -fsS http://127.0.0.1:8899/health && echo OK-health
bun simorgh-platform/scripts/e2e-bun.ts

# and prove you did not break the existing runtime
npm run typecheck && echo OK-typecheck
npm test 2>&1 | grep -E "Test Files|Tests " && echo OK-tests
npm run platform:smoke && echo OK-node-smoke
```

If `bun run <file>.ts` refuses the type-stripping for something the Node runtime allows, **say exactly
what it refused** — that is a portability finding, not an obstacle to work around silently.

## Report

`mailbox/OUTBOX/TASK-010-REPORT.md`, per `mailbox/README.md`, ending with `TASK-010-END` as the last
non-empty line. The report must state, explicitly:

- **Whether `SqlPort` was satisfiable on `bun:sqlite` without changing the engine**, with the code that
  proves it.
- **Whether `createNodePorts` worked unchanged** on Bun.
- **Anything the engine would need changed** to support a third runtime — or a plain statement that
  nothing was needed.
- The `e2e:bun` output verbatim, and every route's exact status code.
- Any difference in observable behaviour between the Bun and Node runtimes. "None found" is a valid,
  useful answer; state how you checked.

Note: `mailbox/bin/fbmail` takes the **bare numeric id** — `fbmail check 010`, not `fbmail check TASK-010`.
