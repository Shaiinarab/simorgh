// ── The agent core ─────────────────────────────────────────────────────
//
// Epic 4 made the flock a router; this module makes it an *agent*. The gap it
// closes: tools were vetted at the boundary and then dropped on the floor —
// `runFlock(prompt, _tools)` ignored them and `tool_iterations` was hardcoded 0.
// Now allowed tools are actually executed and their results are folded into the
// prompt the answering bird sees.
//
// Like `flyFlock`, everything decision-shaped lives here as a pure function over
// injected dependencies, so the whole loop is testable without workerd, network,
// or a Durable Object. The DO in flock.ts stays a thin shell over storage.

/** A vetted, allow-listed tool the agent may call. */
export type AgentTool = "search_web" | "get_server_time";

/** The tool registry: the same tools index.ts vets against. */
export const AGENT_TOOLS: readonly AgentTool[] = ["search_web", "get_server_time"];

/**
 * Tool-call budget. Bounded by design: each iteration costs a real provider call
 * plus the tool's own fetch, and a prompt that can be answered in two hops does
 * not need ten. The cap is a guardrail, not a target — most answers need zero or
 * one iteration because synthesis is folded into the bird's own completion.
 */
export const MAX_TOOL_ITERATIONS = 4;

/** How many characters of a tool result are folded into the next prompt. */
export const MAX_TOOL_RESULT_CHARS = 2_000;

/**
 * A single tool execution, as recorded in the result meta. Concrete fields of
 * primitives only — this crosses the Durable Object RPC boundary, and the
 * structured-clone rules that ban `unknown` also ban index signatures.
 */
export interface ToolObservation {
  tool: AgentTool;
  iteration: number;
  ok: boolean;
  /** Truncated tool output on success; the error string on failure. */
  result: string;
}

/** The agent portion of the flock result. Cloneable, no `unknown`. */
export interface AgentMeta {
  tool_iterations: number;
  tools_requested: AgentTool[];
  tool_observations: ToolObservation[];
}

export interface AgentRunResult {
  /** Prompt the bird should answer — original prompt plus folded tool results. */
  effectivePrompt: string;
  meta: AgentMeta;
}

/** A single vetted tool invocation decided by the loop. */
export interface ToolInvocation {
  tool: AgentTool;
  /** Structured arguments parsed from the loop decision; `search_web` needs `query`. */
  args: Record<string, string>;
}

/**
 * Extracts the tool argument for one invocation.
 *
 * Kept as its own function so tests can pin argument extraction without any
 * executor. `get_server_time` takes none; `search_web` takes the query. When the
 * loop cannot find a query it falls back to the prompt itself — a malformed
 * request should degrade to a degraded search, not to silence.
 */
export function extractToolArgs(tool: AgentTool, prompt: string, iteration: number): Record<string, string> {
  if (tool === "get_server_time") return {};
  // search_web: the query is the prompt. Later iterations could refine it; for
  // now the prompt IS the search intent, which is exactly what a caller sending
  // tools: ["search_web"] asked for.
  const query = prompt.trim();
  return { query: query.length > 0 ? query : `search iteration ${iteration}` };
}

/**
 * One round of tool execution, in requested order.
 *
 * Errors are captured per-tool and never abort the loop: a failing search must
 * not cost the caller their time answer. A failed tool contributes a "[tool]
 * failed: <error>" note to the folded context so the answering bird can say so
 * honestly instead of inventing a result.
 */
export async function runToolRound(
  tools: readonly AgentTool[],
  prompt: string,
  iteration: number,
  execute: (invocation: ToolInvocation) => Promise<string>
): Promise<ToolObservation[]> {
  const observations: ToolObservation[] = [];
  for (const tool of tools) {
    const args = extractToolArgs(tool, prompt, iteration);
    let ok = true;
    let result: string;
    try {
      result = await execute({ tool, args });
    } catch (e) {
      ok = false;
      result = String(e);
    }
    observations.push({ tool, iteration, ok, result: truncate(result) });
  }
  return observations;
}

function truncate(s: string, max = MAX_TOOL_RESULT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Folds tool observations into the prompt the answering bird receives.
 *
 * Deliberately a *narrative* block, not JSON: story 4.3's bar is "no raw JSON
 * dumps", and that starts with what we hand the model. The bird is told what the
 * tools returned in prose it can quote, and asked to synthesize a coherent
 * natural-language answer.
 */
export function buildSynthesisPrompt(originalPrompt: string, observations: readonly ToolObservation[]): string {
  if (observations.length === 0) return originalPrompt;

  const lines: string[] = [
    "You are Simorgh, an agent with access to real tool results.",
    "Synthesize the tool results below into a coherent natural-language answer.",
    "Do not output raw JSON. Quote the substance of the results in prose.",
    "",
    `Request: ${originalPrompt}`,
    "",
    "Tool results:",
  ];
  for (const obs of observations) {
    if (obs.ok) {
      lines.push(`- [${obs.tool}] ${obs.result}`);
    } else {
      lines.push(`- [${obs.tool}] failed: ${obs.result}`);
    }
  }
  lines.push("", "Now answer the request using these results. If a result failed, say so plainly.");
  return lines.join("\n");
}

/**
 * The agent loop: decide → execute → fold, up to the budget.
 *
 * One round per iteration, tools in the order the caller allowed them. After the
 * loop, `effectivePrompt` carries everything the bird needs to synthesize the
 * final answer (story 4.3) from multiple tool results (story 4.4). The loop is
 * "sequential multi-tool" by construction: it runs within a single flock hop,
 * before the bird is dialled.
 */
export async function runAgentLoop(
  prompt: string,
  tools: readonly AgentTool[],
  execute: (invocation: ToolInvocation) => Promise<string>
): Promise<AgentRunResult> {
  const requested = [...tools];
  const allObservations: ToolObservation[] = [];

  const iterations = Math.min(requested.length, MAX_TOOL_ITERATIONS);
  for (let i = 0; i < iterations; i++) {
    const round = await runToolRound([requested[i]], prompt, i, execute);
    allObservations.push(...round);
  }

  return {
    effectivePrompt: buildSynthesisPrompt(prompt, allObservations),
    meta: {
      tool_iterations: allObservations.length > 0 ? iterations : 0,
      tools_requested: requested,
      tool_observations: allObservations,
    },
  };
}
