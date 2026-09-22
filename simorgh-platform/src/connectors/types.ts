// ── Connectors ────────────────────────────────────────────────────────────────
//
// A connector is how the platform reaches one running phoenix-core. Two exist
// because cores get reached two ways in practice:
//
//   rest  — the documented HTTP API. Always available; the lowest common denominator.
//   mcp   — the agent-facing surface. Richer, session-oriented, and the one an agent
//           host prefers when the core offers it.
//
// Both return the *same* shapes, and both are drawn from `@simorgh/phoenix-core`
// rather than redeclared. That is the dependency arrow made visible: the platform
// depends on the core's contract, and the core depends on nothing.

import type { AgentTool, FlockStatus } from "@simorgh/phoenix-core";

export type ConnectorKind = "rest" | "mcp";

/** The answer to "is this core alive, and on what address?" */
export interface CoreHealth {
  reachable: boolean;
  endpoint: string;
  /** Milliseconds the probe took. `undefined` when it did not complete. */
  latencyMs?: number;
  detail: string;
}

export interface AskRequest {
  prompt: string;
  tools?: readonly AgentTool[];
  userId?: string;
  tier?: string;
}

/**
 * The subset of an execute response the platform reads.
 *
 * Structural rather than nominal: a REST core returns exactly this, and the MCP
 * connector synthesizes it from `tools/call` content. A caller does not care which.
 */
export interface AskResult {
  success: boolean;
  answer: string;
  answeredBy: string;
  attempts: { providerId: string; ok: boolean; error?: string }[];
  /** Present when the request never reached a provider. */
  error?: string;
}

export interface CoreConnector {
  readonly kind: ConnectorKind;
  readonly endpoint: string;
  health(): Promise<CoreHealth>;
  status(): Promise<FlockStatus>;
  ask(request: AskRequest): Promise<AskResult>;
}

/**
 * Translate a core's wire payload into `AskResult`.
 *
 * `flock_attempts[].birdId` is the published field name — the platform says
 * "provider" everywhere a human reads it, but the wire contract keeps the bird
 * names it shipped with.
 */
export function toAskResult(payload: {
  success?: boolean;
  agentResponse?: string;
  meta?: {
    answered_by?: string;
    flock_attempts?: { birdId?: string; ok?: boolean; error?: string }[];
    error?: string;
  };
}): AskResult {
  return {
    success: payload.success === true,
    answer: payload.agentResponse ?? "",
    answeredBy: payload.meta?.answered_by ?? "unknown",
    attempts: (payload.meta?.flock_attempts ?? [])
      .filter((a): a is { birdId: string; ok: boolean; error?: string } =>
        typeof a.birdId === "string"
      )
      .map((a) => ({ providerId: a.birdId, ok: a.ok === true, ...(a.error ? { error: a.error } : {}) })),
    ...(payload.meta?.error ? { error: payload.meta.error } : {}),
  };
}
