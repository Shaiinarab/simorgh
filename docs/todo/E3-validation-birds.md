---
type: "Implementation Task"
title: "E3 — Evidence-gated validation providers"
description: "Add only the smallest provider set needed to validate discovery, capability and quota routing."
tags:
  - simorgh
  - todo
  - providers
  - validation
  - epic-e
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "later"
priority: "P3"
depends_on:
  - E2
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
---
# E3 — Evidence-gated validation providers

## TL;DR

Do not add birds for a round number. Add at most Gemini and OpenRouter free models to prove that the
discovery/cost/quota contract works end-to-end.

**Verified 2026-10-12.** The three birds added 2026-10-12 (cerebras, nvidia, aigateway in `src/flock.ts`)
carry NO cost classification, so FREE_ONLY refuses them although the commit calls them "three free
birds"; `docs/research/Simorgh Deep Research Audit (October 2026).md` records that Cerebras' free trial
now requires a verified payment method.

## Acceptance

- Each candidate has a dated official source for cost, allowed use, limits and privacy/training terms.
- Missing quota facts remain unknown rather than fabricated.
- Live tests prove the adapter's response shape, rate-limit headers and failure classification.
- The provider is kept dormant unless configuration and FREE_ONLY eligibility are both proven.
