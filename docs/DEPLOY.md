# Deploying Simorgh — three paths, one of which must always work

**Verified:** 2026-10-08, on Node v26.7.0, wrangler 4.146.0, from the working tree at
`feat/phoenix-core-modularization`. Every command marked ✅ below was executed in this repo during this
pass and its exit code recorded; every command marked ⚠️ could not be and says so.

> **Read this as a claim set, not a fact set** — the same contract
> [`STATE-OF-PROJECT.md`](STATE-OF-PROJECT.md) sets. Where this file and the code disagree, the code
> wins, and the disagreement is a finding.

Simorgh runs in three places, and **they are not three configurations of one thing**. They are one
runtime-agnostic engine reached through three hosts, and the hosts own different amounts of the
surface. Path A is the floor: it is the only one that needs no account, no card, and no network. If a
change breaks A but not B and C, the engine has picked up a binding and the portability claim is
false — which is precisely what the test split exists to catch.

| Path | Needs | What you get | Section |
|---|---|---|---|
| **A. Local Node** | Node 22.3+, upm | A complete answering core on your box. The floor. | §A |
| **B. Cloudflare Workers** | A free Cloudflare account | The managed edge, with the only zero-key guarantee. | §B |
| **C. Self-hosted / VPS / private repo** | A box, Node 22.3+, upm | The same core as A, supervised. No container image ships. | §C |

There is no D. A fourth target that cannot complete its own deploy steps would be worse than a missing
one — it turns "deploy" into a debugging session at the worst possible moment. That is the
`EXTENSION_POINT` rule in [`simorgh-platform/src/targets.ts`](../simorgh-platform/src/targets.ts), and
it is why there is deliberately no `docker`, `kubernetes`, or `lambda` entry.

---

## The toolchain, before anything else

```bash
upm install                     # once; node_modules is not committed
upm install --frozen-lockfile   # what CI does: fail rather than resolve
```

**The package manager is [upm](https://github.com/unjs/upm), not npm.** There is no
`package-lock.json`, there will not be one, and it is gitignored so a tool cannot quietly reintroduce
a second resolution of the same manifest. `npm run <script>` still works and still means exactly that:
npm is running a `package.json` script, not installing anything. The reasoning, and what had to change
in the manifest and in the security gate to get here, is
[ADR-0004](adr/ADR-0004-toolchain-upm.md).

Node is the **only** JavaScript runtime; `engines.node` is `>=22.3` and CI pins `node-version: 22`.
Bun was removed on 2026-10-03 and must not come back — see [`HOST-PORTABILITY.md`](HOST-PORTABILITY.md)
§6 and its closing note for what that deletion did, and did not, lose.

### ⚠️ `export NO_PROXY=127.0.0.1,localhost` — do this first

```bash
export NO_PROXY=127.0.0.1,localhost
```

A global proxy env var on your machine will intercept `127.0.0.1`, and then `platform:smoke`, `e2e:ask`,
`simorgh serve`, `simorgh doctor` and every `simorgh connect` fail against a core that is demonstrably
running. It is the single most expensive trap in this repo and it has cost a real debugging session:
the symptom is a connection error against a healthy process.

Honest note: on the machine this document was verified on, no proxy variable is set (checked
2026-10-08), so the trap did not fire and I could not reproduce it. It is documented because
[`AGENTS.md`](../AGENTS.md) and [`STATE-OF-PROJECT.md`](STATE-OF-PROJECT.md) §6 both record it happening
on machines that do have one, not because I watched it.

---

## A. Local Node — the floor

**This is the path that must always work.** It is a dev convenience *and* the product's local mode; a
first-class way to run Simorgh, not a way to avoid the edge. It requires no Cloudflare account, no API
token, no credit card, and no outbound request to pass its own test suites.

### Verify the install

```bash
upm install
export NO_PROXY=127.0.0.1,localhost

npm run typecheck        # ✅ exit 0 — three configs: root, phoenix-core, simorgh-platform
npm test                 # ✅ exit 0 — BOTH suites, workers first
npm run platform:smoke   # ✅ 5/5, exit 0
npm run e2e:ask          # ✅ 10/10, exit 0
npm run security:scan    # ⚠️ needs network for the throwaway audit tree (ADR-0004 §4)
```

Observed suite composition on 2026-10-08: **workers 14 files / 129 tests, node 22 files / 368 tests.**
That is the number to compare against, and it is *not* the number
[`STATE-OF-PROJECT.md`](STATE-OF-PROJECT.md) §3.1 records (11/93 and 19/261) — see **Provenance**, at the end of this file.

Three of those deserve a note:

- **`npm run platform:smoke`** boots a real core on an *ephemeral* port with **no providers configured**
  and asserts five things: `health`, `flock-status`, `auth-fails-closed`,
  `execute-degrades-honestly` (HTTP 200 with `answered_by: "none"`, not a 500 and not a fabricated
  answer), and `mcp-initialize`. It is the cheapest real proof that the Node host works.
- **`npm run e2e:ask`** starts a core, then drives the platform CLI against it over **REST and MCP**
  and compares the two answers. It is the test that would catch the platform's mapper disagreeing
  with a real core.
- **`npm run simorgh -- doctor`** exits **1 on an empty fleet**, with one finding:
  `✗ [no-instances] fleet: No instances recorded in the fleet file.` That is not a broken install.
  `doctor` exits 0 healthy and 1 unhealthy, and an unhealthy fleet is a *finding with a stable code*,
  never a stack trace.

### Run a core

```bash
# foreground, prints its own routes
node simorgh-platform/src/runtimes/node.ts --port 8788

# or through the CLI, which warns when auth is unconfigured
npm run simorgh -- serve --port 8788
```

✅ Both boot. Verified against `node simorgh-platform/src/runtimes/node.ts --port 8788`:
`GET /health` → `200 {"status":"ok",...}`, `GET /api/v1/flock/status` → `200`, an unauthenticated
`POST /api/v1/agent/execute` → `401`, and an authorised `POST /mcp` `initialize` → `200` with
`protocolVersion: 2026-07-28`.

### Supply your own provider keys — as env vars

Nothing here is read from a config file. The Node host reads `process.env` and nothing else
(`simorgh-platform/src/runtimes/node.ts`, `main()` and `cmdServe` in `cli.ts`):

```bash
export SIMORGH_API_KEY="..."           # REQUIRED for the authed routes. Unset ⇒ every one of them
                                       # returns 503 AUTH_NOT_CONFIGURED. It fails closed, not open.
export GROQ_API_KEY="..."              # optional — unlocks Shāhīn (priority 10)
export HF_TOKEN="..."                  # optional — unlocks Bulbul (priority 20)
export OLLAMA_BASE_URL="http://127.0.0.1:11434"   # optional — a local daemon; see below
export OLLAMA_MODEL="llama3.2"                    # optional — defaults to llama3.2
export CORS_ORIGINS="https://your.app"            # optional — unset allows NO browser origin, not all
```

A missing key means **dormant, not broken**. The bird shows as `dormant` in
`/api/v1/flock/status`, is skipped without a cooldown, and is not an error. That is the whole reason a
core can run with zero secrets and still answer honestly.

**There is no Homā on Node.** Homā is Cloudflare Workers AI; a Node process has no such binding. The
Node catalog (`simorgh-platform/src/runtimes/providers.ts`) simply omits it rather than shipping a
pretend provider, and the one keyless option that *does* exist locally — an Ollama daemon — is opt-in
via `OLLAMA_BASE_URL`, because a permanently unreachable provider costs a failed dial plus a cooldown
on every single request.

### ⚠️ The SQLite file is in memory, and the CLI cannot change that

`startNodeRuntime()` defaults to `sqlPath: ":memory:"`. Both `node simorgh-platform/src/runtimes/node.ts`
and `simorgh serve` call it without passing `sqlPath`, and neither exposes a flag for it — `main()`
parses `--port` and nothing else.

So **the ledger, the rate-limit counters, the cooldown table and the quota table all live in memory and
are gone on restart** when you start the core the documented way. The transparency ledger is an
architectural contract (append-only, written before the flight), and on this path it is per-process.

To get a file, call `startNodeRuntime({ sqlPath: "/var/lib/simorgh/core.db" })` from your own entry
point. This is a real gap, not a caveat I am hedging: the `node` target's `supervise` step in
[`targets.ts`](../simorgh-platform/src/targets.ts) says *"the process holds no durable state beyond
its SQLite file"*, which reads as though a file exists. With the shipped entrypoints it does not.
Flagged rather than fixed — see **Provenance**, at the end of this file.

### Point the platform at it

```bash
export NO_PROXY=127.0.0.1,localhost
npm run simorgh -- connect node http://127.0.0.1:8788 --api-key "$SIMORGH_API_KEY"
npm run simorgh -- status      # health + flock of every recorded instance
npm run simorgh -- ask "who is simorgh" --prefer rest
npm run simorgh -- doctor      # exit 0 healthy, 1 unhealthy, stable codes either way
npm run simorgh -- disconnect <id>
```

The fleet is a versioned `fleet.json` (default path under the platform's data dir; `--fleet <path>`
overrides). `ask` reports **every** failure, not just the last — with three cores down for three
different reasons, "connection refused" alone sends you to the wrong one.

---

## B. Cloudflare Workers — the managed edge

The edge is the only target with the **zero-KYC guarantee**: Workers AI is bound in `wrangler.toml`, so
Homā answers with no provider key at all. Everything else about it is optional.

### 1. Authenticate and create the KV namespace — do not skip this

```bash
npx wrangler login
npx wrangler kv namespace create CONTEXT_STORE   # paste the returned id into wrangler.toml
```

**This is the most likely first-deploy failure in the repository, and nothing warns you about it.**
`wrangler.toml` ships:

```toml
[[kv_namespaces]]
binding = "CONTEXT_STORE"
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
```

`wrangler dev` is perfectly happy with the placeholder. ✅ `npx wrangler deploy --dry-run` is *also*
happy with it — verified here, exit 0, and it cheerfully prints
`env.CONTEXT_STORE (REPLACE_WITH_YOUR_KV_NAMESPACE_ID)` in the binding table. Only a real
`wrangler deploy` fails, at the least convenient moment, with an error that does not say which
placeholder it choked on. Edit the `id`, then deploy.

The subcommand name is verified against the installed wrangler (4.146.0): `wrangler kv namespace
create <namespace>` — the older `wrangler kv:namespace create` spelling is gone. ⚠️ Creating the
namespace against a **real** account is the one step in this document I could not execute; there is no
account here.

### 2. Local loop

```bash
npm run dev     # = wrangler dev --local --port 8787
```

✅ Verified: it boots and serves `/health` → `200 {"status":"ok","timestamp":"…"}` and
`/api/v1/flock/status` → `200` **with the KV placeholder still in place**, which is the evidence behind
step 1. It also prints the local-explorer routes, including
`GET /cdn-cgi/local/explorer/api/storage/kv/namespaces` and
`POST /cdn-cgi/local/explorer/api/local/scheduled?worker=<name>` for driving the cron trigger by hand.

For local secrets, put them in `.dev.vars` (gitignored — `scripts/security-scan.sh` fails the gate if
that file is ever *tracked*). Wrangler picks it up automatically; the log line `Using secrets defined
in .dev.vars` confirms it. Nothing in it is ever committed.

### 3. Deploy

```bash
npm run deploy           # = npm run typecheck && wrangler deploy
```

✅ `npm run typecheck` exit 0; ✅ `npx wrangler deploy --dry-run --outdir dist` bundles clean
(149.78 KiB / 41.20 KiB gzip at the time of writing). ⚠️ A real `wrangler deploy` needs an account and
was not run.

### Secrets vs vars

**No secret value is ever committed.** `wrangler secret put` writes to the account, not the repo;
`env.d.ts` declares the *names* only, because `wrangler types` cannot see a secret and
`worker-configuration.d.ts` is generated. The authoritative list is the comment block at the bottom of
[`wrangler.toml`](../wrangler.toml) — re-read it rather than trusting this table, because it moves.

| Name | How to set it | Consequence if absent |
|---|---|---|
| `SIMORGH_API_KEY` | `npx wrangler secret put SIMORGH_API_KEY` | Every bearer-gated route returns **503 `AUTH_NOT_CONFIGURED`**. Fails closed. |
| `GROQ_API_KEY` | `npx wrangler secret put GROQ_API_KEY` | Shāhīn dormant. |
| `HF_TOKEN` | `npx wrangler secret put HF_TOKEN` | Bulbul dormant. |
| `GEMINI_API_KEY` | `npx wrangler secret put GEMINI_API_KEY` | Gemini dormant. |
| `OPENROUTER_API_KEY` | `npx wrangler secret put OPENROUTER_API_KEY` | OpenRouter dormant. |
| `TELEGRAM_BOT_TOKEN` | `npx wrangler secret put TELEGRAM_BOT_TOKEN` | The Telegram webhook route never answers. |
| `TELEGRAM_WEBHOOK_SECRET` | `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` | The webhook rejects every delivery. |
| `CORS_ORIGINS` | a `[vars]` entry, **or** a secret | The one name here the repo documents as **non-secret**. Unset allows **no** browser origin — a secure default, not a gap. |

The credential the *platform CLI* expects, which is different and never reaches the Worker:

```bash
export CLOUDFLARE_API_TOKEN="..."   # Workers Scripts:Edit on the target account
export CLOUDFLARE_ACCOUNT_ID="..."
```

### 4. The deploy gate is deliberate — `--yes` has no escape hatch

```bash
npm run simorgh -- deploy cloudflare-workers --mode manual     # prints the plan, runs nothing
npm run simorgh -- deploy cloudflare-workers --mode cli --dry-run
npm run simorgh -- deploy cloudflare-workers --mode cli --yes
```

✅ Verified, `--mode cli` without `--yes`:

```
Refusing to execute. 2 step(s) would run real commands on this machine.
Re-run with --yes to proceed, or --dry-run to see the calls without running them.
```
exit **2**. There is no env var, no config file, and no "we are in CI so obviously yes". That is the
point: a half-applied deploy is the most expensive state a deployer can leave behind, and a doomed
plan must never start.

Preflight runs *before* the consent prompt and is read-only — required secrets, tools missing from
`PATH`, unresolved `{origin}` placeholders, and a runtime older than `engines.node`. ✅ Verified against
this tree with no Cloudflare credentials present:

```
Blocked by 4 checkers:
  ✗ missing-secret: Required secret CLOUDFLARE_API_TOKEN … is not set
  ✗ unresolved-origin: Step verify contains unresolved {origin} in argv: {origin}/health
    → Provide --origin when building the plan
Preflight blocked — cloudflare-workers/simorgh cannot proceed.
Refusing to deploy: preflight found blockers, and nothing was executed.
```
exit 2. `--skip-preflight` overrides, explicitly and loudly.

### Step 1 installs with `upm`, and it completes

Both the `cloudflare-workers` and the `node` plan render step 1 as:

```
[run] 1. Install workspace dependencies
       $ upm install --frozen-lockfile
```

✅ Verified against the real plan builder, not from the source:

```
$ npm run simorgh -- plan node --origin 127.0.0.1:8788 --mode cli
  [run] 1. Install workspace dependencies
         $ upm install --frozen-lockfile
```

✅ `upm install --frozen-lockfile` run from the repository root exits **0** — `✓ up to date · 93 pkgs ·
1 ws`. `--frozen-lockfile` is what makes a deploy fail loudly rather than silently re-resolving a
dependency tree nobody reviewed, which is the property you want from a step a machine is about to run.

✅ `deploy node --mode cli --dry-run` therefore reaches the end of the plan instead of aborting on
step 1: `deps` and `smoke` are reported `ok (dry run — not executed)`, and the run finishes with
`Deploy finished — node (cli)`.

**This section used to say `--mode cli` could not complete at all.** It could not, and the cause was
a real bug: step 1 still read `npm ci` after [ADR-0004](adr/ADR-0004-toolchain-upm.md) deleted
`package-lock.json`, so every `--mode cli` deploy aborted on step 1 with `npm ci`'s `EUSAGE`. The fix
is landed in [`targets.ts`](../simorgh-platform/src/targets.ts), both targets, with a `manual` text on
the same step so `--mode manual` still tells a human what to run. **You do not need `--mode manual` to
work around an install step any more.**

`npm ci` still exits **1** with `EUSAGE` if *you* type it — there is still no lockfile and there never
will be. That is the ADR working, not a deploy fault; the deploy no longer runs it.

### The Workers Free ceilings that will actually bite

Stated as facts from Cloudflare's own pages, re-read 2026-10-08. Not forecasts — headroom, with the
source attached.

| Ceiling | Workers Free | Where it bites here | Source |
|---|---|---|---|
| **100,000 requests/day**, resetting at 00:00 UTC | Workers | Exceeded → Cloudflare error **1027**, which *fails open* by default: requests bypass the Worker entirely and hit your origin, or a 1027 page. A gateway that silently stops running is worse than one that 429s. | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| **10 ms CPU per HTTP request** | Workers | The tightest number here. A request that runs the agent tool loop, the ledger write and the flock — all synchronous work — plus the Durable Object RPC round-trip is the exact profile Cloudflare describes as "authentication, server-side rendering, or parse large payloads: typically 10–20 ms". Exceeded → error **1102** (`exceededCpu`). Note CPU excludes time waiting on `fetch`/KV/SQL, so the provider call itself does not count. | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| **KV: 1,000 keys written/day**, 100,000 read, 1,000 list, **1 GB stored** | Workers KV | `CONTEXT_STORE` is written once per offloaded execute request. 1,000/day of *execute* traffic, not of total traffic — the dashboard and `/health` are reads. KV is the last-resort flock-status fallback and an offload store, not the ledger; losing it degrades, it does not lose the ledger. All KV Free limits reset at 00:00 UTC and **exceeding one fails that operation with an error** rather than silently dropping it. | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| **Durable Objects: 100,000 requests/day, 13,000 GB-s/day** duration | Workers | Every Durable Object RPC method call is its own billed request — the flock coordinator and the Data Trust vault sit on this. | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| **Durable Objects: 1,000 requests/second, per individual Object, soft** | Durable Objects | Every Object is single-threaded. This is a *per-Object* ceiling, not per-namespace: `FlockCoordinator` and `DataTrustVault` serialise everything they own. Over the limit the platform queues, then returns an "object is overloaded" error to the caller. | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| **Durable Objects SQLite: 5 GB per account** (Free), 100 classes per account | Durable Objects | The ledger, `bird_health`, the rate-limit counters and `quota_state` all live here. Reached → `SQLITE_FULL`; reads and deletes keep working, writes fail. | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| 50 subrequests/request, 128 MB per isolate, 100 Workers per account, 5 cron triggers per account | Workers | Comfortable today. The cron is `15 6 * * *` — one a day, against a Free allowance of 5. | [limits](https://developers.cloudflare.com/workers/platform/limits/) |

⚠️ **One number Cloudflare states two ways.** The per-*Object* SQLite storage ceiling is given as
**10 GB** in the limits table and as **1 GB on the Free plan** in that same page's FAQ and
`SQLITE_FULL` section. The 5 GB *per-account* Free figure above is consistent across both sources, so
it is the one to plan against. Not reconciled here; noted so a deployer does not discover it by
overflowing.

**What none of these say:** that a real Simorgh deployment on the Free plan has been measured against
any of them. Every figure above is from the vendor's documentation. No load test exists in this
repository, and the `1102` risk from the 10 ms CPU ceiling is a reading of the architecture, not an
observed failure.

---

## C. Self-hosted / VPS / private repo

### Blunt, first: there is no container image

✅ Verified — `find` over the whole tree returns **zero** `Dockerfile`, `*.dockerfile` or
`docker-compose*` files. There is no image, no compose stack, no healthcheck, no `.dockerignore`, and
no CI job that builds one. **The Docker path does not exist in this repository today.** Nothing below
invents one.

What *does* exist is the self-hosted core itself, and it is real:

**[`simorgh-platform/src/runtimes/node.ts`](../simorgh-platform/src/runtimes/node.ts)** — a complete
`phoenix-core` on Node, in one file, with no Cloudflare in it. A `node:http` server, `node:sqlite` for
persistence, `process.env` for secrets, an hourly `setInterval` stale-health sweep mirroring the edge
cron, and `SIGINT`/`SIGTERM` handlers that close the server and the database before exiting 0.

The file says why it exists, and the reason is the whole portability argument: *"This is what makes the
`node` target real rather than a promise, and it is the second implementation that proves phoenix-core
is actually portable — if the engine had a Workers dependency, this file could not exist."*

It runs **unbuilt**. Node strips the types and every relative import in the workspace carries an
explicit `.ts` extension, so there is no build step between the repo and a running core.

### Run it

```bash
# Node 22.3+ and upm, same as everywhere else
upm install
export NO_PROXY=127.0.0.1,localhost

# prove the runtime boots and answers before you supervise anything
npm run platform:smoke      # ✅ 5/5, exit 0 — ephemeral port, no providers, no keys needed

# run it for real
node simorgh-platform/src/runtimes/node.ts --port 8788     # ✅ boots, answers /health 200
```

`platform:smoke` is not ceremony: it is the `smoke` step of the `node` target's deploy plan, and it is
bounded by construction — ephemeral port so it never collides with a core already running, no providers,
no waiting, always terminates. A step that started a server in the foreground would hang
`simorgh deploy --cli` forever, and a step that merely printed instructions would not be a check.

### Supervise it

The `node` target's own guidance (`simorgh deploy node --mode manual`, step `supervise`): run
`node simorgh-platform/src/runtimes/node.ts --port 8788` under systemd with `Restart=always`, pm2, or
your platform's supervisor. ⚠️ **The repository ships no unit file, no service template and no process
manager config.** Writing one is left to you; there is nothing here to verify against.

Behind a reverse proxy, expose it over HTTPS and set `CORS_ORIGINS` to the browser origin. Bearer auth
is unchanged — `SIMORGH_API_KEY`, failing closed with 503 when unset. For the routes it *does* serve,
nothing about the wire contract changes: same error shapes, same request ids, same flock-status payload,
same ledger, on purpose, so a client cannot tell which target it is talking to. It serves fewer routes
than the edge — see the table under **What is genuinely portable** below.

### Before you containerise it, you will hit the in-memory SQLite again

⚠️ Covered in **§A** and it is the same problem here:
`sqlPath` defaults to `:memory:` and neither shipped entrypoint exposes it. **Your ledger is
per-process.** If the deployment needs a durable ledger, an entrypoint that calls
`startNodeRuntime({ sqlPath: … })` is the first thing to write — and that, not the Docker packaging,
is the harder half.

For reference, a correct image would need Node 22.3+, `upm install --frozen-lockfile`, the repo tree
with `phoenix-core/` present, and a writable path for the SQLite file. I have not built one and am not
going to describe steps I did not run.

---

## What is genuinely portable, and what is not

This is the part worth reading before you bet on the engine.

### The engine: runtime-agnostic, and machine-enforced

[`phoenix-core/test/boundary.test.ts`](../phoenix-core/test/boundary.test.ts) is five assertions over
every `.ts` file in `phoenix-core/src`, and it is part of the Node suite (✅ green in the 22-file run
above). Read the file: it asserts

1. there are sources to check (≥ 8 — a guard that silently scans nothing is worse than no guard);
2. **no `cloudflare:` import** anywhere in the engine;
3. **no `node:` import** outside `src/node/`, the one declared adapter, guarded by an `isNodeAdapter`
   path check;
4. **no bare runtime globals** — `new TextEncoder` / `TextDecoder` / `Response` / `Request`, a bare
   `crypto.`, `DurableObject`, `SqlStorage` — after comment-stripping, because checking prose for code
   is exactly how a guard gets deleted instead of fixed;
5. **every port declared in `ports.ts` and nowhere else**, because a port defined twice is two ports
   and the Node adapter and the Workers host drift silently.

The asymmetry is the detector. `test:workers` runs inside workerd with real Durable Objects, KV and
SQLite. `test:node` runs the engine with no runtime bindings at all. **If the engine ever picks up a
binding, the Node suite stops resolving and goes red while the workerd suite keeps passing.** A change
that passes only one suite has been tested on one runtime.

### The narrow truth about the portability claim

`SqlPort.exec()` returns a **cursor, synchronously**, and `toArray()` reads it synchronously — no
promise anywhere in the interface. So the honest statement is narrower than "runs anywhere":

> `phoenix-core` is portable across **runtimes that can supply a synchronous SQL implementation** —
> not across hosts in general.

Every networked database is async, so none of them can implement `SqlPort` as it stands. That is a
finding, not a gap someone forgot: it is written up in
[`HOST-PORTABILITY.md`](HOST-PORTABILITY.md) §4 and
[ADR-0002](adr/ADR-0002-sqlport-async-before-networked-host.md). `bun:sqlite` satisfied `SqlPort`
unchanged, which proved the engine is not Node-shaped — and that host was then removed by owner
decision, which is why **Node is the only second runtime that exists today.** Deno 2 is untested.

### The host: where the bindings live — and where the surface stops being portable

The engine is the same on both hosts. **The route surface is not.** Measured by reading the two route
registries:

| Route | Workers host | Node host |
|---|---|---|
| `GET /health`, `GET /api/v1/flock/status`, `POST /api/v1/agent/execute` | ✅ | ✅ |
| `GET /api/v1/user/:id/logs`, `GET /api/v1/context/:refId` | ✅ | ✅ |
| `POST /mcp` | ❌ **absent** | ✅ |
| `GET /dashboard` | ✅ | ❌ |
| `GET /api/v1/quota` | ✅ | ❌ |
| `GET`+`POST /api/v1/schedule` | ✅ | ❌ |
| `GET /api/v1/platform/connectors` | ✅ | ❌ |
| `POST /api/v1/telegram/webhook` | ✅ | ❌ |

✅ Verified by grepping `src/*.ts` for every `.get(`/`.post(` registration — 12 routes on the Workers
side, 7 on the Node side — and by reading the Node runtime's handler. **The Workers host serves no `/mcp` at all** — `mcp` appears in
`src/` only inside dashboard prose. That has a direct consequence for a deployer:
`simorgh connect <core> --connector mcp` works against a Node core and will fail against a deployed
Worker. Prefer `--connector rest` for anything on the edge. It also means `AGENTS.md`'s "a core
answers … `/health`, `/api/v1/flock/status`, `/api/v1/agent/execute`, `/api/v1/user/{id}/logs`,
`/mcp`" describes the Node host's surface, not the edge's.

Other host-owned differences, all deliberate and all documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §2:

- **Secrets** — `wrangler secret` on Workers, `process.env` on Node.
- **SQL** — Durable Object `SqlStorage` on Workers, `node:sqlite` `DatabaseSync` on Node. The two
  dialects differ (`node:sqlite` splits reads and writes, Cloudflare fuses them into one `exec`); that
  bridge is the single place `RETURNS_ROWS` sniff lives, in the adapter, and it is why a *third* host is
  the cheap test of the whole claim.
- **Context offload** — KV on Workers, `memoryContextStore` (an honest `Map`) on Node. On Node a
  context reference does not survive a restart, so `GET /api/v1/context/:refId` can 404 a ref the
  same client was handed seconds earlier. A wrong answer is worse than a slow one; the engine's own
  comment says a host wanting durability should pass its own port.
- **Flock membership** — Homā exists only on Workers. Node's catalog omits it rather than faking it.
- **The staleness sweep** — a cron trigger on Workers, an hourly `setInterval` on Node.

### What I could not verify about portability

- **No third runtime.** The boundary test proves the engine *contains* no runtime binding. It does not
  prove the engine *runs* somewhere new. Only workerd and Node have actually executed it.
- **No load or scale test on either host**, so the Free-plan ceilings in **§B** are documentation, not
  measurement.
- **The Go gateway cannot join the fleet.** `gateway/` is a real second answering runtime with an
  OpenAI-compatible SSE endpoint and encrypted secrets at rest, but it exposes **none** of the core
  contract the platform dials. See [`STATE-OF-PROJECT.md`](STATE-OF-PROJECT.md) §4.2 and
  [ADR-0001](adr/ADR-0001-go-workspace-role.md). Do not point `simorgh connect` at it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED` / `TypeError: fetch failed` against `127.0.0.1` while the core is visibly running | A global proxy env var is intercepting localhost | `export NO_PROXY=127.0.0.1,localhost` **before** the command, not after |
| `inconsistent vendoring in <dir>` from any `go build` | `~/.config/go/env` holds `GOFLAGS=-mod=vendor`, written by an unrelated project. Misleading: no `vendor/` exists | `GOFLAGS=-mod=readonly go build all`, or use the wrappers (`npm run go:build` / `go:vet` / `go:test`, which already set it). **Do not delete that file** — other projects on this box want it |
| `npm ci` → `EUSAGE: can only install with an existing package-lock.json` | You typed it. The deploy plan does **not** — step 1 is `upm install --frozen-lockfile` | `upm install --frozen-lockfile`. There is no lockfile by design and there will not be one ([ADR-0004](adr/ADR-0004-toolchain-upm.md)) |
| A `package-lock.json` reappeared in your working tree | A tool regenerated it | Delete it. It is gitignored on purpose — a second lockfile is a second resolution of the manifest, with nothing comparing the two. [ADR-0004](adr/ADR-0004-toolchain-upm.md) |
| A real `wrangler deploy` fails while `wrangler dev` and `--dry-run` are both fine | The KV placeholder is still in `wrangler.toml` | `npx wrangler kv namespace create CONTEXT_STORE`, paste the id into `id = …`. Nothing warns you |
| `Refusing to execute. N step(s) would run real commands on this machine.` exit 2 | `deploy --mode cli` without `--yes` | Intentional. Add `--yes`, or `--dry-run` to see the calls without running them. There is no exemption path, and adding one would delete the feature |
| `Preflight blocked — … cannot proceed.` exit 2 | Missing required secret, or an unresolved `{origin}` | Read the checker output; each line carries its own fix. `--skip-preflight` overrides, loudly |
| `✗ [no-instances] fleet: No instances recorded` and `doctor` exits 1 | An empty fleet is a finding, not a crash | `npm run simorgh -- connect node http://127.0.0.1:8788 --api-key "$SIMORGH_API_KEY"` |
| Every bearer-gated route returns `503 AUTH_NOT_CONFIGURED` | `SIMORGH_API_KEY` unset | Set it. **This is the fail-closed design working** — not a bug to route around |
| A bird shows `dormant` and is skipped | Its key is absent | Expected. `dormant` is not an error and earns no cooldown |
| `GET /api/v1/context/:refId` returns `404` for a ref you were just handed | On Node the context store is an in-memory `Map` | Restart the process; it does not survive. Same fix as the in-memory SQLite note |
| A test run fails at *collection* | A hard stop, not a normal failure | Report the file and the error. Never re-run hoping — a collection error means the module cannot load |
| `✗ runtime-unsupported: Node runtime <v> does not satisfy the required range <range>` | The running Node is outside the range in `package.json`'s `engines.node` (`>=22.3`) | Install a Node inside the range, or correct `engines.node`. A range the preflight cannot parse blocks as `runtime-version-unverifiable` rather than passing — it fails closed |
| `✗ runtime-version-unverifiable: Cannot verify Node <v> against engines.node …` | `engines.node` uses a range form preflight does not implement (`^`, `~`, `x` wildcards, hyphen ranges) | Rewrite it in the supported subset, e.g. `">=22.3"`. A gate that cannot parse its own requirement must not approve the runtime |

---

## Provenance

Everything marked ✅ was executed in this repository on 2026-10-08 and the exit code recorded:

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 (3 configs) |
| `npm test` | exit 0 — workers **14 files / 129 tests**, node **22 files / 368 tests** |
| `npm run platform:smoke` | 5/5, exit 0 |
| `npm run e2e:ask` | 10/10, exit 0 |
| `npm run simorgh -- targets` | 3 targets listed, exit 0 |
| `npm run simorgh -- doctor` | exit 1, one finding: `no-instances` |
| `npm run simorgh -- plan cloudflare-workers --mode manual` | 5 steps, 3 missing required secrets |
| `npm run simorgh -- deploy cloudflare-workers --mode cli --dry-run` | 4 preflight blockers, exit 2, nothing executed |
| `npm run simorgh -- deploy node --mode cli --origin … --skip-preflight` | consent gate, exit 2, nothing executed |
| `npx wrangler --version` / `wrangler kv namespace --help` | 4.146.0; `wrangler kv namespace create <namespace>` |
| `npx wrangler deploy --dry-run --outdir …` | exit 0, placeholder printed verbatim |
| `npm run dev` | boots; `/health` 200, `/api/v1/flock/status` 200, KV placeholder present |
| `node simorgh-platform/src/runtimes/node.ts --port 8788` | boots; `/health` 200, flock 200, unauth execute 401, MCP `initialize` 200 |
| `npm ci` | exit 1, `EUSAGE` — no lockfile exists. Confirms the ADR-0004 position only; the deploy plan no longer runs `npm ci`, so it no longer confirms anything about the plan |
| `upm install --frozen-lockfile` | exit 0 — `✓ up to date · 93 pkgs · 1 ws`; this is what deploy step 1 now runs |
| `npm run simorgh -- deploy node --mode cli --origin … --dry-run` | reaches `Deploy finished`; both runnable steps reported `ok (dry run)` |
| `find` for `Dockerfile*` / `docker-compose*` | zero matches |
| Workers + KV + DO Free limits | read from Cloudflare's own pages, 2026-10-08 |

⚠️ **Not executed, and therefore not claimed:** anything requiring a Cloudflare account
(`wrangler login`, `kv namespace create` against a real account, `wrangler secret put`,
`wrangler deploy`), `npm run security:scan` (needs network for its throwaway audit tree), the Go
workspace (not part of any deploy path), and any container build.

### Things this document found that other documents get wrong

Items 2 and 6 were inside this pass's allowlist and are fixed in place; they are kept here, struck
through, because a fixed finding that simply vanishes teaches nobody that it was ever real. The rest
are recorded rather than edited, because those files are outside this pass's allowlist.

1. **`STATE-OF-PROJECT.md` §3.1 suite counts are stale.** It records workerd 11 files / 93 tests and
   Node 19 files / 261 tests. The suites print **14/129** and **22/368**. That file's own instruction —
   *"if a number you find there disagrees with what the suite actually prints, the suite is right and the
   doc is stale"* — resolves it.
2. ~~**`targets.ts` still deploys with `npm ci`**~~ — **RESOLVED.** Both plans' step 1 now reads
   `upm install --frozen-lockfile`, verified against the real plan builder and by running the command
   (exit 0). A `--mode cli` deploy clears step 1 and reaches the end of the plan; see **§B** for the
   rendered output and the `--dry-run` result.
3. **`targets.ts`' `supervise` step says the Node process "holds no durable state beyond its SQLite
   file"**, which implies a file exists. With both shipped entrypoints it does not — `sqlPath` defaults
   to `:memory:` and no flag exposes it. The transparency ledger is per-process on the Node host.
4. **The Workers host serves no `/mcp` route**, while `AGENTS.md` lists `/mcp` in the core contract and
   the dashboard itself (`src/dashboard.ts:316`) says *"a core speaks MCP at `/mcp`"*. True of the Node
   host; false of the
   edge. `simorgh connect … --connector mcp` against a deployed Worker will fail.
5. **`CONTRIBUTING.md`'s Prerequisite table says `engines.node` is `">=20"`.** `package.json` says
   `">=22.3"`. The document itself flags it as a proposed change it did not make — and by now the
   manifest has moved, so the note is doubly stale.
6. ~~**`README.md`'s Flock table lists three birds**~~ — **RESOLVED.** The table now lists all five
   (`src/flock.ts`: Shāhīn 10, Gemini 15, Bulbul 20, OpenRouter 25, Homā 30), and Quick Start names
   `GEMINI_API_KEY` and `OPENROUTER_API_KEY` beside the two it already listed.