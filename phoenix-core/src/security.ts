// ── Request security ──────────────────────────────────────────────────────────
//
// Bearer authentication, bounded input validation, and CORS allow-listing. All of it
// is pure over injected capabilities: `Headers` is accepted structurally, hashing
// arrives as a port, and the configured key arrives as a value. Nothing here knows
// what a Worker is, which is what lets the same checks guard the edge and a
// self-hosted Node core.
//
// Two decisions worth stating, because both are easy to get wrong:
//
//   1. Missing configuration fails *closed* (503), it does not open the door. A
//      deployment that forgot to set SIMORGH_API_KEY refuses service rather than
//      silently accepting anonymous traffic.
//   2. Comparison is constant-time over SHA-256 digests, not `===`. Digests rather
//      than raw bytes so unequal lengths cannot leak through an early exit.

import type { AgentTool } from "./agent.ts";
import type { Sha256 } from "./ports.ts";

export const MAX_EXECUTE_BODY_CHARS = 32_000;
export const MAX_PROMPT_CHARS = 12_000;
export const MAX_TOOLS = 8;
export const MAX_USER_ID_CHARS = 128;

export type Tier = "Free-Volunteer" | "Pro-Paid" | "Pro-Data-Pact";

export interface ParsedExecuteRequest {
  prompt: string;
  tools: AgentTool[];
  blockedTools: string[];
  userId: string;
  tier: Tier;
}

const VALID_TIERS: readonly Tier[] = ["Free-Volunteer", "Pro-Paid", "Pro-Data-Pact"];

/** Anything with `get(name)`. A real `Headers` satisfies this structurally. */
export interface HeaderLike {
  get(name: string): string | null;
}

export function extractBearerToken(headers: HeaderLike): string | undefined {
  const value = headers.get("Authorization")?.trim();
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || undefined;
}

export async function constantTimeEqual(
  left: string,
  right: string,
  sha256: Sha256
): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a[i % a.length] ?? 0) ^ (b[i % b.length] ?? 0);
  }
  return diff === 0;
}

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; code: "UNAUTHORIZED" | "AUTH_NOT_CONFIGURED" };

/**
 * Validate a service-to-service bearer token.
 *
 * `apiKey` is passed in rather than read from an env object so this module has no
 * opinion about how a host stores configuration — and so failing closed is a
 * property of the function, not of remembering to check a binding first.
 */
export async function authenticateServiceRequest(
  headers: HeaderLike,
  options: { apiKey?: string; sha256: Sha256 }
): Promise<AuthResult> {
  const configured = options.apiKey?.trim();
  if (!configured) return { ok: false, status: 503, code: "AUTH_NOT_CONFIGURED" };

  const supplied = extractBearerToken(headers);
  if (!supplied || !(await constantTimeEqual(supplied, configured, options.sha256))) {
    return { ok: false, status: 401, code: "UNAUTHORIZED" };
  }
  return { ok: true };
}

/**
 * Parse and bound an execute request body.
 *
 * Every limit exists to stop one caller becoming everyone's outage: the body cap
 * bounds parse cost, the prompt cap bounds provider spend, and the tool cap bounds
 * how much work a single request can ask for.
 *
 * Unknown tools are *dropped and reported*, not rejected: a caller asking for a tool
 * this deployment has not shipped should still get an answer from the tools it did
 * get. The dropped names travel in `blockedTools` so the ledger records what was
 * refused.
 */
export function parseExecuteBody(
  raw: string,
  availableTools: readonly AgentTool[],
  headerUserId?: string
): ParsedExecuteRequest {
  if (raw.length > MAX_EXECUTE_BODY_CHARS) {
    throw new RequestValidationError(
      413,
      "request_too_large",
      "Request body exceeds " + MAX_EXECUTE_BODY_CHARS + " characters."
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body_not_object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    throw new RequestValidationError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new RequestValidationError(400, "invalid_prompt", "prompt must be a non-empty string.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new RequestValidationError(
      413,
      "prompt_too_large",
      "prompt exceeds " + MAX_PROMPT_CHARS + " characters."
    );
  }

  const rawTools = body.tools;
  if (
    rawTools !== undefined &&
    (!Array.isArray(rawTools) || rawTools.some((tool) => typeof tool !== "string"))
  ) {
    throw new RequestValidationError(400, "invalid_tools", "tools must be an array of strings.");
  }

  const requestedTools = (rawTools as string[] | undefined) ?? [];
  if (requestedTools.length > MAX_TOOLS) {
    throw new RequestValidationError(
      400,
      "too_many_tools",
      "At most " + MAX_TOOLS + " tools may be requested."
    );
  }

  const available = new Set<string>(availableTools);
  const tools: AgentTool[] = [];
  const blockedTools: string[] = [];
  for (const tool of requestedTools) {
    if (available.has(tool)) tools.push(tool as AgentTool);
    else if (!blockedTools.includes(tool)) blockedTools.push(tool);
  }

  const bodyUserId = normalizeUserId(body.userId);
  const normalizedHeader = normalizeUserId(headerUserId);
  if (bodyUserId && normalizedHeader && bodyUserId !== normalizedHeader) {
    throw new RequestValidationError(
      400,
      "ambiguous_identity",
      "userId in the body and X-Simorgh-User-Id must match."
    );
  }

  const tierValue = body.tier;
  const tier = tierValue === undefined ? "Free-Volunteer" : parseTier(tierValue);

  return {
    prompt,
    tools,
    blockedTools,
    userId: normalizedHeader ?? bodyUserId ?? "anonymous",
    tier,
  };
}

function normalizeUserId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > MAX_USER_ID_CHARS ||
    !/^[A-Za-z0-9:_-]+$/.test(value)
  ) {
    throw new RequestValidationError(
      400,
      "invalid_user_id",
      "userId must use letters, numbers, colon, underscore, or hyphen."
    );
  }
  return value;
}

function parseTier(value: unknown): Tier {
  if (typeof value !== "string" || !VALID_TIERS.includes(value as Tier)) {
    throw new RequestValidationError(400, "invalid_tier", "tier is not recognized.");
  }
  return value as Tier;
}

export function allowedOrigins(configured: string | undefined): string[] {
  return (configured ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Browser origins are an allow-list, never a wildcard.
 *
 * An absent configuration allows *nothing* rather than everything: a deployment
 * that has not decided who may call it from a browser should not guess "anyone".
 * Requests with no `Origin` header are unaffected — this only governs browsers.
 */
export function isAllowedOrigin(origin: string, configured: string | undefined): boolean {
  return allowedOrigins(configured).includes(origin);
}

/**
 * A request failure the router can turn straight into a status code.
 *
 * Declared as plain fields assigned in the constructor, not as TypeScript
 * *parameter properties*. That is not stylistic: parameter properties are TS-only
 * runtime syntax, and Node's native type stripping refuses them outright
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Using them here would mean this file could
 * not be executed unbuilt, which is the whole reason the engine is portable.
 */
export class RequestValidationError extends Error {
  readonly status: 400 | 413;
  readonly code: string;

  constructor(status: 400 | 413, code: string, message: string) {
    super(message);
    this.name = "RequestValidationError";
    this.status = status;
    this.code = code;
  }
}
