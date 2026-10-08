# TASK-017 — Expose the capability matrix

- **Owner:** fb2 (the same session that *wrote* the brief — see §6, it is a real caveat)
- **Status:** done, 2026-10-08T16:58
- **Question:** `capabilities.ts` is complete, tested, and reachable from nowhere. Can it be exposed
  honestly, on both hosts, without inventing the parts that do not exist yet?
- **Answer:** yes. Five commits, all local, nothing pushed. And the endpoint immediately earned its
  keep by making a **host difference visible in one line** that four documents describe but no command
  showed.

---

## 1. What landed

| Commit | What it carries |
|---|---|
| `60599d7` | `feat(core)`: `capability-probes.ts` — the probe half, in the engine |
| `5919e38` | `feat(edge)`: `GET /api/v1/capabilities`, with 4 tests |
| `64f4b63` | `feat(node)`: the same route on the self-hosted host, with 2 tests |
| `286282a` | `test(core)`: the probe mapping's rules, incl. why `bulbul` is not `free` |
| — | this report |

Where it lives, and why there rather than in `capabilities.ts`:

`capabilities.ts`'s header states two things that decide it — it *"imports nothing but `quota.ts`"*, and
*"a host probes what it actually has"*. So the probe is a separate engine module rather than more code
in that file (which would have broken its stated purity) and rather than a copy in each host (two copies
of one mapping drift, and this repo already has two provider rosters — that is why
`providers-parity.test.ts` exists). `capability-probes.ts` imports only `capabilities.ts` and
`provider.ts`, touches no port and no runtime binding, so `boundary.test.ts` is untouched.

## 2. The decision the brief required — and the one it did not anticipate

**Required:** does an un-attempted capability appear, or is it omitted? `buildCapabilityStatus`
documents that it omits one, because *"there is nothing to report about a capability nothing
attempted"*; the launch plan says a capability *"may be satisfied by zero adapters, and the runtime must
say so"*.

**Decision: report it, as a failed probe with `reason: "no_adapter_registered"`.**

Both readings are defensible, so here is why this one. The module's sentence is an accurate description
of its **input contract** — a pure function cannot invent rows — and it is not a policy that
capabilities should be invisible. `renderCapabilitySummary` already draws the distinction for a
capability whose every adapter failed: *an absent line and a line saying "nothing is here" are different
claims, and only one of them is true*. An operator asking "can this box do embeddings?" is owed the
answer **no**; omitting the line invites the reading "not applicable", which is a different and false
claim. `unclaimedCapabilityProbes` applies the module's own rule to the empty set.

**Not anticipated:** a third question turned out to matter more — *which* costs are classified. See §4.

## 3. Verification

**Suites (local, no network):** `npm run typecheck` clean across 3 configs · workers **138** (was 134) ·
node **473** (was 464) · `npm run platform:smoke` **5/5**, exit 0.

**Negative control — run, not asserted.** `providerProbes` was changed to ignore the secret entirely
(`const configured = true`). The key-free test went red with
`expected ['shahin','gemini','bulbul',…] to deeply equal ['homa']`. Restored, the workers suite is green
at 138. The control is recorded here rather than in a scratch file because the value is that it *fired*.

**Positive control, in the suite.** "Reports a gap" passes trivially against a probe that reports every
keyed bird as missing regardless of the environment, so a third case sets `GROQ_API_KEY` and requires
`shahin` to become usable **without displacing Homā**.

**Against a live core, through HTTP — the part that actually settled it.** The host suites use injected
rosters, which prove the wiring but agree with whatever the test believes. Booting the real
`startNodeRuntime` with the real `defaultProviders` and reading the endpoint over HTTP produced:

```
GET /api/v1/capabilities → 200

inference   ok       3/4 available: shahin, gemini, bulbul
embeddings  DEGRADED 0/1 available: (none)  [no_adapter_registered]
vector      DEGRADED 0/1 available: (none)  [no_adapter_registered]
sync        DEGRADED 0/1 available: (none)  [no_adapter_registered]
scheduler   DEGRADED 0/1 available: (none)  [no_adapter_registered]
4 of 5 capabilities degraded

  shahin      usable=true  cost=free     renewing=true  requires=["GROQ_API_KEY"]      reason=-
  gemini      usable=true  cost=free     renewing=true  requires=["GEMINI_API_KEY"]    reason=-
  bulbul      usable=true  cost=unknown  renewing=false requires=["HF_TOKEN"]          reason=-
  openrouter  usable=false cost=free     renewing=true  requires=["OPENROUTER_API_KEY"] reason=missing_config:OPENROUTER_API_KEY

GET /api/v1/capabilities (no token) → 401
```

**Four adapters, not five — and it is correct.** `simorgh-platform/src/runtimes/providers.ts` documents
itself as *"the Workers catalog, minus Homā"*, because Homā is a Cloudflare binding with no Node
equivalent. So the matrix reflects the roster it was given, which is the difference between probing and
enumerating, demonstrated on a live process rather than asserted.

With **no provider keys at all** but `OLLAMA_BASE_URL` set — the documented key-free local option — the
same endpoint returned `inference ok 1/5 available: ollama`, and `ollama(keyFree=true)`. The
zero-KYC path on the self-hosted host is real and the endpoint shows it.

## 4. Found but NOT fixed — one genuine gap, and it is a vocabulary problem

**`ollama` classifies as `unknown`, which means the only key-free option on the self-hosted host is
refused by the planner under `FREE_ONLY`.**

That is not a bug in the probe: `DEFAULT_PROVIDER_COST` has no `ollama` row, and the fallback is
`unknown` on purpose, so forgetting to classify a new bird fails closed instead of quietly becoming
free. But the consequence is real, and it is the *opposite* of the intent: the key-free local path —
the one that makes the self-hosted deployment work with no account — is the path `FREE_ONLY` would
refuse.

It was left alone because the fix is not a one-liner, and the reason is a **gap in the vocabulary**:
`renewing` means "does this allowance refill". A local Ollama daemon has no allowance at all — it is
your own hardware, unbounded and always present. `renewing: true` implies a refilling quota that does
not exist; `false` means "a one-time grant, spend last", which is worse. Neither is true, so neither
should be asserted without deciding what the third state is. That is a design call for the owner, not a
value to guess — and it is exactly the kind of "obvious" one-line fill-in that this repo's own doctrine
says should be measured before it is trusted.

Recorded at `DEFAULT_PROVIDER_COST` in `phoenix-core/src/capability-probes.ts` and here.

## 5. What I could NOT verify, and how I would

- **The edge host's live matrix.** `wrangler dev` needs Cloudflare tooling and a network this container
  is unreliable on; the edge is covered by `test/http.test.ts` against real miniflare bindings, which
  includes `env.AI`, so the *Homā-present* shape is asserted there but was not seen on a live process.
  To verify: `npm run dev` on a machine with Cloudflare egress and read `/api/v1/capabilities`.
- **That `simorgh -- doctor` surfaces the matrix.** The launch plan pairs the endpoint with a doctor
  matrix; `doctor` reads the fleet over connectors and was not touched here, so the two are not yet
  connected. To verify: run `npm run simorgh -- doctor` against a core with one key and confirm the
  matrix appears.
- **Cost classification beyond the five built-ins.** `DEFAULT_PROVIDER_COST` is a claim with a
  fail-closed default; nothing cross-checks it against a provider's published limits. §2.1 of the
  everybird plan is the evidence it is currently based on.

## 6. Caveat on this lane, stated plainly

**The same session wrote the brief and implemented it.** That is not the intended shape of a mailbox
lane and it removes the reviewer a dispatched brief would have had. The mitigations are real but
partial: the brief specified the deliverable and the negative control before the code existed, so the
acceptance criteria were not reverse-engineered from the implementation; the negative control was run
and its failure output is quoted above; and the live-core probe in §3 was evidence the brief's author
did not have and could not have staged. A genuinely independent review of `60599d7` and `5919e38` is
still worth asking for, and it is the one thing here I would not sign off on my own.

TASK-017-END
