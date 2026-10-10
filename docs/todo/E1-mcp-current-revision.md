---
type: "Implementation Task"
title: "E1 — Current-revision MCP plus task-shaped tools"
description: "Resolve the declared-revision and transport mismatch, preserve deliberate legacy support, and expose tasks."
tags:
  - simorgh
  - todo
  - mcp
  - api
  - interop
  - epic-e
generated:
  by: "openai/gpt-6"
  at: "2026-10-10T15:05:00Z"
status: "draft"
work_status: "queued"
priority: "P2"
depends_on:
  - B1
  - D1
stale_after: "2026-10-17T00:00:00Z"
sources:
  - id: roadmap-spine
    resource: "../ROADMAP-SPINE.md"
    title: "Canonical roadmap"
  - id: continuation-review
    resource: "../research/CONTINUATION-REVIEW-2026-10-10.md"
    title: "Continuation review, October 10 2026"
  - id: mcp-spec
    resource: "https://modelcontextprotocol.io/specification/2026-07-28/changelog"
    title: "MCP 2026-07-28 changelog"
---
# E1 — Current-revision MCP plus task-shaped tools

## TL;DR

The server declares revision 2026-07-28 but still requires the older initialize handshake and
Mcp-Session-Id. Support the current stateless path, and preserve older-client behavior only if explicitly
tested. Do not claim conformance without a real client check.

## Work

- Inspect the exact protocol shape from the official 2026-07-28 changelog before editing.
- Add the stateless request path and required version/routing metadata; retain an explicit legacy path
  for clients that need it.
- Expose task-shaped tools on the core surface: task create/status/cancel/wait, goal create, knowledge
  search and agent execute.
- Keep platform_* tools on the platform; simorgh_* task tools belong to one core.
- Use the official TypeScript SDK as a real integration client. Treat the standardized Tasks extension
  as a separate decision from application-specific tools.
- Keep OpenAI-compatible chat completion support as a separate one-client spike, not an assumed route.

## Acceptance

- The current stateless and explicitly supported legacy paths work in integration tests.
- A real external client can list and call the core's task tools.
- Tool lists are compared exactly, errors match the protocol shape, and unsupported features fail
  explicitly rather than pretending to work.
