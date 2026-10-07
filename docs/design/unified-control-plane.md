# The unified control plane

One page over every platform this deployment touches, served at `GET /dashboard`.

The previous revision was a flock viewer with a console that could not work. This
document records what it became, and — more usefully — the two decisions inside it
that were not obvious.

---

## 1. The problem with "on / off"

The first draft of the connector matrix had two states, and both were wrong:

| State | What it told an operator | Why it is wrong |
|---|---|---|
| `on` | nothing to do | fine, when true |
| `off` | something is unconfigured | **conflates two different jobs** |

`off` cannot distinguish *"you forgot a key"* from *"nobody wrote the code"*. Those go
to different people: the first is a secret to add, the second is an integration to
build. A single `off` badge sends an operator on the secret hunt for a platform
nothing calls — and it will look configured afterwards, permanently, with no way to
see that it is still dead.

So the model is three states, and the precedence between them is load-bearing:

```
not-wired  ← wired: false            checked FIRST
needs-secret ← a required key absent
live       ← wired, and every required key present
```

`not-wired` is checked first, so an unbuilt connector cannot be reported as
`needs-secret` merely because its key happens to be absent. GitHub is the live example
in this repo: it has a declared `GITHUB_TOKEN` need and `wired: false`, and it reports
`not-wired` **even when the token is set**. Reversing the two checks is the
wrong-but-plausible page this design exists to prevent, and
`test/platform-connectors.test.ts` pins it.

### The matrix today

| Connector | State | Why |
|---|---|---|
| Cloudflare Workers | `live` | The host. `wired: true`, no secrets — the page rendering at all is the proof. |
| Telegram | `live` / `needs-secret` | `wired: true`. Live once `TELEGRAM_BOT_TOKEN` is set; `TELEGRAM_WEBHOOK_SECRET` is optional and does not block. |
| GitHub | `not-wired` | No runtime path in this Worker reads a GitHub token. Declared so the gap is visible, not so it looks supported. |

---

## 2. The console that could only break

`SIMORGH_API_KEY` is fail-closed: absent means `503 AUTH_NOT_CONFIGURED`, wrong means
`401`. The old page POSTed to `/api/v1/agent/execute` with no `Authorization` header
at all. There was no deployment in which that worked:

- key unset → `503`
- key set → `401`

The tempting fix is to open the route. The correct fix is to stop pretending the
browser is a trusted service:

- the operator pastes the key into the page; it lives in `localStorage` and goes out as
  a bearer header;
- the server never embeds it, so viewing the page source reveals nothing;
- the open panels (`/api/v1/flock/status`, which is unauthenticated by design — see
  `SECURITY.md` AUTH-001, and the server-rendered connector matrix) keep working with
  no key at all;
- every panel that stays dark says **why** it is dark, with the HTTP status and the
  code behind it.

A dashboard that hides *why* it is empty trains its reader to distrust it.

---

## 3. What each panel answers

Decisions first — a panel that does not lead to an action is decoration.

| Panel | The question | Source |
|---|---|---|
| KPI row (7 tiles) | Is it broken right now? | `/api/v1/flock/status` |
| Needs attention | What do I do next? | Derived; each row drills into its tab |
| Flock | Which bird, and how is it doing? | `/api/v1/flock/status` |
| Platforms | What is connected, and what is missing? | Server-rendered from the connector registry |
| Schedules | What is queued, and did it run? | `/api/v1/schedule` → DO `listScheduled()` |
| Quota | How much headroom is left? | `/api/v1/quota` → DO `getQuotaState()` |
| Tools & MCP | What can this deployment be asked to do? | `AGENT_TOOLS` and the engine's budgets |
| Direct chat | Ask it something. | `POST /api/v1/agent/execute` |

Three rules the panel set follows, each of which cost a rewrite to learn:

- **Rates, not averages.** The headline is `failures / calls` summed across birds, not
  an average of per-bird rates — an average would weight a busy bird and an idle one
  equally. The formula ships in the tile's `title` attribute, because a visible method
  is what stops two people deriving two numbers and then disagreeing about the board.
- **Seven tiles, not eight.** A dormant bird was the eighth. It is a deployment fact
  that cannot change without a redeploy, so as a permanent amber headline it teaches
  the reader to ignore the row. It lives in Needs attention, where it names the bird
  and the missing key.
- **Never guess a field.** The quota panel renders whatever columns the engine returns
  rather than hardcoding names it does not own. A panel that goes blank when a column
  is renamed is a panel that lies by omission.

---

## 4. Adding a platform

A connector is data, not code, and it is checked:

1. Add an entry to `CONNECTORS` in `src/platform.ts` — `id`, `label`, `summary`,
   `wired`, `secrets`, `surfaces`.
2. Wire the runtime path that talks to it.
3. List only surfaces that exist. The registry is asserted by
   `test/platform-connectors.test.ts`, which dials **every declared surface** and fails
   on a 404. A matrix that advertises a route nobody implemented is worse than a
   missing entry, because it is believed.

To promote GitHub from `not-wired` to `live` you need both halves: a route (or cron)
that calls the GitHub API, and then `wired: true` with that surface listed. The token
alone changes nothing — which is the whole point of the three-state model.

## 5. Adding another MCP server

A core speaks MCP at `/mcp`; the platform's own server publishes `platform_targets`,
`platform_fleet` and `platform_ask`. An MCP-backed connector follows the same route as
any other platform: add the connector entry, add the runtime path that consumes it,
and let the matrix report the truth about readiness.

There is deliberately no registry of MCP *servers* on this page. The fleet's servers
live on the host, not in the Worker, so the page cannot observe them — and a panel
listing servers it cannot reach would be the same lie as a `live` badge with no
surface behind it.

---

## 6. Verifying the page

`npm run typecheck` proves TypeScript is happy. It does **not** prove the client script
is valid JavaScript: the whole page is a string, and workerd has no `eval`. That gap
shipped a real bug — a string literal opened with `"` and closed with `'` — where
TypeScript was content, the page rendered, every content assertion passed, and the
browser would have thrown a `SyntaxError` that killed the entire dashboard, because one
malformed token takes the whole IIFE with it.

`npm run dashboard:check` closes it: extract the inline script, substitute the single
server-side interpolation for a literal, refuse to pass if the extraction is
suspiciously small, and hand it to `node --check`. It runs as part of
`npm run security:check`.
