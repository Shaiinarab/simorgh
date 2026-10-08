# Security Policy

Simorgh is a free-to-run, no-KYC agentic AI gateway: it federates free-tier model providers into
one "flock" and answers through whichever is healthy and configured
([`README.md`](README.md), [`package.json`](package.json)). It is maintained by **a single maintainer**
and is deployed by **one operator**, usually on free tiers, with **no customer data**.

That posture is not hedging — it is the recorded basis for every security decision in this repository.
It is also why the highest-value reports are narrower than they would be for a hosted multi-tenant
service. Both are spelled out below, and both are traceable to
[`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md), which is the real document. This file is a
disclosure policy and a map; the audit is the evidence.

---

## Supported versions

**There is no release-support policy in this repository, because there is no release process.** This
clone contains **no git tags and no `CHANGELOG`**, and `.github/` holds a single workflow
(`workflows/ci.yml`) which builds and tests — it does not publish. `package.json` carries
`version: 2.0.0`, but nothing in the repository publishes it. The only supported configuration is
therefore:

> **The current tip of the repository, as CI runs it.**

Older commit-level states are not supported and will not receive fixes. If your report depends on a
specific commit, say which, and check whether the tip still has the shape you tested.

| What is pinned | Where it is pinned |
|---|---|
| Node **22** | `.github/workflows/ci.yml` (`node-version: 22` in two jobs). Its comment states upm requires Node 22.3+ and cites [`docs/adr/ADR-0004-toolchain-upm.md`](docs/adr/ADR-0004-toolchain-upm.md). |
| Go **1.25** | `.github/workflows/ci.yml` (`go-version: "1.25"`), for the Go workspace under `gateway/`, `packages/`, `bot/`, `tools/`. |
| TypeScript 7 via `tsgo` | `@typescript/native-preview` in `devDependencies`; `npm run typecheck` runs three configs. |
| Cloudflare Workers | `wrangler.toml` (`main = "src/index.ts"`), `wrangler ^4.132.0`. |
| Package manager | **upm**, with `upm.lock` committed. No `package-lock.json`, and none may be created — see [ADR-0004](docs/adr/ADR-0004-toolchain-upm.md) and `.gitignore`. |

**Known inconsistency, reported rather than smoothed over:** `package.json` declares
`engines.node: ">=20"`, but CI runs Node 22 and the repository's own rationale is that upm needs
22.3+. The deploy preflight also rejects any runtime older than the workspace's `engines.node` — so a
Node 20 host satisfies that check while `upm install` still requires 22.3+. **Proposal (not a claim
about current behaviour):** raise `engines.node` to `>=22.3`. That is a code change and is
deliberately not made here.

---

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting.** It is the only channel this project can honour:

> <https://github.com/Shaiinarab/simorgh/security/advisories/new>

A private advisory is visible only to the maintainer until it is published. If that URL 404s, private
vulnerability reporting is not enabled on the repository — please say so in a plain issue with **no
technical detail**, because that is itself worth knowing.

**Do not** open a public issue, pull request, or discussion containing vulnerability details, and **do
not** paste a live credential. If you found a credential, describe its **location and format** and let
the maintainer retrieve it; describe it the way you would redact it for a bug report.

### What this project does and does not offer — plainly

- **No published email address.** There is no security inbox, no `security.txt`, and no contact
  address anywhere in this repository. None is invented here, because an address nobody monitors is
  worse than no address.
- **No response-time SLA.** There is one maintainer. A report may be read promptly or not read at all.
- **No bug bounty, no PGP key, no 24×7 channel.**
- **No confidentiality guarantee beyond the advisory's own visibility.** Do not include third-party
  credentials, or anything you are not authorised to disclose.

### What a useful report contains

Because triage is done by hand against the audit, a report that speaks the audit's vocabulary is
dramatically faster to act on:

1. **Which boundary it crosses.** The audit's diagram (below) names the trusted components and the
   untrusted input sources — say which one your input arrived through.
2. **Whether it is already recorded.** The audit's §1 has 25 findings with stable IDs (`AUTH-002`,
   `SSRF-001`, `SEC-001`, …). If yours matches one, say so and give the **new** part: a different path,
   a working proof, or evidence that one of the void conditions below has been met.
3. **Which host.** A core on the Workers edge, a core on the Node runtime, and the platform CLI are
   different deployments of the same engine and have genuinely different exposure.
4. **Whether it voids the risk acceptance.** The audit names four conditions that void it (listed
   below). Three of them are about money, credentials, and cross-caller data: if your report reaches
   one, say which explicitly — that is the difference between a deferred finding and an incident.

---

## What counts as a vulnerability here

This is a single-operator gateway whose "users" in the ledger are **request-caller labels, not tenants
with data of their own** ([audit §4](docs/SECURITY-AUDIT.md)). A report is worth the maintainer's time
when it threatens one of these:

1. **Making the deployment spend money it was not told about.** The cost model makes this
   structural: `FREE_ONLY` is the default mode, and under it both `paid` and `unknown` cost classes are
   ineligible ([`docs/adr/ADR-0005-free-only-mode.md`](docs/adr/ADR-0005-free-only-mode.md)). Anything
   that routes onto billable capacity without an explicit `PAID_ALLOWED`, that turns an `unknown` cost
   into a charge, or that spends an operator's money by another route is the top-priority report in
   this project. `QuotaState.cost` is a **required** field precisely so a missing value cannot buy
   capacity.
2. **Leaking an operator's provider credential.** Provider keys are optional by design (the gateway
   runs with zero secrets) but each one the operator adds is a bill and a liability. Relevant surfaces
   are named in [Secrets policy](#secrets-policy) and in audit §2.
3. **Letting one caller read another's data.** Two IDORs are already recorded and accepted
   (`AUTH-002` on the ledger, `AUTH-003` on offloaded context) *because the acceptance holds*. What is
   new and valuable is any **third** cross-principal path, or evidence that the deployment now has a
   second real principal — which voids the acceptance immediately.
4. **Weakening a fail-closed control.** Authentication returns `503 AUTH_NOT_CONFIGURED` when
   unconfigured and never anonymous-allowed ([`phoenix-core/src/security.ts`](phoenix-core/src/security.ts));
   `CORS_ORIGINS` unset allows **nothing**; `deploy --mode cli` requires `--yes` with no env var, no
   config file and no CI exemption; the tool allow-list is enforced at the Durable Object boundary. A
   change that makes any of these open is a vulnerability even if nothing is exploited today.
5. **Bypassing the deploy consent gate**, or turning the platform into an SSRF pivot — the fleet file
   is dialled with no endpoint validation, by design of the `byo-endpoint` target (`SSRF-001`,
   accepted; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4 for the target matrix).

**Why those three are first, stated plainly.** This project runs on free tiers with no customer data,
so a report has to earn its attention against a narrow threat model. The most valuable reports are the
ones that could:

| The report would let an attacker… | Which accepted finding it re-opens | Which void condition it meets |
|---|---|---|
| **make it spend money it was not told about** | `SEC-001` (whose blast radius stops being one machine) | (2) credentials/accounts arriving from outside the operator's environment |
| **leak an operator's provider credential** | `SEC-001` | (2) |
| **let one caller read another's data** | `AUTH-002`, `AUTH-003` | (1) a second principal, and (3) persistent user data on a reachable surface |

Those are the conditions the audit itself singles out. A public deployment — (4) — voids the
acceptance for `AUTH-001` and `SSRF-001` on its own, with no bug required.

## What does not count

Stated explicitly, so the maintainer does not have to spend a triage cycle on it:

- **A restatement of an already-recorded finding.** They are not dismissed — they are recorded with
  evidence, and re-reporting one adds nothing. New evidence, a new path, or a void condition being met
  *is* something.
- **Absence of multi-tenant isolation, while the single-operator acceptance still holds.** See the
  [void conditions](#the-accepted-high-findings-and-their-void-conditions).
- **Prompt-injection content reaching the model as prose.** The agent loop is deterministic and selects
  the tools, not the model, so attacker-influenced web text shaping an *answer* is not a tool-calling
  bypass (`INJ-001`). It becomes one the moment tool selection becomes model-driven.
- **Anything that already requires a valid provider credential, or write access to the operator's
  fleet file, to reach.** That is the accepted trust model — the fleet file is the operator's own
  file. Escalate if the same path yields anything *more* than what the reporter already had.
- **A dependency CVE with no reachable path here.** Report it upstream; `npm run security:scan` already
  audits shipped dependencies and currently reports zero. (The dependency gate resolves a throwaway
  tree from `package.json`, because upm does not proxy `npm audit` — see [ADR-0004](docs/adr/ADR-0004-toolchain-upm.md).)
- **Architectural or style preferences.** Those are contributions, not reports — see
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Security boundaries

Summarised from [the audit's trust-boundary diagram and §3](docs/SECURITY-AUDIT.md); read the audit for
the diagram, the per-finding evidence with file and line references, and the deliberately-unprotected
table.

**Trusted (inside the boundary):**

| Component | File | What it is trusted to hold |
|---|---|---|
| The agent loop | `phoenix-core/src/agent.ts` | Choosing between the two vetted tools, folding results into the prompt |
| The tool executor | `phoenix-core/src/tools.ts` | Exactly two tools: `search_web` (DuckDuckGo) and `get_server_time` |
| The deploy gate | `simorgh-platform/src/deploy/apply.ts` | Refusing to run without an explicit `--yes` |
| The transparency ledger | `phoenix-core/src/ledger.ts` | An append-only log, written *before* the flight |

**Untrusted (outside the boundary — these are the inputs):**

| Source | File | Note |
|---|---|---|
| Telegram webhook | `src/telegram.ts` | Internet-facing; authenticated only by a shared secret token, verified in constant time before the body is read |
| Fleet file | `simorgh-platform/src/fleet-store.ts` (`~/.simorgh/fleet.json`) | Operator-edited JSON naming the endpoints **and API keys** the platform dials |
| Plan argv | `simorgh-platform/src/deploy/plan.ts` | `--origin` / `--service` substituted into commands (spawned with `shell: false`) |
| Request body | `src/index.ts` (`POST /api/v1/agent/execute`) | Caller-supplied prompt, tool list and `userId` |
| Provider responses | — | Text folded into the next prompt iteration |
| MCP clients | — | Any agent connecting to the platform or core MCP servers |

**What crosses it:** a Telegram message → webhook handler → `executeAgent` → agent loop → tool fetch →
provider response → next prompt; a fleet file → connectors → external origins; a `--yes` flag →
shell commands via `spawn`.

**The structural point the audit keeps returning to:** authentication stops at the service token and
authorization stops at the URL path. That is why the two IDOR findings are the ones carried first —
their fix is to bind identity to the request rather than the path.

---

## The accepted HIGH findings and their void conditions

**An accepted finding is not a fixed finding.** The audit's words, quoted because the distinction is
the whole point: the six HIGH findings are *"**not** downgraded, not dismissed, and not closed: they
stay at their audited severity, and this section records **why** they are being carried."*

Full record, with the reason and the cost-to-fix for each: [audit §4](docs/SECURITY-AUDIT.md).

| Finding | Carried because | Fixing it would cost |
|---|---|---|
| `AUTH-002` — IDOR on `/api/v1/user/:userId/logs` | One principal; ledger "users" are caller labels | Derive the id from the token instead of the path — small, but a route-contract change |
| `AUTH-003` — IDOR on `/api/v1/context/:refId` | Same posture; context offload is a KV convenience, not an isolation boundary | Same shape as `AUTH-002` |
| `AUTH-001` — unauthenticated `/api/v1/flock/status` | The operator dashboard and `doctor` need it before a key exists | One `requireServiceAuth` call — but a fresh deployment could no longer show its own status |
| `SSRF-001` — fleet endpoints dialed unvalidated | `byo-endpoint` exists so the operator can dial a core they run | A private/link-local blocklist in `connectorFor` |
| `SEC-001` — plaintext fleet API keys | Single-operator file on the operator's own machine | Encrypt at rest — and `packages/crypto` already does exactly this in Go |
| `MCP-001` — Workers MCP handler auth unresolved | The finding is that the audit **could not locate** the route; unverified in either direction | One verification, then possibly one guard |

### The condition under which the acceptance is void

The acceptance **expires the moment any of these becomes true**. Each is a change in the deployment's
*shape*, not its traffic, and each turns a single-principal assumption into a false one:

1. **A second principal.** A teammate, a shared bot, a hosted dashboard. `AUTH-002` and `AUTH-003`
   become disclosure between real accounts — they are the two to fix **first**, and they are cheap.
2. **Provider credentials arriving from anywhere but the operator's own environment.** Per-account
   credentials are now a first-class concept (`phoenix-core/src/quota.ts`, `Provider.accountId`). Once
   an account's secret can come from anywhere other than the operator's shell or `wrangler secret`,
   `SEC-001`'s blast radius stops being "my own machine".
3. **Persistent user data on a network-reachable surface.** The ledger holds request metadata today.
   The moment it holds something one principal would not want another to read, `AUTH-002` is a breach.
4. **A public deployment.** Any core reachable from the open internet makes `AUTH-001` a reconnaissance
   map and `SSRF-001` a pivot, regardless of how few users exist.

**A report that demonstrates one of these four is the single most valuable thing a reporter can
bring.** It does not need a novel bug.

### What is explicitly *not* deferred

From the same section, and not negotiable: authentication **fails closed**; `CORS_ORIGINS` unset allows
**nothing**; the `--yes` deploy gate stays; no change may weaken
`phoenix-core/test/boundary.test.ts`; and **no secret may be logged, echoed, committed, or written to a
test fixture**.

### Re-verification trigger

Any change touching `src/index.ts` routes, `simorgh-platform/src/connectors/*`, `fleet-store.ts`, or the
MCP handler registration **must** re-read §1 of the audit before review. A PR that adds a route is a PR
that can widen one of these six.

---

## Secrets policy

**No secrets in code, ever.** Configuration arrives by **env-var reference** — `env.SIMORGH_API_KEY`,
`process.env.CORS_ORIGINS` — never as a literal. The declared secret surface lives in
[`env.d.ts`](env.d.ts); the set `wrangler.toml` expects is documented in its own comments, and the local
template is [`.dev.vars.example`](.dev.vars.example) (`.dev.vars` itself is gitignored and must never
be committed).

**`worker-configuration.d.ts` is generated — never hand-edit it.** It is produced wholesale by
`wrangler types` (`npm run types`) and is committed only so a fresh clone typechecks without booting
Wrangler. Hand-written additions go in `env.d.ts`, and a secret must be declared on **both** `Env` and
`Cloudflare.Env` — they are separate interfaces, so declaring it on only one yields an `env.X` that
typechecks in the router and fails inside a Durable Object. The same "never hand-edit" rule covers
`upm.lock` and `go.work.sum`.

### The gate that enforces it

`npm run security:scan` → [`scripts/security-scan.sh`](scripts/security-scan.sh), which is the **same
script CI runs** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

- scans for high-signal **token formats** — provider key prefixes, Google API keys, Slack tokens, AWS
  access-key ids, PEM private-key headers, JWTs — across `.ts`, `.js`, `.mjs`, `.json`, `.go`, `.yml`,
  `.yaml`, `.toml`, `.sh`, **`.md`** and `.example` files, excluding `node_modules/`, `dist/` and
  `.git/`;
- prints **`file:line` with the value redacted** — never the value;
- fails if an environment file is **tracked by git** (present on disk but untracked is only a warning);
- audits shipped dependencies, and **fails closed**: if dependency resolution cannot run, or reports
  success without writing a lockfile, the gate **fails**. A gate that quietly passes when it cannot
  check is worse than no gate.

It is read-only, idempotent, needs no account and no licence, and is meant to be run before a commit.

### Known asymmetry, recorded not hidden

From audit §2: the Go side seals provider secrets with **AES-256-GCM** under **argon2id**-derived keys
(`packages/crypto/crypto.go`). The TypeScript side has **no equivalent** — the fleet file at
`~/.simorgh/fleet.json` stores core `apiKey` values in **plaintext JSON**, protected only by the OS
default. That is `SEC-001`, one of the accepted findings above, and it is why a report about *how* those
keys are exposed is worth more than a report about whether they are encrypted today.

---

## Where the rest of the evidence lives

| Document | What it holds |
|---|---|
| [`docs/SECURITY-AUDIT.md`](docs/SECURITY-AUDIT.md) | The trust-boundary diagram, 25 findings in §1 with file/line evidence, the deliberately-not-protected table, the honest secrets scan, and the §4 risk acceptance |
| [`AGENTS.md`](AGENTS.md) | The operating contract: commands, conventions, Definition of Done, the "never do" list |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Port table, the invariant list, the target × connector matrix, how-to recipes |
| [`docs/adr/ADR-0005-free-only-mode.md`](docs/adr/ADR-0005-free-only-mode.md) | Why cost is a three-state fact and why the default is closed |
| [`docs/adr/ADR-0004-toolchain-upm.md`](docs/adr/ADR-0004-toolchain-upm.md) | Why upm is the package manager and how the dependency-audit gate survived the migration |
| [`docs/QUALITY.md`](docs/QUALITY.md) | An audit of assertions that cannot fail — read it before trusting a green suite |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Prerequisites, the two test suites, the verification discipline, the PR checklist |
