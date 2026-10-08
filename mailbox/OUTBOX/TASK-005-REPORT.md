# TASK-005 — Deploy Preflight

- Brief: `mailbox/INBOX/TASK-005-deploy-preflight.md`
- Instance: shai-pc (headless pool lane)
- Status: **done**

## Summary

Built a read-only preflight gate that answers "can this deploy plan succeed in this environment right now?" before any step is attempted. Three files created:

- `simorgh-platform/src/deploy/preflight.ts` — `runPreflight()` and `renderPreflight()` implementing six plan-derived checks (missing secrets, missing tools, unresolved `{origin}`, mode/target agreement, endpoint liveness, runtime version)
- `simorgh-platform/test/preflight.test.ts` — 13 tests, all passing, using injected `env`/`which`/`fetch`
- `.openclaw/tmp/preflight-demo.ts` — throwaway demo run against the real `buildDeployPlan`

Every check is derived from the plan — no hardcoded target IDs or tool lists. A new target is covered automatically by declaring its steps and secrets. The gate never installs, deploys, or writes anything; probes and errors are caught and turned into warnings, never rejected.

## Checks

### npm run typecheck

Exit code 1 due to **pre-existing** type errors in `simorgh-platform/src/mcp/server.ts` and `simorgh-platform/test/mcp-server.test.ts` (both outside the Allowlist). Zero errors in `preflight.ts` or `preflight.test.ts`.

```
npm notice run tsgo --noEmit && tsgo --noEmit -p phoenix-core/tsconfig.json && tsgo --noEmit -p simorgh-platform/tsconfig.json
simorgh-platform/src/mcp/server.ts(16,48): error TS2307: Cannot find module '@simogh/phoenix-core' or its corresponding type declarations.
simorgh-platform/src/mcp/server.ts(101,24): error TS2339: Property 'body' does not exist on type '{}'.
simorgh-platform/src/mcp/server.ts(101,47): error TS2339: Property 'body' does not exist on type '{}'.
simorgh-platform/src/mcp/server.ts(106,13): error TS2339: Property 'headers' does not exist on type '{}'.
simorgh-platform/src/mcp/server.ts(107,13): error TS2339: Property 'headers' does not exist on type '{}'.
simorgh-platform/test/mcp-server.test.ts(248,49): error TS2554: Expected 1-2 arguments, but got 0.
simorgh-platform/test/mcp-server.test.ts(249,16): error TS2554: Expected 1-2 arguments, but got 0.
```

### npm test (workerd portion)

```
npm run test:workers && echo OK-workerd
npm notice run vitest run
 RUN  v4.1.11
 Test Files  10 passed (10)
      Tests  82 passed (82)
OK-workerd
```

Full `npm test` exits 1 due to pre-existing node test failures in `simorgh-platform/test/mcp-server.test.ts` (3) and `simorgh-platform/test/conformance.test.ts` (3) — all outside Allowlist.

### preflight tests

```
npx vitest run --config vitest.node.config.ts simorgh-platform/test/preflight.test.ts && echo OK-preflight
 RUN  v4.1.11
 Test Files  1 passed (1)
      Tests  13 passed (13)
OK-preflight
```

### vitest node run (tail)

```
npx vitest run --config vitest.node.config.ts 2>&1 | tail -5
 Test Files  2 failed | 14 passed (16)
      Tests  6 failed | 179 passed (185)
```

### Demo runs (against real buildDeployPlan)

Run 1 — `node .openclaw/tmp/preflight-demo.ts` (no SIMORGH_API_KEY):
```
=== Preflight for node --origin 127.0.0.1:8788 ===

Blocked by 1 checker:
  ✗ missing-secret: Required secret SIMORGH_API_KEY (Bearer token every caller must present.) is not set
    → Set SIMORGH_API_KEY in the environment

Warnings (1):
  ⚠ endpoint-live: A core is already responding at http://127.0.0.1:8788 (HTTP 501)
    → Re-deploying over a live core is legal; review the impact first

Preflight blocked — node/simorgh cannot proceed.
```

Run 2 — `SIMORGH_API_KEY=whatever node .openclaw/tmp/preflight-demo.ts`:
```
=== Preflight for node --origin 127.0.0.1:8788 ===

Warnings (1):
  ⚠ endpoint-live: A core is already responding at http://127.0.0.1:8788 (HTTP 501)
    → Re-deploying over a live core is legal; review the impact first

Preflight passed — node/simorgh can proceed.
```

## Test Coverage Detail

All 13 tests pass. Key scenarios covered:

| # | Test | Result |
|---|------|--------|
| 1 | Healthy plan → ok: true, zero blockers | pass |
| 2 | Missing required secret → blocker naming secret | pass (`missing-secret`) |
| 3 | Optional secret missing → not a blocker | pass |
| 4 | Missing tool → blocker naming step id | pass (`missing-tool`) |
| 5 | Tool list derived (not hardcoded) → `frobnicate` step | pass (`missing-tool`) |
| 6 | Unresolved `{origin}` in argv → blocker | pass (`unresolved-origin`) |
| 7 | cli mode on non-executable target → blocker | pass (`mode-target-mismatch`) |
| 8 | Live core at endpoint → warning, ok true | pass (`endpoint-live`) |
| 9 | Dead endpoint → ok true | pass |
| 10 | Probe throws → warning with real message | pass (`endpoint-live`) |
| 11 | blockers/checks agree | pass |
| 12 | renderPreflight: blockers before warnings before verdict | pass |
| 13 | renderPreflight: zero checks says plan clear | pass |

ID values emitted: `missing-secret`, `missing-tool`, `unresolved-origin`, `mode-target-mismatch`, `endpoint-live`, `runtime-too-old`.

## Next_actions

- Lead to wire `runPreflight` into `deploy` flow (per brief, Lead handles integration)
- Pre-existing type errors in `simorgh-platform/src/mcp/server.ts` and `simorgh-platform/test/mcp-server.test.ts` should be fixed independently (outside this task's scope)
- Pre-existing node test failures in `mcp-server.test.ts` and `conformance.test.ts` should be investigated independently

## Artifacts

- `simorgh-platform/src/deploy/preflight.ts` — preflight implementation (257 lines)
- `simorgh-platform/test/preflight.test.ts` — test suite (13 tests, all passing)
- `.openclaw/tmp/preflight-demo.ts` — throwaway demo (33 lines)

## NAGs

None — all acceptance checks that fall within scope pass. Typecheck and full node test failures are pre-existing and in files outside this task's Allowlist.

TASK-005-END
