---
type: "Product Design"
title: "Simorgh Control Center — one setup, every client"
description: "Product and implementation design for the hosted static onboarding surface and local provisioning companion."
tags: [simorgh, control-center, onboarding, identity, wizard, security]
generated:
  by: "human:shahin"
  at: "2026-11-21T16:30:00+03:30"
status: "draft"
stale_after: "2027-02-21T00:00:00Z"
sources:
  - id: adr-0011
    resource: "../adr/ADR-0011-control-center-provisioning-boundary.md"
    title: "Provisioning boundary and credential lifecycle"
  - id: contract
    resource: "../api/CONTRACT.md"
    title: "Canonical REST contract"
  - id: setup
    resource: "../../src/setup.ts"
    title: "Provider key validation and setup metadata"
  - id: pages
    resource: "../../site/index.html"
    title: "Current bilingual setup page"
  - id: roadmap
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
---

# Simorgh Control Center

> **Configure once. Connect every Simorgh client.**

## Product definition

The Control Center is the first-run experience for an individual's Simorgh deployment. It is not a public multi-tenant credential broker and it is not a place where provider secrets are stored by GitHub Pages.

A user should finish setup with:
- one reachable Simorgh Core endpoint;
- one personal Simorgh credential mapped to a principal;
- provider integrations configured on the Core host;
- a tested connection profile that can be imported by CLI, local web app and Android;
- a recovery path that does not require returning to the Pages site.

The existing `site/index.html` is already a bilingual static setup page. It currently explains Node/Workers/VPS deployment, generates a client-side token/map, and documents Android configuration. It does **not** provision a Cloudflare account, install provider secrets, create a durable user account, or automatically connect every client. Do not describe those operations as shipped.

## UX: a guided control plane, not a long settings form

Use a persistent 6-step progress rail with a visible completion state and a compact "advanced" drawer. Every step has a safe skip path when optional.

1. **Choose where Simorgh lives**
   - Local machine (recommended for first-time users), Cloudflare Workers, or self-hosted server.
   - Explain ownership, availability, cost, and where secrets reside.
   - Show target eligibility with a verification date; never promise a free tier without current evidence.
2. **Connect AI providers**
   - Provider cards grouped into "recommended", "connected", and "available".
   - Reveal one key field at a time; paste, validate, show provider/model/validation timestamp, then immediately hand the secret to the local provisioner.
   - Never persist raw keys in browser storage, URL, analytics, logs, generated static files, Git commits, or a remote Pages endpoint.
   - Support "skip for now"; Homā/zero-key mode remains an honest baseline where available.
3. **Configure capabilities**
   - Model/provider priority, allowed tools, retrieval/knowledge, MCP endpoints, optional Telegram/Discord.
   - Safe defaults first; advanced routing and limits behind disclosure.
4. **Deploy and verify**
   - Preview a human-readable plan before execution.
   - Require explicit confirmation before writing secrets or deploying.
   - Stream step status; preserve redacted logs and a retry action.
   - Run health, capabilities, flock and authenticated identity probes.
5. **Create your Simorgh identity**
   - Generate a high-entropy personal bearer credential locally with Web Crypto.
   - Show it once with copy/download and recovery warning.
   - Register/map it to a principal through the authenticated local provisioner; never send it to the Pages origin.
   - Distinguish it from provider keys and any deployment-wide service credential.
6. **Connect your devices**
   - Generate an importable `simorgh-profile.json` and QR code containing only Core URL, personal credential, principal label, and schema version.
   - Offer CLI, local web app, Android, and MCP connection instructions.
   - QR is a bearer-secret display: warn before showing, do not embed in public screenshots, and provide rotate/revoke actions.

## Credential model

- **Provider secret**: e.g. `GROQ_API_KEY`, `GEMINI_API_KEY`. Stored only in the user's Core host secret store.
- **Personal Simorgh credential**: random bearer secret used by clients. The Core maps it to a principal using the existing A3 identity model (`SIMORGH_API_KEYS` today).
- **Service credential**: deployment/operator-only credential, never shipped to mobile or browser clients.
- **Connection profile**: portable client configuration. It contains the personal bearer credential and is therefore sensitive.

The current A3 implementation uses a JSON token-to-subject map. The first implementation may generate and install that mapping through the local provisioner, but the design should leave room for hashed credential records, key IDs, scopes, expiry, last-used metadata, rotation and revocation. Do not claim those lifecycle features until implemented and tested.

## Deployment and trust boundaries

**GitHub Pages** serves only the static, bilingual Control Center shell. It is the discovery/documentation surface, not a secret vault or provisioning backend.

**Local setup companion** is the trusted provisioning boundary. The user launches it through the CLI; it binds to loopback only, validates the browser Origin, uses short-lived one-time pairing, and delegates deployment to existing target adapters/Wrangler. It accepts provider keys only over loopback, redacts all output, writes secrets directly to the selected host, and never returns provider keys to the page after submission. It must reject non-loopback binds by default.

**Core API** remains the single runtime contract shared by Node/Go/Workers and clients. The existing `POST /api/v1/setup/validate` and `POST /api/v1/setup/check-mcp` routes are validation helpers, not a remote secret installation API. Keep them that way unless a separately reviewed security design changes the boundary.

No GitHub PAT in the browser. No GitHub Actions workflow that accepts arbitrary provider keys in workflow inputs. No secrets committed to a generated repository. No centralized Simorgh server that stores user provider keys.

## Recommended implementation shape

- Reuse the existing `simorgh-platform/src/deploy/{plan,preflight,apply}.ts` planner and target matrix. Do not create a second deployment engine.
- Add a small local provisioning command and loopback HTTP bridge in `simorgh-platform`; the existing CLI remains the orchestration entry point.
- Keep the static Pages surface dependency-light. The first version can remain semantic HTML + TypeScript/vanilla modules; use progressive enhancement and accessible form controls.
- Use the current Hono 4 host and shared `phoenix-core` contracts. Avoid adding a second backend framework.
- TypeScript 7 native preview is already present in the repository toolchain; treat it as a pinned compiler experiment, not a reason to migrate application code to unstable APIs.
- HTMX 4 can be evaluated for server-rendered local wizard fragments only after its release/API stability and browser behavior are verified. It is not required for the static shell or a reason to introduce a server round-trip architecture.
- Keep Go 1.27 as the high-throughput gateway/runtime convergence track (G2), not as a rewrite of the wizard.
- Rust remains optional and evidence-gated under ADR-0010. Do not add Rust to the onboarding critical path.

## Acceptance criteria

- A first-time user can choose Local Node, Cloudflare, or self-hosted without reading the full README.
- Provider keys are never sent to the Pages origin or persisted in browser storage.
- The local companion binds only to loopback and enforces Origin + one-time pairing.
- Deployment plans are previewed and require confirmation; failed steps are resumable and report actionable errors.
- A generated personal credential authenticates as the intended principal; a service credential is not substituted.
- CLI, local web app and Android consume the same versioned connection profile.
- Key rotation/revocation behavior is documented and tested before calling the flow production-ready.
- Keyboard, screen-reader, mobile, RTL Persian and English flows are tested.
- Pages build and deploy workflow succeeds from GitHub Actions; the repository Pages source is configured to GitHub Actions.

## Delivery order

1. Correct the product/security contract and update docs (this design + ADR + task).
2. Improve the current static page's information architecture and make the existing manual flow accurate.
3. Implement the local CLI provisioner and loopback bridge.
4. Wire provider validation, host secret installation and deployment plan/apply.
5. Implement identity issuance/mapping and connection-profile export/import.
6. Add client onboarding adapters in order: CLI, local web app, Android.
7. Add browser E2E, secret-leak negative controls, and deployment smoke checks.
