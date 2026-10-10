# GhostBrain → Simorgh Adoption Spec

Source: `github.com/Godde3s/GhostBrain` (MIT, v1.0.0) — one file `GhostBrain.py` (3268 lines) + `docs/AMOOZESH-KAMEL.md` (211 lines, Persian walkthrough). **Test inventory: zero automated tests** — no `test_*`/`pytest`; the README's only "tests" are its live-agent matrix (OpenCode, OpenClaw, Hermes, Cline, LangChain, Aider). Adopt the patterns, not that posture (`phoenix-core` has 18 vitest suites); the changelog header (`:7-102`) is portable: bug *and* fix.

Paths are real: `phoenix-core/src/` = engine, `src/index.ts` = Hono entry, `simorgh-platform/src/` = control plane.

## 1. Pool: round-robin, admission queue, 429 cooldown, return-to-pool

`:1820-1829` `_pick_healthy`, `:1831-1860` `acquire`, `:1862-1882` `unavailable_error`, `:1178-1194` `refresh_status`, `:1737-1754` `_check_post_health`, `:1896-1904` `add_account`. Accounts = one persistent browser profile on disk (`Gemini_Profiles/profile_N`, `:950`); state = `status ∈ {healthy,busy,rate_limited,needs_login,failed,offline}` + `_cooldown_until` (`:1079-1085`).

```text
rr := 0
acquire(deadline):                        # admission queue
  loop: w := workers[rr++ % n]; if healthy: re-probe login; if ok: w := busy; return w
        if now >= deadline: return unavailable()   # 429 if ALL rate_limited, else 503
        sleep 0.4
429 -> status := "rate_limited"; cooldownUntil := now + 60s
tick: now < cooldownUntil -> stay "rate_limited"   # return-to-pool is time-driven
```
Pre-flight failover (`:2220-2232`): send is awaitable, so `needs_login`/`editor_not_found`/`send_failed` retry the **next** worker before any SSE byte. → `phoenix-core/src/flock.ts`, `health.ts` (per-account cooldown; `COOLDOWN_RATE_LIMIT_MS` is already 60s), new `accounts.ts`, retry in `execute.ts`. **M**

## 2. Dual-protocol shaping: sniff window + heartbeat

`:2328-2383` (`_shape_stream`), `:2316-2317` (`SNIFF_MAX_CHARS=8192`, `SSE_HEARTBEAT_S=12`), `:501-506`, OpenAI builders `:664-734`, Anthropic events `:2609-2670`.

```text
normalize(deltas) -> ("text",d) | ("tools",calls) | ("end",finish,full) | ("hb")
sniffing := tools advertised; buf := ""
on delta: buf += d; if sniffing and buf.lstrip() starts "```" or "{": hold while len <= 8192 else stop sniffing; flush buf[flushed:]
hb := asyncio.wait({next}, 12)   # task race — never cancels the stream
end: tools advertised and extract(full) hits -> ("tools",calls) + ("end","tool_calls")
```
OpenAI: first delta carries `{"role":"assistant"}` (`:668`); all calls in ONE chunk, indices `0..n`, `finish_reason:null` then a `"tool_calls"` chunk (`:705-721`); heartbeat = `": ping\n\n"` (`:2462`). Anthropic: `message_start`→`ping`→`content_block_start`/`content_block_delta{text_delta}`→per call `content_block_start{tool_use,input:{}}`+`content_block_delta{input_json_delta,partial_json}`+`content_block_stop`→`message_delta{stop_reason}`→`message_stop`; `ping` on heartbeat. → new `phoenix-core/src/sse.ts`; routes in `src/index.ts` + aliases `:2287-2294`. **M**

## 3. Tool calls: byte-sniffing, JSON repair, name validation

`:523-593` `extract_tool_calls`, `:469-498` `repair_json_obj`, `:454-466` `_JSON_FIXES`, `:2320-2325` validation set.

```text
fenced ```json {…}``` first; bare brace scan only if no fenced call
normalize: parameters -> arguments; missing -> {}
arguments as str -> repair_json_obj(...) else {"raw": args}
if tool_names and name ∉ tool_names: reject as prose; cleaned := text minus consumed spans
repair ladder, json.loads each: [raw, True/False/None/undefined -> true/false/null,
                                 “”‘’ -> ",", trailing "," before }/]]
```
→ new `phoenix-core/src/tool-calls.ts`, wired into `tools.ts` / `agent.ts`. **S**

## 4. TokenMiser history dedup

`:320-351`; scope is one request — v0.2.1's singleton cache leaked `[cached block]` into unrelated conversations (`:321-324`).

```text
compress(msgs): seen := set()
  for m: if len(content) > 5000: h := md5(content)[:8]
    if h in seen: content := "[SYSTEM: repeated block {h} omitted — identical block earlier in THIS conversation]"
    else seen.add(h)
```
→ new `phoenix-core/src/history.ts`, called from `execute.ts`. **S**

## 5. Translation, config, guards, route table

`anth_to_openai` `:800-908`: system blocks → system message, `tool_use` → `tool_calls[]`, `tool_result` → `role:"tool"`+`tool_call_id` (before user text), `tool_choice any|tool` → `"required"|named`, images counted then 422; `count_tokens` `:2717-2734`. Env defaults (`:929-999`,`:1105`,`:2001`): `HOST/PORT=127.0.0.1:8000`,`WORKERS=2`,`API_KEY=""` (key-free),`IDLE_TIMEOUT=120`,`COOLDOWN=60`,`MAX_PROMPT=120000`,`QUEUE_TIMEOUT=60`,`STRICT_MODEL=0`,`HEADLESS=auto`,`CORS=same-origin`,`ROUTES`. Auth: `x-api-key` **or** `Bearer`, one body both protocols parse (`:1959-1983`); DNS-rebinding Host guard (`:1941-1956`). Bonus: `ghost_routes.json` `fnmatch` model→upstream routing + SSE passthrough (`:2005-2022`, `:2043-2122`). → new `phoenix-core/src/protocol.ts`, `security.ts`, env/routes in `src/index.ts` + `provider.ts`. **M**

## MIT notice

MIT requires the notice in copies/substantial portions. In every derived file header: `Portions derived from GhostBrain (MIT) © 2026 RealMDstar & Godde3s — github.com/Godde3s/GhostBrain`, plus a root `NOTICE` entry and `phoenix-core/README.md`. Files: `phoenix-core/src/{sse,protocol,tool-calls,history,accounts,flock,health}.ts` (wherever the algorithm is ported, not merely inspired).
