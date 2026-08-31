// ── Dashboard — 30-Bird Mission Control ──────────────────────────
// Self-contained HTML with inline CSS/JS, no build step.
// Polls /api/v1/flock/status and shows live bird health.

export function renderDashboard(_env: Env): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Simorgh — 30-Bird Mission Control</title>
  <style>
    :root {
      --bg: #080d18;
      --panel: rgba(18, 28, 48, .78);
      --line: rgba(160, 190, 255, .18);
      --text: #eef4ff;
      --muted: #aab7d0;
      --cyan: #5ee7df;
      --amber: #ffc870;
      --green: #75e4a5;
      --red: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background: radial-gradient(circle at 12% 0%, #172a53 0, transparent 33rem), radial-gradient(circle at 93% 28%, #123c4c 0, transparent 28rem), var(--bg);
      font: 16px/1.6 Inter, ui-sans-serif, system-ui, sans-serif;
    }
    .shell { max-width: 960px; margin: auto; padding: 2rem 1.5rem; }
    h1 { font-size: clamp(2rem, 5vw, 3rem); letter-spacing: -.04em; margin: 0 0 .5rem; }
    h1 span { color: var(--cyan); }
    .sub { color: var(--muted); margin-bottom: 2rem; }
    .grid { display: grid; gap: 1rem; }
    .bird {
      padding: 1.25rem;
      border: 1px solid var(--line);
      border-radius: .75rem;
      background: var(--panel);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .bird-name { font-weight: 700; font-size: 1.1rem; }
    .bird-meta { color: var(--muted); font-size: .85rem; }
    .status-dot { width: .7rem; height: .7rem; border-radius: 50%; flex-shrink: 0; }
    .status-dot.healthy { background: var(--green); box-shadow: 0 0 .8rem var(--green); }
    .status-dot.tired { background: var(--amber); box-shadow: 0 0 .8rem var(--amber); }
    .status-dot.dormant { background: var(--muted); }
    .console {
      margin-top: 2rem;
      padding: 1.25rem;
      border: 1px solid var(--line);
      border-radius: .75rem;
      background: var(--panel);
    }
    .console input {
      width: 100%;
      padding: .65rem;
      border: 1px solid var(--line);
      border-radius: .5rem;
      background: rgba(8, 13, 24, .6);
      color: var(--text);
      font: inherit;
    }
    .console button {
      margin-top: .65rem;
      padding: .55rem 1.2rem;
      border: none;
      border-radius: .5rem;
      background: linear-gradient(120deg, #72a7ff, var(--cyan));
      color: #07111e;
      font-weight: 700;
      cursor: pointer;
    }
    .console button:hover { filter: brightness(1.1); }
    .response {
      margin-top: 1rem;
      padding: 1rem;
      border-radius: .5rem;
      background: rgba(8, 13, 24, .6);
      color: var(--muted);
      font-size: .9rem;
      white-space: pre-wrap;
      display: none;
    }
    .attempts { margin-top: .5rem; font-size: .8rem; color: var(--cyan); }
    footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
  </style>
</head>
<body>
  <div class="shell">
    <h1>🦅 SIMORGH <span>// MISSION CONTROL</span></h1>
    <p class="sub">30-Bird Flock Federation — live Swarm-State and Flight Console.</p>

    <div class="grid" id="flock-status">
      <div class="bird"><span class="bird-name">Loading flock status...</span></div>
    </div>

    <div class="console">
      <h3>Flight Console</h3>
      <input id="prompt" placeholder="Ask the flock..." value="What is the current server time?">
      <button onclick="executeFlight()">Launch</button>
      <div class="response" id="response"></div>
      <div class="attempts" id="attempts"></div>
    </div>

    <footer>© 2026 Shahin Arab · MIT License · Si morgh → Simorgh. Thirty birds → one.</footer>
  </div>

  <script>
    async function loadFlock() {
      try {
        const resp = await fetch('/api/v1/flock/status');
        const data = await resp.json();
        const html = data.birds.map(b => {
          const cls = b.dormant ? 'dormant' : b.status === 'tired' ? 'tired' : 'healthy';
          return \`<div class="bird">
            <div><div class="bird-name">\${b.name}</div><div class="bird-meta">\${b.provider} · \${b.model}</div></div>
            <div style="display:flex;align-items:center;gap:.5rem">
              <span class="bird-meta">\${b.dormant ? 'dormant' : b.status}</span>
              <div class="status-dot \${cls}"></div>
            </div>
          </div>\`;
        }).join('');
        document.getElementById('flock-status').innerHTML = html;
      } catch(e) { console.error(e); }
    }

    async function executeFlight() {
      const prompt = document.getElementById('prompt').value;
      const respEl = document.getElementById('response');
      const attEl = document.getElementById('attempts');
      respEl.style.display = 'block';
      respEl.textContent = 'Flying the flock...';

      try {
        const resp = await fetch('/api/v1/agent/execute', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ prompt, tools: ['get_server_time','search_web'], userId: 'dashboard', tier: 'Free-Volunteer' })
        });
        const data = await resp.json();
        respEl.textContent = data.agentResponse || data.meta?.error || 'No answer';

        if (data.meta?.flock_attempts) {
          attEl.textContent = 'Flock: ' + data.meta.flock_attempts.map(a => a.birdId + (a.ok ? '✓' : '✗')).join(' → ');
        }
      } catch(e) {
        respEl.textContent = 'Error: ' + e.message;
      }
    }

    loadFlock();
    setInterval(loadFlock, 5000);
  </script>
</body>
</html>`;
}
