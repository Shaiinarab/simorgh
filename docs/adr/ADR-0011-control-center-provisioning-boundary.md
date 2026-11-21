---
type: "Architecture Decision Record"
title: "ADR-0011 — Control Center provisioning and secret boundary"
description: "Decides how the GitHub Pages wizard, local provisioner, Core credentials and client profiles cooperate without leaking user secrets."
tags: [simorgh, adr, control-center, security, onboarding]
generated:
  by: "human:shahin"
  at: "2026-11-21T16:30:00+03:30"
status: "stable"
stale_after: "2027-11-21T00:00:00Z"
sources:
  - id: control-center
    resource: "../design/simorgh-control-center.md"
    title: "Control Center product and implementation design"
  - id: adr-0008
    resource: "ADR-0008-unified-surface-harness-api-gateways-wizards.md"
    title: "Four doors and the first-run wizard"
  - id: api-contract
    resource: "../api/CONTRACT.md"
    title: "Credential-derived principal contract"
  - id: setup
    resource: "../../src/setup.ts"
    title: "Provider key validation"
---

# ADR-0011 — Control Center provisioning and secret boundary

- **Status:** accepted
- **Date:** 2026-11-21
- **Decision:** GitHub Pages is a static, untrusted presentation layer; a local CLI-launched provisioner owns secrets and deployment actions.

## Context

The repository already has `site/index.html` and `.github/workflows/pages.yml`. The page is bilingual and contains deployment instructions, a browser-side token generator, Android configuration fields, and a Pages deployment workflow. It is a useful manual starter, but it is not yet an end-to-end provisioning application.

The earlier ADR-0008 proposal says provider tokens should be validated in the browser and secrets written to a generated repository through a dispatched workflow. That is not an acceptable default trust boundary: browser-held GitHub credentials, arbitrary workflow inputs, or generated commits create avoidable secret exposure and audit complexity.

## Decision

1. GitHub Pages hosts the static Control Center shell and public documentation only.
2. A local CLI-launched companion performs privileged operations. It binds to loopback, validates browser Origin, uses one-time pairing, and delegates to existing deployment adapters.
3. Provider keys are submitted directly to the local companion and installed into the selected Core host secret store. They are never sent to GitHub Pages, committed, placed in URLs, or saved in browser storage.
4. Personal Simorgh credentials are distinct from provider keys and service credentials. They map to a principal using the existing A3 contract. Client profiles are sensitive bearer-secret containers.
5. The wizard reuses the existing deploy plan/preflight/apply pipeline and target matrix. It does not create a new provisioning backend or second deployment engine.
6. The current setup validation endpoints remain validation-only. They must not become an unauthenticated remote secret-write endpoint.
7. Cloudflare/Wrangler OAuth and deployment credentials stay in the user's local CLI environment. The static site must never request a GitHub PAT or Cloudflare API token.

## Consequences

- The Pages wizard can be opened from any device, but provisioning requires the user's local CLI companion or an explicitly supported remote self-hosted admin surface.
- "All setup inside the website" is not safely achievable with a static public page alone. The local companion is the secure bridge that makes the experience feel like one wizard without turning Pages into a secret-handling server.
- The current manual site remains useful until the companion exists; documentation and UI must label manual steps honestly.
- Key lifecycle improvements (hashed storage, key IDs, scopes, expiry, rotation and revocation) are follow-up work, not assumed capabilities of the current JSON subject map.

## Rejected alternatives

- **Browser → GitHub API with a PAT:** broad bearer credential exposed to page JavaScript and browser extensions.
- **GitHub Actions workflow_dispatch with provider keys:** secrets appear in workflow payloads/logging/permissions surfaces and are difficult to reason about safely.
- **Commit secrets to a generated repository:** unacceptable, even for a private repository.
- **Central Simorgh-hosted key vault:** contradicts BYOK/self-sovereign operation and creates a high-value secret store.
- **Static-only "fully automated" claim:** technically false; Pages cannot deploy into a user's Cloudflare account or write host secrets without a privileged actor.

## Security invariants

- Loopback-only listener by default; no LAN bind unless an explicit, separately reviewed remote-admin mode is introduced.
- Strict Origin allow-list for the Pages origin and local UI; reject DNS-rebinding/host-header ambiguity.
- Pairing secret is high entropy, short lived, single use, and never logged.
- Redact provider keys, personal bearer credentials and authorization headers from logs/errors.
- No secrets in browser local/session storage, IndexedDB, service-worker caches, URLs, telemetry or Git history.
- Explicit confirmation before deployment, secret replacement, credential rotation or revocation.
- Negative tests prove the Pages origin never receives provider-key material and a non-loopback bind is rejected.

## Revisit conditions

Revisit only if a reviewed, user-controlled remote admin plane can provide equivalent isolation, least privilege, auditability and BYOK guarantees.
