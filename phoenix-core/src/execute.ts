// ── The request pipeline ──────────────────────────────────────────────────────
//
// One execute call, end to end: run the vetted tools, offload the request context,
// write the transparency ledger, then fly the flock. Every side effect goes through
// a port, so this function is the *whole* request path and it is identical on the
// Cloudflare edge and in a self-hosted Node process.
//
// Hosts supply the ports and get back a structured-cloneable result. Nothing here
// imports a runtime, and nothing here knows which provider answered.

import { runAgentLoop, type AgentTool, type ToolInvocation, type ToolObservation } from "./agent.ts";
import { flyFlock, type FlockRunResult } from "./flock.ts";
import type {
  ContextStorePort,
  LedgerPort,
  PhoenixPorts,
  SecretReader,
  WorkersAiPort,
} from "./ports.ts";
import type { Provider } from "./provider.ts";

export interface ExecuteAgentInput {
  prompt: string;
  tools: readonly AgentTool[];
  userId: string;
  tier: string;
  /** Tools the caller asked for that this deployment does not offer. */
  blockedTools?: readonly string[];
  requestId?: string;
}

/** Everything the pipeline needs that does not depend on how the flight happens. */
export interface ExecuteAgentCommonDeps {
  ports: PhoenixPorts;
  secret: SecretReader;
  /** Absent on hosts with no Workers AI equivalent; those providers go unavailable. */
  workersAi?: WorkersAiPort;
  contextStore: ContextStorePort;
  ledger: LedgerPort;
  /** Runs one allow-listed tool. The only way the pipeline touches the outside world. */
  executeTool: (invocation: ToolInvocation) => Promise<string>;
  /** How long an offloaded context stays retrievable. */
  contextTtlSeconds?: number;
}

/**
 * How the flight happens — and the seam that lets *every* host use this pipeline.
 *
 * A host can either hand over the raw ingredients and let core fly them, or fly them
 * itself and hand back the result. The second form exists for a real constraint rather
 * than for symmetry: on Cloudflare the cooldown and observation writes live in Durable
 * Object storage, which is only reachable over RPC from the request context. A closure
 * cannot cross that boundary, so a host like that *must* fly through a stub of its own.
 *
 * Before this, that host had to re-implement the pipeline's ordering — offload the
 * context, write the ledger, then fly — which meant the transparency contract held in
 * one place and was *assumed* in the other. Now the order lives here once, and the host
 * supplies only the part it is actually the owner of.
 *
 * A union rather than an optional field: `fly` and the raw ingredients are mutually
 * exclusive by construction, so a host cannot pass both and leave a reader guessing
 * which one won.
 */
export type FlightDeps =
  | {
      /**
       * The flight, already bound to whatever the host flies with.
       *
       * `tools` is the caller's requested set, passed through unchanged. It is not input
       * to the flight — the loop has already folded every tool result into `prompt` — but
       * hosts publish their flight signature as `(prompt, tools)` and use it to record
       * what was asked for. Dropping it here would silently narrow a contract those hosts
       * had already shipped.
       */
      fly: (prompt: string, tools: readonly AgentTool[]) => Promise<FlockRunResult>;
      providers?: never;
      cooldownUntil?: never;
      record?: never;
    }
  | {
      fly?: never;
      providers: readonly Provider[];
      cooldownUntil: (providerId: string) => number;
      record: (providerId: string, ok: boolean, error?: string) => void;
    };

export type ExecuteAgentDeps = ExecuteAgentCommonDeps & FlightDeps;

export interface ExecuteAgentResult {
  success: boolean;
  meta: FlockRunResult["meta"] & {
    contextRefId: string;
    loggedToLedger: boolean;
    tool_iterations: number;
    tools_requested: AgentTool[];
    tool_observations: ToolObservation[];
    blocked_tools: string[];
    requestId: string;
  };
  agentResponse: string;
}

export const DEFAULT_CONTEXT_TTL_SECONDS = 3_600;

export async function executeAgent(
  input: ExecuteAgentInput,
  deps: ExecuteAgentDeps
): Promise<ExecuteAgentResult> {
  const requestId = input.requestId ?? deps.ports.randomUUID();
  const blockedTools = [...(input.blockedTools ?? [])];

  const agent = await runAgentLoop(input.prompt, input.tools, deps.executeTool);

  const refId = deps.ports.randomUUID();
  await deps.contextStore.put(
    "ctx_" + refId,
    JSON.stringify({ prompt: input.prompt, tools: input.tools }),
    { expirationTtl: deps.contextTtlSeconds ?? DEFAULT_CONTEXT_TTL_SECONDS }
  );

  // Logged before the flock is dialled, on purpose: the transparency contract is
  // "this request happened and here is what it was allowed to do", and that must
  // hold even when every provider is down.
  await deps.ledger.logEntry({
    userId: input.userId,
    tier: input.tier,
    refId,
    timestamp: deps.ports.now(),
    action: "execute",
    details: JSON.stringify({ requestId, tools: input.tools, blockedTools }),
  });

  // The host flew it, or we did. Either way the ordering above already happened, which is
  // the part that matters: the ledger row exists before any provider is dialled, so the
  // transparency contract holds even when every provider is down.
  const result = deps.fly
    ? await deps.fly(agent.effectivePrompt, input.tools)
    : await flyFlock(agent.effectivePrompt, {
        providers: deps.providers,
        ctx: {
          fetch: deps.ports.fetch,
          secret: deps.secret,
          ...(deps.workersAi ? { workersAi: deps.workersAi } : {}),
        },
        cooldownUntil: deps.cooldownUntil,
        record: deps.record,
        now: deps.ports.now(),
      });

  return {
    success: result.meta.answered_by !== "none",
    meta: {
      ...result.meta,
      contextRefId: refId,
      loggedToLedger: true,
      tool_iterations: agent.meta.tool_iterations,
      tools_requested: agent.meta.tools_requested,
      tool_observations: agent.meta.tool_observations,
      blocked_tools: blockedTools,
      requestId,
    },
    agentResponse: result.answer,
  };
}
