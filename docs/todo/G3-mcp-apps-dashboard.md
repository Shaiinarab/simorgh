---
type: "Implementation Task"
title: "G3 — MCP Apps: the dashboard as a ui:// resource"
description: "Expose the existing server-rendered dashboard as an MCP Apps resource on the core's MCP surface so MCP hosts render flock/quota/schedules inside the conversation."
tags:
  - simorgh
  - todo
  - mcp
  - mcp-apps
  - dashboard
  - epic-g
generated:
  by: "kilo/ernie-5.5-flash-preview"
  at: "2026-11-21T15:00:00Z"
status: "draft"
work_status: "queued"
priority: "P2"
depends_on:
  - E1
stale_after: "2027-02-21T00:00:00Z"
sources:
  - id: deep-recon
    resource: "../research/NOVEMBER-2026-DEEP-RECON.md"
    title: "November 2026 deep recon — MCP Apps as the first official extension"
  - id: mcp-apps
    resource: "https://modelcontextprotocol.io/extensions/apps/overview"
    title: "MCP Apps overview"
  - id: dashboard
    resource: "../../src/dashboard.ts"
    title: "The existing server-rendered dashboard"
  - id: mcp-server
    resource: "../../simorgh-platform/src/mcp/server.ts"
    title: "The platform MCP server (where the ui:// resource would attach)"
---

# G3 — MCP Apps: the dashboard as a ui:// resource

## TL;DR

MCP Apps (2026-01-26) is the first official MCP extension: a server declares interactive HTML
resources via the `ui://` scheme, associates them with tools through metadata, and hosts render them
in a sandboxed iframe connected back over the same JSON-RPC path. Simorgh's dashboard already exists
as server-rendered HTML (`src/dashboard.ts`): flock status, quota, schedules, the connections manager.
Expose it as an MCP Apps resource on the core's MCP surface so Claude, VS Code Copilot, Goose and
Postman render it **inside the conversation** — the "dashboard that comes to where the operator
already is". No second UI stack.

## Work

- Implement E1 first (the stateless 2026-07-28 core MCP surface); Apps rides on it.
- Add a `ui://simorgh/dashboard` resource served by the core MCP server, with tool metadata
  (`_meta.ui.resourceUri`) on a `simorgh_status` tool so hosts know which UI to show.
- The resource is read-only flock/quota/schedules HTML (reuse the existing dashboard rendering,
  not a rewrite); every mutation stays a tool call through the normal audit path.
- Declare the `io.modelcontextprotocol/apps` extension in `server/discover` capabilities.

## Acceptance

- `tools/list` shows the UI metadata; `resources/read` on the `ui://` URI returns the HTML.
- A real MCP Apps host (Claude Desktop or Goose) renders the dashboard and a status refresh works.
- The UI resource carries `ttlMs`/`cacheScope` like every other list/read result.
- No secrets in the resource; it shows the same fields the authenticated dashboard shows.

## Depends on

E1 (stateless MCP surface + `server/discover`).