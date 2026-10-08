# TASK-014 — Mission Control: make the dashboard tell the truth, and prove it renders

- Owner: any
- Status: open
- Depends on: nothing · Estimate: 120–180 min · Runner: **UI/UX specialist** agent

## 0. Start here: introduce yourself

Before you read anything else, write a short introduction as your **first** action, into
`mailbox/OUTBOX/TASK-014-INTRO.md`:

- **Who you are** and the role you are taking on this task.
- **What you are good at**, concretely — the tools you reach for first, and why.
- **How you would approach a UI problem in a codebase like this one**, in 3–5 steps.
- **What you would need to ask a maintainer** before you could finish, if anything.
- **Your honest read on whether this task is well-specified**, and what is missing.

That file is not ceremony. Two reasons. First, a specialist who introduces their own
approach surfaces a mis-specified brief *before* three hours are spent on it. Second, the
lead reads it to route the next task, so the quality of your introduction is directly
proportional to how much useful work you get next.

Keep it under 40 lines. Do not pad it.

## 1. Orient yourself before you write a line of code

This repository has a large, deliberately-curated skill and harness estate. **Do not skip
this.** A specialist who invents an approach when a proven one already exists is the single
most expensive failure mode here.

**Read, in this order:**

1. `AGENTS.md` — the operating contract. Non-negotiable rules, the Definition of Done, and
   an **Environment traps** section that has cost real debugging sessions each.
2. `.agents/skills/simorgh-testing/SKILL.md` — the two-suite split and, critically, the
   section on **why a green suite is not a verified system**. Read the table of three real
   defects this repo shipped with all tests green. It changes how you write assertions.
3. `docs/ARCHITECTURE.md` and `docs/STATE-OF-PROJECT.md` — what exists and what is honestly
   absent.
4. `src/dashboard.ts` — the thing you are changing. It is 161 lines of self-contained HTML
   with inline CSS and JS and **no build step**. That constraint is deliberate.

**Skills worth loading** (install/find them via the workspace catalog at
`/home/shai/personal/projects/docs/skills-catalog.md`, and read the SKILL.md before use):

- `frontend-ui-engineering` — production-quality, accessible UI. Load this first.
- `make-interfaces-feel-better` — spacing, typography, hierarchy, interaction states. This is
  what separates "it renders" from "it is good".
- `accessibility` / `frontend-a11y` — WCAG 2.2 AA. Required, not optional.
- `design-system`, `frontend-design-direction` — if you extend the visual language.
- `agent-architecture-audit` — to check you have not coupled the UI to a runtime.

**Harnesses you may use** (`/home/shai/personal/projects/harnesses/`):

- `self-bench/` — `BENCH-GUIDE.md`, `RESULTS.md`, `workloads/`. There is a Ralph-loop pattern
  here (`workloads/ralph-loop.sh`) for stateless multi-step work. Read `BENCH-GUIDE.md`
  before using it.
- `agents/personas/` — read two or three persona files. They show how this workspace expects a
  specialist to be scoped: explicit triggers, named MCPs, named skills. That is the house
  style for a specialist brief.
- `knowledge-vault/` — if you need durable notes across sessions.

**Never** hard-delete anything. To discard your own scratch, use `.openclaw/tmp/` inside the
repo, which is gitignored. Move real deletions to `_archive/` at the workspace root.

## 2. The job, and why it exists (JTBD)

**When an operator runs Simorgh, they need to answer one question: is the flock healthy, and
what is it doing right now?** Today the dashboard cannot answer it.

PRD story **11.2** ("metrics dashboard") is `NOT DONE`, and an audit confirmed it with
evidence:

- `src/dashboard.ts` renders **bird health only** — a status grid and a flight console.
- There are **no metrics**: no request count, no success rate, no latency percentile, no
  tool-call count, no block count.
- `/api/v1/flock/status` returns **persisted health rows, not aggregates**.
- Per-provider latency EMA **is already recorded** in `quota_state`
  (`phoenix-core/src/quota.ts`), and is **exposed on no endpoint at all**.
  `docs/OBSERVABILITY.md` states this plainly.
- `docs/OBSERVABILITY.md` §3 already specifies the fix: *"One route that reads `bird_health`
  + the ledger and returns per-provider success rate, failure count, current cooldown, and
  last-ok. No aggregation daemon: the tables are small and already indexed by primary key."*

So the data exists, or nearly does. The work is to **surface what is already recorded**, not
to invent a telemetry stack. This repo's own note is explicit: *"Do not add a metrics backend
for this."*

**And there is a defect that makes this urgent.** The only dashboard test is:

```
test/http.test.ts: "GET /dashboard serves the mission-control HTML"
  → expects status 200, content-type text/html, body contains "SIMORGH"
```

That is a smoke test with **no negative control**. It would pass against a dashboard stripped
of every panel, because it asserts a literal that is hardcoded in the source. It is the exact
shape of the three green-suite defects `AGENTS.md` warns about. Your first job is to replace
it with something that can fail.

## 3. What to build

**MUST** do:

1. **A metrics route.** One new endpoint returning per-provider aggregates: success rate,
   failure count, last-ok, current cooldown, and the latency EMA already in `quota_state`.
   Read it from existing tables. **MUST NOT** add an aggregation daemon, a metrics
   dependency, or a new store.
2. **A panel** that renders those metrics, following the existing visual language. If you
   introduce a new pattern, keep it inside the one file — no framework, no bundler, no build
   step. The constraint is load-bearing: `src/dashboard.ts` is served as a single string.
3. **Replace the smoke test** with assertions that would fail if the panel were deleted. Name
   the metric. Use `toContain` for presence and `toEqual` where completeness is the property —
   `AGENTS.md` calls out that distinction specifically.
4. **A negative control, and you must run it.** Remove the panel, watch the new tests go red,
   restore, watch them go green. Paste the red output in your report. **A test that has never
   fired is not evidence.**
5. **Accessibility.** Keyboard reachable, `aria-live` on anything that updates on a timer,
   visible focus, and contrast that passes AA. The dashboard polls; a screen reader announcing
   an entire re-render every few seconds is a real accessibility failure, not a theoretical one.
6. **Responsive behaviour** down to a phone width, and `prefers-reduced-motion` honoured.

**SHOULD** do:

- Show *why* a bird is unavailable, not just that it is. `dormant` means "no secret
  configured" and `tired` means "in cooldown" — those need different operator actions, and
  conflating them is the difference between a useful dashboard and a confusing one.
- Surface the `Retry-After` value from the exhaustion path, so an operator can see the
  backpressure the API is now returning.

**MUST NOT**:

- Add a dependency. No chart library, no framework. The standard library and CSS are enough.
- Change `phoenix-core`. It must stay runtime-agnostic — no `cloudflare:`, no `node:`,
  no bare runtime global. `phoenix-core/test/boundary.test.ts` fails the build on a violation
  and you **MUST NOT** weaken it.
- Make the dashboard a build artefact. It is inline HTML/JS/CSS and must stay that way.
- Claim a metric you cannot source. If a number is not in a table, it does not go on the
  dashboard. A plausible-looking invented number is the worst possible outcome here.

## 4. Allowlist — yours EXCLUSIVELY

```
src/dashboard.ts                  (modify)
src/metrics.ts                    (new — the aggregation route)
test/http.test.ts                 (modify — replace the smoke test)
test/dashboard.test.ts            (new — panel + a11y + responsive assertions)
docs/observability.md             (modify — mark 11.2's current state truthfully)
```

**Do NOT touch** — other agents are working in this same worktree right now:

- `phoenix-core/**` — three other agents own files in there
- `src/index.ts`, `src/flock.ts`, `src/agent-service.ts` — the Lead
- `simorgh-platform/**` — the Lead
- `mailbox/**` — the Lead

**A `npm run typecheck` failure outside your allowlist is another agent's in-flight edit.
Report it; do not fix it.** You share one worktree and one typecheck.

## 5. Constraints that are not negotiable

- Package manager is **upm**; there is no `package-lock.json` and `node_modules` is already
  installed. Never run `npm install` / `npm ci`. `upm run <script>` and `npm run <script>`
  both work for running scripts.
- Do **not** run `git commit`, `git push`, or `git rebase`. The Lead integrates.
- **Never weaken a type, a test, or a security check to make something pass.** If a test fails
  because the implementation is wrong, fix the implementation.
- If you need a metric the tables do not contain, **say so in your report** rather than
  inventing one.

## 6. Acceptance criteria — paste this output verbatim

```bash
cd /home/shai/personal/projects/projects/simorgh

npm run typecheck
npx vitest run test/dashboard.test.ts
npx vitest run test/http.test.ts
npx vitest run --config vitest.node.config.ts phoenix-core/test/boundary.test.ts
npx wrangler deploy --dry-run --outdir dist
```

Every command **MUST** exit `0`. If you cannot run one, say which and why — silence reads
as a pass, and this repo has three documented cases of a green suite hiding a real defect.

Then paste: the negative-control red output, and a **before/after screenshot or text dump**
of the dashboard if you can produce one. If you cannot screenshot, paste the rendered HTML
structure of your panel.

## 7. Report

Write `mailbox/OUTBOX/TASK-014-REPORT.md`. **The last non-empty line MUST be exactly
`TASK-014-END`.** That marker, not your process exiting, is the completion signal.

Include, in this order:

1. Your self-introduction summary (what you told the Lead in §0).
2. What you built, and which acceptance criterion each part satisfies.
3. **The negative-control red output, verbatim.**
4. Verbatim acceptance output.
5. **What you found but did NOT fix.**
6. **What you think is wrong with this brief.** You are not penalised for this and it is the
   most valuable section. If the brief asked for something the architecture should not have,
   say so plainly.
7. What you would do next with more time, ranked.

If you are blocked, write `mailbox/NAGS/open-TASK-014-<slug>.md` and stop — do not stall
silently. The Lead reads nags first.

TASK-014-BRIEF-END