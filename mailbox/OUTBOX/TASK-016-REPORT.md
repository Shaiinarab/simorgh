# TASK-016 — Report: router legibility, complexity, affinity, and one more bird

- **Owner:** Lead session (Buffy, MiMo 2.6 Flash, acting as both worker and integrator
  at the operator's direction — the usual Lead-integrates split collapsed into one
  session, so the commits carry the Lead sign-off this brief normally expects).
- **Status:** done, 2026-10-08. All four adoptions implemented; §6 stretch included;
  §7 comparison below. Nothing pushed.
- **Question:** can Simorgh's router be made legible, complexity-aware and cache-aware
  without a behaviour change on the hot path? **Yes** — everything ships opt-in, and
  the default path is pinned byte-identical by the *untouched* workers-suite tests.

---

## 1. Adoption 1 — the routing-reason vocabulary

`RouteReason` in `phoenix-core/src/flock.ts`; `FlockAttempt.reason?: RouteReason`
(additive, optional). Members as the brief suggested, unchanged:
`selected_by_priority` · `selected_by_capacity` · `selected_by_complexity` ·
`pinned_by_session` · `fallback_previous_unavailable` · `skipped_dormant` ·
`skipped_cooldown` · `skipped_cost_ineligible`.

Two judgement calls, both justified in ADR-0006 §2:

1. **`selected_by_capacity` / `skipped_cost_ineligible` are vocabulary-only in the
   flock.** They belong to the capacity layer — cost and quota facts do not exist
   inside the routing loop, and re-deriving them there is the
   two-definitions-nothing-comparing-them trap `ledger.ts` documents. The flock
   emits the other six.
2. **A dormant-skip is never a `fallback`.** Only a *dialled* failure makes the next
   winner a fallback. If every skip ahead of the winner was dormant, the winner was
   the first available bird; calling it a fallback would tell an operator their
   fleet is failing when it is merely unconfigured.

**Backward compatible by construction, not by assertion.** Reasons appear only when
the host passes `FlyFlockDeps.routing`. The default branch is *literally*
`byPriority(...)` — not `orderCandidates` with empty options — and the pre-existing
`test/flock-routing.test.ts` (which I did not touch; it is not in the allowlist)
asserts `flock_attempts` with `toEqual` and stays green at 138. That untouched test
is the strongest form the compatibility claim can take.

## 2. Adoption 2 — complexity ordering (`phoenix-core/src/complexity.ts`, new)

Pure `estimateComplexity(prompt)` — no clock, no randomness, no I/O, no LLM.
Features reported alongside the score (`signals`) so a routed decision is explainable.
Tiers: `trivial` < 12 ≤ `moderate` < 35 ≤ `heavy` (capped feature scores).

- **Ordering, never exclusion**, machine-checked: `fitRank` returns 0/1/2, rank 2 is
  a queue position, and the flock test *never excludes: a tier-mismatched bird is
  still dialled when the birds ahead fail*.
- **Providers declare fit** with optional `servesTiers`; absent = "assume anything",
  so no existing catalog entry changes meaning.
- **Byte-identical default** pinned by a dedicated test (`keeps the wire shape
  byte-identical when no routing signal is supplied`).
- **Honesty:** the module header calls itself a crude lexical proxy and names the
  misjudgements it will make. A 400-word poetic prompt reads "heavy"; a simply
  phrased systems question reads "trivial". Acceptable only because of the two rules
  above.

## 3. Adoption 3 — session affinity (`phoenix-core/src/session.ts`, new)

- Host-shaped `SessionSignal { previousWinnerId?, contextChars }`; the engine never
  mints a session id.
- `sessionBias`: linear 1 → 0 at `SESSION_AFFINITY_REF_CHARS` (32k, parameterised;
  the constant documents why it is the default and that it is not authoritative).
  Pin releases exactly at bias 0 — deliberately binary, because a fractional priority
  would change the meaning of the *published* `priority` field in
  `/api/v1/flock/status`.
- **Opt-in, off by default** (§5's conformance point): no `routing.session`, no pin.
- **Research (verified 2026-10-08, ADR-0006 §4):** Anthropic cache write 1.25× /
  read 0.1× (platform.claude.com docs); OpenAI automatic ~50% off cached input, no
  write premium (developers.openai.com docs); **Groq — Shāhīn's own backend — 50%
  off cached input tokens, no extra cost** (console.groq.com/docs/prompt-caching).
  Gemini ~75% off: secondary sources only, **UNVERIFIED**. Cache-*hit metrics* in
  provider responses: **UNVERIFIED** against live endpoints — nothing in the engine
  depends on one, which is why the bias is a function of context size.
- **On decay direction:** Cloudflare's framing argues the switching penalty grows
  with context (stay). The brief says decay (yield). I followed the brief and said
  why: a pin that never decays is a capability ceiling wearing a cache costume.

## 4. Adoption 6 (stretch) — `cloudflare/auto` as a bird

Included. `autoRouterProvider` behind the **existing** `Provider` port;
`WorkersAiPort.run` widened **additively** (optional third arg,
`{ gateway: { id } }`). Additive was the right call because the port has several
implementors (the Workers `env.AI` binding and every test stub) and a breaking
change would tax all of them for one bird's need — a one-line assignability proof
(typecheck) plus the untouched 138 worker tests demonstrate it.

- Workers-only, honest on Node (`workers_ai_unavailable` → flock routes around).
- Opt-in by construction: the factory **requires** `gatewayId` and refuses to build
  a bird without one (a permanently-failing dial costs a request and plants a
  cooldown on every flight).
- `cf-aig-routed-model` is a response *header* the Workers binding does not surface;
  the bird best-effort reads a `routed_model`/`model` **body** field into
  `servedModel` → `meta.ai_model`, and reports no served model rather than
  fabricating one. **UNVERIFIED** against a live gateway account.
- **Host registration NOT wired** — see §6 below (found-but-not-fixed).

## 5. Verification

**Acceptance battery, all exit 0, verbatim tails:**

```
npm run typecheck                        → tsgo ×3 configs, 0 errors, exit 0
npx vitest run --config vitest.node.config.ts phoenix-core/test/{flock,complexity,session}.test.ts
                                         → 44 passed (3 files), exit 0
npm run test:node                        → 500 passed (25 files), exit 0   (was 473; +27 new)
npm run test:workers                     → 138 passed (14 files), exit 0   (unchanged — untouched tests)
npx wrangler deploy --dry-run --outdir dist → "--dry-run: exiting now.", exit 0
```

**Negative controls — mandatory, run, red, restored (§10's three):**

1. *Skip-reason recording removed* (deleted the `skipped_dormant` emission):

```
 FAIL  phoenix-core/test/flock.test.ts > flyFlock — routing vocabulary (opt-in) > names every considered-but-not-dialled candidate with a skipped_* reason
AssertionError: expected [ { birdId: 'dormant', …(2) }, …(2) ] to deeply equal [ { birdId: 'dormant', …(3) }, …(2) ]
-     "reason": "skipped_dormant",
 Test Files  1 failed (1) · Tests  1 failed | 28 passed (29)
```

2. *Complexity ordering disabled* (`if (false && fa !== fb) return fa - fb`):

```
 FAIL  phoenix-core/test/flock.test.ts > flyFlock — routing vocabulary (opt-in) > orders a trivial task ahead of the heavy bird: selected_by_complexity
AssertionError: expected 'heavy' to be 'small' // Object.is equality
 Test Files  1 failed (1) · Tests  1 failed | 28 passed (29)
```

3. *Session decay removed* (`sessionBias` returns 1 always):

```
 FAIL  phoenix-core/test/flock.test.ts > … > releases the pin once the session's context reaches the reference size — decay, end to end
AssertionError: expected 'second' to be 'first'
 FAIL  phoenix-core/test/session.test.ts > sessionBias > decays linearly and hits 0 exactly at the reference context size
AssertionError: expected 1 to be close to 0.5, received difference is 0.5
 Test Files  2 failed · Tests  5 failed | 31 passed (36)
```

Each was restored and re-run green (final: 44/44 new-file tests, 500 node, 138
workers). `boundary.test.ts` untouched and passing — no port, no binding, no runtime
global entered the engine.

## 6. §7 — Go-vs-TS routing comparison

`packages/providers/adapter.go` `Registry.Select`: **healthy → lower measured
latency EMA (`0.7·old + 0.3·new`) → lower priority number**; adapters that do not
`Supports(model)` are **excluded**. `phoenix-core` `flyFlock`: **priority order,
dormant skip, cooldown skip, fail-through**; no latency ordering; no exclusion.

**The divergence is pre-existing and intentional.** ADR-0001 tabulates exactly this
("priority order, dormant skip, explicit cooldowns, fail-through" vs "health, then
latency EMA, then priority; unhealthy after 3 consecutive errors") and assigns the
Go workspace the obligation of *converging on the core contract*. So the honest
answer to "is the divergence intentional?" is: **yes, recorded, with a convergence
debt** — and this task neither widens nor pays it (the new signals are opt-in and
off, so Go behaviour is untouched).

**When it must converge:** not by duplicating ordering logic in Go, but as **one
normalised shared value model** — provider identity, priority, health/cooldown, cost
class, complexity tier, and the `RouteReason` member names from §1 — consumed by
both runtimes. The vocabulary in ADR-0006 §2 is that model's kernel. Per the brief:
*say so and stop* — I did not implement it.

## 7. Found but deliberately NOT fixed

- **Host wiring of `routing` signals** (Workers + Node hosts currently never pass
  `routing`, so the feature is engine-live but host-dark). Turning it on needs a
  host-level opt-in flag; that is a host decision and hosts were not in the
  allowlist beyond the bird registration.
- **`autoRouterProvider` host registration** requires a new env declaration, and the
  env files (`env.d.ts`, the generated `worker-configuration.d.ts`) are outside the
  allowlist — and hand-editing the generated file is banned repo-wide.
- **`latencyEmaMs` in `QuotaState` is still unrouted-on** in TS (Go orders by it).
  The convergence value model above is where it belongs; a third ordering signal
  added unilaterally here would deepen the divergence this task was asked to
  *report*.
- **9router comparison:** `harnesses/9router-provider/` is TypeScript and was cited
  as a second routing implementation to compare against; its tree has no routing
  policy (it is a provider *for* 9router, not a router), so the Go comparison is the
  only real second implementation. Noted rather than forced.

## 8. What I think is wrong with the brief

Nothing that blocked the work, but two flags for whoever reads this next:

1. **§3's "every considered candidate must appear with a skipped_* reason" collides
   with §3's "backward compatible with `toEqual` consumers".** Reasons on every
   attempt *cannot* ship on the default path — `test/flock-routing.test.ts` (not in
   the allowlist) `toEqual`-asserts the old shape. Opt-in `routing` is the only
   reading that satisfies both MUSTs simultaneously; it is what I implemented. If
   the intent was "reasons always on, update the workers test too", that is a
   two-line change plus a test update — but it *is* a wire-shape change and should
   be said out loud, not smuggled in.
2. **The decay-vs-stay tension in §5 is real, not sloppiness.** The brief says bias
   decays with context while citing Cloudflare's logic that argues the opposite.
   I followed the brief and documented the cost; if the operator later wants cache
   economics to win, `sessionBias` is one function and one ADR paragraph away from
   flipping.
3. Minor: §6 says "~40 lines" — with the honesty requirements (refuse-to-build
   without gateway id, best-effort served-model read, degradation test) it is ~75,
   and I would spend them again.

TASK-016-END
