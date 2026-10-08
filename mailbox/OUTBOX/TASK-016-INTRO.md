# TASK-016 INTRO — AI/context-engineering specialist

**Who I am:** Buffy, a Freebuff CLI agent on MiMo 2.6 Flash, taking the AI-engineering lane as
the session Lead. I have read the repo's AGENTS.md, the mailbox protocol, and the whole
TASK-016 brief before writing this.

**What I am good at:** routing/scheduling policy work in TypeScript (pure functions, TDD,
state machines), reading load-bearing comment-driven codebases, provider-API archaeology
(cache pricing, model tiers), and disciplined verification (negative controls, two-suite
splits, "verify against reality not your fixture"). Tooling first: the two-suite vitest
configs, `platform:smoke`, the mcp-fleet research servers (tavily/exa/firecrawl) for the
cache-economics pass, codebasememory's graph for call-chain impact, and the repo's own
ECC `cost-aware-llm-pipeline` + `benchmark-optimization-loop` skills for routing-pattern
and measurement discipline.

**How I approach a router problem here (3-5 steps):**
1. Read the routing policy end-to-end (`flock.ts`, `provider.ts`, `quota.ts`) and its ADRs;
   every comment is load-bearing, several document rejected alternatives.
2. Write the test that pins today's behaviour *before* touching the policy (byte-identical
   default is an acceptance criterion here, not a nicety).
3. Implement pure, host-injectable pieces in `phoenix-core`; never touch a port or a runtime
   binding; `boundary.test.ts` stays green or I stop.
4. Run the mandatory negative control for each new detector — break it, watch red, restore.
5. Verify the whole acceptance battery incl. wrangler dry-run, then write the honest report.

**What I would ask a maintainer:**
- Session affinity "bias decaying as context grows" — is there an existing session-id shape on
  the request path, or do I define the seam? (I'll look before asking; brief says host supplies.)
- §6 stretch: is a Cloudflare-account gateway id ever expected on this box for verification,
  or does the bird ship unverified-but-dry-run-clean?

**Is the brief well-specified?** Yes, unusually — adoptions have explicit MUST/MUST-NOT,
an allowlist, and mandated negative controls. What is genuinely open: the exact decay
function for the session bias, the complexity feature set, and whether the shared
value-model conclusion in §7 lands as code or as ADR prose. Those are decisions the brief
wants me to make and justify, which is the right shape.
