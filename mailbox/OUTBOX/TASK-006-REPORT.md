# TASK-006 — Platform MCP Server

- Brief: `mailbox/INBOX/TASK-006.md`
- Instance: shai-pc (headless pool lane)
- Status: **done**

## Summary

Shipped the platform's own MCP server so an agent host can drive the fleet over the same protocol the platform already speaks. Two files created (both within Allowlist):

- **`simorgh-platform/src/mcp/server.ts`** — `platformMcpHandler(options?)` returning a `FetchLike`. Exposes five tools: `platform_targets`, `platform_fleet`, `platform_ask`, `simorgh_status`, `simorgh_ask`. JSON-RPC 2.0 envelope, session-oriented (`Mcp-Session-Id` enforced on every `tools/call`), accepts `application/json` requests and returns `application/json` responses. Delegates to instances via the injected `fetch`.
- **`simorgh-platform/test/mcp-server.test.ts`** — 13 tests (all passing).

Key design decisions:
- **Content encoding**: `application/json` — the server returns JSON responses inline (not SSE). The MCP client (`connectors/mcp.ts`) tolerates both `application/json` and `text/event-stream`; JSON is simpler and sufficient for a server that always responds synchronously.
- **`platform_*` prefix** on all fleet-level tools to prevent confusion with a core's `simorgh_*` tools when both are reachable from one agent host.
- **Tool failures** return `isError: true` with a readable message in the result, never HTTP 500.
- **Unknown method** → JSON-RPC error (`-32601`). **Unknown tool** → `isError: true` in result.
- The server takes `instances` as an option (not global state), so tests can inject stub instances and the server never mutates the fleet file.

## Checks

### npm run typecheck

```
npm run typecheck && echo OK-typecheck
npm notice run tsgo --noEmit && tsgo --noEmit -p phoenix-core/tsconfig.json && tsgo --noEmit -p simorgh-platform/tsconfig.json
OK-typecheck
```

### npm test (workerd + node)

```
npm test && echo OK-workerd
 RUN  v4.1.11 /home/shai/personal/projects/projects/opensource/simorgh-platform
 Test Files 10 passed (10)
      Tests 82 passed (82)
 RUN  v4.1.11 /home/shai/personal/projects/projects/opensource/simorgh-platform
 Test Files 17 passed (17)
      Tests 202 passed (202)
OK-workerd
```

### mcp-server tests

```
npx vitest run --config vitest.node.config.ts simorgh-platform/test/mcp-server.test.ts && echo OK-mcp-server
 RUN  v4.1.11 /home/shai/personal/projects/projects/opensource/simorgh-platform
 Test Files 1 passed (1)
      Tests 13 passed (13)
OK-mcp-server
```

### vitest node run (tail)

```
npx vitest run --config vitest.node.config.ts 2>&1 | tail -5
 Test Files 17 passed (17)
      Tests 202 passed (202)
```

### CLI still works

```
npm run simorgh -- targets >/dev/null && echo OK-cli-still-works
OK-cli-still-works
```

### Raw platform_targets JSON

The server returns this for a `tools/call` on `platform_targets` (shown unwrapped from MCP content blocks for readability):

```json
[
  {
    "id": "cloudflare-workers",
    "label": "Cloudflare Workers (the edge)",
    "runtime": "workerd",
    "connectors": ["rest", "mcp"],
    "modes": ["manual", "cli"],
    "endpoint": "https://{service}.workers.dev"
  },
  {
    "id": "node",
    "label": "Self-hosted Node process",
    "runtime": "node",
    "connectors": ["rest", "mcp"],
    "modes": ["manual", "cli"],
    "endpoint": "http://{origin}"
  },
  {
    "id": "byo-endpoint",
    "label": "An existing phoenix-core (bring your own)",
    "runtime": "unknown",
    "connectors": ["rest", "mcp"],
    "modes": ["manual"],
    "endpoint": "{origin}"
  }
]
```

(The raw wire response wraps this in `{ "content": [{ "type": "text", "text": "<JSON above>" }] }` as per MCP tool-result convention.)

## Next_actions

- Lead to wire `platformMcpHandler` into the platform's HTTP routing (per brief, Lead handles integration).
- All 13 tests pass; no further work required within this task's scope.

## Artifacts

- `simorgh-platform/src/mcp/server.ts` — platform MCP server implementation (new, ~400 lines)
- `simorgh-platform/test/mcp-server.test.ts` — 13 tests covering: initialize protocol version, initialize serverInfo, tools/list schemas, round trip through own client (health + status), session enforcement (without and with), unknown method, unknown tool, platform_targets schema, platform_fleet empty/unknown, platform_ask dead fleet, platform_ask failover

## NAGs

None — all acceptance commands that fall within scope pass with zero errors.

TASK-006-END
