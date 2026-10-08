// ── Per-key rate limiting ─────────────────────────────────────────────────────
//
// A fixed window counter in SQL. Fixed windows are the lazy correct choice here:
// the workload is one limit per user per minute, the failure mode of an edge-heavy
// window is a user briefly getting two windows' worth of requests, and a sliding
// window would cost a scan per request. A token bucket would buy smoothness nobody
// asked for.
//
// `now` is a parameter, not a call to `Date.now()`, so a test can drive the window
// boundary directly.

import type { SqlPort, SqlRow } from "./ports.ts";

export const RATE_LIMIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
`;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

type RateLimitRow = {
  count: number;
  window_start: number;
};

export function consumeRateLimit(
  sql: SqlPort,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): RateLimitDecision {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;

  // Drop this key's expired rows before reading. Without it the table grows one row
  // per user forever; with it, a key keeps exactly one live row.
  sql.exec("DELETE FROM rate_limits WHERE key = ? AND window_start < ?", key, windowStart);

  const row = sql
    .exec<RateLimitRow & SqlRow>(
      "SELECT count, window_start FROM rate_limits WHERE key = ?",
      key
    )
    .toArray()[0];

  // No row, or a row from an older window: start this window at 1.
  if (!row || row.window_start !== windowStart) {
    sql.exec(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1",
      key,
      windowStart
    );
    return { allowed: true, limit, remaining: Math.max(0, limit - 1), resetAt };
  }

  if (row.count >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt };
  }

  const nextCount = row.count + 1;
  sql.exec("UPDATE rate_limits SET count = ? WHERE key = ?", nextCount, key);
  return { allowed: true, limit, remaining: Math.max(0, limit - nextCount), resetAt };
}

/**
 * Rate-limit response headers, in BOTH the standardised and the legacy form.
 *
 * The standardised form comes from `draft-ietf-httpapi-ratelimit-headers`, an active
 * IETF Internet-Draft in the httpapi working group (v11, 2026-05-23, advancing toward
 * RFC; it replaces `draft-polli-ratelimit-headers`). It uses RFC 8941 structured fields:
 *
 *   RateLimit-Policy: "default";q=100;w=60
 *   RateLimit: "default";r=15;t=23
 *
 * where `q` is the quota, `w` the window in seconds, `r` what remains and `t` seconds to
 * reset. Cloudflare has emitted this since September 2025 and GitLab, CircleCI and OKX
 * already send it.
 *
 * The legacy `X-RateLimit-*` headers are still emitted alongside it, deliberately. The
 * draft is not an RFC yet — draft-10 drew an HTTPDIR early review marked "Not ready" —
 * so a client that only understands the old names must keep working. Both forms are
 * computed from one decision so they cannot disagree, which is the failure that matters:
 * a gateway reporting two different quotas is worse than one reporting none.
 *
 * `Retry-After` is separate and is RFC 9110, not this draft; it is emitted only when the
 * request is actually denied.
 */
export function rateLimitHeaders(decision: {
  limit: number;
  remaining: number;
  resetAt: number;
}): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = Math.max(1, Math.ceil((decision.resetAt - now * 1000) / 1000));
  // RFC 8941 integers carry no fractional part. `resetAt / 1000 - now` emitted
  // `t=60.7960000038147` for a window of a minute, which is not a valid integer member
  // and which a strict client must reject as a malformed field — turning a helpful header
  // into a dropped one. Ceiling is the right rounding for a countdown: rounding down
  // would tell a client to retry before the window is actually over.
  const secondsToReset = Math.max(0, Math.ceil(decision.resetAt / 1000) - now);
  return {
    "RateLimit-Policy": `"default";q=${decision.limit};w=${windowSeconds}`,
    RateLimit: `"default";r=${Math.max(0, decision.remaining)};t=${secondsToReset}`,
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(Math.ceil(decision.resetAt / 1000)),
  };
}
