# Port spec — `api-access-gateway` → Simorgh

Source: https://github.com/jaavid/api-access-gateway @ `a4cc71c` (v2.0.0), one file,
`src/worker.js` (205 lines). **MIT — Copyright (c) 2025 Jaavid — retain the notice in any
portion ported into `simorgh-platform`** (a header/NOTICE credit, not just a link).

## 1. Control endpoints — verbatim response shapes

`GET /_gateway/health` (`worker.js:90-96`)
```json
{ "ok": true, "version": "2.0", "auth_required": true }
```
`GET /_gateway/routes` (`worker.js:98-111`) — `{ routes: [{ name, upstream, probe_path }] }`,
name-sorted, unparsable entries skipped. `GET /_gateway/probe/:route` (`worker.js:113-143`), id
`[A-Za-z0-9._-]+`:
```json
{ "ok": true, "route": "telegram", "reachable": true, "upstream_status": 404, "latency_ms": 87 }
```
Unreachable → `502` `{ ok, route, reachable: false, error: <Error.name>, latency_ms }`; unknown
route → `404` `{ ok: false, route, error: "route_not_found" }`. **Any completed HTTP response
counts as reachable** (`README.md:128`) — a 404 still proves DNS/TLS/HTTP.

## 2. KV schema (dual-format, `normalizeRouteConfig` `worker.js:28-60`)

Legacy string: `/telegram -> api.telegram.org`. Rich JSON:
`{"upstream":"https://api.telegram.org","probe_path":"/"}`. Normalisation adds `https://` when
missing, pins `url.origin` (killing path/query injection), rejects non-http(s), defaults
`probe_path` to `"/"`. Keys are read as `/` + route name (`worker.js:63`).

## 3. Security pattern to adopt

Body/headers proxied verbatim, but before `fetch` (`worker.js:178-180`):
`headers.delete('X-API-Gateway-Key'); headers.delete('X-Upstream-Bot-Token'); headers.delete('host');`
Auth is `X-API-Gateway-Key === GATEWAY_API_KEY` (`worker.js:22-26`), checked once in
`handleRequest` before any branch. Token-safe bot forwarding: the caller sends
`POST /telegram/bot/sendMessage` + `X-Upstream-Bot-Token`, the Worker reconstructs
`/bot<TOKEN>/...` (`worker.js:73-87`) after rejecting `[\r\n/]` and >2048 chars — the
credential never enters a logged URL. Errors: `401 unauthorized`, `400 invalid_route`/
`invalid_bot_token`, `404 route_not_found`, `502 upstream_unreachable`, all
`{ ok: false, error }`, never echoing `error.message` (`worker.js:194-199`).

## 4. Minimal Hono sketch (per-bird probe/health, extends — does not duplicate)

```ts
// src/bird-probe.ts — mounted in src/index.ts. Bearer-gated like /api/v1/capabilities.
const GATEWAY_HEADERS = ["X-Api-Gateway-Key", "X-Upstream-Bot-Token", "Host"];

function stripGatewayHeaders(init: RequestInit): RequestInit {
  const h = new Headers(init.headers);
  for (const name of GATEWAY_HEADERS) h.delete(name);
  return { ...init, headers: h };
}

app.get("/api/v1/flock/probe/:birdId", async (c) => {
  const denied = await requireServiceAuth(c);
  if (denied) return denied;
  const bird = PROVIDERS.find((p) => p.id === c.req.param("birdId"));
  if (!bird) return c.json({ ok: false, error: "bird_not_found" }, 404);
  const started = Date.now();
  try {
    const res = await fetch(bird.probePath ?? "/", stripGatewayHeaders({
      method: "GET", redirect: "manual", headers: c.req.raw.headers,
    }));
    return c.json({ ok: true, bird: bird.id, reachable: true,
      upstream_status: res.status, latency_ms: Date.now() - started });
  } catch (e) {
    return c.json({ ok: false, bird: bird.id, reachable: false,
      error: (e as Error).name, latency_ms: Date.now() - started }, 502);
  }
});
```

## 5. Conflicts to resolve before porting

1. **Duplication.** `GET /api/v1/capabilities` (`src/index.ts:442`) plus
   `phoenix-core/src/capability-probes.ts` already probe every bird off the same `PROVIDERS`
   the router dials (`capability-probes.ts:41-46` forbids a second rule). Adopt the *shape*
   (`ok`/`reachable`/`latency_ms`, any-status-counts) and the header-strip helper — not a
   parallel probe implementation.
2. **Runtime boundary.** `phoenix-core` must stay runtime-agnostic (`boundary.test.ts`); the
   probe itself stays in the Worker (`src/`), only shapes go in core.
3. **`probe_path` source.** `Provider` (`phoenix-core/src/provider.ts:38`) has no probe-path
   field; add one there, or reuse the model endpoint — a third source of truth is the failure
   `capability-probes.ts:1-13` documents.
4. **Do not port the open proxy.** The gateway forwards arbitrary paths to allowlisted hosts;
   Simorgh needs no egress proxy and has no `APIRoutes` KV. Only the health/probe contract and
   the header-strip are portable.
