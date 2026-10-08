# ADR-0006 — Auto-Router compatibility: a routing vocabulary, a complexity signal, session affinity, and `cloudflare/auto`

**Status:** Accepted · **Date:** 2026-10-08 · **Supersedes:** nothing · **Amends:** ADR-0003 (capacity), ADR-0005 (free-only)

**Decision in one line:** Simorgh keeps its own routing policy and adopts four things
from Cloudflare's AI Gateway Auto Router — a *selection-reason vocabulary*, a
*complexity ordering signal*, *session affinity with a decaying bias*, and the
`cloudflare/auto` model as one more opt-in bird — all pure in `phoenix-core`, all
opt-in, none of them replacing the flock.

---

## 1. Context

Cloudflare shipped **AI Gateway Auto Router** (public beta, 2026-09-30). It cannot
replace Simorgh's routing — its own docs say it selects "from a pool of models
managed by Cloudflare", and that pool contains none of the BYOK free-tier providers
(Groq, HuggingFace, OpenRouter) Simorgh federates; it cannot express quota reset
horizons or `FREE_ONLY`; and it requires a Cloudflare control plane, which would put
a Cloudflare dependency inside a runtime-agnostic engine. The lead's assessment
stands; this ADR records what was *adopted* from it anyway.

## 2. The vocabulary (`RouteReason` in `phoenix-core/src/flock.ts`)

`FlockAttempt` recorded who was tried and whether it worked, never **why**. ADR-0003
insists a rejection names its binding reason; the selection-side mirror did not
exist. Cloudflare's `cf-aig-routing-reason` header is the model; Simorgh's members:

| Member | Emitted by | Meaning |
|---|---|---|
| `selected_by_priority` | `flyFlock` | the default ordering chose it |
| `selected_by_complexity` | `flyFlock` | the complexity signal moved it forward |
| `pinned_by_session` | `flyFlock` | session affinity held (bias > 0) |
| `fallback_previous_unavailable` | `flyFlock` | a *dialled* bird failed; this one answered |
| `skipped_dormant` | `flyFlock` | no secret configured — a deployment fact |
| `skipped_cooldown` | `flyFlock` | inside a health cooldown |
| `selected_by_capacity` | capacity layer (hosts/quota) | won the quota/capacity plan |
| `skipped_cost_ineligible` | capacity layer (hosts/quota) | refused by the cost gate (ADR-0005) |

The last two are deliberately **not** emitted by `flyFlock`: cost and quota facts do
not exist inside the routing loop, and re-deriving them there would create the
two-definitions-nothing-comparing-them trap `ledger.ts` documents. They exist in the
vocabulary so a host that pre-filters by capacity speaks the same language.

**Opt-in.** Reasons (and the two ordering signals) appear only when the host passes
`FlyFlockDeps.routing`. The default path is *literally* `byPriority` — not an
`orderCandidates` call with empty options — and the pre-vocabulary wire shape of
`flock_attempts` is pinned byte-identically by the untouched workers-suite test
`test/flock-routing.test.ts`, which asserts it with `toEqual`. A dormant skip is
never called a fallback: the winner of a run whose only skips were dormant was the
first available bird, and labelling it a fallback would tell an operator their fleet
is failing when it is merely unconfigured.

## 3. Complexity ordering (`phoenix-core/src/complexity.ts`)

A pure, deterministic, host-injectable estimate — **no LLM in the routing path**,
which this project has explicitly rejected. A crude lexical proxy (words, code
fences, paragraphs, question marks, a five-word directive-verb list), documented as
crude where it is defined. It **orders, never excludes**: `fitRank` puts a declared
mismatch at the back of the queue, and the flock-level test proves the mismatched
bird is still dialled when the birds ahead of it fail. Providers declare fit with an
optional `servesTiers`; absent means "assume it can serve anything", so no existing
catalog changes meaning. With no `routing.task`, ordering is unchanged.

## 4. Session affinity (`phoenix-core/src/session.ts`)

The host supplies the session id (the engine never mints one); the bias decays
linearly from 1 (fresh) to 0 at `SESSION_AFFINITY_REF_CHARS` (32k, a parameter with
a documented default — deployments that disagree pass their own horizon). At bias 0
the pin releases and priority/complexity decide.

### Cache economics, researched 2026-10-08

| Provider | Mechanism | Price | Source |
|---|---|---|---|
| Anthropic | explicit cache breakpoints | write 1.25× (5-min) / 2× (1-hr); read **0.1×** | platform.claude.com docs — **verified** |
| OpenAI | automatic, no opt-in | ~**50% off** cached input; no write premium | developers.openai.com docs — **verified** |
| **Groq** (Shāhīn's backend) | automatic | no extra cost, **50% off** cached input tokens | console.groq.com/docs/prompt-caching — **verified** |
| Gemini | implicit + explicit | ~75% off reported | secondary sources only — **UNVERIFIED** |

Whether any provider exposes a **cache-hit metric** in the API response body (so the
flock could *measure* affinity instead of assuming it): OpenAI's usage object
reportedly carries cached-token details — **UNVERIFIED** against a live response at
time of writing. No affinity decision in this ADR depends on it; that is why the
bias is a function of context size, not of a metric nothing in the engine can read
yet.

**Why decay rather than the opposite.** Cloudflare's framing says the switching
penalty *grows* with context, so a deeper conversation has more to earn back by
staying. The brief chose the other direction, and it is the safer one: a pin that
never decays is a capability ceiling wearing a cache costume — the cheap bird that
greeted the session would keep the 80k-token analysis too. Yield beats cache.

## 5. The auto bird (`autoRouterProvider`)

`cloudflare/auto` behind the **existing** `Provider` port. `WorkersAiPort.run` gains
an **additive, optional** third argument (`{ gateway: { id } }`): every existing
implementor still satisfies the widened port untouched, and the one new consumer
pays for the extension alone. Workers-only, like `homa`; on Node it reports
`workers_ai_unavailable` and the flock routes around it. Opt-in by construction —
the factory requires a `gatewayId` and refuses to build a bird without one, because a
permanently-failing dial costs a request and plants a cooldown on every flight. The
model that *actually served* a request surfaces as `servedModel` → `meta.ai_model`.
`cf-aig-routed-model` is a response **header** on the AI Gateway HTTP path, which the
Workers binding does not surface — reading a body field is best-effort and marked
UNVERIFIED without a live account to probe.

**Host registration was not wired** (the env declaration lives outside this task's
allowlist): the bird ships as factory + tests + this ADR, and a host that wants it
registers it when — and only when — a gateway id is configured.

## 6. Go-vs-TS routing semantics (the required comparison)

`packages/providers/adapter.go` `Registry.Select`: healthy → lower measured latency
EMA (`0.7·old + 0.3·new`) → lower priority; adapters that do not `Supports(model)`
are **excluded**. `phoenix-core` `flyFlock`: priority order, dormant skip, cooldown
skip, fail-through; no latency ordering; no exclusion.

**Divergence is pre-existing and intentional** — ADR-0001 already records the two
policies side by side, with the Go workspace's second obligation being *converging on
the core contract*. Nothing in this ADR narrows or widens it: the new signals are
opt-in and off by default, so Go behaviour is untouched and TS behaviour is
byte-identical without them.

**The convergence shape, when it is needed:** one **normalised shared value model** —
provider identity, priority, health/cooldown, cost class, complexity tier, and the
`RouteReason` vocabulary — not a second implementation of the ordering logic in Go.
The vocabulary in §2 *is* that value model's kernel; a Go port should consume the
same member names, not re-derive them. This ADR says so and stops, per the brief:
do not build duplicate routing intelligence in both runtimes.

## 7. Consequences

- An operator can read *why* a bird answered, and every skipped bird is on the
  ledger, when routing signals are on.
- Complexity and affinity change nothing until a host opts in; conformance has
  nothing new to catch by default, and something concrete to catch the moment it is
  turned on.
- The engine gained two pure modules and zero ports; `boundary.test.ts` is untouched
  and still passing.
- The auto bird is a factory away from being live; the missing piece is an env
  declaration, not a design decision.
