# TASK-004 — the connector conformance kit: make "you cannot tell which connector answered" executable

- Owner: any
- Status: done (Lead 2026-09-22T13:04)
- Depends on: nothing · Estimate: 45–70 min · Runner: pool lane (headless)

## Why this exists

`simorgh-platform` ships two ways to reach a phoenix-core, and its central promise is in
`connectors/types.ts`:

> Both return the *same* shapes [...] A caller cannot tell which connector answered, and should not have to.

Today that promise is held up by two hand-written test files that were written separately and do not
know about each other. Nothing asserts the connectors *agree*. So the promise erodes the moment either
connector changes, and no test goes red — which is the expensive kind of failure, because the *caller*
discovers it in production.

Fix it the way the rest of this codebase fixes things: make the claim runnable. A conformance kit is a
list of assertions **every** `CoreConnector` must satisfy, run against each implementation. Then a
future connector (gRPC, a plain WebSocket, whatever) is validated by running the kit, not by
re-reading two test files and hoping.

## Read first

- `simorgh-platform/src/connectors/types.ts` — `CoreConnector`, `CoreHealth`, `AskRequest`, `AskResult`,
  and `toAskResult` (the wire→platform translation both connectors share)
- `simorgh-platform/src/connectors/rest.ts` and `connectors/mcp.ts` — the two implementations under test
- `phoenix-core/src/execute.ts` and `phoenix-core/src/flock.ts` — the **actual** response shape a real
  core returns (`success`, `agentResponse`, `meta.answered_by`, `meta.flock_attempts[]`) and the
  `FlockStatus` shape. Your fake core must imitate these, not invent them.
- `simorgh-platform/src/runtimes/node.ts` — the self-hosted core's real route table and MCP handshake.
  **This is your best reference for what a core actually says on the wire.**
- `simorgh-platform/test/fleet.test.ts` and `test/connectors.test.ts` — the stub-`fetch` pattern; copy
  its style, do not reinvent it
- `mailbox/README.md` — report template. `npm install` is **not** needed; the workspace is already linked.

## Deliverable 1 — `simorgh-platform/test/support/fake-core.ts` (new)

One in-process fake phoenix-core that speaks **both** REST and MCP through a single `FetchLike`, so both
connectors can be pointed at the same double and their answers compared against the same expectations.

It must be **scripted**, not hardcoded to one happy path. A shape like:

```ts
export interface FakeCoreScript {
  /** What each provider did, in order. Drives meta.flock_attempts. */
  attempts?: { providerId: string; ok: boolean; error?: string }[];
  answer?: string;                 // agentResponse; default a fixed string
  answeredBy?: string;             // meta.answered_by
  /** Force a bare HTTP failure from every route. */
  httpStatus?: number;             // e.g. 401, 503, 500
  /** FlockStatus the status route reports. */
  flockStatus?: FlockStatus;
  /** Capture every request the double saw, for assertions. */
  record?: { url: string; method: string; body?: string }[];
}

export function fakeCore(script?: FakeCoreScript): { fetch: FetchLike; calls(): ... };
```

Requirements:
- Speak the REST routes the real core exposes (`/health`, `/api/v1/flock/status`, the execute route)
  **and** the MCP JSON-RPC methods a real MCP server answers: `initialize` (issuing an
  `Mcp-Session-Id` response header — the MCP connector depends on that header existing),
  `notifications/initialized`, and `tools/call`. Read `runtimes/node.ts` for the exact tool names
  (`simorgh_status`, `simorgh_ask`) and the content-block shape.
- Enforce the session: a `tools/call` that does **not** echo `Mcp-Session-Id` should fail. That is what
  makes the double a real test of the MCP connector rather than a rubber stamp.
- `httpStatus` must apply to *both* transports, so a 401 and a 503 can be compared across them.
- Type it strictly — no `any`. The repo runs `tsc --noEmit` over everything, tests included.

## Deliverable 2 — `simorgh-platform/src/connectors/conformance.ts` (new)

```ts
export interface ConformanceCheck {
  name: string;          // stable, greppable, e.g. "health-resolves-when-core-is-down"
  ok: boolean;
  detail: string;        // what was observed — include the actual value on failure
}

export interface ConformanceOptions {
  connector: CoreConnector;
  /** The double the connector was built against, so the kit can script it per check. */
  script: (s: FakeCoreScript) => void;
}

export function runConnectorConformance(options: ConformanceOptions): Promise<ConformanceCheck[]>;
```

Hmm — passing a `FakeCoreScript` type into `src/` would make production source depend on a test
helper. **Resolve that however you think is cleanest** and say which you chose in the report: either a
`ConformanceHarness` interface the kit defines and the test implements, or a kit that takes a factory
`(script) => CoreConnector`. A `src/` module must not import from `test/`.

Checks the kit must make (add more if you find real ones):
1. `health()` **resolves** — never rejects — when the core is unreachable, and reports `reachable: false`.
2. `health()` reports `reachable: true` and a numeric `latencyMs` against a healthy core.
3. `status()` returns a payload whose providers carry the core's real field names.
4. `ask()` maps `answered_by` into `AskResult.answeredBy` and `flock_attempts[].birdId` into
   `attempts[].providerId` — the *same* mapping for both connectors.
5. `ask()` on a core with no usable provider returns `success: false` with an `error`, rather than
   throwing. A user-visible failure must be a value, not an exception.
6. The failure modes are **distinguishable**: a `401` and a `503` must not produce identical error text.
7. `connector.endpoint` is exactly the endpoint it was constructed with (no silent rewriting).

**Do not** assert on our own prose wording — assert on stable things (codes, field names, booleans).

## Deliverable 3 — `simorgh-platform/test/conformance.test.ts` (new)

- Run the kit against `restConnector` **and** `mcpConnector`, against the *same* fake core.
- Assert the two connectors produce the **same number of checks** — that is the drift detector.
- **Prove the kit is not decorative.** Define a deliberately broken connector *inline in the test*
  (e.g. one whose `ask()` throws instead of returning `success: false`) and assert the kit **fails**
  it, naming the specific check. A suite that only ever passes proves nothing about the suite.
- Tests run under `vitest.node.config.ts` (Node, not workerd).

## Allowlist — touch nothing else

```
simorgh-platform/test/support/fake-core.ts   (new)
simorgh-platform/src/connectors/conformance.ts (new)
simorgh-platform/test/conformance.test.ts      (new)
```

Do **not** edit `connectors/rest.ts`, `connectors/mcp.ts`, `connectors/types.ts`, `src/index.ts`, or
`package.json`. If you find a bug in a connector, report it — do not fix it, another lane is
mid-flight on adjacent files.

## Acceptance — run these and paste the output verbatim

```bash
npm run typecheck && echo OK-typecheck
npm test && echo OK-workerd
npx vitest run --config vitest.node.config.ts simorgh-platform/test/conformance.test.ts && echo OK-conformance
npx vitest run --config vitest.node.config.ts 2>&1 | tail -5
npm run simorgh -- targets >/dev/null && echo OK-cli-still-works
```

Also state the exact check names your kit emits, and which connector (if either) fails a check today.
**If a check fails, that is a finding — report it, do not weaken the check to make it pass.**

## Report

`mailbox/OUTBOX/TASK-004-REPORT.md`, per `mailbox/README.md`, ending with `TASK-004-END` as the last
non-empty line. Include the acceptance output verbatim, the check-name list, and how you resolved the
`src/` must-not-import-`test/` constraint.
