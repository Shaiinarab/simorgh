// ── Dashboard — the unified control plane ─────────────────────────────────────
//
// One self-contained string, still: no build step, no framework, no second runtime.
// The Worker serves it, the browser runs it, and the whole page is inspectable with
// view-source — which is the point for a gateway whose promise is that nothing is
// hidden. A dashboard shipped as a minified bundle would be the one component an
// operator could not audit.
//
// ── Why the operator pastes a key into the page at all ──
//
// The alternative is "set an environment variable and redeploy", which is correct for
// a deployment and useless for a first five minutes: it means the operator cannot find
// out whether their Groq key even works until they have already done the deploy. So
// the page takes the key, checks it against the provider *live*, and hands back the
// exact command that makes it permanent. The key is transient on the server — never
// stored, never logged, never echoed. See `src/setup.ts` for the security shape.
//
// ── The visual world ──
//
// "Observatory": a night sky, because the flock is the product's own vocabulary —
// Shāhīn, Homā and Bulbul are birds, so the surface they are watched from is the sky
// they fly in. Deep indigo, a cold horizon, one warm star for anything alive. Nothing
// in it is decorative: the breathing dot on a healthy bird is the only motion on the
// page, and it means "this one is dialling right now".

import { connectorReadiness, toolSurface, type ConnectorReadiness } from "./platform";
import { PROVIDER_KEY_CHECKS, setupProviderRows } from "./setup";

/** `</script>` inside a JSON island would close the tag early; `<` never needs to appear. */
function jsonIsland(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export type { ConnectorReadiness };

export const STATUS_COPY: Record<ConnectorReadiness["status"], string> = {
  live: "live",
  "needs-secret": "needs secret",
  "not-wired": "not wired",
};


export type ConnectionKind = "secret" | "mcp" | "data";

export interface ConnectionDef {
  id: string;
  label: string;
  kind: ConnectionKind;
  group: "host" | "inference" | "gateway" | "memory";
  /** The `Env` binding this connection becomes. */
  secret: string;
  /** Human-readable "where do I get one". */
  signup: string;
  note: string;
  /**
   * How to check it, if at all. `null` means this one cannot be checked from here —
   * which is stated rather than faked, because a Check button that always says
   * "could not verify" is worse than no button.
   */
  check: "provider" | "mcp" | null;
  /** Placeholder for the input, so the field says what it wants. */
  placeholder: string;
}

export const CONNECTIONS: readonly ConnectionDef[] = [
  // ── The host itself ──
  {
    id: "simorgh-key",
    label: "Simorgh API key",
    kind: "secret",
    group: "host",
    secret: "SIMORGH_API_KEY",
    signup: "you choose it — any long random string",
    note: "This deployment's own bearer token. Gates quota, schedules and chat; without it the whole API answers 503 and says so.",
    check: null,
    placeholder: "any long random string you choose",
  },
  {
    id: "simorgh-keys",
    label: "Simorgh key map (multi-caller)",
    kind: "secret",
    group: "host",
    secret: "SIMORGH_API_KEYS",
    signup: '{"<token>": "<userId>"}',
    note: "A JSON map that lets several callers share one deployment without reading each other's ledgers. Optional while you are the only user.",
    check: null,
    placeholder: '{"token-one":"alice","token-two":"bob"}',
  },

  // ── Inference ──
  {
    id: "groq",
    label: "Groq",
    kind: "secret",
    group: "inference",
    secret: "GROQ_API_KEY",
    signup: "console.groq.com/keys",
    note: "The workhorse of the free flock. OpenAI-compatible, so one key speaks the dialect most tools already use.",
    check: "provider",
    placeholder: "gsk_…",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "secret",
    group: "inference",
    secret: "GEMINI_API_KEY",
    signup: "aistudio.google.com/apikey",
    note: "Free tier from AI Studio, no card for the key itself. A second opinion when Groq is rate-limited.",
    check: "provider",
    placeholder: "AIza…",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "secret",
    group: "inference",
    secret: "OPENROUTER_API_KEY",
    signup: "openrouter.ai/keys",
    note: "One key, many models — including the :free variants. The widest single-key reach in the flock.",
    check: "provider",
    placeholder: "sk-or-…",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    kind: "secret",
    group: "inference",
    secret: "HF_TOKEN",
    signup: "huggingface.co/settings/tokens",
    note: "A read token is enough for inference on the free tier.",
    check: "provider",
    placeholder: "hf_…",
  },

  // ── Gateways ──
  {
    id: "telegram-token",
    label: "Telegram bot token",
    kind: "secret",
    group: "gateway",
    secret: "TELEGRAM_BOT_TOKEN",
    signup: "t.me/BotFather",
    note: "Without it the webhook still authenticates, but the bot cannot answer — Telegram is the door, not the engine.",
    check: null,
    placeholder: "123456:ABC-DEF…",
  },
  {
    id: "telegram-secret",
    label: "Telegram webhook secret",
    kind: "secret",
    group: "gateway",
    secret: "TELEGRAM_WEBHOOK_SECRET",
    signup: "you choose it, then set it on the webhook",
    note: "A shared secret Telegram echoes on every delivery. Optional, and without it the webhook is unauthenticated — set it.",
    check: null,
    placeholder: "any long random string",
  },
  {
    id: "discord-key",
    label: "Discord public key",
    kind: "secret",
    group: "gateway",
    secret: "DISCORD_PUBLIC_KEY",
    signup: "Developer Portal → General Information",
    note: "Not a secret — the Ed25519 *public* key the endpoint verifies against. Discord needs no bot token on this path at all.",
    check: null,
    placeholder: "64 hex characters",
  },

  // ── Memory / data ──
  {
    id: "drive-folder",
    label: "Google Drive folder",
    kind: "data",
    group: "memory",
    secret: "GOOGLE_DRIVE_FOLDER_ID",
    signup: "the id in the folder's URL",
    note: "Where memory snapshots are written. Optional: memory stays local-only without it, and says so rather than pretending.",
    check: null,
    placeholder: "1AbC…",
  },
  {
    id: "drive-token",
    label: "Google OAuth token",
    kind: "data",
    group: "memory",
    secret: "GOOGLE_REFRESH_TOKEN",
    signup: "OAuth playground, Drive scope",
    note: "The credential that lets the agent write to that folder. A refresh token, not an access token — access tokens expire mid-snapshot.",
    check: null,
    placeholder: "1//0e…",
  },
];

/** An MCP server the operator wants this deployment to be able to dial. */
export interface McpTargetDef {
  id: string;
  label: string;
  hint: string;
  /** The env var that would hold its address. */
  envVar: string;
}

export const MCP_TARGETS: readonly McpTargetDef[] = [
  {
    id: "mcp-cloudflare-docs",
    label: "Cloudflare docs",
    hint: "The official Cloudflare MCP — search and execute the whole API from one code-mode server.",
    envVar: "MCP_CLOUDFLARE_URL",
  },
  {
    id: "mcp-github",
    label: "GitHub",
    hint: "Issues, PRs and code search against the repo this gateway lives in.",
    envVar: "MCP_GITHUB_URL",
  },
  {
    id: "mcp-custom",
    label: "Any other MCP server",
    hint: "Paste a URL and the page runs an initialize handshake against it, so you know it speaks MCP before you trust it.",
    envVar: "MCP_CUSTOM_URL",
  },
];

const GROUP_COPY: Record<ConnectionDef["group"], { title: string; blurb: string }> = {
  host: {
    title: "This deployment",
    blurb: "What the gateway uses to authenticate its own callers.",
  },
  inference: {
    title: "Inference — the flock",
    blurb: "Each key wakes one bird. Zero keys still answers, through Homā, the Workers AI binding.",
  },
  gateway: {
    title: "Chat gateways",
    blurb: "The doors. Telegram is wired today; Discord needs only a public key, no bot token.",
  },
  memory: {
    title: "Memory and backup",
    blurb: "Where snapshots go. Absent means local-only, and the page says so instead of failing quietly.",
  },
};

/** Rows for the setup panel, as an embeddable island. */
export function connectionRows(): ConnectionDef[] {
  return CONNECTIONS.map((c) => ({ ...c }));
}


export function renderDashboard(env: Env): string {
  const connectors = connectorReadiness(env);
  const tools = toolSurface();
  const rows = connectionRows();

  // Server-rendered so the matrix is correct on first paint and with no token: a
  // readiness badge that only appears after an authenticated fetch would be blank in
  // exactly the deployment an operator most needs to inspect. Derived from the same
  // `connectorReadiness` the API serves, so the two cannot disagree.
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%A6%85%3C/text%3E%3C/svg%3E">
<script type="application/json" id="connections">${jsonIsland(rows)}</script>
<script type="application/json" id="mcp-targets">${jsonIsland(MCP_TARGETS)}</script>
<script type="application/json" id="connectors">${jsonIsland(connectors)}</script>
<style>
  :root {
    /* Night sky, not "dark mode". The flock is the product's own vocabulary — Shāhīn,
       Homā, Bulbul are birds — so the surface they are watched from is the sky they
       fly in: deep indigo, a cold horizon, and one warm star for anything alive. */
    --bg:#05070f;
    --sky-1:#101c38; --sky-2:#0a1f2e; --sky-3:#161232;
    --panel:rgba(16,24,44,.72); --raised:rgba(28,40,68,.62);
    --line:rgba(148,178,255,.14); --line-2:rgba(148,178,255,.26);
    --text:#eaf1ff; --muted:#8fa1c4; --faint:#64769a;
    --cyan:#6ff0e6; --blue:#8ab4ff; --amber:#ffce7a; --green:#8bf0b4; --red:#ff8080;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,"Helvetica Neue",Arial,sans-serif;
    --r:.7rem;
    --shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 12px 32px -18px rgba(0,0,0,.9);
    --nav-w:15.5rem;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; color:var(--text); font:15px/1.6 var(--sans);
    background:
      radial-gradient(ellipse 80% 55% at 12% -8%, var(--sky-1) 0, transparent 60%),
      radial-gradient(ellipse 70% 50% at 92% 8%, var(--sky-2) 0, transparent 55%),
      radial-gradient(ellipse 90% 60% at 50% 108%, var(--sky-3) 0, transparent 60%),
      var(--bg);
    background-attachment:fixed;
    min-height:100vh;
    /* Numerals that do not jitter as the panel refreshes — this page polls every 5s. */
    font-variant-numeric:tabular-nums;
    -webkit-font-smoothing:antialiased;
  }
  ::selection { background:rgba(111,240,230,.28); color:#fff; }

  /* ── App shell: a real nav rail, not a tab strip ──
     Desktop gets a fixed rail so the page reads as an application with destinations
     rather than a document with sections. Under 60rem it collapses to a horizontal
     scroller, because a rail that eats a phone's width is worse than no rail. */
  .app { display:grid; grid-template-columns:var(--nav-w) minmax(0,1fr); min-height:100vh; }
  nav.rail {
    position:sticky; top:0; align-self:start; height:100vh; padding:1.5rem .9rem 2rem;
    border-right:1px solid var(--line); display:flex; flex-direction:column; gap:1.4rem;
    background:linear-gradient(180deg, rgba(10,16,32,.55), rgba(5,7,15,.2));
    backdrop-filter:blur(8px);
  }
  .brand { display:flex; align-items:center; gap:.55rem; padding:0 .4rem; }
  .brand .glyph { font-size:1.4rem; line-height:1; }
  .brand b { font-size:1.02rem; letter-spacing:-.02em; font-weight:800; }
  .brand small { display:block; font-size:.58rem; letter-spacing:.24em; text-transform:uppercase; color:var(--faint); }
  .rail nav { display:flex; flex-direction:column; gap:.15rem; }
  .rail nav button {
    display:flex; align-items:center; gap:.6rem; width:100%; text-align:left;
    background:none; border:0; border-radius:.5rem; padding:.5rem .65rem;
    color:var(--muted); font:inherit; font-size:.88rem; font-weight:500; cursor:pointer;
    border-left:2px solid transparent;
  }
  .rail nav button:hover { background:rgba(148,178,255,.07); color:var(--text); filter:none; }
  .rail nav button[aria-selected="true"] {
    color:var(--cyan); background:rgba(111,240,230,.09); border-left-color:var(--cyan);
  }
  .rail nav button .ico { width:1.1rem; text-align:center; opacity:.9; }
  .rail nav button .badge {
    margin-left:auto; font-size:.6rem; padding:.1rem .38rem; border-radius:1rem;
    background:rgba(255,206,122,.16); color:var(--amber); font-weight:700;
  }
  .rail .rail-foot { margin-top:auto; padding:0 .5rem; }

  main { min-width:0; padding:1.6rem 1.6rem 4rem; }
  .page-head { margin-bottom:1.2rem; }
  .page-head h1 { font-size:clamp(1.35rem,2.4vw,1.8rem); letter-spacing:-.035em; margin:0; font-weight:800; }
  .page-head p { margin:.35rem 0 0; color:var(--muted); font-size:.88rem; max-width:62ch; }

  a { color:var(--cyan); text-decoration-color:rgba(111,240,230,.4); text-underline-offset:.18em; }
  code { font-family:var(--mono); font-size:.85em; color:#d9e6ff; letter-spacing:-.01em; }
  h3 { margin:0; font-size:1.02rem; letter-spacing:-.012em; }
  h4 { margin:1.15rem 0 .45rem; font-size:.66rem; letter-spacing:.16em; text-transform:uppercase; color:var(--faint); font-weight:700; }
  ul { list-style:none; margin:0; padding:0; }
  li { padding:.45rem 0; border-bottom:1px solid rgba(148,178,255,.07); }
  li:last-child { border-bottom:0; }
  .micro { color:var(--muted); font-size:.8rem; margin:.25rem 0 0; line-height:1.5; }
  section[hidden] { display:none; }

  .bar { display:flex; flex-wrap:wrap; gap:.55rem; align-items:center; margin:0 0 1.2rem; }
  input, select {
    padding:.5rem .7rem; border:1px solid var(--line); border-radius:.5rem;
    background:rgba(5,7,15,.6); color:var(--text); font:inherit; font-size:.86rem;
    transition:border-color .15s, box-shadow .15s;
  }
  input:focus, select:focus { outline:0; border-color:var(--line-2); box-shadow:0 0 0 3px rgba(111,240,230,.13); }
  .bar input#token { flex:1 1 18rem; font-family:var(--mono); }
  button {
    padding:.5rem 1rem; border:0; border-radius:.5rem; cursor:pointer; font:inherit;
    font-weight:600; font-size:.86rem;
    background:linear-gradient(120deg,var(--blue),var(--cyan)); color:#04121c;
    transition:filter .15s, transform .06s;
  }
  button:hover { filter:brightness(1.1); }
  button:active { transform:translateY(1px); }
  button.ghost { background:rgba(148,178,255,.07); border:1px solid var(--line); color:var(--text); font-weight:500; }
  button.ghost:hover { border-color:var(--line-2); filter:none; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, [role="tab"]:focus-visible {
    outline:2px solid var(--cyan); outline-offset:2px;
  }

  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr)); gap:.7rem; }
  .kpi { padding:.95rem 1.05rem; border:1px solid var(--line); border-radius:var(--r); background:var(--panel); box-shadow:var(--shadow); }
  .kpi b { display:block; font-size:1.7rem; letter-spacing:-.035em; line-height:1.15; font-weight:700; }
  .kpi .micro { text-transform:uppercase; letter-spacing:.11em; font-size:.64rem; }
  .kpi.click, .answer.click { cursor:pointer; transition:border-color .15s, background .15s, transform .1s; }
  .kpi.click:hover, .answer.click:hover { border-color:var(--line-2); transform:translateY(-1px); }
  .kpi.click:hover { background:var(--raised); }
  .answer.click { border:1px solid transparent; }
  .answer.click:hover { background:rgba(111,240,230,.08); }
  .kpi.good b { color:var(--green); } .kpi.warn b { color:var(--amber); }
  .kpi.bad b { color:var(--red); } .kpi.info b { color:var(--cyan); }

  table { width:100%; border-collapse:collapse; font-size:.87rem; }
  th,td { text-align:left; padding:.55rem .6rem; border-bottom:1px solid rgba(148,178,255,.09); }
  th { font-size:.64rem; letter-spacing:.13em; text-transform:uppercase; color:var(--faint); font-weight:700; }
  td.num { font-family:var(--mono); font-variant-numeric:tabular-nums; }

  /* ── Status: the one piece of motion on the page ──
     A live bird breathes; a dormant one does not. That is the whole animation budget
     for an Operate surface, and it is switched off for reduced-motion. */
  .dot { display:inline-block; width:.55rem; height:.55rem; border-radius:50%; margin-right:.45rem; vertical-align:middle; }
  .dot.healthy { background:var(--green); box-shadow:0 0 .55rem rgba(139,240,180,.85); animation:breathe 2.8s ease-in-out infinite; }
  .dot.tired { background:var(--amber); box-shadow:0 0 .55rem rgba(255,206,122,.7); }
  .dot.dormant { background:var(--faint); }
  @keyframes breathe { 0%,100% { opacity:1 } 50% { opacity:.45 } }
  @media (prefers-reduced-motion:reduce) {
    .dot.healthy { animation:none }
    .kpi.click:hover, .answer.click:hover { transform:none }
  }

  .tag { font-size:.64rem; padding:.12rem .42rem; border-radius:.35rem; font-weight:600; background:rgba(148,178,255,.12); color:var(--muted); text-transform:uppercase; letter-spacing:.07em; }
  .tag.ok { background:rgba(139,240,180,.15); color:var(--green); }
  .tag.warn { background:rgba(255,206,122,.15); color:var(--amber); }
  .tag.bad { background:rgba(255,128,128,.15); color:var(--red); }
  .pill { font-size:.63rem; padding:.22rem .58rem; border-radius:1rem; font-weight:700; text-transform:uppercase; letter-spacing:.09em; white-space:nowrap; }
  .pill.live, .pill.ok { background:rgba(139,240,180,.15); color:var(--green); }
  .pill.needs-secret, .pill.bad { background:rgba(255,206,122,.15); color:var(--amber); }
  .pill.not-wired { background:rgba(148,178,255,.12); color:var(--muted); }
  .conn-verdict.ok { color:var(--green); }
  .conn-verdict.bad { color:var(--red); }
  .conn-cmd code { font-size:.78rem; word-break:break-all; }
  .method { font-family:var(--mono); font-size:.66rem; padding:.1rem .38rem; border-radius:.3rem; background:rgba(138,180,255,.16); color:#cfe0ff; font-weight:600; }
  .method.post { background:rgba(255,206,122,.16); color:var(--amber); }

  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(19rem,1fr)); gap:1rem; }
  .connector, .conn { padding:1.15rem 1.25rem; border:1px solid var(--line); border-radius:var(--r); background:var(--panel); box-shadow:var(--shadow); transition:border-color .15s; }
  .connector:hover, .conn:hover { border-color:var(--line-2); }
  .connector header, .conn header { display:flex; justify-content:space-between; align-items:center; gap:.75rem; }
  .connector.not-wired { opacity:.72; }
  .conn .kind { font-size:.58rem; letter-spacing:.14em; text-transform:uppercase; color:var(--faint); font-weight:700; }
  .conn .row { display:flex; gap:.5rem; margin-top:.8rem; }
  .conn input { flex:1; min-width:0; }
  .conn .conn-cmd { margin-top:.6rem; display:none; }
  .conn .conn-cmd.on { display:block; }
  .panel { padding:1.15rem 1.3rem; border:1px solid var(--line); border-radius:var(--r); background:var(--panel); box-shadow:var(--shadow); margin-bottom:1rem; }
  .notice { padding:.72rem 1rem; border-left:3px solid var(--amber); background:rgba(255,206,122,.07); border-radius:.45rem; color:#f0dcb8; font-size:.85rem; margin-bottom:1rem; line-height:1.5; }
  .notice.bad { border-color:var(--red); background:rgba(255,128,128,.07); color:#ffd9d9; }
  .notice.ok { border-color:var(--green); background:rgba(139,240,180,.07); color:#d6f7e5; }
  .answers { display:grid; gap:.4rem; margin-top:.9rem; }
  .answer { padding:.55rem .7rem; border-radius:.45rem; background:var(--raised); font-size:.86rem; }
  .answer form { display:flex; gap:.4rem; }
  .answer input { flex:1; padding:.35rem .5rem; border-radius:.4rem; background:rgba(5,7,15,.55); font-size:.8rem; }
  .chat-log { display:flex; flex-direction:column; gap:.5rem; max-height:26rem; overflow-y:auto; margin:.9rem 0; }
  .msg { padding:.6rem .8rem; border-radius:.6rem; font-size:.88rem; white-space:pre-wrap; max-width:80%; line-height:1.5; }
  .msg.me { align-self:flex-end; background:rgba(138,180,255,.16); }
  .msg.flock { align-self:flex-start; background:var(--raised); }

  /* Progressive disclosure: the MCP address list is detail behind a summary, so the
     connections page leads with the three connection kinds and not with every option. */
  details.mcp-block { margin-top:1.2rem; border:1px solid var(--line); border-radius:var(--r); background:var(--panel); }
  details.mcp-block summary { cursor:pointer; padding:.9rem 1.1rem; font-weight:600; font-size:.9rem; list-style:none; }
  details.mcp-block summary::-webkit-details-marker { display:none; }
  details.mcp-block summary::before { content:"▸ "; color:var(--cyan); }
  details.mcp-block[open] summary::before { content:"▾ "; }
  details.mcp-block .inner { padding:0 1.1rem 1.1rem; }
  .mcp-row { display:flex; gap:.6rem; align-items:flex-start; padding:.7rem 0; border-bottom:1px solid rgba(148,178,255,.07); }
  .mcp-row:last-child { border-bottom:0; }
  .mcp-row .who { flex:1; min-width:0; }
  .mcp-row .who b { font-size:.9rem; }
  .mcp-row input { flex:0 0 14rem; font-family:var(--mono); font-size:.78rem; }
  .mcp-row button { flex:0 0 auto; }

  /* The rail becomes a scroller before it can eat the page. */
  @media (max-width:60rem) {
    .app { grid-template-columns:1fr; }
    nav.rail { position:static; height:auto; border-right:0; border-bottom:1px solid var(--line); padding:1rem; }
    .rail nav { flex-direction:row; overflow-x:auto; gap:.3rem; }
    .rail nav button { white-space:nowrap; border-left:0; border-bottom:2px solid transparent; }
    .rail nav button[aria-selected="true"] { border-left:0; border-bottom-color:var(--cyan); }
    .rail .rail-foot { display:none; }
    main { padding:1.1rem 1rem 3rem; }
  }
</style>
</head>
<body>
<div class="app">
<nav class="rail">
  <div class="brand"><span class="glyph">🦅</span><span><b>SIMORGH</b><small>// CONTROL PLANE</small></span></div>
  <nav class="tabs" role="tablist">
    <button role="tab" data-tab="setup" aria-selected="true"><span class="ico">⌂</span> Setup</button>
    <button role="tab" data-tab="overview" aria-selected="false"><span class="ico">◎</span> Overview</button>
    <button role="tab" data-tab="flock" aria-selected="false"><span class="ico">✦</span> Flock <span class="badge" id="nav-flock-badge" hidden></span></button>
    <button role="tab" data-tab="platforms" aria-selected="false"><span class="ico">⬡</span> Platforms</button>
    <button role="tab" data-tab="schedule" aria-selected="false"><span class="ico">◷</span> Schedules</button>
    <button role="tab" data-tab="quota" aria-selected="false"><span class="ico">▤</span> Quota</button>
    <button role="tab" data-tab="tools" aria-selected="false"><span class="ico">⌘</span> Tools &amp; MCP</button>
    <button role="tab" data-tab="chat" aria-selected="false"><span class="ico">✉</span> Direct chat</button>
  </nav>
  <div class="rail-foot">
    <p class="micro">Zero secrets, zero accounts. One free Workers AI bird answers even with no key set — the rest wake as you add them.</p>
  </div>
</nav>

<main>
  <div class="bar">
    <input id="token" type="password" placeholder="SIMORGH_API_KEY (bearer) — required for quota, schedule and chat" autocomplete="off">
    <button id="save-token" class="ghost">Save key</button>
    <button id="forget" class="ghost">Forget</button>
    <button id="refresh" class="ghost">Refresh</button>
    <label class="micro"><input type="checkbox" id="auto" checked> auto (5s)</label>
  </div>

  <div id="auth-note"></div>
  <div id="signal-note"></div>

  <section id="tab-setup">
    <div class="page-head">
      <h1>Connect this deployment</h1>
      <p>Paste anything it needs — an API key, an MCP server address, or a place to keep things. It is checked live against the real provider, and never stored here: the page hands you the one command that makes it permanent.</p>
    </div>
    <div id="conn-groups"></div>

    <details class="mcp-block">
      <summary>MCP server addresses — connect an external tool server</summary>
      <div class="inner">
        <p class="micro">Not credentials: URLs. Each one gets an <code>initialize</code> handshake, so you know it speaks MCP before you trust it. Addresses live in config, not in a secret.</p>
        <div id="mcp-rows"></div>
      </div>
    </details>
  </section>

  <section id="tab-overview" hidden>
    <div class="page-head"><h1>Overview</h1><p>Five questions, each a route into the detail.</p></div>
    <div class="kpis" id="kpis"><div class="kpi"><b>…</b><div class="micro">loading</div></div></div>
    <h4>Needs attention</h4>
    <div class="panel" id="attention"><p class="micro">Loading…</p></div>
  </section>

  <section id="tab-flock" hidden>
    <div class="page-head"><h1>Flock</h1><p>Live from the Durable Object. Call and failure counts are per-bird totals since the object was created.</p></div>
    <div class="panel">
      <table><thead><tr>
        <th>Bird</th><th>Provider</th><th>Model</th><th>Priority</th><th>State</th>
        <th>Calls</th><th>Failures</th><th>Fail %</th><th>Cooldown</th>
      </tr></thead><tbody id="flock-rows"><tr><td colspan="9" class="micro">Loading…</td></tr></tbody></table>
    </div>
  </section>

  <section id="tab-platforms" hidden>
    <div class="page-head"><h1>Platforms</h1><p>Readiness is derived from the live environment, not from configuration intent. <strong>Not wired</strong> means no runtime path exists here — adding a token would change nothing.</p></div>
    <div class="cards">${connectorCards}</div>
  </section>

  <section id="tab-schedule" hidden>
    <div class="page-head"><h1>Schedules</h1><p>Runs through the same flock, once, at or after the given time. A row whose host died is reclaimed on a later pass.</p></div>
    <div class="panel">
      <h3>Schedule a flight</h3>
      <div class="bar" style="margin:0">
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
    <div class="page-head"><h1>Quota</h1><p>Every declared account, over RPC from the Durable Object.</p></div>
    <div class="panel"><div id="quota-body"><p class="micro">Requires a bearer key.</p></div></div>
  </section>

  <section id="tab-tools" hidden>
    <div class="page-head"><h1>Tools &amp; MCP</h1><p>The allow-list the executor vets against, and the deployment's own endpoints.</p></div>
    <div class="cards">
      <div class="panel">
        <h3>Tool surface</h3>
        <ul>${toolRows}</ul>
      </div>
      <div class="panel">
        <h3>This deployment's endpoints</h3>
        <p class="micro">Reachable over REST; <code>/mcp</code> exists on the Node runtime, not on the Workers host.</p>
        <ul>
          <li><span class="method get">GET</span> <code>/health</code></li>
          <li><span class="method get">GET</span> <code>/api/v1/flock/status</code></li>
          <li><span class="method post">POST</span> <code>/api/v1/agent/execute</code></li>
          <li><span class="method get">GET</span> <code>/api/v1/user/:userId/logs</code></li>
          <li><span class="method post">POST</span> <code>/api/v1/telegram/webhook</code></li>
          <li><span class="method post">POST</span> <code>/api/v1/discord/webhook</code></li>
        </ul>
      </div>
    </div>
  </section>

  <section id="tab-chat" hidden>
    <div class="page-head"><h1>Direct chat</h1><p>One prompt to the flock, with the whole tool loop and the ledger behind it.</p></div>
    <div class="chat-log" id="chat-log"></div>
    <div class="answer">
      <form onsubmit="return false">
        <input id="c-prompt" placeholder="Ask the flock…" autocomplete="off">
        <button id="c-send">Send</button>
      </form>
    </div>
  </section>
</main>
</div>
<script>
(function () {
  var CONNECTORS = ${jsonIsland(connectors)};
  var TOKEN_KEY = "simorgh_api_key";
  var state = { flock: null, quota: null, schedule: null, lastFetch: 0, busy: false };
  var $ = function (id) { return document.getElementById(id); };

// ── Connections: paste anything, check it, get the command ─────────────────
  //
  // Built here rather than server-rendered so the input can hold the value without it
  // ever travelling to the server as part of the page — the same reason the operator's
  // bearer token is read from localStorage at call time.
  //
  // One renderer for three kinds, because the shape is identical and only the check
  // differs: a secret is checked against its provider, an MCP address against a real
  // handshake, and a data source has no endpoint to check and says so instead of
  // pretending.
  var GROUPS = ["host", "inference", "gateway", "memory"];
  var GROUP_META = {
    host: { title: "This deployment", blurb: "What the gateway uses to authenticate its own callers." },
    inference: { title: "Inference — the flock", blurb: "Each key wakes one bird. Zero keys still answers, through Homā, the Workers AI binding." },
    gateway: { title: "Chat gateways", blurb: "The doors. Telegram is wired today; Discord needs only a public key, no bot token." },
    memory: { title: "Memory and backup", blurb: "Where snapshots go. Absent means local-only, and the page says so instead of failing quietly." }
  };
  var KIND_LABEL = { secret: "API key / token", mcp: "MCP address", data: "Data source" };

  function readJson(id) {
    try { return JSON.parse($(id).textContent); } catch (e) { return []; }
  }

  function connCard(row) {
    var card = document.createElement("article");
    card.className = "conn";
    card.dataset.secret = row.secret;
    card.innerHTML =
      '<header><div><span class="kind">' + KIND_LABEL[row.kind] + "</span>" +
      "<h3>" + esc(row.label) + "</h3></div>" +
      '<span class="pill bad">unset</span></header>' +
      '<p class="micro">' + esc(row.note) + "</p>" +
      '<p class="micro">Get one at <code>' + esc(row.signup) + "</code></p>" +
      '<div class="row">' +
      '<input class="conn-input" type="' + (row.kind === "mcp" ? "url" : "password") + '" placeholder="' + esc(row.placeholder) + '" autocomplete="off">' +
      (row.check ? '<button class="conn-check">Check</button>' : "") +
      "</div>" +
      '<div class="conn-verdict micro"></div>' +
      '<div class="conn-cmd"><code>' + esc(row.check === "mcp" ? "" : "wrangler secret put " + row.secret) + "</code>" +
      ' <button class="ghost conn-copy">Copy</button></div>';
    return card;
  }

  function renderConnections() {
    var rows = readJson("connections");
    var host = document.createElement("div");
    GROUPS.forEach(function (g) {
      var meta = GROUP_META[g];
      var inGroup = rows.filter(function (r) { return r.group === g; });
      if (!inGroup.length) return;
      var block = document.createElement("div");
      block.style.marginBottom = "1.6rem";
      // Single-quoted attributes: this code is spliced into a template literal, where a
      // \" escape would collapse to a bare " and terminate the string early — the class
      // of bug that is invisible in the source and only shows up as dead JavaScript.
      block.innerHTML = "<h4>" + esc(meta.title) + "</h4><p class='micro' style='margin-bottom:.8rem'>" + esc(meta.blurb) + "</p>";
      var cards = document.createElement("div");
      cards.className = "cards";
      inGroup.forEach(function (row) { cards.appendChild(connCard(row)); });
      block.appendChild(cards);
      host.appendChild(block);
    });
    $("conn-groups").appendChild(host);

    // Delegated so a card added later needs no rewiring.
    $("conn-groups").addEventListener("click", function (e) {
      var card = e.target && e.target.closest ? e.target.closest(".conn") : null;
      if (!card) return;
      if (e.target.classList.contains("conn-check")) checkConnection(card);
      if (e.target.classList.contains("conn-copy")) copyCommand(card);
    });
    $("conn-groups").addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var card = e.target && e.target.closest ? e.target.closest(".conn") : null;
      if (card && e.target.classList.contains("conn-input")) checkConnection(card);
    });
  }

  function setVerdict(card, ok, detail) {
    var pill = card.querySelector(".pill");
    var verdict = card.querySelector(".conn-verdict");
    var cmd = card.querySelector(".conn-cmd");
    verdict.textContent = detail || "";
    verdict.className = "conn-verdict micro " + (ok ? "ok" : "bad");
    if (ok) {
      pill.className = "pill ok"; pill.textContent = "valid";
      cmd.classList.add("on");
    } else {
      pill.className = "pill bad"; pill.textContent = "not set";
      cmd.classList.remove("on");
    }
  }

  function checkConnection(card) {
    var secret = card.dataset.secret;
    var input = card.querySelector(".conn-input");
    var value = input.value.trim();
    if (!value) { setVerdict(card, false, "Paste a value first."); return; }

    var row = readJson("connections").filter(function (r) { return r.secret === secret; })[0];
    setVerdict(card, false, "Checking…");

    // An MCP address is a URL, not a credential, so it gets the handshake endpoint.
    var path = row && row.kind === "mcp"
      ? "/api/v1/setup/check-mcp"
      : "/api/v1/setup/validate";
    var body = row && row.kind === "mcp"
      ? JSON.stringify({ url: value })
      : JSON.stringify({ provider: row ? row.label : secret, key: value });

    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No auth header on purpose: these routes are checkable before any key exists,
      // which is the only moment they are useful.
      body: body
    }).then(function (r) { return r.json(); }).then(function (res) {
      var detail = res.detail || (res.ok ? "Accepted." : "No answer.");
      if (res.ok && res.server) detail += " (" + res.server + ")";
      setVerdict(card, res.ok, detail);
      // Clear as soon as it is known good: a secret that sits in a DOM input is a
      // secret one stray screenshot from taking with it.
      if (res.ok) input.value = "";
    }).catch(function () {
      setVerdict(card, false, "Could not reach this deployment to run the check.");
    });
  }

  function copyCommand(card) {
    var text = card.querySelector(".conn-cmd code").textContent;
    var done = function () { $("auth-note").innerHTML = '<div class="notice ok">Command copied to the clipboard.</div>'; };
    // navigator.clipboard needs a secure context; the fallback keeps the wizard usable
    // over plain http on a LAN address, which is how most self-hosted operators will
    // first see this page.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { prompt("Copy this command:", text); });
    } else {
      prompt("Copy this command:", text);
    }
  }

  function renderMcpTargets() {
    var targets = readJson("mcp-targets");
    var host = $("mcp-rows");
    targets.forEach(function (t) {
      var row = document.createElement("div");
      row.className = "mcp-row";
      row.dataset.env = t.envVar;
      row.innerHTML =
        '<div class="who"><b>' + esc(t.label) + "</b>" +
        '<div class="micro">' + esc(t.hint) + "</div>" +
        '<div class="conn-cmd" style="margin-top:.4rem"><code>wrangler secret put ' + esc(t.envVar) + "</code></div></div>" +
        '<input class="mcp-input" type="url" placeholder="https://…/mcp" autocomplete="off">' +
        '<button class="ghost mcp-check">Handshake</button>';
      host.appendChild(row);
    });
    host.addEventListener("click", function (e) {
      if (!e.target.classList.contains("mcp-check")) return;
      var row = e.target.closest(".mcp-row");
      var input = row.querySelector(".mcp-input");
      var cmd = row.querySelector(".conn-cmd code");
      var value = input.value.trim();
      if (!value) { cmd.textContent = "Paste an address first."; return; }
      cmd.textContent = "Checking…";
      fetch("/api/v1/setup/check-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value })
      }).then(function (r) { return r.json(); }).then(function (res) {
        // The command is the outcome: a verified address becomes the exact line that
        // records it, so "check" and "make permanent" are the same gesture.
        cmd.textContent = res.ok
          ? "wrangler secret put " + row.dataset.env + "   # " + (res.server || "MCP server") + " answered"
          : (res.detail || "Could not check it.");
        cmd.className = res.ok ? "" : "bad";
        if (res.ok) input.value = "";
      }).catch(function () {
        cmd.textContent = "Could not reach this deployment to run the handshake.";
      });
    });
  }

  renderConnections();
  renderMcpTargets();

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
    ["setup", "overview", "flock", "platforms", "schedule", "quota", "tools", "chat"].forEach(function (t) {
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
