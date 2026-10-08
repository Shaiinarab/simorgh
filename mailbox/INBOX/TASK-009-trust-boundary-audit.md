# TASK-009 — trust boundary: what can an attacker make Simorgh do?

- Owner: any
- Status: done (Lead 2026-09-22T14:46)
- Depends on: nothing · Estimate: 45–70 min · Runner: codex lane (headless)

## Why this exists

Simorgh is an **agent that runs tools** behind a **control plane that deploys and connects to remote
cores**. Both halves take instructions from outside the trust boundary:

- the agent loop feeds provider output back into a model that then decides which **tool** to call
- the platform reads a **fleet file** and dials whatever origins are in it
- a **Telegram webhook** accepts messages from the internet
- `deploy --mode cli --yes` runs plan steps as **real commands on the operator's machine**
- MCP servers expose tools to clients that may be other agents

So the central question is not "are there vulnerabilities" — it is this, and your report must answer it
in one sentence before anything else:

> **What can an attacker make a Simorgh agent, connector, or deployer do that the user did not
> explicitly authorize?**

## Read first (this is the trust boundary — read it as such)

- `phoenix-core/src/security.ts` — bearer auth, the constant-time compare, and **fail-closed** behaviour
- `phoenix-core/src/agent.ts` — the agent loop: how tool calls are chosen and how tool output is fed back
- `phoenix-core/src/tools.ts` — the tool bodies, shared by every host
- `phoenix-core/src/execute.ts` — the pipeline order, including where the ledger write sits
- `src/index.ts` — the Worker's routes, CORS, and the Intent Shield/tool allow-list
- `src/telegram.ts` — the webhook, and its `X-Telegram-Bot-Api-Secret-Token` check
- `simorgh-platform/src/deploy/{apply,runner,plan,preflight}.ts` — **the `--yes` gate and what a step runs**
- `simorgh-platform/src/connectors/{rest,mcp}.ts` — what the platform will dial, and with what
- `simorgh-platform/src/mcp/server.ts` — tools exposed to *other* agents
- `simorgh-platform/src/runtimes/node.ts` — the self-hosted core's route table
- `docs/ARCHITECTURE.md` — the invariants, so you can tell a violation from a design choice

## Deliverable — `docs/SECURITY-AUDIT.md` (new)

### 0. The answer

One sentence answering the central question, then the trust-boundary diagram (what is inside, what is
outside, what crosses). Be concrete about which components are *untrusted input sources*.

### 1. Findings, each with a severity and evidence

Table: `id`, `severity` (`high`/`medium`/`low`/`info`), `finding`, `evidence (file:line)`, `impact`,
`recommended fix`. Severity must be justified in one clause — `high` means an attacker outside the
boundary achieves it without extra privileges.

Cover at least these surfaces, and **say explicitly when a surface is fine** — a "checked, clean, here
is the mechanism" line is a real result:

- **Authentication.** Is the constant-time compare actually constant-time in the way it is used? Does
  the fail-closed path (unset `SIMORGH_API_KEY`) fail *closed* everywhere, or is there a route that
  still answers? What happens on a malformed `Authorization` header?
- **Authorization.** Is there any difference between "authenticated" and "authorized"? Can one user
  read another user's logs or context (`/api/v1/user/{id}/logs`, `/api/v1/context/{id}`)? **This is
  the highest-value question in the document** — an IDOR here is a data-leak bug, and the ids are in
  the URL.
- **Tool abuse / prompt injection.** Trace it concretely: a provider returns text containing
  instructions. Can that text cause a tool call the user did not ask for? What exactly prevents it —
  is the allow-list the only control? Can a *tool result* (e.g. fetched web content) inject the next
  iteration?
- **SSRF.** `byo-endpoint` targets and provider base URLs are operator-supplied origins that the
  platform *dials*. What stops a fleet entry from pointing at `169.254.169.254`, `localhost`, or an
  internal host? Is there any validation at all? (Answer with the code.)
- **The deploy gate.** Can `--yes` be satisfied implicitly — an env var, a config file, a CI
  environment, a default? What does `runner.ts` actually execute, and could a plan's argv be influenced
  by data rather than by `targets.ts` literals?
- **MCP exposure.** What does the platform's MCP server let a *client* do to the fleet? What does a
  core's MCP server let a client do? Are they separated (the `platform_*` vs `simorgh_*` distinction)?
- **Secrets.** Are any secrets logged, echoed in errors, returned in responses, or persisted
  unencrypted? Where does the fleet file keep a core's API key, and what are its permissions?
- **Error leakage.** Do error responses or `doctor` output expose internals (paths, versions, stack
  traces, upstream provider messages)?
- **Rate limiting.** What is it keyed on? Can it be bypassed (spoofed header, rotating path, no auth)?
- **Telegram.** Is the secret-token check constant-time? Is it applied before the body is parsed? Is
  the bot token ever logged?
- **Dependencies.** `npm audit --omit=dev` — run it and report the real output.

### 2. Secrets scan — the honest version

Run and report. Redact values; report `file:line` and the *kind* of match only.

```bash
grep -rInE '(ghp_|gho_|ghu_|ghs_|ghr_|sk-ant-|AIza[0-9A-Za-z_-]{20,}|xox[bpas]-|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})' \
  --include='*.ts' --include='*.js' --include='*.go' --include='*.yml' --include='*.toml' . 2>/dev/null | grep -v node_modules
ls -la .env .env.* .dev.vars 2>/dev/null || echo "no env files on disk"
grep -rn 'apiKey\|API_KEY' --include='*.ts' simorgh-platform/src/fleet-store.ts
```

Then answer: **where does a core's API key live at rest, and what protects it?** The Go side
(`packages/crypto`) seals provider keys with AES-GCM; state whether the TypeScript side does anything
equivalent, and whether the asymmetry is a finding.

### 3. What is deliberately NOT protected

Every real system accepts risk. List what this one accepts and whether it is documented. If an
accepted risk is undocumented anywhere, that is itself a finding.

## Rules for this audit

- **No offensive testing against anything you do not control.** Do not port-scan, do not probe external
  hosts, do not attempt to reach cloud metadata endpoints, do not send traffic anywhere except
  `127.0.0.1`. Reason from the code for SSRF and describe the attack; do not perform it.
- **Read-only.** Do not edit source or tests. Report; do not fix. The Lead triages.
- **No fabrication.** If you could not determine something, write "not determined" plus what you would
  need. A confident wrong finding costs more than an admitted gap.
- **Distinguish a design choice from a bug.** `CORS_ORIGINS` unset meaning "no browser origin" is a
  choice; a route that answers without auth is a bug. Say which you think each one is.

## Allowlist — touch nothing else

```
docs/SECURITY-AUDIT.md   (new)
```

## Acceptance — run these and paste the output verbatim

```bash
cd /home/shai/personal/projects/projects/opensource/simorgh-platform
npm audit --omit=dev 2>&1 | tail -15
npm run typecheck && echo OK-typecheck
npm test 2>&1 | grep -E "Test Files|Tests " && echo OK-tests
grep -rIn 'corsOrigin\|CORS' src/security.ts src/index.ts | head
```

## Report

`mailbox/OUTBOX/TASK-009-REPORT.md`, per `mailbox/README.md`, ending with `TASK-009-END` as the last
non-empty line. Include the acceptance output verbatim, the finding count by severity, and
**explicitly name the three findings you would fix first and why**.
