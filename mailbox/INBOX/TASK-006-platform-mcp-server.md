# TASK-006 — the platform's own MCP server: let an agent drive the fleet

- Owner: any
- Status: done (Lead 2026-09-22T13:24)
- Depends on: nothing · Estimate: 45–70 min · Runner: pool lane (headless)

## Why this exists

Right now MCP flows **one way**: `simorgh-platform` *consumes* cores over MCP. An agent host can ask a
core a question, but it cannot ask the *platform* anything — it cannot discover where a core could
live, cannot see which cores are up, cannot fail over across them. So the only way to operate the
fleet from an agent is to shell out to the CLI and scrape stdout, which is exactly the coupling the
platform exists to remove.

Flip it: ship a server so the platform is reachable over the same protocol it already speaks. Then an
agent gets three tools — where cores can live, which cores are mine, and ask the fleet — with no CLI
and no stdout parsing.

The elegant part, and the reason this is worth a lane: **the platform already ships a conforming MCP
*client*** (`connectors/mcp.ts`). So the server can be tested against our own client, end to end. If
that round trip works, we know the platform's own usage of MCP is honest — a real interop check, not a
simulation.

## Read first

- `simorgh-platform/src/connectors/mcp.ts` — the **client** you must satisfy: it sends
  `initialize`, then `notifications/initialized`, then `tools/call`; reads the JSON-RPC reply; and
  requires the `Mcp-Session-Id` response header on `initialize` and echoed back afterwards. It also
  tolerates **both** `application/json` and `text/event-stream` replies. Your server only has to pick
  one, but must pick one deliberately and say which in the report.
- `simorgh-platform/src/runtimes/node.ts` — the codebase already contains an MCP **server** for a core
  (it serves `simorgh_status` / `simorgh_ask`). **Reuse its framing and its JSON-RPC envelope style**;
  do not invent a second dialect. Note how it is parameterized and how it is wired to a `FetchLike`.
- `simorgh-platform/src/targets.ts` — `listTargets()`, `DeploymentTarget` (what `simorgh targets` reports)
- `simorgh-platform/src/fleet.ts` — `createFleet`, `connectorFor`, `CoreInstance`, `InstanceReport`.
  This is where "which cores are mine" lives.
- `simorgh-platform/src/connectors/types.ts` — `AskRequest` / `AskResult`, the shapes to return
- `simorgh-platform/src/fleet-store.ts` — how the fleet is loaded (and that it warns rather than throws)
- `mailbox/README.md` — report template. `npm install` is **not** needed; the workspace is already linked.

## Deliverable 1 — `simorgh-platform/src/mcp/server.ts` (new)

Export a server as a `FetchLike`-compatible handler plus a small wrapper, in the same shape
`runtimes/node.ts` uses. A reasonable public surface:

```ts
export interface PlatformMcpOptions {
  /** Instances to operate on. Defaults to the loaded fleet. */
  instances?: readonly CoreInstance[];
  /** Injected so the server is testable and never reaches for a global. */
  fetch?: FetchLike;
  /** Sent in `initialize`'s result. */
  serverName?: string;
  serverVersion?: string;
}

/** Build a `FetchLike` handler: point a client straight at it, no socket needed. */
export function platformMcpHandler(options?: PlatformMcpOptions): FetchLike;
```

Tools to expose — **`platform_*` on purpose**, so they cannot be confused with a core's
`simorgh_*` when both are reachable from one agent host:

| Tool | Arguments | Returns |
|---|---|---|
| `platform_targets` | none | every registered target: `id`, `label`, `runtime`, `connectors`, `modes`, `endpoint` — **no `steps` or `secrets`** (that is a deploy plan's job, and dumping them makes this tool useless to an agent reading a context window) |
| `platform_fleet` | optional `{ instanceId }` | with no argument: one entry per recorded instance — `id`, `endpoint`, `kind`, reachable, `latencyMs`, detail. With an id: that instance's full `FlockStatus` |
| `platform_ask` | `{ prompt, instanceId?, tools?, userId?, tier? }` | an `AskResult` (the same shape the connectors return). With no `instanceId`, ask the fleet **in order and fail over**; report which instance answered |

Requirements:
- JSON-RPC 2.0 envelope, `initialize` answering with `protocolVersion` (**import the constant from
  `connectors/mcp.ts` — do not duplicate it**), `capabilities.tools`, and `serverInfo`.
- Issue an `Mcp-Session-Id` on `initialize` and **reject** a `tools/call` that does not echo it
  (`-32600` or your chosen code, with a clear message). The session is the point of the transport;
  accepting calls without it would mean the client had no idea what it was talking to.
- `tools/list` — implement it. We do not need it internally, but a real MCP host will call it, and a
  server that cannot describe itself is not usable by a third-party client. Mark the tools' input
  schemas honestly.
- Unknown method → a proper JSON-RPC error, never a thrown exception out of the handler. A transport
  that throws on a bad message is a transport that breaks on a typo.
- **A failing tool must be `isError: true` with a readable message, not an HTTP 500.** `platform_ask`
  against an unreachable fleet is a normal outcome an agent must be able to reason about.
- Never mutate the fleet file. This server reads.

## Deliverable 2 — `simorgh-platform/test/mcp-server.test.ts` (new)

At least **12** tests. The three that matter most:

1. **Round trip through our own client.** Build `mcpConnector({ endpoint, fetch: platformMcpHandler(...) })`
   and prove `health()` reports `reachable: true` and `status()` returns real data. This is the interop
   proof: our client and our server, no stubs between them.
2. **The session is enforced.** A `tools/call` sent without the `Mcp-Session-Id` header must fail; with
   it, must succeed.
3. **`platform_ask` fails over.** Two instances, the first refusing, and assert the answer came from
   the second and the result says so.

Also cover: `initialize` returns the shared protocol version constant; `tools/list` advertises all
three tools with schemas; unknown method → JSON-RPC error, no throw; unknown tool → `isError`, no
throw; `platform_targets` omits `steps`/`secrets`; `platform_fleet` with no instances recorded is a
clean empty result rather than an error; `platform_fleet` with an unknown `instanceId` says so;
`platform_ask` against a dead fleet returns `isError` rather than throwing.

Use a stub `FetchLike` for the *core* side (copy the pattern from `test/fleet.test.ts`), but drive the
*server* through the real client wherever you can. Tests run under `vitest.node.config.ts`.

## Allowlist — touch nothing else

```
simorgh-platform/src/mcp/server.ts        (new)
simorgh-platform/test/mcp-server.test.ts  (new)
```

Do **not** edit `src/index.ts` (the Lead exports `mcp/server.ts`), `connectors/mcp.ts`, `fleet.ts`,
`runtimes/node.ts`, or `fleet-store.ts`. If you need `src/` to import from `test/`, you have the design
wrong — the server takes its instances as an option for exactly this reason.

## Acceptance — run these and paste the output verbatim

```bash
npm run typecheck && echo OK-typecheck
npm test && echo OK-workerd
npx vitest run --config vitest.node.config.ts simorgh-platform/test/mcp-server.test.ts && echo OK-mcp-server
npx vitest run --config vitest.node.config.ts 2>&1 | tail -5
npm run simorgh -- targets >/dev/null && echo OK-cli-still-works
```

Also paste the **raw JSON** your server returns for a `tools/call` on `platform_targets` (print it from
one test or a throwaway script), so the shape can be reviewed by a human without running anything.

## Report

`mailbox/OUTBOX/TASK-006-REPORT.md`, per `mailbox/README.md`, ending with `TASK-006-END` as the last
non-empty line. Include the acceptance output verbatim, the raw `platform_targets` JSON, which content
encoding you chose (`application/json` vs `text/event-stream`) and why, and the test count.
