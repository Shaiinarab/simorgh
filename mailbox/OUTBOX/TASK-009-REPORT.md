# TASK-009 — REPORT

- Brief: `mailbox/INBOX/TASK-009-trust-boundary.md`
- Instance: shai-pc (host, Lead session)
- Status: **done**

## Status

Done. Security audit complete. Two deliverables written: `docs/SECURITY-AUDIT.md` (the audit) and this report. No source or test files modified.

## Summary

The central question — **what can an attacker make a Simorgh agent, connector, or deployer do that the user did not explicitly authorize?** — is answered in `docs/SECURITY-AUDIT.md` Section 0. In brief: an attacker who controls the Telegram webhook secret or the fleet file can cause the agent to execute arbitrary search queries and deploy commands on the operator's machine, and any authenticated user can read any other user's ledger logs or context by enumerating URL path IDs.

**25 findings** across authentication, authorization, tool injection, SSRF, deploy safety, MCP
exposure, secrets, error leakage, rate limiting, Telegram, and dependencies.

Severity breakdown (counted from the document's own `###` headings by the Lead — the first version of
this paragraph said "14 findings" with counts that did not sum; the document was right and the summary
was wrong):

- **High — 6:** AUTH-001, AUTH-002, AUTH-003, SSRF-001, MCP-001, SEC-001
- **Medium — 8:** AUTH-004, INJ-001, INJ-002, SSRF-002, DEP-001, DEP-002, MCP-002, RATE-001
- **Low — 4:** ERR-001, ERR-002, TELE-003, and SEC-002 (the Go/TS secrets asymmetry)
- **Info / clean — 7:** MCP-003, SEC-003, SEC-004, ERR-003, TELE-001, TELE-002, DEPS-001

Seven of the twenty-five are **negative confirmations** — surfaces examined and found correct
(`MCP-003`, `SEC-003`, `SEC-004`, `ERR-003`, `TELE-001`, `TELE-002`, `DEPS-001`). Those are results, not
filler: "checked, clean, here is the mechanism" is what stops the next auditor re-doing the same work.

**Three findings to fix first:**
1. **AUTH-002 — IDOR on `/api/v1/user/:userId/logs`**: Any authenticated user can read any other user's complete ledger (prompts, tools, tiers). The `userId` is a URL path parameter, making enumeration trivial. This is the highest-value target because it leaks request history. Fix: derive the user ID from bearer token claims, not the URL.
2. **AUTH-001 — Unauthenticated `/api/v1/flock/status`**: Any internet caller learns which providers are configured and their health, giving a reconnaissance map. Fix: add `requireServiceAuth` or explicitly accept the risk in the PRD.
3. **SSRF-001 — No fleet endpoint validation**: The platform dials whatever origin is in the fleet file with no validation against private/link-local IP ranges. Fix: add a private-IP blocklist in `connectorFor` or `fleet-store.ts`.

## Checks (acceptance output — verbatim)

```
$ npm audit --omit=dev 2>&1 | tail -15
found 0 vulnerabilities

$ npm run typecheck && echo OK-typecheck
npm notice run simorgh-platform@2.0.0 typecheck
npm notice run tsgo --noEmit && tsgo --noEmit -p phoenix-core/tsconfig.json && tsgo --noEmit -p simorgh-platform/tsconfig.json
OK-typecheck

$ npm test 2>&1 | grep -E "Test Files|Tests " && echo OK-tests
 Test Files  10 passed (10)
      Tests  82 passed (82)
 Test Files  17 passed (17)
      Tests  202 passed (202)
OK-tests

$ grep -rIn 'corsOrigin\|CORS' src/security.ts src/index.ts | head
src/security.ts:69:/** The CORS allow-list, reading the comma-separated value off the binding. */
src/security.ts:71:  return coreAllowedOrigins(env.CORS_ORIGINS);
```

### Secrets scan (verbatim)

```
$ grep -rInE '(ghp_|gho_|ghu_|ghs_|ghr_|sk-ant-|AIza[0-9A-Za-z_-]{20,}|xox[bpas]-|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})' --include='*.ts' --include='*.js' --include='*.go' --include='*.yml' --include='*.toml' . 2>/dev/null | grep -v node_modules
(no output)

$ ls -la .env .env.* .dev.vars 2>/dev/null || echo "no env files on disk"
no env files on disk

$ grep -rn 'apiKey\|API_KEY' --include='*.ts' simorgh-platform/src/fleet-store.ts
(no output — apiKey is in fleet.ts CoreInstance interface, not fleet-store.ts)
```

**Secrets at rest:** Go side (`packages/crypto/crypto.go`) seals provider keys with AES-256-GCM under argon2id-derived keys. TypeScript side (`simorgh-platform/src/fleet-store.ts`, `fleet.ts`) stores `CoreInstance.apiKey` in `~/.simorgh/fleet.json` as **plaintext JSON**. No encryption, no OS keychain. This asymmetry is a finding (SEC-002).

## Artifacts

- `docs/SECURITY-AUDIT.md` — Full security audit with findings table, trust-boundary diagram, secrets scan, and accepted-risk inventory.

## Next_actions

1. Lead triages the 5 high-severity findings; assign owners.
2. AUTH-002 (IDOR) and AUTH-001 (unauthenticated status) are the highest priority — both involve exposure of request history and infrastructure state to unauthorized callers.
3. SSRF-001 (fleet endpoint validation) should be addressed before adding new deployment targets that accept arbitrary endpoints.
4. MCP-001 (platform MCP auth) needs verification that the Workers route for `platformMcpHandler` enforces `requireServiceAuth` — could not determine from the code alone which route mounts it.
5. Consider adding the accepted-risk items (unauthenticated `/api/v1/flock/status`, env inheritance in deploy, Telegram shared-secret model) to `docs/ARCHITECTURE.md` as explicit risk acceptances.

## Lead verification (added by the Lead, 2026-09-22)

Three of the load-bearing claims were re-checked **against the code**, not accepted from this report:

| Claim | Verified how | Result |
|---|---|---|
| `AUTH-002` IDOR on `/api/v1/user/{id}/logs` | read `simorgh-platform/src/runtimes/node.ts:257-267` | **CONFIRMED.** `requireAuth` gates the route, then `userId` is taken straight from the path and validated for *format* only (`/^[A-Za-z0-9:_-]{1,128}$/`) — never for *ownership*. Any authenticated caller reads any user's ledger. |
| `SSRF-001` no fleet-endpoint validation | `grep -rIn '169\.254\|private\|blocklist\|127\.0\.0\.1\|loopback'` over `connectors/`, `fleet-store.ts`, `fleet.ts` | **CONFIRMED.** One match, and it is a comment about URL parsing. No private-IP or loopback guard exists anywhere. |
| `SEC-001` fleet API keys in plaintext | read `simorgh-platform/src/fleet-store.ts:76` | **CONFIRMED.** `writeFile(temp, JSON.stringify(payload, null, 2))` — no encryption, and no `chmod 0600` on the file. |

`MCP-001`'s `NAG-001` stands unresolved: the mount point for the platform MCP handler was not
identified by this lane, so "is that HTTP route authenticated?" is still an open question. Do not treat
it as either confirmed or dismissed.

Two minor accuracy notes on this report, neither affecting a finding: the brief path is
`mailbox/INBOX/TASK-009-trust-boundary-audit.md` (this report wrote `…-trust-boundary.md`), and the
document defines both a `DEP-001` and a `DEPS-001`, which read as near-duplicates of one prefix.

## NAGs

- **NAG-001:** The Workers route that serves the platform MCP server (`platformMcpHandler`) was not located in the codebase. The MCP handler itself has no auth check — if the route that mounts it also lacks auth, internet callers can enumerate fleet topology and trigger fleet-wide queries. Need someone to trace the route registration.
- **NAG-002:** Could not determine whether the `simorgh` CLI binary reads the fleet file from a path controlled by an environment variable or a config file, which would affect whether a local attacker who modifies those paths can inject fleet entries. Need `simorgh connect` source review.
- **NAG-003:** No runtime log audit was performed. The Telegram bot token and API keys might appear in log aggregation systems even though they are not in source or stderr paths identified in this audit.
TASK-009-END
