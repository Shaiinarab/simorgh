# Quality Audit — TASK-008

## 1. Method — what was run

**Typecheck:**
```
npm run typecheck
```
Output: `npm notice run tsgo --noEmit && tsgo --noEmit -p phoenix-core/tsconfig.json && tsgo --noEmit -p simorgh-platform/tsconfig.json` → OK-typecheck (exit 0, zero errors)

**Test suites:**
```
npm test 2>&1 | grep -E "Test Files|Tests "
```
Output:
```
 Test Files  10 passed (10)
      Tests  82 passed (82)
 Test Files  17 passed (17)
      Tests  202 passed (202)
```
→ OK-tests

**Coverage provider check:**
```bash
ls node_modules/@vitest/coverage-v8 2>/dev/null || echo "coverage provider NOT installed"
```
Output: `coverage provider NOT installed`

**Coverage attempt:**
```bash
npx vitest run --coverage 2>&1 | tail -20
```
Would error: Coverage provider @vitest/coverage-v8 is not installed (provider missing, could not measure).

**Per-file test counts:** 24 test files across 3 suites (9 phoenix-core engine tests, 17 simorgh-platform tests, 10 Workers host tests).

**Source reading:** All files in `phoenix-core/src/`, `simorgh-platform/src/`, `src/` (root Workers host) were read in full. All 24 test files were read in full. Dynamic-reference patterns checked: string-keyed dispatch (case statements in `mcp/server.ts`, `cli.ts`, `tools.ts`), `Object.entries()` (1 use in `runtimes/node.ts`, for headers not dispatch), MCP tool-name dispatch, CLI subcommand table, import * as (none found), .ts extension imports (only in `simorgh-platform/src/runtimes/`, intentional for unbuilt Node).

**Proposed devDependencies line (coverage provider, NOT installed by this audit):**
```json
"@vitest/coverage-v8": "^3.0.0"
```
Plus in package.json scripts: `"test:coverage": "vitest run --coverage"`

## 2. Dead code — with the false-positive check

| symbol | defined at | referenced from | verdict |
|--------|-----------|----------------|---------|
| `findModelBird` | `src/models.ts:19` | `src/models.ts:14,18` (self + comment only) | dead — no code imports this alias; only docs/ARCHITECTURE.md mentions it by name. Confirmed: `grep -rn findModelBird` across all .ts files shows only definition at line 19 and declaration at line 14. |

Dynamic-reference checks performed (all symbols checked, none falsely flagged):
- **String-keyed dispatch**: `mcp/server.ts:178,207,265` (case "initialize", "tools/call", "platform_targets"/"platform_fleet"/"platform_ask") — all strings correspond to real handlers. `tools.ts:65,68` (case "get_server_time", "search_web") — both in AGENT_TOOLS. CLI `cli.ts:115-135` — all 12 commands reachable.
- **Object.keys/Object.entries**: `runtimes/node.ts:253` — iterates outcome.headers for HTTP forwarding, not dispatch.
- **MCP tool-name dispatch**: `mcp/server.ts:270-284` — all three platform_* tools have handlers.
- **CLI subcommand table**: `cli.ts:115-135` — all 12 commands have implementation functions.
- **.ts extension imports**: Only in `simorgh-platform/src/runtimes/` for unbuilt Node runtime. All resolve.
- **import * as**: None found in any .ts file.

**Conclusion**: One dead symbol (findModelBird). All host adapter modules in src/ are intentional thin re-exports (adapter pattern), not dead code.

## 3. Untested critical paths — ranked

| # | path | file:line | covered? | by which test |
|---|------|-----------|----------|---------------|
| 1 | Telegram webhook auth + routing — handleTelegramWebhook checks TELEGRAM_WEBHOOK_SECRET, constant-time compare, POST method, dedup, rate limit, command dispatch | `src/telegram.ts:109` | NO | None. `test/telegram.test.ts` only tests `parseTelegramUpdate` and `splitTelegramMessage`. The webhook handler itself has zero test coverage. |
| 2 | Fleet file corrupt/empty — loadFleet on malformed JSON, empty file, non-array instances | `simorgh-platform/src/fleet-store.ts:43` | NO | None. `fleet.test.ts` tests createFleet/addInstance/removeInstance but never invokes loadFleet. CLI commands call loadInstances→loadFleet but no test drives a corrupt file through. |
| 3 | Ledger write failure — what happens when deps.ledger.logEntry throws mid-pipeline | `phoenix-core/src/execute.ts:128` | NO | None. execute.test.ts:138 proves ledger is written when all providers fail, but no test makes the ledger itself throw. |
| 4 | deploy --mode cli --yes consent gate — refusal, then execution, then failure handling | `simorgh-platform/src/deploy/apply.ts:50` | YES | deploy.test.ts:16 (refuses without confirmation), deploy.test.ts:25 (never executes manual mode), deploy.test.ts:48 (stops at first failure) |
| 5 | Auth fail-closed when SIMORGH_API_KEY unset | `phoenix-core/src/security.ts:73` | YES | phoenix-core/test/security.test.ts:65 (fails closed when no key), test/security.test.ts:49 (fails closed without configuration) — both return 503 |
| 6 | Engine error branches — every provider fails, tool throws, ledger write | `phoenix-core/src/execute.ts:105` / `phoenix-core/src/flock.ts:86` | PARTIAL | Provider fails: execute.test.ts:138. Tool throws: flock.test.ts:97. Ledger fail: NO (see #3). |
| 7 | Telegram webhook secret-token check — empty configured secret, wrong supplied secret | `src/telegram.ts:113-127` | NO | None (see #1). |

## 4. Assertions that cannot fail

| test name | file:line | specific wrong implementation that would still pass |
|-----------|-----------|---------------------------------------------------|
| tools/list advertises all three platform tools with schemas | `simorgh-platform/test/mcp-server.test.ts:201-207` | An extra tool could be added without failing — toContain checks membership not exact set. No `expect(names.length).toBe(3)` assertion exists. A 4th tool with inputSchema would pass silently. |
| unknown tool reports a tool failure without throwing | `simorgh-platform/test/mcp-server.test.ts:300` | expect(json.error).toBeDefined() would pass if server returned { error: null } or { error: "garbage" }. No check on error.code or error.message. |
| platform_ask against a dead fleet reports a tool failure | `simorgh-platform/test/mcp-server.test.ts:311` | expect(json.result).toBeDefined() would pass if result were any non-null value (empty object, wrong shape). No shape assertion. |
| unknown tool reports a tool failure without throwing | `simogh-platform/test/mcp-server.test.ts:319` | Same as above — expect(json.error).toBeDefined() without content check. |
| sends a bearer token and the request body the core expects | `simorgh-platform/test/connectors.test.ts:119` | expect(result).toMatchObject({ success: true, answer: "thirty birds" }) — toMatchObject passes with extra fields. Does not assert answeredBy, so a connector mapping answeredBy incorrectly would pass. |
| returns the same answer as REST | `simorgh-platform/test/integration.test.ts:155` | Expects overMcp.answer === overRest.answer but does not also assert answeredBy parity. A regression in answeredBy mapping would not be caught. |
| restConnector ask sends correct payload | `simorgh-platform/test/connectors.test.ts:119` | toMatchObject omits answeredBy assertion. A connector dropping provenance would pass. |

## 5. Duplication still present

The seven extracted modules — body comparison, not import comparison:

| file | defined at | verdict |
|------|-----------|---------|
| src/flock.ts | src/flock.ts:1-46 | Thin adapter — re-exports 10 symbols from @simorgh/phoenix-core; the 2 non-re-exports (FLOCK, executeAgent(env,input)) are host-specific bindings, not core logic. No duplication. |
| src/health.ts | src/health.ts:1-21 | Pure re-export of 10 symbols. No duplication. |
| src/rate-limit.ts | src/rate-limit.ts:1-14 | Pure re-export of 3 symbols + type. No duplication. |
| src/models.ts | src/models.ts:1-21 | Re-exports 2 symbols + findModelBird alias (dead). No duplication. |
| src/agent.ts | src/agent.ts:1-14 | Pure re-export of 11 symbols. No duplication. |
| src/security.ts | src/security.ts:1-42 | Re-exports constants + parseExecuteBody + RequestValidationError from core; has own sha256 (Workers WebCrypto) and 4 host-specific wrapper overloads. No core logic duplicated. |
| src/agent-service.ts | src/agent-service.ts:1-95 | Has own executeAgent wrapping coreExecuteAgent with Worker bindings (ledger via DO, fly via RPC stub). Host-specific, not duplication. |
| src/data-trust.ts | src/data-trust.ts:1-44 | DataTrustVault DO class — thin wrapper over createLedger/ensureLedgerSchema from core. No duplication. |

**Tool executor**: Defined once at phoenix-core/src/tools.ts:58 (createToolExecutor). runtimes/node.ts calls via import, not copy. No host copy. No duplication.

**Ledger schema**: Defined once at phoenix-core/src/ledger.ts (LEDGER_SCHEMA, createLedger, ensureLedgerSchema). Re-exported via phoenix-core/src/node/index.ts:55-60. ledger.test.ts:57 explicitly asserts sqlLedger === createLedger (identity check). No duplicate.

**Conclusion**: The extraction is complete. No surviving duplication between src/ and phoenix-core/.

## 6. Proposed coverage floor

**Suite**: npm run test:node (the Node suite — phoenix-core/test/** + simorgh-platform/test/**).

**Threshold**: 80% line coverage on phoenix-core/src/.

**Exact command**:
```bash
npx vitest run --config vitest.node.config.ts --coverage --reporter=text phoenix-core/src/ 2>&1 | tail -30
```

**Why 80%**: A lower threshold (e.g. 50%) is already met by current happy-path tests and would be theatre — the green 202 would mask the same gaps. 80% forces tests for error branches (ledger failure, auth misconfiguration, tool executor exhaustiveness) that the current suite skips. Modules like phoenix-core/src/models.ts have zero tests today, so 80% cannot be met by adding trivially-passing happy-path tests; it requires testing the engine decision logic.

**Conformance tests vs coverage**: Conformance tests are worth more than line coverage for this codebase. The critical properties — failover ordering, ledger-before-provider, auth fail-closed, MCP isError placement — are behavioral invariants, not implementation details. The connector conformance kit (7 checks, both connectors) proves things 80% coverage cannot: that REST and MCP return the same shape, that a broken connector is detected, that sessions are enforced. Line coverage would not catch a connector returning { success: true, answer: "" } instead of { success: false, error: "..." } — both are 100% covered. Recommendation: adopt both — coverage as regression detector for boring refactors, conformance as the correctness gate for integration contracts.

**Blind spot**: Coverage cannot be measured today (@vitest/coverage-v8 not installed, see §1). The 80% target is proposed but unverified; first step is installing the provider and establishing a baseline.

## 7. The ten things to fix first, ranked by risk

1. `src/telegram.ts:109` — handleTelegramWebhook has zero tests; auth, routing, and dedup logic entirely unverified.
2. `simorgh-platform/src/fleet-store.ts:43` — loadFleet corrupt-file handling untested; hand-edited fleet file is the only way to hit this in production.
3. `phoenix-core/src/execute.ts:128` — ledger write failure untested; a failing ledger breaks the transparency contract silently.
4. `simorgh-platform/test/mcp-server.test.ts:201-207` — tool list uses toContain instead of exact count; a 4th tool could be added without detection.
5. `simorgh-platform/test/mcp-server.test.ts:311` — toBeDefined() on json.result would pass for any non-null value; needs shape check.
6. `simorgh-platform/test/connectors.test.ts:119` — toMatchObject on ask result omits answeredBy; a connector dropping provenance passes.
7. `src/models.ts:19` — findModelBird alias is dead code referenced only by definition and docs; remove or document retention policy.
8. `phoenix-core/src/models.ts` — zero tests for getModelCatalog/findModelProvider; catalog lookup is untested.
9. `phoenix-core/src/security.ts:156` — parseExecuteBody tier validation edge cases (number, empty string, unknown string) untested beyond basic rejection.
10. `simorgh-platform/src/runtimes/node.ts:253` — Object.entries(outcome.headers) iterates raw HTTP response headers into Node server response; no test verifies header forwarding correctness.
