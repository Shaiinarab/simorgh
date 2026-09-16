import { Hono } from "hono";
import { FlockCoordinator } from "./flock";
import { DataTrustVault } from "./data-trust";
import { renderDashboard } from "./dashboard";

// ── App ──────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

// ── Intent Shield — tool allow-list ──────────────────────────────
const TOOL_ALLOW_LIST = ["search_web", "get_server_time"] as const;
type AllowedTool = (typeof TOOL_ALLOW_LIST)[number];

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

  // Offload context to KV
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
  // cloneable and must not be sent across the RPC boundary.
  const id = c.env.FLOCK_COORDINATOR.idFromName("global");
  const stub = c.env.FLOCK_COORDINATOR.get(id);
  const result = await stub.runFlock(body.prompt, vettedTools);

  return c.json({
    success: true,
    meta: {
      ...result.meta,
      contextRefId: refId,
      loggedToLedger: true,
      tool_iterations: 0,
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
