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

export function consumeRateLimit(
  sql: SqlStorage,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitDecision {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;

  sql.exec(
    "DELETE FROM rate_limits WHERE key = ? AND window_start < ?",
    key,
    windowStart
  );

  const row = sql
    .exec<{ count: number; window_start: number }>(
      "SELECT count, window_start FROM rate_limits WHERE key = ?",
      key
    )
    .toArray()[0];

  if (!row || row.window_start !== windowStart) {
    sql.exec(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1",
      key,
      windowStart
    );
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - 1),
      resetAt,
    };
  }

  if (row.count >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt };
  }

  const nextCount = row.count + 1;
  sql.exec("UPDATE rate_limits SET count = ? WHERE key = ?", nextCount, key);
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - nextCount),
    resetAt,
  };
}
