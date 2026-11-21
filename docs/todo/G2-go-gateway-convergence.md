---
type: "Implementation Task"
title: "G2 — Go gateway on the core contract (fleet convergence)"
description: "Make the Go runtime speak the core contract so it can join the fleet as a first-class core, keeping its SSE, sealed keys and quota accounting as the reason to converge."
tags:
  - simorgh
  - todo
  - go
  - gateway
  - convergence
  - epic-g
generated:
  by: "kilo/ernie-5.5-flash-preview"
  at: "2026-11-21T15:00:00Z"
status: "draft"
work_status: "queued"
priority: "P1"
depends_on:
  - A3
stale_after: "2027-02-21T00:00:00Z"
sources:
  - id: deep-recon
    resource: "../research/NOVEMBER-2026-DEEP-RECON.md"
    title: "November 2026 deep recon — the stranded-asset finding"
  - id: adr-0010
    resource: "../adr/ADR-0010-native-module-policy.md"
    title: "Native-module policy (records the convergence decision)"
  - id: go-audit
    resource: "https://dev.to/pranay_batta/best-open-source-ai-gateway-in-2026-2flb"
    title: "Bifrost (Go) throughput class — maintainer-reported, independently reviewed"
  - id: state
    resource: "../STATE-OF-PROJECT.md"
    title: "§4 — the Go side and the precise gap"
---

# G2 — Go gateway on the core contract

## TL;DR

The Go gateway is a real answering runtime with capabilities the TypeScript hosts lack — SSE streaming,
AES-256-GCM sealed keys, latency-EMA failover, quota accounting — but it speaks **none** of the core
contract, so the fleet cannot include it. Converge it: implement the core contract on the Go host, pass
the connector conformance kit against it, and let `simorgh-platform` connect to it like any other core.
The 2026 market evidence (Go gateways as the throughput tier) says this is the biggest product lever
available; the REA build-info audit (go1.27.2, revision `f3b0436`) says the asset is current.

## Work

- Add the core-contract routes to `gateway/internal/server`: `GET /health` (core shape
  `{status, timestamp}` — the Go host currently sends `{status, uptime, providers[]}`, which the
  preflight correctly treats as an impostor), `GET /api/v1/flock/status` (bird/answered_by wire
  fields), `POST /api/v1/agent/execute` (the `executeAgent` union's raw-ingredients form), 
  `GET /api/v1/user/{id}/logs` (ledger read, principal-scoped), `POST /mcp`
  (`simorgh_status`, `simorgh_ask`, 2026-07-28 stateless shape).
- Reuse `packages/crypto` (sealed keys) and the quota state; do not fork policy.
- Add a Go-host target to `simorgh-platform/src/targets.ts` (`go-gateway`) with a step list that
  actually completes; run `runConnectorConformance()` against it.
- Prove the fleet can include it: `simorgh connect go-gateway http://127.0.0.1:8788 --api-key …`
  then `simorgh ask`.

## Acceptance

- The connector conformance kit passes against the Go host (the same assertions every connector must
  satisfy).
- The preflight distinguishes the Go core from an impostor (health shape check).
- `upm run e2e:ask` gains a Go-host leg (or a new `e2e:go` script) that reaches a real Go core over
  REST and MCP.
- `GOFLAGS=-mod=readonly go build all && go vet github.com/shaiinarab/simorgh/... && go test
  github.com/shaiinarab/simorgh/...` green (the GOFLAGS trap is per-command, never a vendor dir).
- No semantic drift: the Go policy stays the Go policy; only the wire contract converges.

## Depends on

A3 (principal identity) — the execute route must resolve the principal from the credential, not a
client claim.