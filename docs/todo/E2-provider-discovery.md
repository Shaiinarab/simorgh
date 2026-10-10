---
type: "Implementation Task"
title: "E2 — Evidence-backed provider and capability discovery"
description: "Discover and classify provider options from verified capabilities, cost, quota and eligibility rather than hard-coded vendor branches."
tags:
  - simorgh
  - todo
  - providers
  - capabilities
  - quota
  - epic-e
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "later"
priority: "P2"
depends_on:
  - B2
  - C1
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
  - id: free-only-adr
    resource: "../adr/ADR-0005-free-only-mode.md"
    title: "FREE_ONLY and unknown-cost rules"
---
# E2 — Evidence-backed provider and capability discovery

## TL;DR

A provider catalogue must describe verified options, not turn community claims into permanent facts.
Use the existing capability probes and cost/quota model; discover options instead of chasing provider count.

## Work

- Derive a normalized catalog from the existing provider and capability abstractions.
- Track wire shape, capabilities, model, cost class, quota windows/reset, rate-limit state, region,
  privacy/training terms, eligibility, source, last verification and confidence.
- Keep unknown cost ineligible under FREE_ONLY. Keep unverified limits distinct from reported limits.
- Use official provider documentation first and label community-only evidence as provisional.
- Support multiple explicit account resources only where providers permit that use. No throwaway-account
  creation, identity spoofing, subscription-cookie/OAuth routing, pooled public keys or ban evasion.
- After the discovery/probe path is useful, validate only a small set of candidates such as Gemini and
  OpenRouter :free; prove each with current official terms and a live test before enabling it.

## Acceptance

- The capability endpoint and routing reasons derive from one normalized contract.
- A provider is not eligible when cost/terms are unknown or incompatible with the requested capability.
- Catalog records include provenance and freshness and can be marked stale without code changes.
- Free-only routing never silently falls back to a paid or unclassified path.
