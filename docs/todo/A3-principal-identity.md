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
status: "stable"
work_status: "done"
priority: "P0"
depends_on:
  []
stale_after: "2027-05-16T00:00:00Z"
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

**Shipped 2026-11-16.** The credential is now the only authority for the executing principal.
`/api/v1/agent/execute`, the MCP `ask` tool, and schedule create/list resolve the subject from the
bearer token; `X-Simorgh-User-Id` and body `userId` are claims that must match or the call is refused
(403). Rate-limit keys and ledger rows are written under the resolved subject. A service-only
deployment executes as the named `service` principal and has no per-user read surface.

**Verified 2026-11-16** after merging Qwen's `qwenone/` work into `main`: `upm run typecheck` exit 0
(3 configs), `upm test` green on **both** suites (188 workers / 18 files, 522 Node / 28 files),
`upm run security:scan` PASS. Cross-principal negative tests run against a real core on the Node host
(`simorgh-platform/test/integration.test.ts`) and on Workers (`test/identity.test.ts`), including a
header and body spoof, rate-budget isolation, an unknown token, and the matching-claim positive control.
The `principal` column migration (`migrateScheduledSchema`) keeps pre-A3 rows firing while making them
invisible to every principal — fail closed on reads and writes, inert on the clock.

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
