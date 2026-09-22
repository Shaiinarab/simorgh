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
