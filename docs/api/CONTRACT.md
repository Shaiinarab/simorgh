---
type: "API Contract"
title: "Simorgh — canonical REST contract"
description: "The single REST surface shared by the CLI, dashboard and Android client; identity is credential-derived."
tags:
  - simorgh
  - api
  - contract
  - okf
generated:
  by: "hy4-flash/opencode"
  at: "2026-11-20T00:00:00Z"
status: "stable"
stale_after: "2027-05-20T00:00:00Z"
sources:
  - id: execute-route
    resource: "../../src/index.ts"
    title: "The Workers core's execute route"
  - id: node-runtime
    resource: "../../simorgh-platform/src/runtimes/node.ts"
    title: "The Node host's equivalent routes"
  - id: execute-result
    resource: "../../phoenix-core/src/execute.ts"
    title: "ExecuteAgentResult, the answer shape"
  - id: identity-task
    resource: "../todo/A3-principal-identity.md"
    title: "A3 — credential-derived principal identity"
---
# Simorgh — canonical REST contract

## TL;DR

One REST surface, two hosts (Cloudflare Workers core and Node host). Both answer the same shapes so a
client never branches on host. Every route that *does work* authenticates with `Authorization: Bearer`
and resolves the acting principal from that credential (A3/AUTH-004). `X-Simorgh-User-Id` and a body
`userId` are **claims**: they may agree with the principal, never replace it. A disagreement is `403`.

Do not add routes here that are not in the code. When code and this contract disagree, the code wins and
this document is stale — fix it in the same change.

## Base URL and transport

- Clients configure one base URL. No host-specific paths: `/health` and `/api/v1/flock/status` exist on
  both hosts; `/mcp` exists on the Node host only.
- Content type is `application/json`. CORS allows `Authorization`, `Content-Type`,
  `X-Simorgh-User-Id` (the header is accepted as a claim, not as authority).
- Set `NO_PROXY=127.0.0.1,localhost` before probing a local core on this machine.

## Configuration (one schema, all clients)

| Field | Meaning | Required |
|---|---|---|
| `baseUrl` | Root of a running core, e.g. `http://127.0.0.1:8787` | yes |
| `apiKey` | Bearer token. A key in `SIMORGH_API_KEYS` maps to a user; a key equal to `SIMORGH_API_KEY` executes as `service` | yes for authed routes |
| `userId` | Optional identity **claim**. Omit it; send it only if it equals the token's subject | no |

The Android client stores these three fields locally. It never hardcodes a token, a URL, or a user id.

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness. Both core hosts answer `{status, timestamp}` (verified against a live Node core 2026-11-20). The separate Go gateway sends `{status, uptime, providers[]}` — **do not discriminate on a field you have not seen the host send**. |
| GET | `/api/v1/flock/status` | none | Bird/provider health snapshot; feeds the status screen |
| GET | `/api/v1/capabilities` | none | Capability matrix |
| GET | `/api/v1/quota` | bearer | Quota rows for the caller |
| POST | `/api/v1/agent/execute` | bearer | Run a prompt through the flock |
| GET | `/api/v1/schedule` | bearer | List **only the caller's** schedules |
| POST | `/api/v1/schedule` | bearer | Schedule a prompt, owned by the caller |
| GET | `/api/v1/user/{userId}/logs` | bearer, mapped subject | Read **only the caller's** transparency ledger |
| GET | `/api/v1/context/{refId}` | bearer, mapped subject | Read **only the caller's** offloaded context |
| POST | `/mcp` | bearer (Node host only) | JSON-RPC MCP tools, incl. `simorgh_ask` |

### POST `/api/v1/agent/execute`

Request:

```json
{
  "prompt": "non-empty string",
  "tools": ["search_web", "get_server_time"],
  "tier": "Free-Volunteer",
  "userId": "optional claim — must equal the token's subject"
}
```

Response `200`:

```json
{
  "success": true,
  "agentResponse": "the answer",
  "meta": {
    "answered_by": "Canned (Test double)",
    "bird_id": "canned",
    "ai_model": "canned-1",
    "contextRefId": "uuid",
    "requestId": "uuid",
    "loggedToLedger": true,
    "sanitizer_findings": [],
    "blocked_tools": []
  }
}
```

Error responses share one envelope:

```json
{ "success": false, "error": { "code": "FORBIDDEN", "message": "...", "requestId": "..." } }
```

Codes a client must handle: `401 UNAUTHORIZED` (missing/unknown token), `403 FORBIDDEN` (identity
claim disagrees with the credential), `429 RATE_LIMITED` (honour `Retry-After`), `503
AUTH_NOT_CONFIGURED` (deployment has no auth configured), `503 IDENTITY_UNRESOLVED` (read route with
a service token), `409 SCHEDULE_CONFLICT` (schedule id owned by another principal). Mismatch messages
are deliberately flat — a refused caller must not be able to enumerate which principals exist.

## Invariants for every client

1. Send no identity unless the user typed it deliberately; the credential always wins.
2. Never read another principal's logs, context or schedules; the server refuses it and the client
   must not retry with a different id.
3. Treat `agentResponse` as untrusted display text (the core already runs an output shield; the
   client still renders it as text, never as HTML or a command).
4. Render `meta` provenance (provider, request id, context ref) so an answer can be traced.
5. A `429` is backpressure, not failure: show `Retry-After` and disable send until it elapses.
