# Architecture — phoenix-core / simorgh-platform

## 1. The two packages and the one-way arrow

| Package | Path | Role |
|---------|------|------|
| `@simorgh/phoenix-core` | `phoenix-core/` | Runtime-agnostic engine: provider routing, agent tool loop, request validation, rate limiting, ledger. Owns no runtime bindings. |
| `simorgh-platform` | `simorgh-platform/` | Control plane: deployment targets, connectors, fleet management, the Node host runtime, and the Workers entry point. Imports the engine. |

**The rule is absolute: the platform imports `@simorgh/phoenix-core`; `phoenix-core` imports nothing from `simorgh-platform`.** This is not a convention — it is enforced by `phoenix-core/test/boundary.test.ts`, which fails the build if `phoenix-core/src/` contains a `cloudflare:` or `node:` import (except the one deliberate adapter at `phoenix-core/src/node/`), or reaches for runtime globals (`Response`, `Request`, `crypto.`, `DurableObject`, `SqlStorage`). The engine is portable because it has no opinions about where it runs; the platform has opinions about everything else.

`phoenix-core` remains usable on its own. A host that only ever wants the engine on one runtime never needs `simorgh-platform`.

### 1.1 What each package actually ships

Every file below exists and is in the build. This is the map to reach for before searching.

**`phoenix-core`** — the engine. No runtime bindings:

| File | Owns |
|------|------|
| `ports.ts` | The seven ports. The only place any of them is declared. |
| `provider.ts` | The `Provider` contract plus factories (`openAiCompatibleProvider`, `workersAiProvider`) |
| `flock.ts` | `flyFlock()`: priority routing, dormant skip, cooldowns, fail-through, exhaustion, and `describeFlock()` status assembly |
| `agent.ts` | The agent loop: registry, argument extraction, per-tool failure capture, truncation, the synthesis prompt, the iteration budget |
| `tools.ts` | `createToolExecutor()` — what each allow-listed tool *does* (the request, the parsing, the failure text) |
| `execute.ts` | The whole request pipeline and its ordering: agent loop → context offload → ledger write → flight |
| `security.ts` | Bearer auth, constant-time compare, `parseExecuteBody()` validation, CORS allow-list |
| `rate-limit.ts` | The per-user SQL counter |
| `health.ts` | `bird_health` upsert, cooldown reads, the stale sweep |
| `ledger.ts` | `createLedger()` / `LEDGER_SCHEMA` — the transparency ledger, on any `SqlPort` |
| `models.ts` | The model catalog |
| `node/index.ts` | The Node adapter (`node:sqlite`, `node:crypto`). The package's only `node:` import. |

**`simorgh-platform`** — the control plane:

| File | Owns |
|------|------|
| `targets.ts` | Where a core can live, and what deploying there involves (3 real targets) |
| `deploy/plan.ts` | `buildDeployPlan()` — one plan, two renderings (manual / cli) |
| `deploy/preflight.ts` | The read-only gate run *before* the consent prompt |
| `deploy/runner.ts`, `deploy/apply.ts` | Step execution and the `--yes` consent gate |
| `connectors/types.ts` | `CoreConnector` — the interface both ways of reaching a core satisfy |
| `connectors/rest.ts`, `connectors/mcp.ts` | The two connectors. MCP is session-oriented (`Mcp-Session-Id`). |
| `connectors/conformance.ts` | `runConnectorConformance()` — the assertions **every** connector must satisfy |
| `fleet.ts` / `fleet-store.ts` | The fleet, its failover, and the versioned `fleet.json` file |
| `mcp/server.ts` | The platform **as** an MCP server (`platform_targets` / `platform_fleet` / `platform_ask`) |
| `runtimes/node.ts` | A complete phoenix-core on Node, runnable unbuilt |
| `runtimes/providers.ts`, `runtimes/smoke.ts` | The Node provider catalog, and the boot-probe the `node` target's deploy step runs |
| `cli.ts` | The `simorgh` command itself |

**Root `src/`** — the Cloudflare host: `index.ts` (Hono routes), `flock.ts` (provider catalog + the `FlockCoordinator` DO), `data-trust.ts` (the `DataTrustVault` DO), `agent-service.ts` (the request pipeline bound to `Env`), `telegram.ts`, and the host adapters (`health.ts`, `rate-limit.ts`, `models.ts`, `agent.ts`, `security.ts`) that delegate to the engine.

---

## 2. Host / engine split

| The core owns | The host owns |
|--------------|--------------|
| `flyFlock()` routing: priority order, dormant skip, cooldowns, fall-through, exhaustion (`phoenix-core/src/flock.ts`) | Which providers exist and how they are constructed (`simorgh-platform/src/runtimes/providers.ts` for Node; inline in the Workers host) |
| Agent tool loop: registry, `runAgentLoop()`, synthesis prompt, per-tool failure capture (`phoenix-core/src/agent.ts`) | Where secrets come from — `wrangler secret` on Workers, `process.env` on Node |
| `parseExecuteBody()` validation: body size, prompt, tools, user ID, tier (`phoenix-core/src/security.ts`) | How SQL is reached — Durable Object `SqlStorage` on Workers, `node:sqlite` on Node |
| Bearer authentication, constant-time SHA-256 comparison (`phoenix-core/src/security.ts`) | How the result is transported — Hono routes + HTTP on Workers, `node:http` server on Node |
| Rate-limit counter in SQL (`phoenix-core/src/rate-limit.ts`) | Provider-specific adapters and model registries |
| Flock status payload shape (`phoenix-core/src/flock.ts`: `FlockStatus`, `ProviderStatus`) | The Workers entry point, Durable Object shell, cron trigger (`simorgh-platform/src/index.ts`) |
| Ledger shape *and* implementation (`phoenix-core/src/ports.ts`: `LedgerEntry`, `LedgerRow`, `LedgerPort`; `phoenix-core/src/ledger.ts`: `createLedger()`, `LEDGER_SCHEMA`) | Durable Object identity, KV namespace, which `SqlPort` the ledger is bound to |
| What each tool *does* (`phoenix-core/src/tools.ts`: `createToolExecutor()` — the request, the parsing, the failure text) | How a tool reaches out: the `fetch` port, the clock, and any endpoint override |
| The request pipeline's **ordering** — agent loop → context offload → ledger write → flight (`phoenix-core/src/execute.ts`) | Whether it flies the providers itself or supplies `fly` (see `FlightDeps`) — see §2.1 |
| `RequestValidationError` and all request validation logic (`phoenix-core/src/security.ts`) | Secrets, KV namespace |

### 2.1 `FlightDeps` — why the pipeline takes a union

`executeAgent()` accepts one of two mutually exclusive shapes:

| Shape | Host supplies | Used by |
|-------|---------------|---------|
| Raw ingredients | `providers`, `cooldownUntil`, `record` | The Node host (`simorgh-platform/src/runtimes/node.ts`), the engine's own tests |
| `fly` | `fly(prompt, tools) => Promise<FlockRunResult>` | The Cloudflare host (`src/agent-service.ts`) |

The second form is not symmetry — it is a hard constraint. On Workers the cooldown and observation writes live in Durable Object SQLite, reachable only over RPC, and **a closure cannot cross that boundary**. Without this seam the Workers host had to re-implement the pipeline's ordering, which meant the Data Trust contract held in one deployment and was merely *assumed* in the other. With it, the order lives in `execute.ts` once and the host supplies only the part it owns.

The type is a union rather than two optional fields so a host cannot pass both and leave a reader guessing which won.

---

## 3. Port table

Every capability the engine needs arrives through an interface declared in `phoenix-core/src/ports.ts`. No host binds a global; every capability is injected.

| Port | Defined in | What it abstracts | Workers host supplies from | Node host supplies from |
|------|-----------|-------------------|---------------------------|------------------------|
| `SqlPort` | `phoenix-core/src/ports.ts` | A SQL database with `exec(query, ...bindings)` returning a cursor | `SqlStorage` (Durable Object) at `simorgh-platform/src/index.ts` | `nodeSqlPort()` wraps `node:sqlite` `DatabaseSync` at `phoenix-core/src/node/index.ts` |
| `FetchLike` | `phoenix-core/src/ports.ts` | Outbound HTTP: `(url, init?) => Promise<HttpLike>` | `globalThis.fetch` at `simorgh-platform/src/index.ts` | `fetch` via `createNodePorts()` at `phoenix-core/src/node/index.ts` |
| `HttpLike` | `phoenix-core/src/ports.ts` | Inbound response: `{ ok, status, json(), headers? }` | Cloudflare `Response` (structural) | Node `Response` (structural, from `fetch`) |
| `PhoenixPorts` | `phoenix-core/src/ports.ts` | All engine capabilities: `fetch`, `sha256`, `randomUUID()`, `now()` | Constructed at `simorgh-platform/src/index.ts` from runtime globals | `createNodePorts()` at `phoenix-core/src/node/index.ts` |
| `ContextStorePort` | `phoenix-core/src/ports.ts` | Key/value offload with TTL: `put(key, value, {expirationTtl})`, `get(key)` | KV namespace at `simorgh-platform/src/index.ts` | `memoryContextStore()` at `phoenix-core/src/node/index.ts` |
| `LedgerPort` | `phoenix-core/src/ports.ts` | Transparency ledger: `logEntry()`, `getUserLogs()` | The `DataTrustVault` Durable Object at `simorgh-platform/src/data-trust.ts`, bound to storage via `createLedger(this.ctx.storage.sql)` | `createLedger(sql)` at `phoenix-core/src/ledger.ts`, re-exported as `sqlLedger` from the `/node` subpath |
| `WorkersAiPort` | `phoenix-core/src/ports.ts` | Cloudflare Workers AI: `run(model, input)` | Workers AI binding at `simorgh-platform/src/index.ts` | Not supplied — Node host omits it; providers needing it report themselves unavailable |

The Node adapter lives at `phoenix-core/src/node/index.ts` and is exposed as the subpath export `@simorgh/phoenix-core/node` (see `phoenix-core/package.json` `exports`). It is the **only** place in `phoenix-core` that names a `node:` module.

### 3.1 What belongs in the main barrel, and what does not

The test for "does this need a subpath?" is *does it name a runtime*, not *does the Node host use it*.

The ledger (`phoenix-core/src/ledger.ts`) and the tool executor (`phoenix-core/src/tools.ts`) are both in the **main barrel**, because neither names a runtime: the ledger needs only a `SqlPort`, and the executor needs only a `FetchLike` plus a clock. Both are reached through ports that every host already satisfies.

The ledger was originally inside `src/node/index.ts`, and that was a real bug rather than a stylistic one: a Worker must not import `node:sqlite`, so the `/node` subpath was unreachable from the Cloudflare host, so `src/data-trust.ts` kept its **own copy** of the same `CREATE TABLE`, the same INSERT, and the same SELECT. Two definitions, nothing comparing them. `phoenix-core/test/ledger.test.ts` now asserts `sqlLedger === createLedger`, so a re-export that silently becomes a copy fails the suite.

Only `node:sqlite`, `node:crypto`, and the in-memory context store stay behind `/node`, because only they cannot run anywhere else.

---

## 4. Target × connector matrix

From `simorgh-platform/src/targets.ts` (`listTargets()` / `getTarget(id)`):

| Target id | Runtime | Connectors | Modes | Required secrets |
|-----------|---------|------------|-------|-----------------|
| `cloudflare-workers` | `workerd` | `rest`, `mcp` | `manual`, `cli` | `CLOUDFLARE_API_TOKEN` (required), `CLOUDFLARE_ACCOUNT_ID` (required), `SIMORGH_API_KEY` (required), `GROQ_API_KEY` (optional), `HF_TOKEN` (optional), `CORS_ORIGINS` (optional) |
| `node` | `node` | `rest`, `mcp` | `manual`, `cli` | `SIMORGH_API_KEY` (required), `GROQ_API_KEY` (optional), `HF_TOKEN` (optional) |
| `byo-endpoint` | `unknown` | `rest`, `mcp` | `manual` | `SIMORGH_API_KEY` (optional) |

Each target also carries a `steps` list (deploy steps, mix of `run` and `manual`) and an `endpoint` template (`https://{service}.workers.dev`, `http://{origin}`, `{origin}`). Adding a target means registering it in `simorgh-platform/src/targets.ts` via `EXTENSION_POINT`: ship its runtime entrypoint, then append a `DeploymentTarget` whose step list actually completes.

---

## 5. Invariant list

Every change must not break these rules. Each is asserted where noted.

1. **No `cloudflare:` import inside `phoenix-core/src/`** — caught by `phoenix-core/test/boundary.test.ts` ("imports no Cloudflare runtime unit"). Reason: a `cloudflare:workers` import would bind the engine to Workers and kill portability. The one exception is `phoenix-core/src/node/`, which is a deliberate adapter and is allowed by the test's `isNodeAdapter` guard.
2. **No `node:` import outside `phoenix-core/src/node/`** — caught by `phoenix-core/test/boundary.test.ts` ("confines `node:` imports to the deliberate host adapter"). Reason: `node:` modules are Node-only; the engine must not pull them into a Workers bundle. `phoenix-core/src/node/index.ts` is the single deliberate exception.
3. **No bare runtime globals in the core** — caught by `phoenix-core/test/boundary.test.ts` ("does not reach for runtime globals instead of its ports"). Forbidden: `TextEncoder`, `TextDecoder`, `Response`, `Request`, `crypto.`, `DurableObject`, `SqlStorage`. Reason: these are declared by whichever runtime's type library is loaded — the exact coupling the ports exist to prevent. `TextEncoder` is the one that actually bit us.
4. **Each port is declared exactly once, in `ports.ts`** — caught by `phoenix-core/test/boundary.test.ts` ("declares every port it needs in ports.ts and nowhere else"). Checks that `SqlPort`, `PhoenixPorts`, `ContextStorePort`, `LedgerPort`, `WorkersAiPort` interfaces are defined only in `ports.ts`. Reason: a port defined twice is two ports, and the Node adapter and Workers host silently drift.
5. **Relative imports carry an explicit `.ts` extension** — Reason: plain `node` must execute the sources unbuilt. Node strips types natively but resolves files literally, so an extensionless specifier fails with `ERR_MODULE_NOT_FOUND`. The bundlers (esbuild via wrangler, vite via test pools) accept the extension too. Confirmed in both `phoenix-core/tsconfig.json` and `simorgh-platform/tsconfig.json` comments.
6. **No TypeScript-only runtime syntax** — no parameter properties, no `enum`, no `namespace` — because Node's type stripping refuses them (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). This bit `RequestValidationError`: the class at `phoenix-core/src/security.ts` uses `readonly` fields assigned in the constructor rather than parameter properties, which is why it survives stripping. If it had used `constructor(private status: ...)` syntax, it would break at runtime on plain Node.
7. **The `birdId` / `birds` / `answered_by` field names are a published API contract and stay** — even though the engine's internal vocabulary is "provider" (`phoenix-core/src/flock.ts` uses `providerId`, `byPriority()`, `ProviderStatus`). The wire fields come from `FlockAttempt.birdId`, `FlockStatus.birds`, and `FlockMeta.answered_by`. Reason: `/api/v1/flock/status` is documented in `README.md` and a dashboard reads it. Renaming wire fields is a breaking API change with no bearing on modularization. The bridge is `toAskResult()` in `simorgh-platform/src/connectors/types.ts`, which maps `birdId` → `providerId` at the seam.

---

## 6. How-to recipes

### Adding a provider

1. Create a factory returning a `Provider` (interface: `phoenix-core/src/provider.ts`). At minimum: `id`, `name`, `provider`, `model`, `priority`, `call(prompt, ctx)`. Optionally `requires` for secret-gated dormancy.
2. Add it to the host's provider catalog — Node: `simorgh-platform/src/runtimes/providers.ts` (uses `defaultProviders()`). Workers: inline in the host entry (`simorgh-platform/src/index.ts`).
3. If the provider needs a secret, add it to the relevant target's `secrets` in `simorgh-platform/src/targets.ts` and to the deploy step's `needs`.

### Adding a deployment target

1. Ship the runtime entrypoint (a runnable script or a Dockerfile).
2. Append a `DeploymentTarget` object to `TARGETS` in `simorgh-platform/src/targets.ts`, following the shape of `CLOUDFLARE_WORKERS` or `NODE`.
3. Write a `steps` list that actually completes — every step with a `run` field must be runnable in CI; steps without it are manual and need `manual` instructions.
4. The seam is marked by `EXTENSION_POINT` at the bottom of `simorgh-platform/src/targets.ts`: "To add a target: ship its runtime entrypoint, then append a DeploymentTarget with a step list that actually completes. A target whose steps cannot run is worse than none."

### Adding a host

1. The engine must stay clean — `phoenix-core/test/boundary.test.ts` will refuse any `cloudflare:` import, any `node:` import outside `phoenix-core/src/node/`, and any use of bare runtime globals.
2. Add a new subpath export in `phoenix-core/package.json` (the pattern maps `"./node"` to `phoenix-core/src/node/index.ts`) for the adapter if the new host needs one.
3. Implement each port as a host-side function (see `phoenix-core/src/node/index.ts` for the pattern: `nodeSqlPort`, `createNodePorts`, `memoryContextStore`). Ports whose only dependency is another port — `createLedger()` (`ledger.ts`), `createToolExecutor()` (`tools.ts`) — already exist in the main barrel; reuse them rather than writing a host-local version.
4. Wire ports into the host's request pipeline — see `simorgh-platform/src/runtimes/node.ts` for the complete reference (it runs the engine on Node with real SQLite).

---

## 7. Where to run things

Two test suites, deliberately separate.

| Command | Config | What runs | What it catches | What it cannot catch |
|---------|--------|-----------|-----------------|----------------------|
| `npm run test:workers` | `vitest.config.ts` (via `npm test` → `test:workers` → `vitest run`) | `simorgh-platform/test/**/*.test.ts` — the Workers app suite, 6 files | Runtime behavior of the app in workerd: Durable Object RPC, KV reads/writes, cron handler shape, HTTP route contracts, the full request path through Hono. Uses real `cloudflare:workers` bindings from `wrangler.toml`. | Nothing about the engine in isolation — the Workers tests import the app, not the core directly. |
| `npm run test:node` | `vitest.node.config.ts` (via `npm test` → `test:node` → `vitest run --config vitest.node.config.ts`) | `phoenix-core/test/**/*.test.ts` + `simorgh-platform/test/**/*.test.ts` (engine + platform unit suites) | Engine correctness in isolation: `flyFlock` routing, agent tool loop, request validation, SQL via `SqlPort` (real SQLite in-memory), rate limiting, boundary invariants. No runtime, no network, no Cloudflare account. | Nothing about the Workers runtime — no `cloudflare:workers` resolution, no Durable Objects, no KV, no AI binding. |

Why separate? `simorgh-platform/test/` imports `cloudflare:workers` (DurableObject) and uses `@cloudflare/vitest-pool-workers` with `remoteBindings: false`. The engine tests must run on plain Node to prove portability — if the engine ever picks up a `cloudflare:` import or a global binding, the Node suite stops resolving and goes red, while the workers suite keeps passing. That signal is the point. `npm test` runs both, in order; the workers suite runs first (it is listed first in `package.json`).

Both suites share `phoenix-core/test/boundary.test.ts`, which runs under the Node config and asserts every portability invariant in section 5.
