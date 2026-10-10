# ADR-0008 — The unified surface: harness + API + chat gateways + free-only wizards

- **Status:** accepted
- **Date:** 2026-10-10
- **Decides:** the product's shape (four doors, one engine), the chat-gateway and memory port
  patterns, and the deploy-target constraint for both setup wizards
- **Amends:** the PRD (adds Epics 14–17); extends [ADR-0007](ADR-0007-adopted-patterns-from-working-open-source.md)
  (hermes-stack moves from reference row to adopted-with-changes)
- **Evidence:** the 2026-10-09 HF deploy debug session (export:
  `~/personal/projects/session-githubactiondebug.md`), the October audit, and the code as it
  stands (`src/telegram.ts`, `src/platform.ts`, `simorgh-platform/src/deploy/`)

## Decision in one line

Simorgh becomes **one engine with four doors** — the agent harness, the REST/MCP API, chat
gateways (Telegram today; Discord and Slack next), and two setup wizards (CLI + GitHub Pages) —
where every door is an instance of an existing port pattern and **every deploy target is
free-to-signup and no-KYC, verified against the target's current policy rather than its
reputation**, because the hermes-stack wizard died of exactly that gap.

## 1. Context

The operator's direction: *"the most unified harness + API + direct chat and gateways
(telegram discord slack etc…), deployable completely on free-to-signup and no-KYC providers,
persistent memory via telegram or google drive, and a wizard to set it up — two, one in CLI and
one in GitHub Pages."*

The hard requirement came with evidence. The debug session of 2026-10-09 (Kilo Code, against
the hermes-stack wizard) established two separate facts:

1. **A code bug, fixed and verified:** `HfApi.create_repo(sdk="docker")` — `sdk` was removed in
   `huggingface_hub` 2.x; `space_sdk="docker"` is the current name. The fix shipped to both
   `Shaiinarab/herme` (`f3ceba3`) and `Shaiinarab/hermes-stack` (`d74de4b`); dry-run green.
2. **A policy wall that no code can pass:** since **2026-07-08** Hugging Face returns
   `402 Payment Required` for *new* compute Spaces on free `cpu-basic` — *"Static Spaces are free
   for everyone, but hosting Gradio and Docker Spaces on free cpu-basic requires a PRO
   subscription."* HF's own docs now say it, community threads reproduce it, existing Spaces keep
   running but none can be created free. The wizard's premise ("free Hugging Face Space") is
   dead for Docker Spaces.

The architectural lesson is not "avoid Hugging Face". It is: **a wizard that hardcodes one
target dies when that target's policy moves**. Both wizards in this ADR are therefore
*target-matrix*: the target list is data, each entry carries a verified-free citation and a
date, and the matrix is re-verified on a schedule — the same "model IDs are cattle" discipline
the October audit mandates for birds, applied to deploy targets.

## 2. The four doors — each an instance of a pattern that already exists

The proof that this is a port problem, not a greenfield one, is in the tree: **Telegram is
already a fully wired chat gateway** (`src/telegram.ts`, 263 lines: update parsing, 4096-char
splitting, constant-time webhook-secret verification) declared as a connector in
`src/platform.ts` and mounted at `POST /api/v1/telegram/webhook` in `src/index.ts`.

**Door 1 — the harness.** `phoenix-core`'s `agent.ts` / `tools.ts` / `session.ts` / `tasks.ts` /
`swarm.ts`. Unchanged by this ADR; it is the product, not the work.

**Door 2 — the API.** REST + `/mcp`. Unchanged — with one precision worth recording: the deployed
Worker (`wrangler.toml` → `src/index.ts`) mounts **no `/mcp` route**; `/mcp` is the Node runtime's
(`simorgh-platform/src/runtimes/node.ts`). Door 2 exists on both, but only via that runtime.

**Door 3 — chat gateways.** One connector module per gateway in the host (`src/<gateway>.ts`),
following the telegram shape exactly: parse provider updates → bound the body → verify the
gateway's secret in constant time → split messages to the platform's limit → answer via the
existing agent path → declare the connector (secrets, route, docs) in `src/platform.ts`. A new
gateway is a host-side module and a declaration row; **the engine never learns which messenger
it is** — the same rule that keeps providers out of the routing policy. Discord (interactions
endpoint + signature) and Slack (events + signing secret) are the next two instances.

**Door 4 — memory.** A `MemoryStore` port whose default implementation is the DO SQLite the
engine already uses; **remote snapshots are ports on top, never on the answer path**: Telegram
(a private chat or channel: `sendDocument` snapshots + append-only log messages) or Google
Drive (a free Google account's 15 GB). Snapshot failure degrades to "memory is local-only" and
never blocks an answer — SOUL.md's honesty rule applied to storage. Telegram-as-storage is a
snapshot transport with platform limits (4096 chars/message, 2 GB/file), **not a database**;
the ledger and the DO remain the source of truth.

## 3. The wizards — two front-ends over the existing deploy planner

`simorgh-platform/src/deploy/` already contains the plan → apply → preflight chain. Both
wizards are thin, human-facing shells over that same planner:

- **CLI wizard** — zero-dependency script (python3 or node, both Termux-native), interactive:
  pick provider secrets → pick deploy target from the matrix → generate config → deploy →
  verify with a live probe. Must run on Termux (Android), plain terminals, and `cmd`.
- **GitHub Pages wizard** — a static, client-side page (the hermes-stack deploy.html pattern:
  tokens validated live against provider APIs, secrets written to a generated repo, the
  workflow dispatched from Actions). Its target matrix is Cloudflare-first because that is
  Simorgh's home turf and it survives the audit's checks: free, no card, no KYC. Hugging Face
  appears in the matrix **Static-Spaces-only** (dashboards), with the PRO-gate fact displayed
  when a user asks about Docker — the wizard tells the truth about the 402 instead of
  rediscovering it.

## 4. The deploy-target matrix (verified-free, dated, re-verified on a schedule)

| Target | Role | Verification |
|---|---|---|
| **Cloudflare Workers free** | home target — core + gateways | audit §D; the repo's existing home |
| **GitHub Pages** | the Pages wizard itself, dashboards | static is free for everyone (incl. post-2026-07-08 HF policy) |
| **GitHub Actions (public repos)** | catalog refresh, ToS-diff, keep-alive pings | audit §D — CI-shaped jobs only per Actions ToS |
| **Hugging Face Spaces — Static only** | dashboard hosting | **Docker/Gradio on free cpu-basic: 402 since 2026-07-08** (debug session + HF docs) |
| **Deno Deploy free** | secondary compute host | audit §D |
| **Telegram / Google Drive** | memory snapshot transport (not compute) | this ADR §2 |
| ~~Vercel Hobby~~ | refused for public/commercial use | non-commercial clause, audit §D |

Any target not on this table needs a verified-free check — with a fetched source and a date —
before it enters a wizard. That rule is the whole point of this ADR.

## 5. What is explicitly not decided here

- **No pooled-credential routing, no browser-automated web accounts.** ADR-0007 §3 and the
  audit's §B.2 stand: the flock dials API free tiers only.
- **No messenger-specific logic in the engine.** If a gateway needs something the engine
  doesn't have, the port is missing — the architectural rule, applied sideways.
- **Telegram is not the database.** The DO ledger stays the source of truth; snapshots are
  recovery aids, and their failure mode is honest silence, never an answer-shaped lie.

## 6. First slices (ordered by evidence × effort)

1. **Discord gateway** — proves the door-3 port pattern generalizes beyond Telegram; smallest
   increment, and the telegram test shape (parse/split/auth + negative control) is the template.
2. **Memory snapshot ports, Telegram first** — snapshot → restore round-trip against real DO
   SQLite, with the transport deliberately failed once (negative control).
3. **CLI wizard** over the existing deploy planner, Termux-safe.
4. **Pages wizard**, target-matrix, Cloudflare-first, HF-static-only, carrying the dated
   verified-free table.
5. **Slack gateway.**

## 7. Consequences

- The vision is mostly *composition*, not construction: one proven gateway pattern, one proven
  deploy planner, one proven wizard pattern, one proven snapshot trick. The new code is glue.
- The HF finding retires the single largest "free deploy" myth of 2025 and is now recorded with
  evidence in this repo — the bird-catalog discipline applied to infrastructure.
- Every new door ships with its negative control; a gateway whose secret check never fired is
  not a gateway.
