// ── Request security — the Cloudflare host ────────────────────────────────────
//
// The engine's `security.ts` holds the real implementation: the bearer extraction,
// the constant-time comparison, the fail-closed auth decision, the bounded body
// parser, the origin allow-list, and `RequestValidationError`.
//
// What differs here is only *where the values come from*. The engine takes the API
// key and the origin list as plain arguments, deliberately: it has no opinion about
// how a host stores configuration, and failing closed is then a property of the
// function rather than of remembering to check a binding first. This module is the
// half that knows about `Env`.
//
// The exported signatures are unchanged, which is the point — `src/index.ts`,
// `src/telegram.ts`, and `test/security.test.ts` all import from this path and did
// not need touching.

import {
  allowedOrigins as coreAllowedOrigins,
  authenticateServiceRequest as coreAuthenticateServiceRequest,
  constantTimeEqual as coreConstantTimeEqual,
  extractBearerToken as coreExtractBearerToken,
  type AuthResult,
  type Sha256,
} from "@simorgh/phoenix-core";

export {
  MAX_EXECUTE_BODY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TOOLS,
  MAX_USER_ID_CHARS,
  parseExecuteBody,
  RequestValidationError,
  type AuthResult,
  type HeaderLike,
  type ParsedExecuteRequest,
  type Tier,
} from "@simorgh/phoenix-core";

/** SHA-256 through the Workers runtime's WebCrypto. */
const sha256: Sha256 = async (value) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );

/** Bearer token from a `Request`; the engine takes anything with `get(name)`. */
export function extractBearerToken(request: Request): string | undefined {
  return coreExtractBearerToken(request.headers);
}

/** Constant-time compare. Timing-safe equality is the engine's; the hash is ours. */
export function constantTimeEqual(
  left: string,
  right: string
): Promise<boolean> {
  return coreConstantTimeEqual(left, right, sha256);
}

/** Service-to-service auth, reading the key off the binding. */
export function authenticateServiceRequest(
  request: Request,
  env: Env
): Promise<AuthResult> {
  return coreAuthenticateServiceRequest(request.headers, {
    apiKey: env.SIMORGH_API_KEY,
    sha256,
  });
}

/** The CORS allow-list, reading the comma-separated value off the binding. */
export function allowedOrigins(env: Env): string[] {
  return coreAllowedOrigins(env.CORS_ORIGINS);
}

export function isAllowedOrigin(origin: string, env: Env): boolean {
  return allowedOrigins(env).includes(origin);
}
