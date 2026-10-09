# OmniRouter → Simorgh adoption spec

Source: `github.com/Godde3s/omnirouter` (Go 1.25, ~36.7k LOC, v1.4.0). MIT — `LICENSE` reads "Copyright (c) 2026 Lelouch": **any ported file must carry that attribution line**.

## (a) Config schema — verbatim `.env.example` excerpt

```bash
PORT=8080
ROUTER_KEY=sk-omni-my-key
ADMIN_PASSWORD=admin
AUTO_CHAIN=qwen/qwen3.8-max,ds/deepseek-chat,gemini/gemini-3.6-flash,glm/glm-5.3,oc/big-pickle
RETRY_PER_PROVIDER=1
COOLDOWN_SECONDS=20
REQUEST_TIMEOUT=300
AUTH_TOKEN=omni-internal-change-me
COMBOS={"free-stack":["qwen/qwen3.8-max","gemini/gemini-3.6-flash","oc/big-pickle"]}
```

Custom/unknown APIs are objects in `data/omnirouter.json` (`internal/core/store.go:45`):

```json
{"name":"gemini","base_url":"https://…/v1","api_key":"…","models":["…"],"enabled":true,
 "model_map":{"gpt-4o":"gemini-3.6-flash"}}
```

Precedence: env → JSON store → dashboard CRUD.

## (b) Adapter interface (pseudocode, from `registry.go` / `bridges.go`)

```go
type Provider struct {                     // registry.go:38
  ID string; Kind enum{bridge, custom}; BaseURL string; APIKey string
  Enabled bool; Models []string; Aliases map[string]string  // public→upstream
  Healthy bool; LastErr string
}
type Bridge interface { Init(); Handler() http.Handler }    // bridges.go / mount.go
// core serves each bridge on 127.0.0.1:0 and forwards with the shared internal
// AUTH_TOKEN (bearer); custom providers get the real URL + their own key.
```

## (c) Failover rules (`proxy.go` ForwardChat / ForwardMessages)

1. `Resolve(model)` → ordered candidates: `auto` → `AUTO_CHAIN`; `provider/model` → single; `combo:name` → named chain; plain id → catalog owner first, then other owners.
2. Pass 1 skips candidates on cooldown; each candidate gets `RETRY_PER_PROVIDER` attempts. Retryable = `429/401/403/>=500`/transport error.
3. First non-retryable response is streamed to the client; **once the first byte is flushed there is no failover** — mid-stream failure becomes an SSE error frame.
4. A candidate exhausting retries is benched: `Cooldown(id, COOLDOWN_SECONDS)`.
5. Non-stream requests get `REQUEST_TIMEOUT`; streams are unbounded.
6. Pass 2: if *every* candidate was cooling, try them anyway — cooldown is a preference, not a block.
7. All failed → 502 / SSE `all_providers_failed`. Omitted `stream` ⇒ JSON (OpenAI spec).

## (d) Adopt, ranked (all in `phoenix-core/src` unless noted)

1. **Retry-per-bird before failover** — `flock.ts` fails over after one dial — **S**
2. **Pass 2 "cooldown is a preference"** when all birds cooling, instead of instant `flock_exhausted` — `flock.ts` — **S**
3. **Retryable classifier**: 401/403 = bird-scoped secret → fail over, never surface as caller error — `provider.ts` + `flock.ts` — **M**
4. **Stream-commit rule**: no failover after first byte; honest SSE error frame after — `execute.ts` — **S**
5. **Catalog layer**: 60s-TTL `/v1/models` refresh, static fallback list per bird, `provider/model` addressing, alias maps, named chains as pseudo-model ids — new `catalog.ts`, wire into `models.ts` — **M**
6. **Usage from SSE tail**: regex-scan last 8KB, first input / last output, chars/4 fallback — `quota.ts` — **M**

## (e) Do NOT copy

- Dashboard admin + live provider CRUD: config belongs in typed `ports.ts`/`SecretReader`, not a runtime mutation surface.
- The reverse-engineered web bridges (playwright, uTLS, WASM proof-of-work, cookie pools): the exact opposite of Simorgh's honest degradation and portability.
- Flat `.env`/`AUTO_CHAIN` string config; keep `COOLDOWN_RATE_LIMIT_MS` vs `COOLDOWN_FAILURE_MS` differentiation, which omnirouter lacks.
- OAuth device flow (RFC 8628): ~500 LOC + grant store; adopt only against a real client-connection story.
