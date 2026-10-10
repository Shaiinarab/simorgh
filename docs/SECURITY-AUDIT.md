# Security Audit — simorgh-platform / TASK-009

> **What can an attacker make a Simorgh agent, connector, or deployer do that the user did not explicitly authorize?**
> An attacker who controls the Telegram bot token or the fleet file can cause a Simorgh agent to execute arbitrary search queries and execute real shell commands on the operator's machine via `--yes`-gated deploy, or (before 2026-10-08) read any user's ledger logs and context by enumerating IDs in URLs — because authentication stops at the service token and authorization stops at the URL path.

## Trust-Boundary Diagram

**Inside the boundary (trusted):**
- The agent loop (`phoenix-core/src/agent.ts`) — decides which of the two vetted tools to run, folds results into the prompt
- The tool executor (`phoenix-core/src/tools.ts`) — only `search_web` (DuckDuckGo API) and `get_server_time`
- The deploy gate (`simorgh-platform/src/deploy/apply.ts`) — refuses without explicit `--yes`
- The ledger (`phoenix-core/src/ledger.ts`) — append-only transparency log

**Outside the boundary (untrusted input sources):**
- **Telegram webhook** (`src/telegram.ts`) — accepts messages from the internet, authenticated only by a shared secret token
- **Fleet file** (`simorgh-platform/src/fleet-store.ts`, `~/.simorgh/fleet.json`) — operator-edited JSON specifying endpoints and API keys the platform dials
- **Plan argv** (`simorgh-platform/src/deploy/plan.ts`) — `--origin` and `--service` substituted into commands
- **Request body** (`src/index.ts` `POST /api/v1/agent/execute`) — user-supplied prompt, tool list, and `userId`
- **Provider responses** — text returned by LLM providers folded into the next prompt iteration
- **MCP clients** — any agent connecting to the platform or core MCP servers

**What crosses the boundary:** Telegram messages → webhook handler → `executeAgent` → agent loop → tool fetches → provider response → next prompt; fleet file → connectors → external origins; `--yes` flag → shell commands via `spawn`.

---

## 1. Findings

### AUTH-001 — `/api/v1/flock/status` answers without authentication
- **Severity:** high
- **Evidence:** `src/index.ts:137` (edge), `runtimes/node.ts:207` (Node runtime)
- **Impact:** Any unauthenticated caller learns which providers are configured, their statuses, and which providers have keys — a reconnaissance map for targeted attacks. The edge route goes directly to `FLOCK_COORDINATOR.get(id).getFlockStatus()` with no `requireServiceAuth` guard.
- **Recommended fix:** Add `requireServiceAuth` to `/api/v1/flock/status`, or document it as an intentional health-exposure with a risk acceptance. The Node runtime comment says "Not authenticated, matching the edge" — but matching an insecure edge is not a defense.

### AUTH-002 — IDOR: any authenticated user can read any user's ledger logs *(FIXED 2026-10-08)*
- **Severity:** high
- **Evidence:** `src/index.ts:222` (`/api/v1/user/:userId/logs`; `:457` in the fixed tree) and `simorgh-platform/src/runtimes/node.ts:277` — the same route on the self-hosted host, which this audit never enumerated. Both line numbers are given because a reader following either tree should land on the route rather than near it.
- **Impact:** The route authenticates the caller (bearer token) but takes `userId` from the URL path with no ownership check. An authenticated attacker enumerates `userId` values and reads every user's ledger entries (prompt, tools, tier, timestamp). This is the highest-value question in this audit: an IDOR where the IDs are in the URL.
- **Recommended fix:** Bind the route to the authenticated identity. Either derive `userId` from the bearer token claims, or add an allow-list check mapping the authenticated principal to the requested `userId`.
- **Fix:** Identity now comes from the credential. `SIMORGH_API_KEYS` is a JSON `{"<token>": "<userId>"}` map; `authenticateServiceIdentity` (`phoenix-core/src/security.ts`) resolves a subject from it, and the route requires `subjectMatches(subject, userId)`. **Both hosts** were fixed — the Node runtime had the identical hole, which matters because `/api/v1/user/…/logs` is served by both and only one of them is covered by the workerd suite. A deployment that sets only `SIMORGH_API_KEY` cannot attribute a token to a user, so these routes answer **503 `IDENTITY_UNRESOLVED`** rather than guessing; that is a deliberate behaviour change for solo deployments and the message names the remedy. `403` for every non-matching `userId`, existing or not, so the route is not an oracle for which ids are real.
- **Verification:** Negative control run — with the ownership check disabled, the two new tests in `test/http.test.ts` fail (`expected 200 to be 403`); restored, both suites are green (134 workerd + 462 node). See AUTH-003 for the shared evidence.

### AUTH-003 — IDOR: any authenticated user can read any user's context *(FIXED 2026-10-08)*
- **Severity:** high
- **Evidence:** `src/index.ts:198` (`/api/v1/context/:refId`; `:419` in the fixed tree) and `simorgh-platform/src/runtimes/node.ts:303` — the same route on the self-hosted host. Absent from this audit's inventory entirely: the finding named the edge only, and the second host served it identically.
- **Impact:** Same pattern as AUTH-002: authentication verifies the caller but the `refId` in the URL selects the resource. Any authenticated user can read any other user's offloaded context (prompt + tools). The UUID refId is not secret, making enumeration trivial.
- **Recommended fix:** Same as AUTH-002 — scope context reads to the authenticated user, or make refId opaque-to-unauthenticated callers.
- **Fix:** The `refId` is now a claim that gets checked. `LedgerPort.findByRef(refId)` returns the append-only row that binds a reference to the principal that created it, and the route serves the payload only when that owner is the caller. A missing row is treated as **not yours**, never as "unowned, therefore allowed". Refusals return the *same* `404 {error:"not_found"}` as a reference that does not exist, so the route cannot be used to learn which references exist, and the stored payload is not read at all on that path. The `ref_id` index (`LEDGER_REF_INDEX`) is applied as a **second** `exec` rather than appended to `LEDGER_SCHEMA`, because the Node host's `SqlPort` is built on `node:sqlite`'s `prepare()`, which prepares one statement — a two-statement schema string would throw there while working on a Durable Object.
- **Verification:** Negative control run — with the ownership check disabled, the new AUTH-003 tests fail (`expected 200 to be 404`) on **both** hosts. Restored: `npm run typecheck` clean, `npm test` green (134 workerd + 462 node), `platform:smoke` 5/5, `e2e:ask` 10/10, Go build/vet/test green, `security:scan` PASS. Each test runs its **positive** control too (the owner is still served), because an ownership check that denies everybody is a different bug from one that denies nobody and a denial-only assertion cannot tell them apart.
- **Found but not fixed, and recorded so it is not rediscovered:** a token that exists *only* in `SIMORGH_API_KEYS` can read its own data but cannot call `/api/v1/agent/execute`, which still authenticates against `SIMORGH_API_KEY` alone. A multi-caller deployment must therefore issue both. Closing that is not mechanical: it means the `userId` must come from the token instead of `X-Simorgh-User-Id`, or a caller can spend another caller's rate-limit budget and write ledger rows in their name (AUTH-004). Noted at `NodeRuntimeOptions.apiKeys`.

### AUTH-004 — Rate-limit key is spoofable via `X-Simorgh-User-Id` header
- **Severity:** medium · **Status 2026-10-09:** OPEN — promoted to **EPIC-A3, the gate** in
  [`ROADMAP-SPINE.md`](ROADMAP-SPINE.md). Scope beyond this finding's original "rate-limit key" framing:
  credential → authenticated principal → `principalId` must own *every* task/schedule/memory/retrieval/
  connector/credential/ledger operation, with seven cross-principal negative tests (A cannot execute /
  schedule / read context / read logs / consume quota / search knowledge / invoke connectors as B).
  Multi-user autonomous execution is forbidden until A3 ships.
- **Evidence:** `src/index.ts:374` (edge rate limit key), `simorgh-platform/src/runtimes/node.ts:148-150` (the Node host's key), `phoenix-core/src/security.ts:226` (`parseExecuteBody` — userId from header or body)
- **Impact:** The rate limit is keyed on `execute:{userId}` where `userId` comes from the `X-Simorgh-User-Id` header or request body. An unauthenticated caller (hitting `/api/v1/agent/execute`... wait, that route requires auth). However, a holder of any valid bearer token can set `X-Simorgh-User-Id` to any value, causing rate-limit collisions — they can exhaust another user's quota, or reset their own by changing the key. The Telegram rate limit (`telegram:{from_id}`) is keyed on Telegram's own `from` field, which is not attacker-controlled but also not scoped to the operator's identity.
- **Recommended fix:** Derive the rate-limit key from the authenticated identity (e.g., a hash of the bearer token or a user claim in the token), not from a client-supplied header.

### INJ-001 — Provider response content is folded into the next prompt
- **Severity:** medium
- **Evidence:** `phoenix-core/src/agent.ts:146` (`buildSynthesisPrompt`, called at `:198`), `phoenix-core/src/tools.ts:58` (`createToolExecutor` returns provider content)
- **Impact:** The `search_web` tool fetches DuckDuckGo results and returns them as a string. That string is folded into the provider's prompt via `buildSynthesisPrompt`. If the provider were a different model (or if a provider were compromised), it could interpret content in the tool result as instructions. The agent loop itself is deterministic (iterates the caller's tool list, one tool per iteration), so the tool-call decision is not model-driven — but the model's *answer* is shaped by attacker-controlled web content.
- **Recommended fix:** The current design is safe against *tool-calling* injection because the loop, not the model, selects tools. Document this explicitly. Consider content-length limits on tool results (already `MAX_TOOL_RESULT_CHARS = 2_000`, `agent.ts:32/118`) and consider isolating provider-facing text from tool-result text in the synthesis prompt.

### INJ-002 — Telegram commands are user-supplied prompts
- **Severity:** low
- **Evidence:** `src/telegram.ts:240-285` (`/search`, `/time`, plain text all call `executeAgent`)
- **Impact:** Any Telegram user who knows the webhook secret can send any prompt to the agent with `tools: ["search_web"]` or `tools: []`. The agent executes the search and returns the answer. This is by design (the `/search` command exists for this purpose), but a compromised bot token turns the Telegram channel into a free-text agent interface. No user-level authorization separates operators from casual users.
- **Recommended fix:** Add operator-level authorization for Telegram commands beyond `/start` and `/help`, or treat the bot token as a shared secret among trusted operators only.

### SSRF-001 — No validation on fleet endpoint targets
- **Severity:** high
- **Evidence:** `simorgh-platform/src/fleet.ts:161` (`instanceIdFor` — no URL validation), `simorgh-platform/src/connectors/rest.ts:38` (connector dials any endpoint), `simorgh-platform/src/connectors/mcp.ts:96` (same)
- **Impact:** The fleet file (`~/.simorgh/fleet.json`) can contain any endpoint URL. The platform dials these endpoints via `connectorFor`, which calls `config.fetch(base + path, ...)`. An attacker who modifies the fleet file can point the platform at `http://169.254.169.254`, `http://localhost:8080`, or any internal host. There is **no private-IP block, no localhost check and no allow-list** — only `new URL()` parsing for the instance id. The `byo-endpoint` target exists precisely for this purpose ("point the platform at a core someone else runs"). The attack vector requires fleet file access, which is local to the operator's machine.
- **Recommended fix:** Add endpoint validation in `connectorFor` or `fleet-store.ts` — reject private/link-local IP ranges (169.254.0.0/16, 127.0.0.0/8, 10.0.0.0/8, etc.) and require HTTPS for non-localhost endpoints. Document whether this is an accepted risk (operator trusts their own fleet file).

### SSRF-002 — `OLLAMA_BASE_URL` is an operator-supplied fetch target
- **Severity:** medium
- **Evidence:** `simorgh-platform/src/runtimes/providers.ts:48` (`OLLAMA_BASE_URL` from env, interpolated into provider endpoint)
- **Impact:** The Node provider catalog creates an OpenAI-compatible provider from `OLLAMA_BASE_URL`. This endpoint is dialed by the agent loop when the Ollama provider is selected. If `OLLAMA_BASE_URL=http://169.254.169.254`, the provider would make a real HTTP request to the metadata service. This is operator-controlled (env var), so it is a trust-boundary issue, not an external-attacker issue.
- **Recommended fix:** Document the accepted risk. Optionally validate `OLLAMA_BASE_URL` resolves to a local address (must be local by design for Ollama), blocking external IPs.

### DEP-001 — `--yes` gate is explicit but plan argv is operator-influenced
- **Severity:** medium
- **Evidence:** `simorgh-platform/src/deploy/apply.ts:54` (`if (!options.confirmed)`), `simorgh-platform/src/cli.ts:237` (`values.yes !== true`), `simorgh-platform/src/deploy/runner.ts:33` (`shell: false`)
- **Impact:** The `--yes` gate cannot be satisfied implicitly — no env var, no config file, no default. The gate is solid. However, plan `argv` is built from `--origin` and `--service` template substitution (`plan.ts:145-146`). An operator who supplies `--origin="http://attacker.com;rm -rf /"` cannot inject commands because `runner.ts:33` uses `shell: false`. But the argument is still passed to the subprocess — a malicious origin could cause a downstream tool to make an unexpected HTTP request. The `byo-endpoint` target's endpoint template `{origin}` is similarly substituted into `curl` verify commands (`targets.ts:122`).
- **Recommended fix:** The shell-injection defense is solid. Consider validating that `--origin` is a well-formed URL with a host that resolves to a trusted network.

### DEP-002 — Deploy steps execute on the operator's machine with full env
- **Severity:** medium
- **Evidence:** `simorgh-platform/src/deploy/runner.ts:46-51` (`env: { ...process.env, ...options.env }`), `simorgh-platform/src/deploy/apply.ts:60` (`env` passed to runner)
- **Impact:** Every deploy step inherits `process.env` plus step-specific env. If the operator's shell has secrets loaded (e.g., `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`), deploy steps can access them. This is by design (steps need env) but means a compromised step or supply-chain attack in `npm ci` would have access to all environment variables.
- **Recommended fix:** Document the env inheritance as an accepted risk. Consider an opt-in env allow-list for production deploys.

### MCP-001 — Platform MCP server: no authentication on the MCP HTTP endpoint
- **Severity:** high
- **Evidence:** `simorgh-platform/src/mcp/server.ts:143` (MCP handler is a `FetchLike` — the route registration that calls it is not shown, but `platformMcpHandler` itself has no auth), `simorgh-platform/src/runtimes/node.ts:361` (`/mcp` route), `:398` (`handleMcpRequest`), `:403` (its `requireAuth`)
- **Impact:** On the Node runtime, `/mcp` requires auth (`requireAuth` → checks `SIMORGH_API_KEY`). On the Workers edge, the MCP server is exposed via a route — if that route does not enforce auth, any internet caller can call `platform_targets`, `platform_fleet` (which reveals all instance endpoints and health), and `platform_ask` (which executes prompts against the fleet). The platform MCP server exposes fleet topology and can trigger queries. This is a critical separation issue.
- **Recommended fix:** Verify the Workers route that serves `platformMcpHandler` has the same auth guard as other API routes. If it does not, add `requireServiceAuth` before the MCP handler.

### MCP-002 — Core MCP server exposes `simorgh_ask` which can execute arbitrary prompts
- **Severity:** medium
- **Evidence:** `runtimes/node.ts:492` (`MCP_TOOL_ASK` handler calls `executeAgent`; declared `:449`/`:454`), `simorgh-platform/src/mcp/server.ts:275-320` (`platform_ask` does the same at platform level)
- **Impact:** An MCP client with auth can send any prompt to the agent with any allowed tools. This is the intended function, but there is no per-user authorization — a token that can call `simorgh_ask` can ask the agent to search the web, fetch content, and synthesize answers on any topic. Combined with `simorgh_status`, an attacker can map the fleet and then query it.
- **Recommended fix:** This is by design for an MCP server. Document that MCP token holders are trusted operators. Consider scoping `simorgh_ask` to per-user rate limits and tool allow-lists.

### MCP-003 — Platform and core MCP prefixes are properly separated
- **Severity:** info (positive finding)
- **Evidence:** `simorgh-platform/src/mcp/server.ts:19` (comment: "this server publishes nothing under `simorgh_*`"), `runtimes/node.ts:449/454` (core exposes `simorgh_status` and `simorgh_ask` only)
- **Impact:** No confusion between "ask this core" (`simorgh_ask`) and "ask the fleet" (`platform_ask`). An agent reading tool lists can distinguish platform-level queries from core-level queries. This is a deliberate design choice that prevents prompt confusion attacks.
- **Recommended fix:** None. Document as a control.

### SEC-001 — Fleet file stores core API keys in plaintext
- **Severity:** high
- **Evidence:** `simorgh-platform/src/fleet-store.ts:74` (JSON write), `simorgh-platform/src/fleet.ts:31` (`CoreInstance` has `apiKey?: string`), `simorgh-platform/src/connectors/rest.ts:23` (connector reads `config.apiKey`), `simorgh-platform/src/connectors/mcp.ts:36` (same)
- **Impact:** The fleet file at `~/.simorgh/fleet.json` stores instance records including `apiKey` fields for REST and MCP connectors, in plaintext JSON. There is no file-permission enforcement — **no `chmod` anywhere in `fleet-store.ts`** — it relies on the directory's mode. The Go side (`packages/crypto/crypto.go`) seals provider keys with AES-256-GCM, but the TypeScript side has **no equivalent** — fleet file API keys are plaintext.
- **Recommended fix:** Encrypt the `apiKey` field in the fleet file at rest, or store keys in a platform secrets manager (e.g., `wrangler secret` on Workers, OS keychain on Node). At minimum, document the risk.

### SEC-002 — Asymmetry: Go seals secrets, TypeScript does not
- **Severity:** medium
- **Evidence:** `packages/crypto/crypto.go:2` (AES-256-GCM), `packages/crypto/crypto.go:67` (`Encrypt` seals), TypeScript fleet-store.ts (plaintext JSON)
- **Impact:** Provider API keys on the Go side are sealed with AES-256-GCM under argon2id-derived keys. The TypeScript fleet file has no encryption at all. A host compromise on the Node side exposes all recorded core API keys in plaintext; the same compromise on the Go side exposes sealed ciphertext. The asymmetry means the Node side is the weak link.
- **Recommended fix:** Add encryption at rest for the fleet file on the TypeScript side, matching the Go standard. At minimum, use OS keychain storage for the `apiKey` field.

### RES-001 — Unbounded provider answer could exhaust the Workers CPU budget *(FIXED 2026-10-08)*
- **Severity:** high (availability), fixed
- **Evidence:** `phoenix-core/src/provider.ts:122` returned `data.choices?.[0]?.message?.content ?? ""` with no length bound, and that value reached `sanitizeModelOutput` on every answer (`phoenix-core/src/execute.ts:166`) and every tool result (`:212`). Every *inbound* field was already capped (`MAX_PROMPT_CHARS`, `MAX_EXECUTE_BODY_CHARS`, `MAX_TOOLS`, `MAX_USER_ID_CHARS`); nothing bounded the way out.
- **Impact:** The sanitize passes are linear in input length, so an upstream — a hostile endpoint, a compromised key, or merely a misbehaving provider — chose how much CPU a request spends. Measured, not assumed (`bench/native-audit`, `docs/research/NATIVE-COMPUTE-AUDIT.md`): at a 128 KB answer the sanitizer cost **4.71 ms median and 11.72 ms p99**, against a **10 ms CPU limit per request** on the Workers Free plan. The p99 exceeded the entire per-request budget on its own, so a single oversized response could exhaust the CPU allowance for a request rather than merely slow it.
- **Fix:** `MAX_MODEL_OUTPUT_CHARS = 32_000` in `phoenix-core/src/security.ts`, applied as the **first** step of `sanitizeModelOutput` — before any pattern runs, since truncating afterwards would already have spent the CPU the cap exists to save. The value matches `MAX_EXECUTE_BODY_CHARS` deliberately, keeping one length policy instead of two that drift. Recorded as an `output_truncated` finding so the strip stays auditable rather than a silent mutation. Six tests in `phoenix-core/test/security.test.ts` — the file now holds **59** `it(` blocks — including the boundary case (an answer exactly at the cap is byte-identical, so the no-op guarantee survives) and the case that matters most for a length cap — that dangerous markup inside the retained prefix is still neutralised, so the bound is not a sanitiser bypass.
- **Verification:** Negative control run — with the cap removed, 5 of the 6 new tests fail; restored, all 59 in that file pass. `boundary.test.ts` still green (the cap adds no runtime binding), both suites green (129 workerd + 368 node), `typecheck` clean.
- **Residual, stated rather than hidden:** cutting the tail can leave an unterminated construct such as `<a href="` with no `>`. That is inert for a consumer rendering the text as text or markdown, and it is the same class of gap already documented for downstream renderers this function cannot see.

### SEC-003 — No secrets found in source files
- **Severity:** info (positive finding)
- **Evidence:** `grep -rInE '(ghp_|gho_|ghu_|ghs_|ghr_|sk-ant-|AIza[0-9A-Za-z_-]{20,}|xox[bpas]-|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})'` — no matches
- **Impact:** No hardcoded API keys, GitHub tokens, Google API keys, Telegram bot tokens, AWS keys, or private keys in source files. The fleet file is the only location for live keys, and it is on the operator's machine.
- **Recommended fix:** None needed. Continue scanning in CI.

### SEC-004 — No env files on disk
- **Severity:** info (positive finding)
- **Evidence:** `ls -la .env .env.* .dev.vars` — `.dev.vars` is present on disk (126 B), gitignored (`.gitignore:11`) and untracked
- **Impact:** No `.env` file is committed or tracked, and the security gate fails only on a *tracked* env file. `.dev.vars` exists but is never tracked, so the scan still reports **PASS — `.dev.vars` present but never tracked**. Secrets are passed via `wrangler secret` (Workers) or `process.env` (Node), not files.
- **Recommended fix:** None needed.

### ERR-001 — Doctor output exposes endpoint URLs and error details
- **Severity:** low
- **Evidence:** `simorgh-platform/src/doctor.ts:176` (`detail: health.detail`), `simorgh-platform/src/doctor.ts:184` (`detail: error`)
- **Impact:** `simorgh doctor` outputs the full error string from connector calls, which includes endpoint URLs (`http_401`, `bearer token rejected`, `ECONNREFUSED`), the recorded instance's endpoint, and HTTP status codes. While not a stack trace, this reveals infrastructure topology and auth state to anyone who can run `simorgh doctor` (which requires a local install).
- **Recommended fix:** Sanitize doctor output — strip hostnames from error strings, or provide a `detail` and `sensitiveDetail` field where only the former is shown by default.

### ERR-002 — Node runtime logs `String(error)` to stderr
- **Severity:** low
- **Evidence:** `runtimes/node.ts:266` (`process.stderr.write(JSON.stringify({ event: "request_error", requestId, path, error: String(error) }))`)
- **Impact:** On unhandled errors, the Node runtime writes `String(error)` to stderr, which may include provider error messages, upstream response bodies, or error objects with internal fields. This goes to the process stderr, not the HTTP response, so clients don't see it — but a log aggregator or a process-monitoring tool that captures stderr would.
- **Recommended fix:** Redact or truncate error strings before logging. Log the error type and message, not `String(error)` which may serialize internal fields.

### ERR-003 — Edge error handler is clean
- **Severity:** info (positive finding)
- **Evidence:** `src/index.ts:103-118` (`app.onError`)
- **Impact:** The edge Workers error handler returns generic `"The request could not be completed."` for unhandled errors, never stack traces or internal details. `RequestValidationError` returns the specific validation message, which is appropriate (it's user input errors).
- **Recommended fix:** None needed.

### RATE-001 — Rate limiting is a fixed-window SQL counter keyed on userId
- **Severity:** medium
- **Evidence:** `phoenix-core/src/rate-limit.ts:34` (`consumeRateLimit`), `src/index.ts:374` (key: `"execute:" + request.userId`)
- **Impact:** Fixed windows allow a 2x burst at window boundaries (user makes 20 requests at end of window 1, then 20 at start of window 2). More importantly: the key is `execute:{userId}` where `userId` comes from `X-Simorgh-User-Id` header. A holder of any valid bearer token can set this to any string — they can spread requests across many keys to evade limits, or concentrate another user's traffic in one key to trigger their rate limit. The Telegram path (`telegram:{from_id}`) uses Telegram's own user ID, which is better but still not tied to the platform's identity system.
- **Recommended fix:** Key rate limits on the authenticated identity (hash of bearer token or a server-issued user ID), not on a client-supplied header.

### TELE-001 — Telegram secret-token check uses constant-time compare
- **Severity:** info (positive finding)
- **Evidence:** `src/telegram.ts:128` (uses `constantTimeEqual` from `security.ts`, imported at `:3`)
- **Impact:** The check is constant-time over SHA-256 digests, preventing timing side-channels on the secret.
- **Recommended fix:** None needed.

### TELE-002 — Telegram auth check applied before body parsing
- **Severity:** info (positive finding)
- **Evidence:** `src/telegram.ts:128` (secret check, before `request.text()` at line 137)
- **Impact:** The webhook validates the `X-Telegram-Bot-Api-Secret-Token` before reading the request body. This prevents body-parsing DoS from unauthenticated callers and is the correct order.
- **Recommended fix:** None needed.

### TELE-003 — Bot token not logged, but used in error path
- **Severity:** low
- **Evidence:** `src/telegram.ts:162` (rate-limit notification uses `env.TELEGRAM_BOT_TOKEN`), `src/telegram.ts:100-107` (error handler uses `String(error)` in `console.error`, but `env.TELEGRAM_BOT_TOKEN` never appears in logs or responses)
- **Impact:** The bot token is never logged, echoed in errors, or returned in responses. It is used only to call `sendTelegramMessage`. No evidence of leakage.
- **Recommended fix:** None needed, but confirm with runtime log review.

### DEPS-001 — No known vulnerabilities
- **Severity:** info (positive finding)
- **Evidence:** `npm audit --omit=dev 2>&1 | tail -15` → "found 0 vulnerabilities"
- **Impact:** No published vulnerabilities in production dependencies.
- **Recommended fix:** Continue regular `npm audit` runs in CI.

---

## 2. Secrets Scan — Honest Version

```
grep -rInE '(ghp_|gho_|ghu_|ghs_|ghr_|sk-ant-|AIza[0-9A-Za-z_-]{20,}|xox[bpas]-|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})' \
  --include='*.ts' --include='*.js' --include='*.go' --include='*.yml' --include='*.toml' . 2>/dev/null | grep -v node_modules
→ (no output)

ls -la .env .env.* .dev.vars 2>/dev/null || echo "no env files on disk"
→ .dev.vars on disk (126 B) — gitignored, never tracked, so still no *tracked* env file

grep -rn 'apiKey\|API_KEY' --include='*.ts' simorgh-platform/src/fleet-store.ts
→ (no output — apiKey is in fleet.ts CoreInstance interface, not fleet-store.ts)
```

### Where does a core's API key live at rest, and what protects it?

**Go side (`packages/crypto/crypto.go`):** Provider secrets (e.g., `GROQ_API_KEY`, `HF_TOKEN`) are sealed with **AES-256-GCM** under keys derived via **argon2id**. This is the correct standard for secret-at-rest encryption. The sealed ciphertext is stored in the ledger/state.

**TypeScript side (`simorgh-platform/src/fleet-store.ts`, `fleet.ts`):** The fleet file at `~/.simorgh/fleet.json` stores `CoreInstance` records including the `apiKey` field **in plaintext JSON**. There is no encryption, no OS keychain usage, and no file-permission enforcement beyond the OS default. The file is written via `writeFile` then `rename` (atomic), but the content is unencrypted.

**Asymmetry assessment:** Yes, this is a finding. The Go side has envelope encryption (AES-GCM + argon2id); the TypeScript side has none. A host compromise that reads `~/.simorgh/fleet.json` exposes all recorded core API keys in cleartext. The fix is to either encrypt the `apiKey` field (matching the Go standard) or store it in a platform-provided secrets manager.

---

## 3. What Is Deliberately Not Protected

| Accepted risk | Documentation | Analysis |
|---|---|---|
| `/api/v1/flock/status` answers without auth | In-line comment at `runtimes/node.ts:207`: "Not authenticated, matching the edge" | **Undocumented risk.** The comment explains the *reason* (operator needs it before key is configured) but does not frame it as a security trade-off. Any caller can enumerate instance health. Should be an explicit risk acceptance in the PRD or ARCHITECTURE.md. |
| Fleet file endpoints are dialed without SSRF validation | `byo-endpoint` target in `targets.ts:202-208` exists for this purpose | **Documented by existence.** The "bring your own endpoint" target implies the operator trusts the endpoint. But there is no explicit statement that endpoint validation is intentionally absent. |
| Deploy steps inherit full `process.env` | No documentation in `deploy/runner.ts` or `apply.ts` | **Undocumented risk.** `runner.ts:46-51` merges `process.env` into step env. A supply-chain attack in `npm ci` or a malformed step could exfiltrate shell-loaded secrets. Should be documented in `docs/ARCHITECTURE.md`. |
| Telegram bot token has no per-user authorization | `src/telegram.ts:240-285` — all commands use the same token | **By design, but undocumented.** Any holder of the webhook secret can issue any Telegram command. The assumption is that the webhook secret is a shared operator secret. Should be stated in the PRD. |
| `CORS_ORIGINS` unset means "no browser origin" | `security.ts:66-69` and comment at `index.ts` CORS block | **Documented by code comment:** "An absent configuration allows nothing rather than everything." This is a secure default, not a gap. |

---

## Summary

| Severity | Count |
|----------|-------|
| High | 4 open (AUTH-001, SSRF-001, MCP-001, SEC-001) |
| Medium | 8 (AUTH-004, INJ-001, SSRF-002, DEP-001, DEP-002, MCP-002, SEC-002, RATE-001) |
| Low | 4 (INJ-002, ERR-001, ERR-002, TELE-003) |
| Info | 7 (MCP-003, SEC-003, SEC-004, ERR-003, DEPS-001, TELE-001, TELE-002) |
| High, **fixed** | 3 (RES-001, AUTH-002, AUTH-003 — all 2026-10-08) |

*Counts recounted from each finding's own `**Severity:**` line (2026-10-03). The table was
wrong in three of four rows: it undercounted High by one while listing six, counted `INJ-002`
as Medium when its finding declares Low, and omitted `MCP-002` and `SEC-002` from Medium
entirely. A hand-maintained summary of a machine-checkable list is exactly the kind of thing
that drifts, and a security document that miscounts its own HIGH findings is worse than no
summary — §4 accepted the six that were open at decision time; three of the seven are since fixed (§1).*

**RES-001 was found after this audit, by measurement rather than reading** — the `bench/native-audit`
lane (2026-10-07) timed the response-side sanitizer and found the outbound path had no length
bound at all, where the audit above had checked the inbound path and found four caps and moved
on. It is listed as fixed and separate from the six §4 accepts, so it is never mistaken for
something that was agreed to. The general lesson is the audit's own: a security document that
counts one direction of a flow is a description of half a flow.*

**Three findings to fix first:**
1. ~~**AUTH-002 (IDOR on `/api/v1/user/:userId/logs`)**~~ — **fixed 2026-10-08** with AUTH-003, which chained into it (see their entries). What remains of the original reasoning: it was the highest-value target because it leaked request history, and the same fix had to land on *both* hosts.
2. **AUTH-001 (unauthenticated `/api/v1/flock/status`)** — Any internet caller can learn which providers are configured and their health, giving a reconnaissance map for targeted attacks on under-configured cores. Fix: add `requireServiceAuth` or explicitly accept the risk in the PRD.
3. **SSRF-001 (no fleet endpoint validation)** — The platform dials whatever origin is in the fleet file with no validation against private/link-local IP ranges. While fleet file access is local, a compromised operator machine or a supply-chain attack on `simorgh connect` could inject internal targets. Fix: add a private-IP blocklist in `connectorFor` or `fleet-store.ts`.

---

## 4. Risk acceptance — recorded 2026-10-02

**Decision:** the repository owner chose to **defer the six HIGH findings** open at decision time (three of the seven are since fixed — §1) and proceed with
capability work, on the grounds that this is a single-operator deployment on free tiers with no
customer data. The findings above are **not** downgraded, not dismissed, and not closed: they stay
at their audited severity, and this section records *why* they are being carried.

### The acceptance, and exactly what it covers

| Finding | Carried because | What it would cost to fix |
|---|---|---|
| ~~**AUTH-002** IDOR on `/api/v1/user/:userId/logs`~~ | **No longer carried — fixed 2026-10-08.** Carried as: one principal, so the ledger's "users" were request-caller labels rather than tenants with data of their own. | Derive the id from the token instead of the path. Cost was "small, but changes the route contract" — which is what happened, and it took two hosts, not one. |
| ~~**AUTH-003** IDOR on `/api/v1/context/:refId`~~ | **No longer carried — fixed 2026-10-08.** Carried as: context offload is a KV convenience, not an isolation boundary. | The `refId` was the only link to a principal, so the fix needed the ledger to answer "who owns this reference" — one new port method and an index. |
| **AUTH-001** unauthenticated `/api/v1/flock/status` | The operator dashboard and `doctor` read it, and the operator needs it before a key is configured. | One `requireServiceAuth` call — but then a fresh deployment cannot show its own status. |
| **SSRF-001** fleet endpoints unvalidated | The `byo-endpoint` target exists precisely so the operator can dial a core they run. Validating it would narrow a feature that is the point. | A private/link-local IP blocklist in `connectorFor`. |
| **SEC-001** plaintext fleet API keys | Single-operator file on the operator's own machine, already `0600`-scoped by the OS. | Encrypt at rest — and `packages/crypto` already does exactly this in Go, so the code exists. |
| **MCP-001** Workers MCP handler auth unresolved | The finding is that the audit *could not locate* the route. It is unverified in either direction. | One verification, then possibly one guard. |

### The condition under which this acceptance is void

> **Triggered 2026-10-08.** Conditions **1** (a second principal) and **4** (a public deployment) both
> became true for the 11 October launch, so this acceptance is **void as it applies to AUTH-002 and
> AUTH-003** — both are now fixed rather than carried, and their rows below are strikes-through
> history, not live deferrals. The remaining four HIGH findings are still carried under this section.

**This acceptance expires the moment any of the following becomes true.** Each is a change in the
deployment's *shape*, not in its traffic, and each turns a single-principal assumption into a false
one:

1. **A second principal.** Any second real caller — a teammate, a shared bot, a hosted dashboard —
   turns AUTH-002 and AUTH-003 from theoretical into data disclosure between real accounts. They are
   the two findings that must be fixed *first*, and they are cheap.
2. **Provider credentials arriving from anywhere but the operator's own environment.** Per-account
   credentials are now a first-class concept (`phoenix-core/src/quota.ts`, `Provider.accountId`).
   The moment an account's secret can be supplied by anything other than the operator's shell or
   `wrangler secret`, SEC-001's blast radius stops being "my own machine" and starts being "every
   account I hold".
3. **Persistent user data on a network-reachable surface.** The ledger currently holds request
   metadata. The moment it holds anything a principal would not want another principal to read,
   AUTH-002 is a breach, not a finding.
4. **A public deployment.** Any core reachable from the open internet makes AUTH-001 a
   reconnaissance map and SSRF-001 a pivot, regardless of how few users exist.

### What is explicitly *not* deferred

- Authentication **fails closed** (`security.ts`) and stays that way. Unconfigured is `503`, never
  anonymous-allowed.
- CORS unset allows **nothing** (`isAllowedOrigin`). Unchanged.
- The `--yes` deploy gate stays. No env var, no config file, no CI exemption.
- The boundary test stays. No change may weaken `phoenix-core/test/boundary.test.ts`.
- No secret may be logged, echoed, committed, or written to a test fixture.

### Re-verification trigger

Any change that touches `src/index.ts` routes, `simorgh-platform/src/connectors/*`,
`fleet-store.ts`, or the MCP handler registration **must** re-read §1 of this audit before it is
reviewed. A PR that adds a route is a PR that can widen one of these six.
