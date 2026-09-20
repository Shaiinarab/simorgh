import type { AgentTool } from "./agent";

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

export function extractBearerToken(request: Request): string | undefined {
  const value = request.headers.get("Authorization")?.trim();
  if (!value) return undefined;
  const match = /^Bearer\\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || undefined;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a[i % a.length] ?? 0) ^ (b[i % b.length] ?? 0);
  }
  return diff === 0;
}

export async function authenticateServiceRequest(
  request: Request,
  env: Env
): Promise<{ ok: true } | { ok: false; status: 401 | 503; code: "UNAUTHORIZED" | "AUTH_NOT_CONFIGURED" }> {
  const configured = env.SIMORGH_API_KEY?.trim();
  if (!configured) return { ok: false, status: 503, code: "AUTH_NOT_CONFIGURED" };

  const supplied = extractBearerToken(request);
  if (!supplied || !(await constantTimeEqual(supplied, configured))) {
    return { ok: false, status: 401, code: "UNAUTHORIZED" };
  }
  return { ok: true };
}

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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body_not_object");
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
  const tier =
    tierValue === undefined
      ? "Free-Volunteer"
      : parseTier(tierValue);

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

export function allowedOrigins(env: Env): string[] {
  return (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string, env: Env): boolean {
  return allowedOrigins(env).includes(origin);
}

export class RequestValidationError extends Error {
  constructor(
    public readonly status: 400 | 413,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}
