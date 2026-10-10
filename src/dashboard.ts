// ── Dashboard — the unified control plane ─────────────────────────────────────
//
// One page over every platform this deployment touches: the flock (Cloudflare
// Durable Objects), the scheduler those objects own, their quota table, the
// connector matrix, the tool surface, and a chat console.
//
// ── Why it is still one self-contained string ──
//
// No build step. The page is served by the same Worker that answers its API, so a
// dashboard that needed a bundler would be a second deployment to keep in sync with
// the first — and the failure mode of a dashboard that drifts from its API is worse
// than a plain one, because it is believed.
//
// ── The auth decision, and why the page asks you for a token ──
//
// `SIMORGH_API_KEY` is fail-closed: without a bearer token every authed route
// answers 401 (or 503 when the key is unset entirely). The previous revision of this
// page POSTed to `/api/v1/agent/execute` with no header at all, so its console could
// only ever have worked in a deployment with no key configured — that is, exactly the
// deployment that should not be exposed. The fix is not to open the route.
//
// The operator pastes the key into the page; it is kept in `localStorage` and sent as
// a bearer header. The server never embeds it, so viewing the page's source reveals
// nothing, and a browser with no key still gets the open panels (flock status is
// deliberately unauthenticated — SECURITY.md AUTH-001) plus an explicit reason for
// every panel that stays dark. A dashboard that hides *why* it is empty trains its
// reader to distrust it.

import { connectorReadiness, toolSurface, type ConnectorReadiness } from "./platform";

/** `</script>` inside a JSON island would close the tag early; `<` never needs to appear. */
function jsonIsland(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const STATUS_COPY: Record<ConnectorReadiness["status"], string> = {
  live: "live",
  "needs-secret": "needs a secret",
  "not-wired": "not wired",
};

export function renderDashboard(env: Env): string {
  const connectors = connectorReadiness(env);
  const tools = toolSurface();

  // Server-rendered so the matrix is correct on first paint and with no token: a
  // readiness badge that only appears after an authenticated fetch would be blank
  // in exactly the deployment an operator most needs to inspect. Derived from the
  // same `connectorReadiness` the API serves, so the two cannot disagree.
  const connectorCards = connectors
    .map((c) => {
      const secrets = c.secrets.length
        ? c.secrets
            .map(
              (s) =>
                '<li><code>' +
                s.name +
                "</code> <span class=\"tag " +
                (s.present ? "ok" : s.required ? "bad" : "warn") +
                '">' +
                (s.present ? "set" : s.required ? "missing" : "optional, unset") +
                "</span>" +
                '<div class="micro">' +
                s.description +
                "</div></li>"
            )
            .join("")
        : '<li class="micro">No secrets required — it is the host.</li>';

      const surfaces = c.surfaces.length
        ? c.surfaces
            .map(
              (s) =>
                '<li><span class="method ' +
                s.method.toLowerCase() +
                '">' +
                s.method +
                '</span> <code>' +
                s.path +
                "</code> " +
                (s.auth
                  ? '<span class="tag warn">bearer</span>'
                  : '<span class="tag ok">open</span>') +
                (s.note ? '<div class="micro">' + s.note + "</div>" : "") +
                "</li>"
            )
            .join("")
        : '<li class="micro">No routes yet — nothing calls this platform at runtime.</li>';

      return (
        '<article class="connector ' +
        c.status +
        '">' +
        '<header><h3>' +
        c.label +
        '</h3><span class="pill ' +
        c.status +
        '">' +
        STATUS_COPY[c.status] +
        "</span></header>" +
        '<p class="micro">' +
        c.summary +
        "</p>" +
        '<h4>Secrets</h4><ul>' +
        secrets +
        "</ul>" +
        '<h4>Reaches us at</h4><ul>' +
        surfaces +
        "</ul>" +
        '<footer class="micro">' +
        c.docs +
        "</footer></article>"
      );
    })
    .join("");

  const toolRows = tools
    .map(
      (t) =>
        '<li><code>' +
        t.name +
        '</code> <span class="tag">' +
        t.kind +
        '</span><div class="micro">' +
        t.detail +
        "</div></li>"
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simorgh — Control Plane</title>
<style>
  :root {
    --bg:#070b14; --panel:rgba(17,26,45,.8); --raised:rgba(27,39,64,.72);
    --line:rgba(150,180,255,.16); --text:#eef4ff; --muted:#96a5c2;
    --cyan:#5ee7df; --blue:#7aa7ff; --amber:#ffc870; --green:#75e4a5; --red:#ff6b6b;
    --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; color:var(--text); font:15px/1.55 Inter,ui-sans-serif,system-ui,sans-serif;
    background:
      radial-gradient(circle at 10% 0%, #17294f 0, transparent 34rem),
      radial-gradient(circle at 94% 22%, #0f3a4a 0, transparent 30rem),
      var(--bg);
    min-height:100vh;
  }
  .shell { max-width:1180px; margin:auto; padding:1.75rem 1.25rem 4rem; }
  a { color:var(--cyan); }
  code { font-family:var(--mono); font-size:.86em; color:#d7e4ff; }
  h1 { font-size:clamp(1.6rem,3.6vw,2.4rem); letter-spacing:-.035em; margin:0; }
  h1 span { color:var(--cyan); }
  h3 { margin:0; font-size:1rem; }
  h4 { margin:1rem 0 .4rem; font-size:.7rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  ul { list-style:none; margin:0; padding:0; }
  li { padding:.4rem 0; border-bottom:1px solid rgba(150,180,255,.08); }
  li:last-child { border-bottom:0; }
  .micro { color:var(--muted); font-size:.8rem; margin:.2rem 0 0; }
  .bar { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0 1.25rem; }
  .bar input {
    padding:.5rem .7rem; border:1px solid var(--line); border-radius:.5rem;
    background:rgba(7,11,20,.65); color:var(--text); font:inherit; font-size:.86rem;
  }
  .bar input#token { flex:1 1 18rem; font-family:var(--mono); }
  button {
    padding:.5rem 1rem; border:0; border-radius:.5rem; cursor:pointer; font:inherit;
    font-weight:600; background:linear-gradient(120deg,var(--blue),var(--cyan)); color:#06101c;
  }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--text); font-weight:500; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .tabs { display:flex; flex-wrap:wrap; gap:.3rem; border-bottom:1px solid var(--line); margin-bottom:1.25rem; }
  .tabs button[aria-selected="true"] { color:var(--cyan); border-bottom:2px solid var(--cyan); }
  .tabs button { background:none; border:0; border-bottom:2px solid transparent; color:var(--muted); border-radius:0; padding:.55rem .8rem; font-weight:500; }
  section[hidden] { display:none; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr)); gap:.7rem; }
  .kpi { padding:.9rem 1rem; border:1px solid var(--line); border-radius:.7rem; background:var(--panel); }
  .kpi b { display:block; font-size:1.65rem; letter-spacing:-.03em; line-height:1.2; }
  .kpi .micro { text-transform:uppercase; letter-spacing:.1em; font-size:.66rem; }
  .kpi.click, .answer.click { cursor:pointer; transition:border-color .15s, background .15s; }
  .kpi.click:hover, .answer.click:hover { border-color:var(--cyan); }
  .kpi.click:hover { background:var(--raised); }
  .answer.click { border:1px solid transparent; }
  .answer.click:hover { background:rgba(94,231,223,.08); }
  .kpi.good b { color:var(--green); } .kpi.warn b { color:var(--amber); } .kpi.bad b { color:var(--red); }
  .kpi.info b { color:var(--cyan); }
  table { width:100%; border-collapse:collapse; font-size:.87rem; }
  th,td { text-align:left; padding:.55rem .6rem; border-bottom:1px solid rgba(150,180,255,.1); }
  th { font-size:.68rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  td.num { font-family:var(--mono); }
  .dot { display:inline-block; width:.6rem; height:.6rem; border-radius:50%; margin-right:.4rem; vertical-align:middle; }
  .dot.healthy { background:var(--green); box-shadow:0 0 .6rem var(--green); }
  .dot.tired { background:var(--amber); box-shadow:0 0 .6rem var(--amber); }
  .dot.dormant { background:var(--muted); }
  .tag { font-size:.66rem; padding:.1rem .4rem; border-radius:.35rem; background:rgba(150,180,255,.14); color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .tag.ok { background:rgba(117,228,165,.16); color:var(--green); }
  .tag.warn { background:rgba(255,200,112,.16); color:var(--amber); }
  .tag.bad { background:rgba(255,107,107,.16); color:var(--red); }
  .pill { font-size:.66rem; padding:.2rem .55rem; border-radius:1rem; text-transform:uppercase; letter-spacing:.08em; }
  .pill.live { background:rgba(117,228,165,.16); color:var(--green); }
  .pill.needs-secret { background:rgba(255,200,112,.16); color:var(--amber); }
  .pill.not-wired { background:rgba(150,180,255,.14); color:var(--muted); }
  .method { font-family:var(--mono); font-size:.68rem; padding:.08rem .35rem; border-radius:.3rem; background:rgba(122,167,255,.18); color:#cfe0ff; }
  .method.post { background:rgba(255,200,112,.18); color:var(--amber); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(19rem,1fr)); gap:1rem; }
  .connector { padding:1.1rem 1.2rem; border:1px solid var(--line); border-radius:.8rem; background:var(--panel); }
  .connector header { display:flex; justify-content:space-between; align-items:center; gap:.75rem; }
  .connector.not-wired { opacity:.78; }
  .panel { padding:1.1rem 1.2rem; border:1px solid var(--line); border-radius:.8rem; background:var(--panel); margin-bottom:1rem; }
  .notice { padding:.7rem 1rem; border-left:3px solid var(--amber); background:rgba(255,200,112,.08); border-radius:.4rem; color:#f2dfbe; font-size:.85rem; margin-bottom:1rem; }
  .notice.bad { border-color:var(--red); background:rgba(255,107,107,.08); color:#ffd9d9; }
  .notice.ok { border-color:var(--green); background:rgba(117,228,165,.08); color:#d6f7e5; }
  .answers { display:grid; gap:.4rem; margin-top:.9rem; }
  .answer { padding:.55rem .7rem; border-radius:.45rem; background:var(--raised); font-size:.86rem; }
  .answer form { display:flex; gap:.4rem; }
  .answer input { flex:1; padding:.35rem .5rem; border:1px solid var(--line); border-radius:.4rem; background:rgba(7,11,20,.6); color:var(--text); font:inherit; font-size:.8rem; }
  .chat-log { display:flex; flex-direction:column; gap:.5rem; max-height:26rem; overflow-y:auto; margin:.9rem 0; }
  .msg { padding:.6rem .8rem; border-radius:.6rem; font-size:.88rem; white-space:pre-wrap; max-width:80%; }
  .msg.me { align-self:flex-end; background:rgba(122,167,255,.18); }
  .msg.flock { align-self:flex-start; background:var(--raised); }
  .msg.err { align-self:flex-start; background:rgba(255,107,107,.14); color:#ffd9d9; }
  .tries { font-family:var(--mono); font-size:.72rem; color:var(--cyan); }
  .row { display:flex; gap:.6rem; flex-wrap:wrap; align-items:center; }
  .row input, .row select { padding:.45rem .6rem; border:1px solid var(--line); border-radius:.45rem; background:rgba(7,11,20,.65); color:var(--text); font:inherit; font-size:.84rem; }
  .row input.grow { flex:1 1 16rem; }
  footer.page { margin-top:2.5rem; color:var(--muted); font-size:.8rem; }
</style>
</head>
<body>
<div class="shell">
  <h1>🦅 SIMORGH <span>// CONTROL PLANE</span></h1>
  <p class="micro">Flock, scheduler, quota, connectors and tools — one page, sourced from the live deployment.</p>

  <div class="bar">
    <input id="token" type="password" placeholder="SIMORGH_API_KEY (bearer) — required for quota, schedule and chat" autocomplete="off">
    <button id="save-token" class="ghost">Save key</button>
    <button id="forget" class="ghost">Forget</button>
    <button id="refresh" class="ghost">Refresh</button>
    <label class="micro"><input type="checkbox" id="auto" checked> auto (5s)</label>
  </div>

  <div id="auth-note"></div>
  <div id="signal-note"></div>

  <nav class="tabs" role="tablist">
    <button role="tab" data-tab="overview" aria-selected="true">Overview</button>
    <button role="tab" data-tab="flock" aria-selected="false">Flock</button>
    <button role="tab" data-tab="platforms" aria-selected="false">Platforms</button>
    <button role="tab" data-tab="schedule" aria-selected="false">Schedules</button>
    <button role="tab" data-tab="quota" aria-selected="false">Quota</button>
    <button role="tab" data-tab="tools" aria-selected="false">Tools &amp; MCP</button>
    <button role="tab" data-tab="chat" aria-selected="false">Direct chat</button>
  </nav>

  <section id="tab-overview">
    <div class="kpis" id="kpis"><div class="kpi"><b>…</b><div class="micro">loading</div></div></div>
    <h4>Needs attention</h4>
    <div class="panel" id="attention"><p class="micro">Loading…</p></div>
  </section>

  <section id="tab-flock" hidden>
    <div class="panel">
      <h3>Birds</h3>
      <p class="micro">Live from the Durable Object. Call and failure counts are per-bird totals since the object was created.</p>
      <table><thead><tr>
        <th>Bird</th><th>Provider</th><th>Model</th><th>Priority</th><th>State</th>
        <th>Calls</th><th>Failures</th><th>Fail %</th><th>Cooldown</th>
      </tr></thead><tbody id="flock-rows"><tr><td colspan="9" class="micro">Loading…</td></tr></tbody></table>
    </div>
  </section>

  <section id="tab-platforms" hidden>
    <p class="micro">Readiness is derived from the live environment, not from configuration intent. <strong>Not wired</strong> means no runtime path exists here — adding a token would change nothing.</p>
    <div class="cards" style="margin-top:.9rem">${connectorCards}</div>
  </section>

  <section id="tab-schedule" hidden>
    <div class="panel">
      <h3>Schedule a flight</h3>
      <p class="micro">Runs through the same flock, once, at or after the given time. The Durable Object's alarm wakes the object; a row whose host died is reclaimed on a later pass.</p>
      <div class="row" style="margin-top:.8rem">
        <input id="s-id" placeholder="task id (unique)" size="18">
        <input id="s-prompt" class="grow" placeholder="prompt for the flock">
        <input id="s-in" type="number" min="0" value="5" size="6" title="minutes from now">
        <span class="micro">minutes from now</span>
        <button id="s-add">Schedule</button>
      </div>
      <div id="s-note" class="micro"></div>
    </div>
    <div class="panel">
      <h3>Scheduled flights</h3>
      <table><thead><tr><th>Id</th><th>State</th><th>Resume at</th><th>Attempts</th><th>Outcome</th></tr></thead>
      <tbody id="s-rows"><tr><td colspan="5" class="micro">Requires a bearer key.</td></tr></tbody></table>
    </div>
  </section>

  <section id="tab-quota" hidden>
    <div class="panel">
      <h3>Account quota</h3>
      <p class="micro">Every declared account, over RPC from the Durable Object.</p>
      <div id="quota-body"><p class="micro">Requires a bearer key.</p></div>
    </div>
  </section>

  <section id="tab-tools" hidden>
    <div class="panel">
      <h3>Tool surface</h3>
      <p class="micro">The allow-list the executor vets against, read from the same constant it enforces.</p>
      <ul style="margin-top:.6rem">${toolRows}</ul>
    </div>
    <div class="panel">
      <h3>Adding another MCP server</h3>
      <p class="micro">A core speaks MCP at <code>/mcp</code> (the Node runtime; the Workers host serves the REST routes); the platform's own server publishes <code>platform_targets</code>, <code>platform_fleet</code> and <code>platform_ask</code>. Adding a platform is a connector entry in <code>src/platform.ts</code> plus the runtime path that uses it — the panel above is generated from that array, so a connector cannot show as live without a surface behind it.</p>
    </div>
  </section>

  <section id="tab-chat" hidden>
    <div class="panel">
      <h3>Direct chat</h3>
      <p class="micro">Sends through <code>/api/v1/agent/execute</code>, which is bearer-gated. The reply is the flock's answer after tool rounds.</p>
      <div class="chat-log" id="chat-log"></div>
      <div class="row">
        <input id="c-prompt" class="grow" placeholder="Ask the flock…" value="What is the current server time?">
        <button id="c-send">Send</button>
      </div>
    </div>
  </section>

  <footer class="page">© 2026 Shahin Arab · MIT · Si morgh → Simorgh. Thirty birds → one.</footer>
</div>

<script>
(function () {
  var CONNECTORS = ${jsonIsland(connectors)};
  var TOKEN_KEY = "simorgh_api_key";
  var state = { flock: null, quota: null, schedule: null, lastFetch: 0, busy: false };
  var $ = function (id) { return document.getElementById(id); };

  // localStorage can throw in a locked-down browser; the page must still render.
  function readToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function writeToken(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function authHeaders() {
    var t = readToken();
    return t ? { Authorization: "Bearer " + t } : {};
  }

  // A single fetch helper so every authed panel fails the same, legible way.
  function api(path, init) {
    var opts = init || {};
    var headers = Object.assign({}, opts.headers || {}, authHeaders());
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (body) {
        return { status: r.status, ok: r.ok, body: body };
      });
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function num(n) { return typeof n === "number" ? n.toLocaleString() : "—"; }
  function pct(a, b) { return b > 0 ? (100 * a / b).toFixed(1) + "%" : "—"; }
  function minsFromNow(ms) {
    if (!ms || ms <= 0) return "—";
    var d = ms - Date.now();
    if (d <= 0) return "due";
    return Math.ceil(d / 60000) + "m";
  }

  function authNote() {
    var el = $("auth-note");
    if (!readToken()) {
      el.innerHTML = '<div class="notice">No bearer key set. The flock, connector and tool panels read live; quota, schedules and chat will answer 401/503 until you paste <code>SIMORGH_API_KEY</code> above.</div>';
      return;
    }
    el.innerHTML = "";
  }

  function signalNote(status) {
    var el = $("signal-note");
    if (!status) { el.innerHTML = ""; return; }
    if (status.source === "kv-cache") {
      var age = status.timestamp ? Math.round((Date.now() - status.timestamp) / 1000) : null;
      el.innerHTML = '<div class="notice">Serving the KV snapshot — the Durable Object did not answer. The picture is ' +
        (age === null ? "of unknown age" : age + "s old") +        ", and its timestamp is when it was true, not when it was served.</div>";
      } else {
      el.innerHTML = '<div class="notice ok">Live from the Durable Object.</div>';
    }
  }

  function renderKpis() {
    var s = state.flock;
    if (!s) { $("kpis").innerHTML = '<div class="kpi"><b>—</b><div class="micro">no flock data</div></div>'; return; }
    var birds = s.birds || [];
    var now = Date.now();
    var calls = birds.reduce(function (a, b) { return a + (b.totalCalls || 0); }, 0);
    var fails = birds.reduce(function (a, b) { return a + (b.totalFailures || 0); }, 0);
    var cooling = birds.filter(function (b) { return (b.cooldownUntil || 0) > now; }).length;
    var healthy = birds.filter(function (b) { return !b.dormant && b.status === "healthy"; }).length;
    var pending = state.schedule ? state.schedule.filter(function (t) { return t.state === "pending" || t.state === "running"; }).length : null;
    var rate = calls > 0 ? fails / calls : 0;

    // Seven tiles, and each one is a question with an action behind it. A dormant
    // bird is deliberately *not* a tile: it is a deployment fact that never changes
    // without a redeploy, so as a headline number it would sit permanently amber and
    // teach the reader to ignore the row. It lives in Needs attention instead, where
    // it names the bird and the missing key.
    //
    // Every computed tile carries its own formula in the title attribute. A rate whose
    // method is not visible is a rate two people will compute two ways and then
    // disagree about — and the disagreeing is what destroys trust in the whole board.
    var tiles = [
      { v: healthy + "/" + birds.length, l: "birds ready", c: healthy === birds.length ? "good" : healthy > 0 ? "warn" : "bad", go: "flock", t: "Non-dormant birds currently reporting healthy, of all declared birds." },
      { v: num(calls), l: "calls", c: "info", go: "flock", t: "Sum of totalCalls across every bird, since the Durable Object was created." },
      { v: num(fails), l: "failures", c: fails === 0 ? "good" : "warn", go: "flock", t: "Sum of totalFailures across every bird. A skipped dormant bird is not a failure." },
      { v: (100 * rate).toFixed(1) + "%", l: "failure rate", c: rate === 0 ? "good" : rate < 0.1 ? "warn" : "bad", go: "flock", t: "failures / calls, summed across every bird. Not an average of per-bird rates \u2014 that would weight a busy bird and an idle one equally." },
      { v: num(cooling), l: "cooling down", c: cooling === 0 ? "good" : "warn", go: "flock", t: "Birds whose cooldownUntil is still in the future; each is skipped without being charged." },
      { v: pending === null ? "\u2014" : num(pending), l: "scheduled", c: pending ? "info" : "", go: "schedule", t: "Rows in the Durable Object's schedule that are pending or running." },
      { v: s.source === "kv-cache" ? "KV" : "LIVE", l: "signal", c: s.source === "kv-cache" ? "warn" : "good", go: "platforms", t: "LIVE means the Durable Object answered. KV means it did not, and this is the last snapshot \u2014 older than the timestamp shown below." }
    ];

    $("kpis").innerHTML = tiles.map(function (t) {
      return '<div class="kpi ' + t.c + (t.go ? " click" : "") + '"' +
        (t.go ? ' data-go="' + t.go + '"' : "") +
        ' title="' + esc(t.t || "") + '">' +
        "<b>" + esc(t.v) + '</b><div class="micro">' + esc(t.l) + "</div></div>";
    }).join("");
  }

  function renderAttention() {
    // Each entry carries the tab that resolves it, so the overview is a route into
    // the detail rather than a summary the reader has to go hunting from.
    var items = [];
    var s = state.flock;
    if (!s) items.push(["warn", "No flock status — the Durable Object and the KV snapshot both failed.", ""]);
    if (s) {
      s.birds.forEach(function (b) {
        if (b.dormant) items.push(["info", esc(b.name) + " is dormant: no " + esc(b.provider) + " secret in this deployment.", "platforms"]);
        else if ((b.cooldownUntil || 0) > Date.now()) items.push(["warn", esc(b.name) + " is cooling down for another " + minsFromNow(b.cooldownUntil) + ".", "flock"]);
        else if (b.status === "tired") items.push(["warn", esc(b.name) + " is tired after " + num(b.consecutiveFailures) + " consecutive failures.", "flock"]);
        else if ((b.totalFailures || 0) > 0) items.push(["info", esc(b.name) + " has " + num(b.totalFailures) + " recorded failure(s) in " + num(b.totalCalls) + " calls.", "flock"]);
      });
    }
    CONNECTORS.forEach(function (c) {
      if (c.status === "needs-secret") items.push(["warn", esc(c.label) + " needs " + esc(c.missing.join(", ")) + ".", "platforms"]);
      if (c.status === "not-wired") items.push(["info", esc(c.label) + " is declared but not wired — see the Platforms tab.", "platforms"]);
    });
    if (!readToken()) items.push(["info", "No bearer key set, so quota, schedules and chat are dark.", ""]);

    var body = items.length
      ? items.map(function (i) {
          return '<div class="answer' + (i[2] ? " click" : "") + '"' + (i[2] ? ' data-go="' + i[2] + '"' : "") +
            '><span class="tag ' + (i[0] === "warn" ? "warn" : i[0] === "bad" ? "bad" : "") + '">' + i[0] + "</span> " + i[1] + "</div>";
        }).join("")
      : '<div class="answer"><span class="tag ok">clear</span> Every bird ready, every wired connector live.</div>';
    $("attention").innerHTML = body;
  }

  function renderFlock() {
    var s = state.flock;
    if (!s) { $("flock-rows").innerHTML = '<tr><td colspan="9" class="micro">No data.</td></tr>'; return; }
    var now = Date.now();
    $("flock-rows").innerHTML = s.birds.map(function (b) {
      var cls = b.dormant ? "dormant" : b.status === "tired" ? "tired" : "healthy";
      var cooling = (b.cooldownUntil || 0) > now ? minsFromNow(b.cooldownUntil) : "—";
      return "<tr>" +
        '<td><span class="dot ' + cls + '"></span>' + esc(b.name) + "</td>" +
        "<td>" + esc(b.provider) + "</td>" +
        "<td><code>" + esc(b.model) + "</code></td>" +
        '<td class="num">' + esc(b.priority) + "</td>" +
        "<td>" + esc(b.dormant ? "dormant" : b.status) + "</td>" +
        '<td class="num">' + num(b.totalCalls) + "</td>" +
        '<td class="num">' + num(b.totalFailures) + "</td>" +
        '<td class="num">' + pct(b.totalFailures, b.totalCalls) + "</td>" +
        '<td class="num">' + cooling + "</td></tr>";
    }).join("");
  }

  function renderSchedule() {
    if (!readToken()) { $("s-rows").innerHTML = '<tr><td colspan="5" class="micro">Requires a bearer key.</td></tr>'; return; }
    if (!state.schedule) { $("s-rows").innerHTML = '<tr><td colspan="5" class="micro">No data.</td></tr>'; return; }
    if (!state.schedule.length) { $("s-rows").innerHTML = '<tr><td colspan="5" class="micro">Nothing scheduled.</td></tr>'; return; }
    $("s-rows").innerHTML = state.schedule.map(function (t) {
      var outcome = t.error ? '<span class="tag bad">' + esc(t.error.slice(0, 60)) + "</span>"
        : t.result ? '<span class="tag ok">done</span> <span class="micro">' + esc(t.result.slice(0, 80)) + "</span>"
        : '<span class="micro">—</span>';
      return "<tr>" +
        "<td><code>" + esc(t.id) + "</code></td>" +
        '<td><span class="tag">' + esc(t.state) + "</span></td>" +
        '<td class="num">' + (t.resume_at ? new Date(t.resume_at).toLocaleString() : "—") + "</td>" +
        '<td class="num">' + esc(t.attempts) + "</td>" +
        "<td>" + outcome + "</td></tr>";
    }).join("");
  }

  // Generic on purpose: the quota row shape belongs to phoenix-core, and a panel
  // that hardcoded field names would go blank the day one was renamed.
  function renderQuota() {
    if (!readToken()) { $("quota-body").innerHTML = '<p class="micro">Requires a bearer key.</p>'; return; }
    if (state.quota === null) { $("quota-body").innerHTML = '<p class="micro">No data.</p>'; return; }
    if (!state.quota.length) { $("quota-body").innerHTML = '<p class="micro">No quota rows recorded yet.</p>'; return; }
    var cols = Object.keys(state.quota[0]);
    var head = cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("");
    var rows = state.quota.map(function (r) {
      return "<tr>" + cols.map(function (c) {
        var v = r[c];
        return '<td class="num">' + esc(v === null || v === undefined ? "—" : String(v)) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    $("quota-body").innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function refresh() {
    if (state.busy) return;
    state.busy = true;
    $("refresh").disabled = true;

    var jobs = [];
    jobs.push(api("/api/v1/flock/status").then(function (r) {
      if (r.ok && r.body && r.body.birds) { state.flock = r.body; signalNote(r.body); }
    }));

    if (readToken()) {
      jobs.push(api("/api/v1/schedule").then(function (r) { state.schedule = r.ok ? r.body : null; }));
      jobs.push(api("/api/v1/quota").then(function (r) { state.quota = r.ok ? r.body : null; }));
    } else {
      state.schedule = null; state.quota = null;
    }

    Promise.all(jobs).then(function () {
      renderKpis(); renderAttention(); renderFlock(); renderSchedule(); renderQuota();
      state.lastFetch = Date.now();
    }).catch(function (e) {
      $("attention").innerHTML = '<div class="notice bad">Refresh failed: ' + esc(e && e.message ? e.message : "unknown") + "</div>";
    }).then(function () {
      state.busy = false; $("refresh").disabled = false;
    });
  }

  function switchTab(name) {
    ["overview", "flock", "platforms", "schedule", "quota", "tools", "chat"].forEach(function (t) {
      $("tab-" + t).hidden = t !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) {
      b.setAttribute("aria-selected", String(b.dataset.tab === name));
    });
  }

  function say(text, who) {
    var el = document.createElement("div");
    el.className = "msg " + who;
    el.textContent = text;
    $("chat-log").appendChild(el);
    $("chat-log").scrollTop = $("chat-log").scrollHeight;
    return el;
  }

  function sendChat() {
    var prompt = $("c-prompt").value.trim();
    if (!prompt) return;
    say(prompt, "me");
    var pending = say("Flying…", "flock");
    $("c-send").disabled = true;

    api("/api/v1/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt, tools: ["get_server_time", "search_web"], userId: "dashboard", tier: "Free-Volunteer" })
    }).then(function (r) {
      var body = r.body || {};
      if (!r.ok) {
        pending.className = "msg err";
        pending.textContent = "HTTP " + r.status + " — " + ((body.error && body.error.code) || "request refused") +
          (r.status === 503 ? ": no SIMORGH_API_KEY is configured on the server." :
           r.status === 401 ? ": the key in this browser was not accepted." : "");
        return;
      }
      pending.className = "msg flock";
      pending.textContent = body.agentResponse || (body.meta && body.meta.error) || "No answer returned.";
      var attempts = body.meta && body.meta.flock_attempts;
      if (attempts && attempts.length) {
        var line = document.createElement("div");
        line.className = "tries";
        line.textContent = "flock: " + attempts.map(function (a) { return a.birdId + (a.ok ? " ✓" : " ✗"); }).join(" → ");
        $("chat-log").appendChild(line);
      }
      refresh();
    }).catch(function (e) {
      pending.className = "msg err";
      pending.textContent = "Error: " + (e && e.message ? e.message : "unknown");
    }).then(function () { $("c-send").disabled = false; });
  }

  function schedule() {
    var id = $("s-id").value.trim();
    var prompt = $("s-prompt").value.trim();
    var mins = Number($("s-in").value);
    var note = $("s-note");
    if (!id || !prompt || !isFinite(mins) || mins < 0) {
      note.textContent = "Id, prompt and a non-negative delay are required.";
      return;
    }
    var resumeAt = Date.now() + Math.round(mins * 60000);
    api("/api/v1/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, prompt: prompt, tools: ["get_server_time"], resumeAt: resumeAt })
    }).then(function (r) {
      note.textContent = r.ok
        ? "Scheduled " + id + " for " + new Date(resumeAt).toLocaleString() + "."
        : "Refused (HTTP " + r.status + "): " + ((r.body && r.body.error && r.body.error.code) || "unknown");
      if (r.ok) { $("s-id").value = ""; $("s-prompt").value = ""; refresh(); }
    });
  }

  // ── wiring ──
  $("token").value = readToken();
  $("save-token").addEventListener("click", function () {
    writeToken($("token").value.trim()); authNote(); refresh();
  });
  $("forget").addEventListener("click", function () {
    writeToken(""); $("token").value = ""; authNote(); refresh();
  });
  $("refresh").addEventListener("click", refresh);
  $("c-send").addEventListener("click", sendChat);
  $("c-prompt").addEventListener("keydown", function (e) { if (e.key === "Enter") sendChat(); });
  $("s-add").addEventListener("click", schedule);
  Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) {
    b.addEventListener("click", function () { switchTab(b.dataset.tab); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.id === "s-prompt") schedule();
  });

  // One delegated listener makes the whole overview a route into the detail: every
  // tile and attention row that names a tab drills down to it. This is the
  // overview → drilldown → evidence path, without a second navigation concept.
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-go]") : null;
    if (el) switchTab(el.getAttribute("data-go"));
  });

  authNote();
  refresh();
  setInterval(function () { if ($("auto").checked) refresh(); }, 5000);
})();
</script>
</body>
</html>`;
}
