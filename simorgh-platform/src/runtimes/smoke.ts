// ── Smoke run ─────────────────────────────────────────────────────────────────
//
// Boots a real core on an ephemeral port, probes it over real HTTP, and exits
// non-zero if anything is wrong. Bounded by construction: it never waits for a
// provider, never needs a key, and always terminates.
//
// This exists because the `node` target's deploy step has to be *runnable*. A step
// that starts a server in the foreground would hang a `simorgh deploy --cli` run
// forever, and a step that merely prints instructions is not a check. This is the
// step: it proves the runtime boots and answers, then gets out of the way.

import { startNodeRuntime } from "./node.ts";

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runSmoke(
  options: { apiKey?: string; env?: Record<string, string | undefined> } = {}
): Promise<{ ok: boolean; checks: SmokeCheck[]; url: string }> {
  const apiKey = options.apiKey ?? "smoke-token";
  const runtime = await startNodeRuntime({
    port: 0, // ephemeral: never collides with a core already running on this box
    apiKey,
    secrets: options.env ?? {},
    providers: [], // no providers on purpose: this checks the host, not any vendor
  });

  const checks: SmokeCheck[] = [];
  const auth = { Authorization: `Bearer ${apiKey}` };

  try {
    const health = await fetch(`${runtime.url}/health`);
    const healthBody = (await health.json()) as { status?: string };
    checks.push({
      name: "health",
      ok: health.ok && healthBody.status === "ok",
      detail: `http_${health.status} status=${healthBody.status ?? "?"}`,
    });

    const status = await fetch(`${runtime.url}/api/v1/flock/status`);
    const statusBody = (await status.json()) as { birds?: unknown[] };
    checks.push({
      name: "flock-status",
      ok: status.ok && Array.isArray(statusBody.birds),
      detail: `http_${status.status} providers=${statusBody.birds?.length ?? "?"}`,
    });

    const denied = await fetch(`${runtime.url}/api/v1/agent/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    checks.push({
      name: "auth-fails-closed",
      ok: denied.status === 401,
      detail: `unauthenticated execute → http_${denied.status} (want 401)`,
    });

    // With no providers configured the engine must report exhaustion rather than
    // throwing — the honest failure for a core that has no keys yet.
    const execute = await fetch(`${runtime.url}/api/v1/agent/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ prompt: "hi", tools: [] }),
    });
    const executeBody = (await execute.json()) as {
      success?: boolean;
      meta?: { answered_by?: string; error?: string };
    };
    checks.push({
      name: "execute-degrades-honestly",
      ok: execute.status === 200 && executeBody.success === false && executeBody.meta?.answered_by === "none",
      detail: `http_${execute.status} answered_by=${executeBody.meta?.answered_by ?? "?"} error=${executeBody.meta?.error ?? "-"}`,
    });

    // MCP is a second surface onto the same core; probe the handshake, not just REST.
    const mcpInit = await fetch(`${runtime.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...auth },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
      }),
    });
    const mcpBody = (await mcpInit.json()) as { result?: { protocolVersion?: string } };
    checks.push({
      name: "mcp-initialize",
      ok: mcpInit.ok && typeof mcpBody.result?.protocolVersion === "string",
      detail: `http_${mcpInit.status} protocol=${mcpBody.result?.protocolVersion ?? "?"}`,
    });
  } finally {
    await runtime.close();
  }

  return { ok: checks.every((check) => check.ok), checks, url: runtime.url };
}

async function main(): Promise<void> {
  const outcome = await runSmoke();
  process.stdout.write(`phoenix-core smoke run (${outcome.url})\n`);
  for (const check of outcome.checks) {
    process.stdout.write(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name} — ${check.detail}\n`);
  }
  process.exit(outcome.ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("smoke.ts")) {
  await main();
}
