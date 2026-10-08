// ── The agent tool loop — now owned by phoenix-core ──────────────────────────
//
// This module was a second copy of the engine's, and not merely a similar one: every
// exported function was line-for-line the same. The only differences were comments —
// where the engine says "answering provider", this said "answering bird".
//
// Nothing here was ever Cloudflare-specific. `runToolRound` and `runAgentLoop` take
// the tool executor as an injected function and never dial a provider themselves, so
// the loop was already runtime-agnostic; it just lived in the wrong package.
//
// The path and the exported names are unchanged, so `src/agent-service.ts`,
// `src/security.ts`, `src/index.ts`, and `test/agent.test.ts` keep working as written.

export {
  AGENT_TOOLS,
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_CHARS,
  buildSynthesisPrompt,
  extractToolArgs,
  runAgentLoop,
  runToolRound,
  type AgentMeta,
  type AgentRunResult,
  type AgentTool,
  type ToolInvocation,
  type ToolObservation,
} from "@simorgh/phoenix-core";
