import { Hono } from "hono";
import { FlockCoordinator } from "./flock";
import { DataTrustVault } from "./data-trust";
import { renderDashboard } from "./dashboard";
import { AGENT_TOOLS, runAgentLoop, type AgentTool } from "./agent";

// ── App ──────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

// ── Intent Shield — tool allow-list ──────────────────────────────
// One source of truth with the agent core: the registry in agent.ts is the
// allow-list, so a tool cannot be executable-but-unvetted or vetted-but-unrunnable.
const TOOL_ALLOW_LIST: readonly AgentTool[] = AGENT_TOOLS;
type AllowedTool = AgentTool;

function vetTool(toolName: string): toolName is AllowedTool {
  return (TOOL_ALLOW_LIST as readonly string[]).includes(toolName);
}

// ── Tools ────────────────────────────────────────────────────────
async function executeTool(
  tool: AllowedTool,
  args: Record<string, unknown>,
  env: Env
): Promise<string> {
  switch (tool) {
    case "get_server_time":
      return new Date().toISOString();
    case "search_web": {
      const query = String(args.query ?? "");
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
      const resp = await fetch(url);
      const data = (await resp.json()) as { AbstractText?: string };
      return data.AbstractText || `No instant answer found for "${query}".`;
    }
  }
}

// ── Routes ───────────────────────────────────────────────────────

app.get("/", (c) => c.text("Simorgh Edge Gateway — the flock is awake."));

app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.get("/dashboard", (c) =>
  c.html(renderDashboard(c.env))
);

app.get("/api/v1/flock/status", async (c) => {
  const id = c.env.FLOCK_COORDINATOR.idFromName("global");
  const stub = c.env.FLOCK_COORDINATOR.get(id);
  const status = await stub.getFlockStatus();
  return c.json(status);
});

app.post("/api/v1/agent/execute", async (c) => {
  const body = (await c.req.json()) as ExecuteRequest;

  // Vet tools against allow-list
  const vettedTools = (body.tools ?? []).filter(vetTool);

  // Run the agent loop: execute each vetted tool, fold the observations into a
  // synthesis prompt (prose, not JSON), and let the answering bird produce a
  // coherent natural-language answer from real results. Orchestration lives in
  // the Worker on purpose — the loop needs no DO state, and keeping it here
  // means the Durable Object receives a ready-to-answer prompt over RPC.
  const agent = await runAgentLoop(body.prompt, vettedTools, (invocation) =>
    executeTool(invocation.tool, invocation.args, c.env)
  );

  // Offload context to KV (the caller's original prompt, not the synthesis block —
  // the ref is a replayable record of the request, not of the derived context)
  const refId = crypto.randomUUID();
  await c.env.CONTEXT_STORE.put(
    `ctx_${refId}`,
    JSON.stringify({ prompt: body.prompt, tools: vettedTools }),
    { expirationTtl: 3600 }
  );

  // Log to Data Trust
  const vaultId = c.env.DATA_TRUST_VAULT.idFromName("global");
  const vault = c.env.DATA_TRUST_VAULT.get(vaultId);
  await vault.logEntry({
    userId: body.userId ?? "anonymous",
    tier: body.tier ?? "Free-Volunteer",
    refId,
    timestamp: Date.now(),
  });

  // Run the flock. The Durable Object reads its own bindings — `env` is not
  // cloneable and must not be sent across the RPC boundary. It receives the
  // synthesis prompt: original request plus folded tool results.
  const id = c.env.FLOCK_COORDINATOR.idFromName("global");
  const stub = c.env.FLOCK_COORDINATOR.get(id);
  const result = await stub.runFlock(agent.effectivePrompt, vettedTools);

  return c.json({
    success: true,
    meta: {
      ...result.meta,
      contextRefId: refId,
      loggedToLedger: true,
      // Real loop telemetry, replacing the hardcoded zero: what was requested,
      // how many iterations ran, and what each tool actually returned.
      tool_iterations: agent.meta.tool_iterations,
      tools_requested: agent.meta.tools_requested,
      tool_observations: agent.meta.tool_observations,
    },
    agentResponse: result.answer,
  });
});

app.get("/api/v1/context/:refId", async (c) => {
  const refId = c.req.param("refId");
  const data = await c.env.CONTEXT_STORE.get(`ctx_${refId}`);
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json(JSON.parse(data));
});

app.get("/api/v1/user/:userId/logs", async (c) => {
  const vaultId = c.env.DATA_TRUST_VAULT.idFromName("global");
  const vault = c.env.DATA_TRUST_VAULT.get(vaultId);
  const logs = await vault.getUserLogs(c.req.param("userId"));
  return c.json(logs);
});

// ── Types ─────────────────────────────────────────────────────────
interface ExecuteRequest {
  prompt: string;
  tools?: string[];
  userId?: string;
  tier?: "Free-Volunteer" | "Pro-Paid" | "Pro-Data-Pact";
}

// ── Cron — daily stale sweep ──────────────────────────────────────
// wrangler.toml declares `[triggers] crons = ["15 6 * * *"]`. Without a
// `scheduled` handler that trigger is inert: it fires, does nothing, and every bird
// that ever failed keeps reading 'tired' on the dashboard for good.
const scheduled: ExportedHandlerScheduledHandler<Env> = async (_controller, env) => {
  const id = env.FLOCK_COORDINATOR.idFromName("global");
  const stub = env.FLOCK_COORDINATOR.get(id);
  const changed = await stub.sweepStale(Date.now());
  console.log(JSON.stringify({ event: "flock_sweep", changed }));
};

// ── Export ────────────────────────────────────────────────────────
// The default export is a handler object, not the bare Hono app, so a `scheduled`
// handler can sit beside `fetch` — a bare app cannot carry one.
// `app.fetch` is bound to the instance by Hono, so passing the reference is correct.
export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
// `app` is re-exported so tests can drive routes with Hono's `app.request(path, init,
// env)` helper, which takes the bindings explicitly and needs no ExecutionContext.
export { app, FlockCoordinator, DataTrustVault };
