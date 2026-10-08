# TASK-017 — Expose the capability matrix: the layer is built, wired to nothing

- Owner: any
- Status: open
- Depends on: nothing · Estimate: 90–120 min · Runner: any agent that can run the two suites

## 0. Start here: introduce yourself

Your **first** action is a short introduction into `mailbox/OUTBOX/TASK-017-INTRO.md`
(≤40 lines): who you are, the role you are taking, what you reach for first and why, your
honest read on whether this brief is well-specified, and what you would ask a maintainer.

## 1. Orient yourself before you start

**Read first:** `AGENTS.md` (especially **Environment traps** and the **Definition of
Done**), then the files named below. `AGENTS.md` records three cases of an all-green suite
hiding a real defect; that is the standard you are being held to.

**Skills** — catalog at `/home/shai/personal/projects/docs/skills-catalog.md`; read each
SKILL.md before use:

- `simorgh-architecture` — the port/host split you are about to extend
- `simorgh-testing` — which suite proves what; both hosts are in scope here
- `search-first` — forces the reuse check before any new code

**Ground rules:** never hard-delete (use `.openclaw/tmp/` for scratch, `_archive/` at the
workspace root for real removals); the package manager is **upm**, not npm-install; no
`git commit`/`push`/`rebase` — the Lead integrates.

## Why this exists

`phoenix-core/src/capabilities.ts` (599 lines) and its 29 passing tests landed on
2026-10-08 in commit `85f5be5`. It is a complete, well-reasoned capability layer:
`CAPABILITY_NAMES`, `AdapterProbe`, `buildCapabilityStatus`, `planCapability`,
`checkCompatibility`, `renderCapabilitySummary`.

**Nothing calls any of it.** `grep -rn 'buildCapabilityStatus\|renderCapabilitySummary\|
planCapability\|CAPABILITY_NAMES' src/ simorgh-platform/src/` returns **zero hits** outside
the engine and its own tests. The launch plan
(`docs/research/EVERYBIRD-DESIGN-AND-LAUNCH-PLAN.md` §0, §3) names the probed capability
matrix as **the demo and the launch story**, and the "one rule that keeps this from rotting"
is an endpoint that prints the real, probed, honest matrix.

This is the same shape of gap as the one fixed in `ffd925c`: primitives that are complete,
tested, and reachable from nowhere. Read that commit's message before you start — the
lesson is not "write the code", it is "**the code that exists is not the code that is
wired, and only a probe of the running system tells you which you have**".

## Read first

- `phoenix-core/src/capabilities.ts` — read the whole module, especially the header comment
  and the comment on `buildCapabilityStatus`. It documents a decision you must respect or
  deliberately overrule (see "The decision you must make", below).
- `src/flock.ts` — the edge host's bird definitions: which providers exist, which secret
  each needs, and their priority order. This is the only real *adapter list* that exists.
- `simorgh-platform/src/runtimes/providers.ts` — the same roster for the Node host. The two
  must agree; `simorgh-platform/test/providers-parity.test.ts` is the existing guard.
- `src/index.ts` and `simorgh-platform/src/runtimes/node.ts` — the two routers you will add
  a route to. Note how `ffd925c` handled a route added to both.
- `test/http.test.ts`, `simorgh-platform/test/integration.test.ts` — the two files that
  assert route contracts at the host layer.
- `docs/OBSERVABILITY.md` — what the ledger already answers, so you do not rebuild it.

## The decision you must make — state it, do not stumble into it

`buildCapabilityStatus` documents: *"Capabilities that no adapter claimed are absent from
the input and therefore absent from the output, because there is nothing to report about a
capability nothing attempted."*

The launch plan wants the opposite emphasis: *"A capability may be satisfied by zero
adapters, and the runtime must say so at startup. No 'pluggable' system that pretends
everything is available."*

Today only `inference` has adapters (the birds). `embeddings`, `vector`, `sync` and
`scheduler` have none. So the endpoint must answer: does an un-attempted capability appear
as `DEGRADED (none)`, or is it omitted? **Pick one, say why, and put the reasoning in the
file you change.** Either is defensible — silently doing the first while the module's
comment claims the second is not, and that is the failure this task exists to avoid.

## Deliverable

1. **A probe builder per host** that turns the real adapter list into `AdapterProbe[]`.
   `ok` must reflect something that actually ran or was actually checked — the honest
   probe for a keyed provider is "is the key present", with `requires: ["GROQ_API_KEY"]`
   and `keyFree: false`. Do **not** invent probes for adapters that do not exist; that is
   the one thing the module's design forbids.
2. **A route on both hosts.** Follow `ffd925c`: whichever host gets it, the other gets it in
   the same change, or you have shipped a fix that is half-wired by construction.
3. **Tests at the host layer**, and they must assert *content*, not just status. A 200 that
   returns an empty list would pass a status-only assertion and tell an operator nothing.
   Include a case that proves a key-free bird still appears when every secret is absent —
   that is the zero-KYC guarantee, and it is the one claim the endpoint exists to make.
4. **A negative control**, run and reported: break the probe (make it report `ok: true` for
   an adapter whose secret is absent) and show the test fails. Then restore it.

## Do NOT

- Do not add a new capability name. `CapabilityName` is a closed set on purpose; adding one
  is a deliberate edit with a reason, not a side effect of this task.
- Do not add retrieval, an embedding adapter, or a vector store. This task exposes what
  exists. `WHERE-WE-ARE-AND-WHERE-WE-GO.md` §4 explains why that is a *later* decision.
- Do not weaken `phoenix-core/test/boundary.test.ts`. The probe builder is host code; the
  engine must stay runtime-agnostic.
- Do not gate the route behind auth by copying `/api/v1/flock/status`'s precedent without
  saying so — AUTH-001 is an open finding for exactly that route. State your choice.

## Verify — paste output verbatim

```bash
cd /work/current/projects/simorgh
export NO_PROXY=127.0.0.1,localhost
npm run typecheck
npm test
npm run platform:smoke
npm run e2e:ask
```

Then probe the real thing, not the fixture — boot a core and show the endpoint's actual
output, with one key set and with none:

```bash
npm run simorgh -- serve                # in the background
curl -s localhost:8788/api/v1/capabilities   # or the path you chose
```

If a command cannot run, say which and why. Silence reads as a pass.

## Report

Write `mailbox/OUTBOX/TASK-017-REPORT.md`. **The last non-empty line must be exactly
`TASK-017-END`.** Include: the decision from "The decision you must make" and its
reasoning; the negative control; what you could **not** verify and how you would; and what
you found but did **not** fix.

TASK-017-BRIEF-END
