// ── What a failure string means: the one definition ──────────────────────────
//
// `ProviderCallResult.error` is a string, deliberately — an error *type* would
// be a second port every third-party adapter has to implement, and provider.ts
// says so at length. A string contract's weakness is that every consumer must
// re-derive what it means, and by the time the omnirouter port research landed
// (ADR-0007) three hosts each carried their own `error === "rate_limit"`: the
// "two definitions, nothing comparing them" trap ledger.ts documents, with one
// copy per host.
//
// This module is that single definition. It is intentionally one function: the
// only question any host asks a failure string today is *is this a rate limit*,
// because that is the only error that changes `cooldownFor` (health.ts). The
// richer classifier the omnirouter research surfaced (429/401/403/5xx/transport
// → retryable) is parked in ADR-0007 §4 with its trigger — a retry policy —
// because a taxonomy without a consumer is an abstraction, and this repo does
// not ship those.

/**
 * Whether a provider's error string means "come back later" — the one failure
 * that earns the longer `COOLDOWN_RATE_LIMIT_MS` over `COOLDOWN_FAILURE_MS`.
 *
 * The literal is the contract, not a heuristic. `openAiCompatibleProvider` and
 * `geminiProvider` emit exactly `"rate_limit"` on HTTP 429, and provider.ts
 * records why it is "matched literally rather than by a pattern": a thrown
 * transport error's text can *contain* "429", and pattern-matching that would
 * classify network storms as rate limits and bench healthy birds for a minute
 * at a time. A provider that means something different emits a different
 * string, and the flock treats it as a plain failure.
 *
 * `undefined` (a successful result never carries an error, but the type allows
 * it) is a plain failure, not a rate limit.
 */
export function isRateLimitError(error: string | undefined): boolean {
  return error === "rate_limit";
}
