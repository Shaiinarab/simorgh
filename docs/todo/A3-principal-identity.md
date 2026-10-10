---
type: "Implementation Task"
title: "A3 — Credential-derived principal identity"
description: "Make authenticated credentials the only authority for user-scoped identity and ownership."
tags:
  - simorgh
  - todo
  - security
  - identity
  - epic-a
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "next"
priority: "P0"
depends_on:
  []
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
  - id: security-audit
    resource: "../SECURITY-AUDIT.md"
    title: "Security audit"
---
# A3 — Credential-derived principal identity

## TL;DR

This is the security gate. Resolve the principal from the credential, not from a user ID supplied in
the request. Do not enable multi-user autonomous execution until the acceptance checks pass on both
Workers and Node.

## Work

- Resolve the authenticated principal from the credential/key map.
- Make the identity used by execute, quota, task, schedule, context, ledger, retrieval and connector
  operations come from that resolved subject.
- Treat X-Simorgh-User-Id and body user IDs as claims to validate, never as authority.
- Define service-only credentials explicitly: either disallow per-user execution without a mapped
  principal, or use a distinct service principal that is not silently treated as a user.
- Keep error responses non-enumerating and preserve the existing fail-closed auth behavior.

## Acceptance

- Test A cannot execute, schedule, read logs/context, consume B's rate/quota, search B's knowledge,
  invoke B's connectors or write ledger rows as B.
- Attempt identity spoofing through both header and body on both Workers and Node.
- A valid bearer token with an unknown principal cannot fall back to anonymous user ownership.
- Run both suites and the security scan; do not weaken existing checks to pass.

## Refuse

Do not add a giant policy engine here. Fix the identity seam and ownership checks directly, using the
existing credential map, auth helpers and ledger.
