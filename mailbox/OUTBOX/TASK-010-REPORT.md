# TASK-010 — REPORT

- Brief: `mailbox/INBOX/TASK-010-bun-portability.md`
- Instance: shai-pc (host). Codex lane launched 2026-09-22 14:57, killed mid-flight (no `END=`
  marker) — this report was assembled from the artifacts it left plus independent verification.
- Status: **done**

## Status

Done. The portability claim survives a third runtime. `SqlPort` **is** satisfiable on
`bun:sqlite` with **no change to `phoenix-core`** — the only dialect difference is the query API,
and it stays in the adapter. `phoenix-core/**` is untouched (`git status` shows only the allowlist).

The lane died before writing its report; the code it produced is sound. Two things were fixed here
before signing off: the e2e's flock assertion was a **false negative** (it asserted a field that
does not exist in the payload — see "Corrections"), and the report itself had to be written.

## The three load-bearing answers

### 1. Was `SqlPort` satisfiable on `bun:sqlite` without changing the engine? — **Yes.**

`bun:sqlite` is synchronous, in the shape the engine needs:
`db.query(sql).all(...)` and `db.query(sql).run(...)` both return synchronously, so `SqlPort.exec`
returning a *synchronous* cursor whose `toArray()` is also synchronous is satisfiable as written.

The proving code — `simorgh-platform/src/runtimes/bun.ts:125-146`:

```ts
const RETURNS_ROWS = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i;

type BunDB = InstanceType<typeof Database>;

function bunSqlPort(db: BunDB): SqlPort {
  return {
    exec<T extends SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      // ArrayBuffer is a legal SqlValue but bun:sqlite expects
      // Uint8Array for binary bindings, so convert rather than cast away.
      const args = bindings.map((b) =>
        b instanceof ArrayBuffer ? new Uint8Array(b) : b
      ) as never[];

      if (RETURNS_ROWS.test(query)) {
        const rows = db.query(query).all(...args) as T[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const result = db.query(query).run(...args);
      return { toArray: () => [], rowsWritten: result.changes };
    },
  };
}
```

Two things worth flagging, both small:

- The `RETURNS_ROWS` sniff in `phoenix-core/src/node/index.ts` is **reused verbatim**. It is not
  Node-shaped after all: `bun:sqlite` splits reads (`all()`) from writes (`run()`) exactly the way
  `node:sqlite` does. The sniff was correct about *dialects that split*, and Bun is one of them.
- `bun:sqlite` wants `Uint8Array` for binary bindings, while `ArrayBuffer` is a legal `SqlValue` in
  the port's type. That conversion is four lines **in the adapter**, not in the engine.

Independent confirmation (`/home/shai/personal/projects/.openclaw/tmp/bun-sqlport-probe.ts`, 7
checks, run under Bun 1.4.0):

```
[ok]   SqlPort.exec returns a cursor SYNCHRONOUSLY — typeof cursor = [object Object]
[ok]   cursor.toArray() is SYNCHRONOUS and row-shaped — [{"one":1}]
[ok]   engine DDL (health/rate-limit/ledger) applies unchanged
[ok]   consumeRateLimit = allow, allow, block (sync write+read through the port) — allowed=true,true,false remaining=0
[ok]   sqlLedger writes then reads back through bun:sqlite — count=1
[ok]   readAllHealth reads through bun:sqlite — rows=0
[ok]   createNodePorts works UNCHANGED on Bun — sha256=32B uuid=36chars

7 passed, 0 failed
```

That probe exercises the *engine's own* `consumeRateLimit`, `sqlLedger` and `readAllHealth` — i.e.
real `phoenix-core` code paths, not a toy schema.

### 2. Did `createNodePorts` work unchanged on Bun? — **Yes.**

`createNodePorts` touches only `node:crypto`, and Bun implements it. Reused as-is at
`bun.ts:155` (`const ports = createNodePorts();`), and observed working through the port probe
above (`sha256` → 32 bytes, `uuid` → 36 chars) and through the running server (rate-limit keys and
the ledger both hash correctly).

### 3. What would the engine need changed to support a third runtime? — **Nothing.**

No change was required and none was made. `phoenix-core/**` is unmodified. The dialect seam the
engine already had (`RETURNS_ROWS`) absorbed the third dialect, and the residual differences
(`Uint8Array` bindings, `db.query()` instead of `prepare()`) are host-side concerns that the port
boundary is supposed to absorb. That is the finding the task existed to produce, and it is a
positive one.

## Acceptance — verbatim

```
$ /home/shai/.bun/bin/bun --version
1.4.0

$ npm run e2e:bun
npm notice run simorgh-platform@2.0.0 e2e:bun
npm notice run bun simorgh-platform/scripts/e2e-bun.ts
[ok] bun runtime started without API key
[ok] GET /health → 200, status: "ok"
[ok] GET /api/v1/flock/status → 200, birds: 2 [dormant,dormant]
[ok] POST /api/v1/agent/execute no token → 503 (fail-closed)
[ok] subprocess without key exited cleanly (exit 0)
[ok] bun runtime started with API key
[ok] POST /api/v1/agent/execute with token → 200 (honest, not fabricated)
[ok] POST /mcp initialize → 200, protocol: 2026-07-28, session: yes
[ok] POST /mcp tools/list → 200, exactly 2 tools: [simorgh_status, simorgh_ask]
[ok] subprocess with key exited cleanly (exit 0)

10/10 checks passed
RC=0
```

```
$ npm run typecheck
npm notice run tsgo --noEmit && tsgo --noEmit -p phoenix-core/tsconfig.json && tsgo --noEmit -p simorgh-platform/tsconfig.json
typecheck_rc=0

$ npm test 2>&1 | grep -E 'Test Files|Tests '
 Test Files  10 passed (10)
      Tests  82 passed (82)
 Test Files  17 passed (17)
      Tests  202 passed (202)

$ npm run platform:smoke
phoenix-core smoke run (http://127.0.0.1:46193)
  ok    health — http_200 status=ok
  ok    flock-status — http_200 providers=0
  ok    auth-fails-closed — unauthenticated execute → http_401 (want 401)
  ok    execute-degrades-honestly — http_200 answered_by=none error=flock_exhausted
  ok    mcp-initialize — http_200 protocol=2026-07-28
smoke_rc=0
```

### Route table — exact status codes, Bun runtime

| Route | Method | Condition | Status | Body |
|---|---|---|---|---|
| `/health` | GET | — | **200** | `{"status":"ok","timestamp":"…"}` |
| `/api/v1/flock/status` | GET | — | **200** | `{birds:[…], timestamp}` — 2 birds, both `dormant` |
| `/api/v1/agent/execute` | POST | `SIMORGH_API_KEY` **absent** | **503** | `error.code = AUTH_NOT_CONFIGURED` |
| `/api/v1/agent/execute` | POST | key set, valid token | **200** | honest result (no providers → `answered_by=none`, `error=flock_exhausted`) |
| `/api/v1/agent/execute` | POST | key set, no/invalid token | **401** | auth failure |
| `/mcp` | POST | `initialize` | **200** | protocol `2026-07-28` + `Mcp-Session-Id` |
| `/mcp` | POST | `tools/list` | **200** | exactly `[simorgh_status, simorgh_ask]` |
| `/`, `/api/v1/user/{id}/logs`, `/api/v1/context/{ref}` | — | — | served from the same route table as Node | — |

`/api/v1/agent/execute` never fabricates an answer: with no providers configured it returns the
honest degraded result, which is the behaviour the Node runtime also has.

## Differences in observable behaviour: Bun vs Node — **none found**

How this was checked, in three independent passes:

1. **Same client, both runtimes, same assertions.** The e2e drives the Bun server over HTTP and the
   existing `platform:smoke` drives the Node server; every shared check (`health`, `flock-status`,
   `execute`, `mcp-initialize`) produces the same status and the same payload shape.
2. **The fail-closed path was probed on both, directly.** With no `SIMORGH_API_KEY` in the
   environment, **Node returns 503 `AUTH_NOT_CONFIGURED`** and **Bun returns the identical 503
   `AUTH_NOT_CONFIGURED`**.
3. **The full test suite runs unchanged** — 284 tests across 27 files, none runtime-conditional.

**One apparent difference turned out to be a configuration difference, not a runtime one, and it is
worth recording so nobody re-finds it as a bug.** The e2e expects "no token → **503**" while
`platform:smoke` expects "no token → **401**". Both are correct:

- `/health`, `flock-status` are unauthenticated by design.
- `smoke.ts` starts the runtime **with** `apiKey: "smoke-token"` (and `providers: []`), so auth *is*
  configured → a tokenless request is **401**.
- `e2e-bun.ts` starts a runtime with **no key at all** → auth is not configured → the documented
  fail-closed **503 `AUTH_NOT_CONFIGURED`**.

Same code, different startup config. Nothing about Bun is involved.

### How the hourly sweep differs from a serverless host

`Bun.serve` has no `setInterval` prohibition, so `bun.ts:578` keeps the same hourly `sweepStale`
the Node runtime uses, with `sweepTimer.unref()` so it never holds the process open. On a
serverless host there is no such timer — the sweep has to be a scheduled trigger (see
`docs/HOST-PORTABILITY.md` §3a). This is the one place where "keep it identical" and "the host is
different" genuinely conflict, and the resolution is: the sweep is host-provided, not part of the
wire contract.

## Corrections made to the lane's work before sign-off

- **False negative in `e2e-bun.ts` (fixed).** The script asserted `body.providers` on
  `/api/v1/flock/status` and reported `[FAIL] … → 200, providers: ?` while the route was in fact
  returning HTTP 200 correctly. The wire contract is `{ birds, timestamp }`
  (`phoenix-core/src/flock.ts:177`; asserted as `birds` in `smoke.ts:44`). The assertion was
  corrected to `birds` and now also prints each bird's state. **This is why the lane's own log
  showed a failure the runtime did not have.** Lesson for the next lane: verify a payload shape
  against a live response before asserting on it.
- **Environment fact in the brief is wrong (brief has not been edited).** The brief says `bun` is at
  `/home/shai/.local/bin/bun`. It is at **`/home/shai/.bun/bin/bun`** (v1.4.0); `~/.local/bin/bun`
  does not exist. The lane used the correct path. The brief's acceptance snippet also pins port
  `8899`, which is held by an unrelated listener that answers `404` — a boot attempt there dies with
  `EADDRINUSE`. The e2e uses its own port (`8897`), and the manual probes used 8901/8902.

## Artifacts

- `simorgh-platform/src/runtimes/bun.ts` (new, 647 lines) — the Bun runtime: `Bun.serve`, the same
  route table, `bunSqlPort`, MCP handler, fail-closed auth, identical headers, hourly sweep.
- `simorgh-platform/scripts/e2e-bun.ts` (new, 198 lines) — the runnable proof, `10/10`.
- `package.json` — exactly two added scripts, nothing else:
  `"runtime:bun": "bun run simorgh-platform/src/runtimes/bun.ts"`,
  `"e2e:bun": "bun simorgh-platform/scripts/e2e-bun.ts"`.
- `.openclaw/tmp/bun-sqlport-probe.ts` — the independent 7-check `SqlPort` probe (workspace scratch,
  not part of the repo).
- **`phoenix-core/**` is unmodified**, no dependency was added, `bun install` was never run.

## Next_actions

1. **Record the verdict.** `docs/HOST-PORTABILITY.md` / `ADR-0002` concluded the cheap load-bearing
   test was "a runtime that can still supply a synchronous SQL implementation". It passed on the
   first try with zero engine change — that belongs in the ADR as a settled question, so the next
   host decision starts from "the SQL port is genuinely portable across three dialects" rather than
   re-testing it.
2. **Fix the brief's `bun` path** (`/home/shai/.bun/bin/bun`) and drop the `--port 8899` acceptance
   line, or the next lane burns time on `EADDRINUSE` and a phantom missing binary.
3. **Decide whether the Bun runtime is a product target or a proof.** It is currently a proof. If it
   becomes a target it needs a supervisor, a persistence choice (`:memory:` today), and the same
   hardening the Node runtime has.
4. Note for whoever picks up a third runtime beyond Bun: the `ArrayBuffer` → `Uint8Array` binding
   conversion is the only place a new dialect is likely to differ again.

## NAGs

- **NAG-001:** `/api/v1/agent/execute` with a key set and a *valid* token returns `200` with
  `answered_by=none, error=flock_exhausted` whenever no providers are configured. Verified honest,
  but nothing in this task checked it against a *configured* provider — so "never fabricates an
  answer" is proven for the empty-fleet case only. A runtime with a live provider was out of scope.
- **NAG-002:** The Bun path is a proof, not a deployment: `:memory:` SQL means the ledger and
  rate-limit state vanish on restart. Fine for the portability claim, not fine if anyone runs it.
- **NAG-003:** The lane was killed by session end (SIGHUP), not by a timeout, and left no report. Two
  lanes have now died this way. Whoever dispatches TASK-011 should launch via a mechanism that
  survives the tool shell (see the `simorgh-lanes` skill) — this is the third instance of "grade on
  artifacts, not on the driver".
TASK-010-END
