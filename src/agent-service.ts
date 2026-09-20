import { AGENT_TOOLS, runAgentLoop, type AgentTool, type AgentRunResult } from "./agent";
import { type FlockRunResult } from "./flock";
import type { Tier } from "./security";

export interface ExecuteAgentInput {
  prompt: string;
  tools: AgentTool[];
  userId: string;
  tier: Tier;
  blockedTools?: string[];
  requestId?: string;
}

export interface ExecuteAgentResult {
  success: boolean;
  meta: FlockRunResult["meta"] & {
    contextRefId: string;
    loggedToLedger: boolean;
    tool_iterations: AgentRunResult["meta"]["tool_iterations"];
    tools_requested: AgentRunResult["meta"]["tools_requested"];
    tool_observations: AgentRunResult["meta"]["tool_observations"];
    blocked_tools: string[];
    requestId: string;
  };
  agentResponse: string;
}

async function executeTool(
  tool: AgentTool,
  args: Record<string, unknown>
): Promise<string> {
  switch (tool) {
    case "get_server_time":
      return new Date().toISOString();
    case "search_web": {
      const query = String(args.query ?? "").trim();
      if (!query) return "No search query supplied.";
      const url =
        "https://api.duckduckgo.com/?q=" +
        encodeURIComponent(query) +
        "&format=json&no_html=1";
      const response = await fetch(url);
      if (!response.ok) throw new Error("search_http_" + response.status);
      const data = (await response.json()) as { AbstractText?: string };
      return (
        data.AbstractText ||
        'No instant answer found for "' + query + '".'
      );
    }
  }
}

export async function executeAgent(
  env: Env,
  input: ExecuteAgentInput
): Promise<ExecuteAgentResult> {
  const requestId = input.requestId ?? crypto.randomUUID();

  const agent = await runAgentLoop(
    input.prompt,
    input.tools,
    (invocation) => executeTool(invocation.tool, invocation.args)
  );

  const refId = crypto.randomUUID();
  await env.CONTEXT_STORE.put(
    "ctx_" + refId,
    JSON.stringify({ prompt: input.prompt, tools: input.tools }),
    { expirationTtl: 3600 }
  );

  const vaultId = env.DATA_TRUST_VAULT.idFromName("global");
  const vault = env.DATA_TRUST_VAULT.get(vaultId);
  await vault.logEntry({
    userId: input.userId,
    tier: input.tier,
    refId,
    timestamp: Date.now(),
    details: JSON.stringify({
      requestId,
      tools: input.tools,
      blockedTools: input.blockedTools ?? [],
    }),
  });

  const flockId = env.FLOCK_COORDINATOR.idFromName("global");
  const flock = env.FLOCK_COORDINATOR.get(flockId);
  const result = await flock.runFlock(
    agent.effectivePrompt,
    input.tools.map(String)
  );

  return {
    success: result.meta.answered_by !== "none",
    meta: {
      ...result.meta,
      contextRefId: refId,
      loggedToLedger: true,
      tool_iterations: agent.meta.tool_iterations,
      tools_requested: agent.meta.tools_requested,
      tool_observations: agent.meta.tool_observations,
      blocked_tools: input.blockedTools ?? [],
      requestId,
    },
    agentResponse: result.answer,
  };
}
