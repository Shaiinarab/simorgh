# TASK-016 — AI/context engineering: make the router legible, complexity-aware, and cache-aware

- Owner: any
- Status: open
- Depends on: nothing · Estimate: 120–180 min · Runner: **AI engineering** agent

## 0. Start here: introduce yourself

First action: write `mailbox/OUTBOX/TASK-016-INTRO.md` (≤40 lines) — who you are, the
AI-engineering role you are taking, which model-routing or agent-architecture tooling you
reach for first and why, your honest read on whether this brief is well-specified, and what
you would ask a maintainer.

## 1. Orient yourself before you design

**Read, in this order:**

1. `AGENTS.md` — the operating contract, **Environment traps**, and the Definition of Done.
2. `phoenix-core/src/flock.ts` — the routing policy end to end. Every comment there is
   load-bearing; several explain *why* an obvious alternative was rejected.
3. `phoenix-core/src/quota.ts` and `docs/adr/ADR-0003-free-compute-capacity.md` — the capacity
   layer, and the rule it encodes: maximise usable capacity **after** the spend, not the
   biggest pile.
4. `docs/adr/ADR-0005-free-only-mode.md` — cost is `free | paid | unknown`, and **unknown is
   not free**.
5. `phoenix-core/src/provider.ts` — the `Provider` port every bird implements.
6. `phoenix-core/src/scheduled.ts` — durable delay, and a comment there that is a warning to
   you: stored `tools` are **not** re-authorised at flight time.

**Skills worth loading** (catalog at `/home/shai/personal/projects/docs/skills-catalog.md`):

- `agent-architecture-audit` — diagnosing agent stacks; use it on your own change afterwards.
- `llm-routing` is not installed; the closest installed ones are `cost-aware-llm-pipeline`,
  `benchmark-optimization-loop`, `latency-critical-systems`, and `eval-harness`.
- `prompt-caching` / cache economics: no dedicated skill — you will need to research current
  provider cache pricing yourself (Anthropic cache read/write, OpenAI automatic caching,
  Google, DeepSeek, Groq). **Verify, do not recall.**
- `tdd`, `incremental-implementation` — this repo expects both.
- `durable-objects`, `workers-best-practices` — for the DO-side changes.

**Harnesses:**

- `/home/shai/personal/projects/harnesses/self-bench/` — `BENCH-GUIDE.md` +
  `workloads/ralph-loop.sh`. There is a stateless task-loop pattern here that suits
  multi-iteration work with machine-checkable acceptance. Read the guide before use.
- `/home/shai/personal/projects/harnesses/9router-provider/` — 39 accounts, and its own
  quota state. Useful as a **second implementation to compare routing semantics against** —
  see task 4 below.

## 2. Background you must not re-derive

Cloudflare shipped **AI Gateway Auto Router** (public beta, free during beta) on 2026-09-30.
The lead already assessed it. Do not repeat that work; **build on it.**

- Blog: <https://blog.cloudflare.com/auto-router/>
- Docs: <https://developers.cloudflare.com/ai-gateway/features/auto-router/>

**Verdict already reached — do not re-litigate:** it **cannot** replace Simorgh's routing.
Its own docs say *"Auto Router selects from a pool of models managed by Cloudflare"*, and that
pool contains no Groq, HuggingFace or OpenRouter — the BYOK free-tier providers Simorgh
federates. `cf-aig-allowed-models` narrows that pool and cannot extend it. It also cannot
express quota reset horizons or FREE_ONLY, and it requires a Cloudflare control plane
(`CLOUDFLARE_ACCOUNT_ID` + `GATEWAY_ID` + `API_TOKEN`), which would put a Cloudflare
dependency inside a runtime-agnostic engine.

**But three things in it are genuinely better than Simorgh's, and this task adopts them.**

## 3. Adoption 1 — a routing-reason vocabulary (why the winner won)

**The gap.** `FlockAttempt` today is `{ birdId, ok, error? }`. It records who was tried and
whether it worked. It never says **why that bird was chosen**, and it cannot distinguish
*"I wanted this one"* from *"this is what I got because the first could not serve the
request."* ADR-0003 is strict that a **rejection** names its binding reason; the mirror of
that discipline — naming the **selection** — does not exist.

**Cloudflare's vocabulary** (from their `cf-aig-routing-reason` header) is the model:

| Their value | Meaning |
|---|---|
| `cost_optimal_within_pool` | best balance of expected quality and cost |
| `forced_by_candidate_pool` | only one candidate was eligible |
| `pinned_by_turn` | reused the model chosen earlier in the turn |
| `fallback_candidate_unavailable` | the selected model could not serve; another was used |
| `fallback_router_error` | the router itself failed |
| `fallback_unsupported_input` | nothing to classify |

**MUST** implement a Simorgh-native vocabulary in the same spirit. Suggested members —
adjust if you find better ones, and **justify any change in your report**:

`selected_by_priority` · `selected_by_capacity` · `selected_by_complexity` ·
`pinned_by_session` · `fallback_previous_unavailable` · `skipped_dormant` ·
`skipped_cooldown` · `skipped_cost_ineligible`

**Requirements:**
- Pure and in `phoenix-core`. **No** new port, **no** runtime binding.
- Every candidate the router *considered* and did **not** dial **MUST** appear with a
  `skipped_*` reason. A scheduler that silently drops candidates is indistinguishable from one
  that lost them — that is ADR-0003's own rule and it applies here.
- **Backward compatible**: `flock_attempts` must keep its current fields, because
  `src/dashboard.ts` and `test/flock-routing.test.ts` read them.

## 4. Adoption 2 — complexity-aware routing

**The gap.** `Provider.priority` is a static integer *"Tried in ascending order"*
(`provider.ts:36`). Routing has **zero** task awareness: the flock cannot tell a
`get_server_time` from a 100k-token research job, so it spends scarce free-tier allocation
identically on both.

**The insight worth taking** (Cloudflare's framing): *"you don't need Opus-level intelligence
if you are looking to summarize an email."* Mapped onto Simorgh: **do not burn a scarce
Groq free-tier allocation on a trivial task when a cheaper bird would do.**

**Requirements:**
- A **pure, deterministic, host-injectable** complexity estimate. Signature roughly
  `(prompt, now) => complexity` or `(workload) => complexity`. It **MUST** be a pure function
  over its inputs — **no LLM call in the routing path.** An LLM deciding scheduling is
  explicitly rejected by this project; do not reintroduce it here.
- Use it to **order** candidates, never to **exclude** them. Excluding on a heuristic is how a
  router silently loses capability.
- It **MUST NOT** break the existing priority contract: when no complexity signal is supplied,
  behaviour **MUST** be byte-identical to today. Pin that with a test.
- Be honest about the limits. A regex complexity estimate is crude; say so in a comment and in
  your report rather than overselling it.

## 5. Adoption 3 — cache/session affinity

**The gap.** Simorgh has **no** notion of prompt-cache economics. Switching models mid-session
throws the cache away and the next request pays full cache-write price for the whole context —
and at 1M users that is a real money-shaped problem even at $0 list price, because it consumes
scarce free-tier tokens.

**Research first, then implement.** Cloudflare's rule: within a turn the cache is hot and
switching rarely pays; across turns a switching penalty grows with context length, so a deeper
conversation has more to earn back. Verify current provider cache pricing and whether any
expose cache-hit metrics. **Cite what you verify; mark the rest `UNVERIFIED`.**

**Requirements:**
- A `sessionId`-shaped concept that biases selection toward the previous winner **within** a
  session/turn, with the bias decaying as context grows.
- **MUST** be opt-in and off by default. A behaviour change on the hot path with no flag is how
  a gateway starts leaking capacity, and `simorgh-platform/test/conformance.test.ts` exists to
  catch exactly that.
- Pure in `phoenix-core`; the host supplies the session id.

## 6. Adoption 4 (stretch) — `cloudflare/auto` as one more bird

Only if 1–3 are done and green. ~40 lines.

- Implement behind the **existing `Provider` port**. Do **not** add a port.
- The call shape is `env.AI.run("cloudflare/auto", input, { gateway: { id } })`.
  **`WorkersAiPort.run()` currently takes `(model, input)` with no options.** You will need to
  thread the gateway option. Extend the port **additively** (an optional third argument) so no
  existing host breaks, and say clearly in your report why additive was the right call.
- **Workers-only**, like the existing `homa` bird, so `phoenix-core` gains no Cloudflare
  dependency. On Node the provider is simply absent — and the catalog says so honestly rather
  than shipping a pretend provider.
- It **MUST** be opt-in: absent unless the gateway id is configured. A permanently-dormant
  provider costs a failed dial and a cooldown on every request.
- Surface `cf-aig-routed-model` somewhere useful, so an operator can see which model actually
  served.

## 7. Task 4 — compare against the Go implementation

`harnesses/9router-provider/` and the Go workspace both have routing logic. **MUST** produce a
short comparison: where do the two implementations' routing semantics **diverge**, and is that
divergence intentional?

**Do not create duplicate routing intelligence in both runtimes.** If the comparison shows
they must agree, the correct fix is one normalised shared value model — say so and stop, rather
than implementing it. Report the divergence either way; a clean "they agree except for X"
answer is a real result.

**Environment trap:** `GOFLAGS` is polluted machine-wide. Override per command:
`GOFLAGS=-mod=readonly go build all`. Do **not** delete `~/.config/go/env` and do **not** add a
`vendor/` directory.

## 8. Allowlist — yours EXCLUSIVELY

```
phoenix-core/src/flock.ts          (modify)
phoenix-core/src/provider.ts       (modify — the Provider port)
phoenix-core/src/ports.ts          (modify — WorkersAiPort, additively ONLY)
phoenix-core/src/complexity.ts     (new)
phoenix-core/src/session.ts        (new)
phoenix-core/test/flock.test.ts    (modify — add)
phoenix-core/test/complexity.test.ts (new)
phoenix-core/test/session.test.ts  (new)
src/flock.ts                       (modify — only to register the new bird, if you do §6)
docs/adr/ADR-0006-auto-router-compatibility.md   (new)
```

**Do NOT touch:** `src/index.ts`, `test/http.test.ts`, `test/dashboard.test.ts`,
`src/dashboard.ts`, `phoenix-core/src/quota.ts`, `tasks.ts`, `swarm.ts`, `security.ts`,
`execute.ts`, `simorgh-platform/**`, `mailbox/**`. Other agents own those right now.

**A typecheck failure outside your allowlist is another agent's in-flight edit — report it,
do not fix it.**

## 9. Constraints

- `phoenix-core` **MUST** stay runtime-agnostic: no `cloudflare:`, no `node:`, no bare runtime
  global. `phoenix-core/test/boundary.test.ts` enforces this — do not weaken it.
- **No new dependency.** No LLM in the routing path. No chart, no framework.
- Package manager is **upm**. Never `npm install`/`npm ci`. No `package-lock.json`.
- Do **not** `git commit`, `git push`, or `git rebase`.
- **Never weaken a type, a test, or a security check to make something pass.**
- Row types in this package are `type` aliases, **not** `interface` — `SqlPort.exec<T>`
  constrains `T` to `SqlRow` and interfaces get no implicit index signature.

## 10. Acceptance — paste verbatim

```bash
cd /home/shai/personal/projects/projects/simorgh

npm run typecheck
npx vitest run --config vitest.node.config.ts phoenix-core/test/flock.test.ts
npx vitest run --config vitest.node.config.ts phoenix-core/test/complexity.test.ts
npx vitest run --config vitest.node.config.ts phoenix-core/test/session.test.ts
npx vitest run --config vitest.node.config.ts phoenix-core/test/boundary.test.ts
npm run test:workers
npm run test:node
npx wrangler deploy --dry-run --outdir dist
```

All **MUST** exit `0`.

**Negative controls are MANDATORY** for every detector you add — this repo's rule is that a
scanner which never fires is not evidence. At minimum:

1. Break the skip-reason recording → watch a test go red.
2. Break the complexity ordering → watch a test go red.
3. Break the session-affinity decay → watch a test go red.

Paste all three red outputs verbatim.

## 11. Report

Write `mailbox/OUTBOX/TASK-016-REPORT.md`. **The last non-empty line MUST be exactly
`TASK-016-END`.**

Include: what you implemented per adoption; **the negative-control red outputs**; verbatim
acceptance output; the Go-vs-TS routing comparison from §7; **what you found but did NOT
fix**; and **what you think is wrong with this brief** — especially if you think an adoption
is a mistake now and only becomes right later.

If blocked: `mailbox/NAGS/open-TASK-016-<slug>.md`, then stop.

TASK-016-BRIEF-END