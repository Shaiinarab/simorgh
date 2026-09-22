# TASK-008 — Quality Audit: Dead Code, Untested Critical Paths, Assertions That Cannot Fail

## Status
Done.

## Summary
Audited the full codebase (`phoenix-core/src/`, `simorgh-platform/src/`, `src/`, and all 24 test files) for the three patterns the brief named: dead code, untested critical paths, and assertions that cannot fail. Found 1 dead symbol, 7 untested critical paths (3 unverified entirely), 7 weak assertions with named wrong implementations, and confirmed the engine extraction removed all 6 documented duplication pairs. Also documented that coverage measurement is impossible today (provider missing).

Key findings:
- **Dead code**: `findModelBird` alias at `src/models.ts:19` — referenced only by its own definition and docs.
- **Untested paths**: Telegram webhook handler (`src/telegram.ts:109`), fleet-store corrupt-file handling (`simorgh-platform/src/fleet-store.ts:43`), ledger write failure (`phoenix-core/src/execute.ts:128`) have zero test coverage.
- **Weak assertions**: `toContain` for MCP tool list at `mcp-server.test.ts:201-207` (could let a 4th tool through), `toBeDefined()` at `mcp-server.test.ts:300,311,319` (passes for any non-null), `toMatchObject` at `connectors.test.ts:119` (omits `answeredBy`).
- **Duplication**: Extraction complete — no surviving duplicates between `src/` and `phoenix-core/`.
- **Coverage gap**: `@vitest/coverage-v8` not installed; cannot measure coverage.

## Checks

### Acceptance commands — verbatim output

**1. Typecheck:**
```
npm run typecheck && echo OK-typecheck
```
Output:
```
npm notice run simorgh-platform@2.0.0 typecheck
npm notice run tsgo --noEmit && tsgo --noEmit -p phoenix-core/tsconfig.json && tsgo --noEmit -p simorgh-platform/tsconfig.json
OK-typecheck
```

**2. Tests:**
```
npm test 2>&1 | grep -E "Test Files|Tests " && echo OK-tests
```
Output:
```
 Test Files  10 passed (10)
      Tests  82 passed (82)
 Test Files  17 passed (17)
      Tests  202 passed (202)
OK-tests
```

**3. Coverage provider:**
```
ls node_modules/@vitest/coverage-v8 2>/dev/null || echo "coverage provider NOT installed"
```
Output: `coverage provider NOT installed`

**4. Document existence:**
```
wc -l docs/QUALITY.md
```
Output: `135 docs/QUALITY.md`

```
grep -c 'file:line\|:[0-9]' docs/QUALITY.md
```
Output: `40`

### What could not be measured
- **Coverage**: `@vitest/coverage-v8` is not installed. `npx vitest run --coverage` would fail with "Coverage provider @vitest/coverage-v8 is not installed". Per the brief, no install was attempted (network installs not in scope). Exact error if attempted: would exit non-zero with provider-not-found message from vitest.
- **Coverage threshold verification**: Cannot verify whether the proposed 80% floor is currently met or not, since coverage cannot be measured. The floor is proposed directionally — modules like `phoenix-core/src/models.ts` (0 tests) and `phoenix-core/src/health.ts` (0 direct tests) would drag any measurement below 80%.

## Artifacts
- `docs/QUALITY.md` — the deliverable (135 lines, 40 file:line citations)

## Next_actions
1. Install `@vitest/coverage-v8` and establish coverage baseline for `phoenix-core/src/`
2. Add tests for `handleTelegramWebhook` (src/telegram.ts:109)
3. Add tests for `loadFleet` corrupt-file handling (simorgh-platform/src/fleet-store.ts:43)
4. Add test for ledger write failure path (phoenix-core/src/execute.ts:128)
5. Strengthen MCP tool-list assertion from `toContain` to exact count (simorgh-platform/test/mcp-server.test.ts:201-207)
6. Replace `toBeDefined()` assertions with shape checks (simorgh-platform/test/mcp-server.test.ts:300,311,319)
7. Add `answeredBy` assertion to connector ask tests (simorgh-platform/test/connectors.test.ts:119)
8. Remove or document `findModelBird` dead alias (src/models.ts:19)

## Lead verification (added by the Lead, 2026-09-22)

This lane's most valuable finding was that a guard **described** in a comment had never been **written**.
It was correct, and it was the Lead's defect from the previous session. Verified against the code:

| Claim | Verified how | Result |
|---|---|---|
| `mcp-server.test.ts:201-207` uses `toContain` and would let a 4th tool through | read the test | **CONFIRMED, and worse than reported.** The test carried a comment reading *"Exactly three — an exact count, not just `toContain`"* while asserting only containment — the exact-count guard it described did not exist. A comment claiming a check that is not there is worse than no comment, because it stops the next reader from looking. Fixed: `toHaveLength(3)` **plus** a sorted `toEqual` of the three names (three tools is not enough if they are the wrong three). The comment now describes what the code does. |
| `findModelBird` (`src/models.ts:19`) is dead | `grep -rn findModelBird` over the whole repo | **REFUTED as a verdict.** It is referenced only by its own definition and by the comment explaining it, so it has no *internal* caller — but the comment states it is a deliberate back-compat alias for the Worker's previously published surface, kept so the rename needed no sweep. That is a published API shim, not dead code: deleting it would be a breaking change made for tidiness. **Kept, deliberately.** Worth re-checking when `main` "major" version changes. |

The other seven weak assertions it named were not each re-verified individually; the `toContain` finding was the one that changed a file, and the pattern it identifies is now asserted by the fixed test.

TASK-008 delivered the audit as asked, including the honest note that **coverage cannot be measured**
because `@vitest/coverage-v8` is not installed — and it correctly declined to install it rather than
report a number it had not measured.

TASK-008-END
