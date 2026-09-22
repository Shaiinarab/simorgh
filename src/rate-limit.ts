// ── Per-key rate limiting — now owned by phoenix-core ────────────────────────
//
// A second copy of the fixed-window counter, differing from the engine's only in
// naming `SqlStorage` instead of `SqlPort`. Cloudflare's storage satisfies the port
// as-is, so the copy is deleted and this module re-exports the engine's.
//
// `now` is a required parameter in the engine and was an optional one here. Every
// caller already passed it — the tests to drive the window boundary, `flock.ts` to
// share the DO's clock — so making it explicit cost nothing and removed the last
// place where behaviour depended on an implicit `Date.now()`.

export {
  RATE_LIMIT_SCHEMA,
  consumeRateLimit,
  type RateLimitDecision,
} from "@simorgh/phoenix-core";
