// ── Session affinity — the cache you cannot see ──────────────────────────────
//
// Why this exists. Switching models mid-session throws away a provider's prompt
// cache, and the next request pays full price for the whole context again. At
// $0 list price that sounds academic; on free-tier capacity it is not, because
// a cache miss still consumes the provider's scarce allocation — the "bill" is
// throttling, not money. Cloudflare's Auto Router makes the same observation:
// within a turn the cache is hot and switching rarely pays.
//
// Verified cache economics (researched 2026-10-08, sources in ADR-0006):
//
//   - Anthropic: cache write 1.25× base input (5-min TTL; 2× for 1-hour),
//     cache read 0.1× — a hit is 90% off. platform.claude.com/docs.
//   - OpenAI: automatic caching, ~50% off cached input tokens, no write premium.
//     developers.openai.com/api/docs/guides/prompt-caching.
//   - Groq — Simorgh's own Shāhīn backend — explicitly documents prompt caching
//     at no additional cost with a **50% discount for cached input tokens**.
//     console.groq.com/docs/prompt-caching.
//   - Gemini caching discount is reported as ~75% off by secondary sources only;
//     **UNVERIFIED** against Google's own pricing page at time of writing.
//
// ── Why the bias *decays* with context ──
//
// Two forces pull in opposite directions, and this module deliberately follows
// the brief over the stronger-sounding one:
//
//   - **Stay** (Cloudflare's framing): the switching penalty grows with context,
//     so a deeper conversation has more to earn back by keeping the same model.
//   - **Yield** (the rule implemented here): as context grows the conversation
//     is also likelier to have *become* real work, and a pinned cheap bird that
//     served the opening pleasantries may be the wrong bird for the 80k-token
//     analysis now in front of it. A pin that never decays is a capability
//     ceiling wearing a cache costume.
//
// So: the bias is 1 for a fresh session and reaches 0 at a reference context
// size, at which point the pin releases and complexity/priority decide. The
// reference is a parameter with a documented default — not a magic number —
// because the right horizon is a deployment fact (a 8k-window bird and a
// 1M-token bird should not share it) and no host should have to fork this file
// to change it.
//
// Off by default at the flock layer: affinity applies only when the host opts in
// via `FlyFlockDeps.routing.session`. A behaviour change on the hot path with no
// flag is how a gateway starts leaking capacity.

/** The host-shaped signal; the host owns the session id, the engine never mints one. */
export interface SessionSignal {
  /** The provider that answered the previous request in this session/turn, if any. */
  previousWinnerId?: string;
  /** Characters of context accumulated in this session so far. */
  contextChars: number;
}

/**
 * The context size at which affinity fully releases. 32k ≈ a quarter of the
 * 128k windows that free-tier flagship models advertise — deep enough that the
 * opening turns are long paid for, shallow enough that a genuine capability
 * mismatch still gets corrected mid-conversation. Deployments that disagree pass
 * their own `refChars`; this constant exists so the default is *findable*, not
 * so it is *authoritative*.
 */
export const SESSION_AFFINITY_REF_CHARS = 32_000;

/**
 * The affinity bias for a context size: linear from 1 (fresh session) to 0
 * (context at or past the reference). Clamped to [0, 1]; a negative or
 * non-finite input reads as "fresh session" (bias 1), because a caller that has
 * not measured its context has not demonstrated a deep one.
 */
export function sessionBias(contextChars: number, refChars: number = SESSION_AFFINITY_REF_CHARS): number {
  if (!Number.isFinite(contextChars) || contextChars <= 0) return 1;
  if (refChars <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - contextChars / refChars));
}

/**
 * The provider id to pin to, or `undefined` when nothing should be pinned.
 *
 * Pinning is deliberately binary at the call site — bias 0 releases the pin
 * entirely — because a partially-decayed pin cannot be expressed as an ordering
 * key without inventing fractional priorities, and fractional priorities would
 * change the meaning of the published `priority` field in `/api/v1/flock/status`.
 */
export function pinnedBySession(signal: SessionSignal | undefined): string | undefined {
  if (!signal || !signal.previousWinnerId) return undefined;
  return sessionBias(signal.contextChars) > 0 ? signal.previousWinnerId : undefined;
}
