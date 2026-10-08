---
name: simorgh-architecture
description: The simorgh module split — phoenix-core's ports and boundary, the executeAgent union seam, the flock routing policy, and the recipes for adding a provider, a host, or a platform target. Use when touching the engine/platform boundary, adding a runtime or provider, changing routing or failover, or when a change needs a port that does not exist yet.
---

# Simorgh architecture

Load this before changing anything that crosses the engine boundary, and before adding a runtime.

## The shape, and why it is one-way

```
simorgh-platform  ──imports──▶  @simorgh/phoenix-core  ──imports──▶  nothing
(control plane)                 (runtime-agnostic engine)
```

Three hosts implement the same engine: the Cloudflare Worker (root `src/`), the self-hosted Node
runtime (`simorgh-platform/src/runtimes/node.ts`), and — not yet converged — the Go gateway.

The engine is portable **because it cannot drift**: `phoenix-core/test/boundary.test.ts` fails the build
on a `cloudflare:` import, any `node:` import outside `phoenix-core/src/node/`, or a bare runtime global
(`Response`, `crypto.`, `SqlStorage`). It fails on a **collection** error, which is why a boundary
failure looks like a hard stop rather than a normal test failure. `vitest.node.config.ts` is the other
half of the detector: it runs the engine with no runtime bindings at all.

## Ports, not imports

Every capability the engine needs is an injected port (`phoenix-core/src/ports.ts`): SQL, fetch, time,
UUID, the context store. `FetchLike` exists specifically so a test never reaches for a global, and so a
host can supply a proxied or instrumented fetch.

**When you want an import inside the engine, the port is missing** — add the port, do not add the
import. That is the whole discipline.

Note `SqlStorage` (Cloudflare) satisfies `SqlPort` **structurally**, so the Worker passes its own DO
storage straight in with no adapter shim. That is a deliberate consequence of keeping `SqlPort` minimal:
`exec`, `get`, `all`, `run`.

## The one genuinely clever seam: `executeAgent`

`phoenix-core/src/execute.ts` accepts a **union** of dependency shapes:

```ts
executeAgent({ providers, cooldownUntil, record, … })   // raw ingredients
executeAgent({ fly, … })                                // a callback that flies them
```

The second form is not symmetry — it is a hard constraint. On Cloudflare the cooldown and observation
writes live in Durable Object SQLite, reachable only over **RPC**, and **a closure cannot cross that
boundary**. Without the union, the Workers host had to re-implement the pipeline's ordering, so the
Data Trust contract — *the request is recorded before any provider is dialled* — held in one deployment
and was merely **assumed** in the other.

Consequence: the pipeline order exists **once**, in the engine. If you add a step to that pipeline, it
lands in all hosts or none. Do not "optimise" the union away.

The `fly` shape must also carry back `toolsRequested` — the DataTrustVault's published contract is
"here are the tools that were requested", and dropping it breaks a real test that pins it.

## Routing policy (`phoenix-core/src/flock.ts`)

Order of decisions, and each one is a deliberate product statement:

1. **Priority** — `order` on the provider, lower first.
2. **Dormant skip** — a provider with no key is *skipped*, not *failed*. This is why the gateway runs
   with zero secrets. A dormant bird appearing in "errors" is a bug.
3. **Cooldown** — after a failure, the bird is unavailable until a timestamp. Not a permanent demotion.
4. **Fail-through** — a **throwing** provider does not 500 the request; the engine catches it and
   continues to the next candidate. This is the correct federation semantic and was a deliberate
   behaviour change from the original Worker.

**Never fabricate an answer.** If every candidate fails, the result is an honest failure with every
underlying reason attached — not a synthesised reply. `Fleet.ask` reports *every* failure, not just the
last one: with three cores down for three different reasons, "connection refused" alone sends the
operator to the wrong one.

## The transparency ledger is a contract, not a table

Append-only, and written **before** the flight (`phoenix-core/src/ledger.ts`). What it must be able to
answer: that a request happened, which provider attempts followed, which tools were requested, and
whether it failed. It lives in the engine's main barrel (not the `node:` adapter) precisely so a
non-Node host can import it — the adapter once kept its own copy of that SQL, and the copy is what the
extraction removed.

Do not conflate it with a **usage/quota** ledger (what the Go side has). Different artifact: one records
*what happened*, the other counts *tokens against a cap*.

## Recipes

### Add a provider
1. Implement the `Provider` contract in `phoenix-core/src/provider.ts` (or reuse a factory).
2. Declare its **capabilities explicitly** — do not pretend providers are interchangeable. The product
   states this as a non-goal.
3. A missing key means dormant, not broken. Never fail a request because a provider is unconfigured.
4. Add it to the host's provider list, not to the engine.

### Add a host
1. Bind the ports: write an adapter for SQL, fetch, time, the context store.
2. Fly the flock — either pass the raw ingredients or implement `fly` if your runtime cannot pass
   closures (RPC, process boundaries, WASM).
3. Use the engine's tool executor (`phoenix-core/src/tools.ts`) — the tool **bodies** live in the engine
   once, shared by every host. Do not copy them; two hosts once had their own copies.
4. Add a suite that runs the engine with **no bindings at all**. If it needs a binding, the boundary is
   broken and the boundary test should be red.

### Add a platform target
`simorgh-platform/src/targets.ts` — a target answers *where a core can live* and *how the platform
reaches it*. Derive nothing by target id: deploy preflight collects argv heads from the plan's own steps
and secrets from its own `secrets` array, so a new target is covered for free. If you hardcode a tool
list or a target id anywhere in preflight, you have broken that.

## Where the depth is

- `docs/ARCHITECTURE.md` — port table, invariant list, how-to recipes (the long form)
- `docs/STATE-OF-PROJECT.md` — verified capabilities with the commands that reproduce them
- `docs/adr/` — decisions with their evidence
- Skills: `simorgh-testing`, `simorgh-deploy-boundary`, `simorgh-go-workspace`
