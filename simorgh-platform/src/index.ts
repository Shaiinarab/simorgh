/**
 * simorgh-platform — the control plane that connects phoenix-core instances.
 *
 * The dependency runs one way and stays that way: this package imports
 * `@simorgh/phoenix-core`, and phoenix-core imports nothing from here. Everything
 * below is about *placement and reach* — where a core runs, how it gets there, and
 * how the platform talks to it — never about how a core thinks.
 *
 *   targets            where a core can live, and what deploying there involves
 *   deploy/*           the plan, the preflight gate, the runner, and the consent gate
 *   connectors/*       REST and MCP, behind one interface, plus a conformance kit
 *   fleet              every core the platform can reach, and failover between them
 *   mcp/server         the platform *as* an MCP server, so an agent can drive the fleet
 *   runtimes/node      a complete phoenix-core on Node, runnable unbuilt
 *
 * `phoenix-core` remains usable on its own. A host that only ever wants the engine
 * on one runtime never needs this package.
 */

export * from "./targets.ts";
export * from "./connectors/types.ts";
export { restConnector, type RestConnectorConfig } from "./connectors/rest.ts";
export {
  mcpConnector,
  MCP_PROTOCOL_VERSION,
  MCP_TOOL_ASK,
  MCP_TOOL_STATUS,
  type McpConnectorConfig,
} from "./connectors/mcp.ts";
export * from "./deploy/plan.ts";
export * from "./deploy/runner.ts";
export * from "./deploy/apply.ts";
export * from "./deploy/preflight.ts";
export {
  runConnectorConformance,
  type ConformanceCheck,
  type ConformanceOptions,
  type FakeCoreScript,
} from "./connectors/conformance.ts";
export * from "./fleet.ts";
export * from "./fleet-store.ts";
export {
  platformMcpHandler,
  type PlatformMcpOptions,
} from "./mcp/server.ts";
export {
  startNodeRuntime,
  type NodeRuntime,
  type NodeRuntimeOptions,
} from "./runtimes/node.ts";
export { defaultProviders, type ProviderCatalogOptions } from "./runtimes/providers.ts";
export { runSmoke, type SmokeCheck } from "./runtimes/smoke.ts";
