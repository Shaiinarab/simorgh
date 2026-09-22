# TASK-002 — Document the phoenix-core / simorgh-platform module boundary

- Owner: any
- Status: done (Lead 2026-09-21T22:17)
- Depends on: nothing · Estimate: 25–40 min · Runner: pool lane (headless) or an fb2/fb3 container session

## Why this exists

The repo was just split in two and **nothing explains the split**. `phoenix-core` is a
runtime-agnostic engine; `simorgh-platform` is the control plane that deploys cores and connects to
them. The rules that make that split real — which imports are forbidden where, which capability must
arrive as a port, why relative imports carry a `.ts` extension — currently exist only in source
comments. A contributor six weeks from now will break them by accident, and the failure will show up
as "it works on the edge and not on Node", which is the most expensive kind to debug.

Your job is to write that down, accurately. **Read the code, do not invent.** Every path, type name,
and rule you write must be one you verified in the tree.

## Read first (do not skip)

- `phoenix-core/src/index.ts` — the engine's public surface
- `phoenix-core/src/ports.ts` — every platform capability, and the comments explaining why each is a port
- `phoenix-core/src/node/index.ts` — the one deliberate `node:` adapter
- `phoenix-core/test/boundary.test.ts` — the rules *as executable assertions*; your prose must not contradict it
- `simorgh-platform/src/index.ts` — the platform's public surface
- `simorgh-platform/src/targets.ts` — the deployment target contract
- `simorgh-platform/src/runtimes/node.ts` — a complete second host for the same engine
- `simorgh-platform/src/connectors/{rest,mcp}.ts` — the two ways a core is reached
- `README.md` — the existing (now incomplete) repository map
- `.github/workflows/ci.yml` — what CI runs today

## Deliverable 1 — `docs/ARCHITECTURE.md`

New file. It must cover, with real names and real paths:

1. **The two packages and the one-way arrow.** What each owns. State the rule plainly: the platform
   imports the core; the core imports nothing from the platform.
2. **The host/engine split as a table.** "The core owns" (`flyFlock` routing + cooldowns, the agent
   tool loop, `parseExecuteBody` validation, bearer auth, the rate-limit counter, the flock status
   payload, the ledger shape) vs "the host owns" (which providers exist, where secrets come from, how
   SQL is reached, how the result is transported).
3. **The port table.** For each of `SqlPort`, `FetchLike`, `HttpLike`, `PhoenixPorts`,
   `ContextStorePort`, `LedgerPort`, `WorkersAiPort`: what it abstracts, and which host supplies it
   (Cloudflare host = `src/`, Node host = `simorgh-platform/src/runtimes/node.ts` + `phoenix-core/src/node`).
4. **The target × connector matrix.** For each registered target: runtime, which connector kinds it
   speaks, which modes it supports, and its required secrets. Take this from `targets.ts`, not memory.
5. **The invariant list** — the rules a change must not break, each with *why it exists* and *what
   catches it*:
   - no `cloudflare:` import inside `phoenix-core/src` (caught by `boundary.test.ts`)
   - no `node:` import outside `phoenix-core/src/node/` (same)
   - no bare runtime globals in the core — no `TextEncoder`, `Response`, `Request`, `crypto.`,
     `DurableObject`, `SqlStorage` (same)
   - each port is declared exactly once, in `ports.ts` (same)
   - relative imports carry an explicit `.ts` extension, because plain `node` must execute the
     sources unbuilt (`ERR_MODULE_NOT_FOUND` otherwise)
   - no TypeScript-only runtime syntax — no parameter properties, no `enum`, no `namespace` —
     because Node's type stripping refuses them (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). This one bit
     `RequestValidationError` and is worth a sentence.
   - the `birdId` / `birds` / `answered_by` field names are a **published API contract** and stay,
     even though the engine's internal vocabulary is "provider"
6. **Three how-to recipes**, short and concrete: adding a provider, adding a deployment target
   (point at `EXTENSION_POINT` in `targets.ts`), adding a host.
7. **Where to run things**: the two test suites (`npm run test:workers`, `npm run test:node`), why
   they are separate configs, and what each one can and cannot catch.

Aim for something a competent newcomer reads once and then cannot get wrong. Prefer tables and short
paragraphs over prose. Do not pad.

## Deliverable 2 — `README.md`

Add a **Modules** section. Keep the existing style (emoji headers, tight tables) and do not delete
existing content. It must state that the repo now holds two packages, name them, and link
`docs/ARCHITECTURE.md`. If the existing "Repository Map" block is now wrong or incomplete, correct it
rather than leaving a contradiction.

## Deliverable 3 — `.github/workflows/ci.yml`

Verify the Node suite actually runs in CI. `npm test` is defined as `test:workers && test:node`, so
`npm ci` + `npm test` **should** cover both — confirm it by reading the scripts in `package.json` and
the workflow, then either (a) state in a workflow comment that `npm test` covers both suites, or
(b) add an explicit `npm run test:node` step if you find a gap. Do not restructure the workflow.
Keep the existing `GOFLAGS: -mod=readonly` comment — it exists for a documented reason.

## Allowlist — touch nothing else

```
docs/ARCHITECTURE.md
README.md
.github/workflows/ci.yml
```

No source file may be modified. If you find a real bug while reading, do **not** fix it: write it up
in your report's `## Next_actions` and carry on.

## Acceptance — run these and paste the results

```bash
test -f docs/ARCHITECTURE.md && echo OK-file
npm run typecheck && echo OK-typecheck
npm test && echo OK-tests                  # both suites: workers + node
grep -q 'phoenix-core' README.md && echo OK-readme
grep -q 'simorgh-platform' README.md && echo OK-readme2
grep -q 'test:node\|npm test' .github/workflows/ci.yml && echo OK-ci
```

Then the honesty check — **every path and symbol you named must exist**:

```bash
# For every repo path you wrote in docs/ARCHITECTURE.md, assert it resolves.
grep -oE '(phoenix-core|simorgh-platform|src|test|docs)/[A-Za-z0-9_./{}-]+\.(ts|md|json|yml)' docs/ARCHITECTURE.md \
  | sort -u | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
# Expect no MISSING lines. A named-but-absent path is the failure mode this check exists for.
```

## Report

`mailbox/OUTBOX/TASK-002-REPORT.md`, per the template, ending with `TASK-002-END` as the last
non-empty line. Include the acceptance output verbatim. If a claim could not be verified, say so
instead of asserting it.
