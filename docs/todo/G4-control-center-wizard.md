---
type: "Implementation Task"
title: "G4 — Simorgh Control Center and secure setup provisioner"
description: "Turn the existing bilingual GitHub Pages starter into a guided setup experience backed by a loopback-only CLI provisioner and portable client identity."
tags: [simorgh, todo, control-center, wizard, onboarding]
generated:
  by: "human:shahin"
  at: "2026-11-21T16:30:00+03:30"
status: "stable"
stale_after: "2027-02-21T00:00:00Z"
work_status: queued
priority: P1
depends_on: [A3, existing-deploy-planner, ADR-0011]
sources:
  - id: design
    resource: "../design/simorgh-control-center.md"
    title: "Control Center design"
  - id: adr
    resource: "../adr/ADR-0011-control-center-provisioning-boundary.md"
    title: "Provisioning security decision"
  - id: pages
    resource: "../../site/index.html"
    title: "Existing static setup page"
  - id: planner
    resource: "../../simorgh-platform/src/deploy/"
    title: "Existing deployment plan/preflight/apply"
---

# G4 — Simorgh Control Center and secure setup provisioner

**Status: queued. Priority: P1.** The existing Pages site is a bilingual manual starter, not a complete provisioning flow. See [ADR-0011](../adr/ADR-0011-control-center-provisioning-boundary.md) and the [Control Center design](../design/simorgh-control-center.md).

## Scope

- Rework the current site into a six-step onboarding journey: target, providers, capabilities, deploy/verify, identity, clients.
- Add a CLI command that starts a loopback-only local provisioner and serves the actual interactive wizard at localhost; Pages remains the public launcher/docs surface.
- Reuse deploy plan/preflight/apply and target eligibility metadata.
- Validate provider keys, then install them directly into the user's selected host secret store.
- Issue/map a personal Simorgh credential to a principal and export a versioned connection profile/QR.
- Add profile import to CLI, local web app and Android clients in that order.
- Keep Persian RTL and English parity, mobile-first responsive behavior, accessible status/errors and resumable steps.

## Non-goals

- No centralized secret vault, account pooling, automatic provider account creation, browser PAT, workflow_dispatch secret payload, or secret-bearing generated repository.
- No rewrite of phoenix-core, no second deployment engine, no full PWA framework, and no Rust rewrite of the wizard.
- Do not promise that a static GitHub Pages page alone can provision a user's Cloudflare account.

## Implementation slices

1. **G4.1 — UX and truth pass:** audit existing site copy and steps; distinguish shipped manual behavior from planned automation; add target/secret trust explanations.
2. **G4.2 — Local provisioner:** CLI command, loopback HTTP server, Origin validation, one-time pairing, redacted structured logs, graceful shutdown.
3. **G4.3 — Provider setup:** reuse provider catalog and validation; install secrets through host adapters; test wrong keys, provider outage and key redaction.
4. **G4.4 — Deploy orchestration:** reuse plan/preflight/apply; preview, explicit confirmation, retries, health/capability/flock probes.
5. **G4.5 — Identity lifecycle:** generate personal credential, map to principal, export profile; test wrong principal, service-token misuse, rotation/revocation.
6. **G4.6 — Client handoff:** CLI profile import, local web app profile import, Android QR/profile import.
7. **G4.7 — Quality gate:** browser E2E, Persian RTL, keyboard/accessibility, mobile, Pages workflow, secret-leak negative controls.

## Acceptance checks

- [ ] Pages page is deployable by the existing GitHub Actions workflow and repository Pages source is configured to GitHub Actions.
- [ ] A new user can complete local setup without manually editing JSON secrets or copying commands between unrelated pages.
- [ ] No provider key reaches the Pages origin, browser storage, workflow input, logs or Git history.
- [ ] Provisioner rejects non-loopback bind and invalid Host/Origin/CSRF requests; local UI session bootstrap is short-lived.
- [ ] Provider validation is truthful and never persists the submitted key itself.
- [ ] Plan is visible before deploy and deploy requires explicit confirmation.
- [ ] Personal credential authenticates as the expected principal across API, CLI, local web app and Android.
- [ ] Profile export/import is versioned and treats the credential as a secret.
- [ ] Key rotation/revocation has tested server-side behavior before the UI exposes it.
- [ ] English and Persian RTL journeys pass browser tests.

## Current blocker

The GitHub Pages workflow exists at `.github/workflows/pages.yml` and publishes `site/` on changes. This repository inspection did not verify the repository's Pages setting or a successful live deployment. Check Settings → Pages → Build and deployment → Source = GitHub Actions, then inspect the Pages workflow run. A green workflow alone does not prove that the Pages source setting or custom domain is correct.
