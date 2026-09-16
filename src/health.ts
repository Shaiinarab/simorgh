// ── bird_health storage ────────────────────────────────────────────
//
// The health table lives here rather than inside the Durable Object for one reason:
// these statements must be testable on their own. The bug that motivated the module
// was invisible from the DO's public surface — `UPDATE ... WHERE bird_id = ?` matched
// zero rows for any bird that had never been seeded, so `total_calls` and
// `cooldown_until` were discarded and no bird could ever actually cool down. Nothing
// failed; the counters just stayed at zero forever.
//
// Taking `SqlStorage` as an argument instead of reaching for `this.ctx` is what makes
// that reachable from a test: `runInDurableObject` hands out a real `state`, so these
// run against real SQLite without a Durable Object method call — and without Homā
// dialling Workers AI.
//
// Rows are `type` aliases, not `interface`s: `sql.exec<T>` constrains T to
// `Record<string, SqlStorageValue>`, and only type aliases receive an implicit index
// signature.

/** One row of `bird_health`. */
export type HealthRow = {
  bird_id: string;
  status: string;
  consecutive_failures: number;
  cooldown_until: number;
  last_ok: number;
  total_calls: number;
  total_failures: number;
};

/** Cooldown applied after a provider failure, in ms. A 429 backs off longer. */
export const COOLDOWN_RATE_LIMIT_MS = 60_000;
export const COOLDOWN_FAILURE_MS = 15_000;

export const HEALTH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bird_health (
    bird_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'healthy',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    last_ok INTEGER NOT NULL DEFAULT 0,
    total_calls INTEGER NOT NULL DEFAULT 0,
    total_failures INTEGER NOT NULL DEFAULT 0
  );
`;

export function cooldownFor(isRateLimit: boolean): number {
  return isRateLimit ? COOLDOWN_RATE_LIMIT_MS : COOLDOWN_FAILURE_MS;
}

/** Every known bird, keyed by id. Birds that have never been called are absent. */
export function readAllHealth(sql: SqlStorage): HealthRow[] {
  return [...sql.exec<HealthRow>("SELECT * FROM bird_health").toArray()];
}

/** Epoch ms until which `birdId` should be skipped. 0 when it has no row yet. */
export function readCooldown(sql: SqlStorage, birdId: string): number {
  const row = sql
    .exec<HealthRow>("SELECT cooldown_until FROM bird_health WHERE bird_id = ?", birdId)
    .toArray()[0];
  return row?.cooldown_until ?? 0;
}

/**
 * Record one observation, upserting.
 *
 * The upsert is the fix, not a style choice. With a plain `UPDATE`, the first
 * observation of any bird matched no row and was silently dropped — so a provider
 * that failed on its very first request was retried on every subsequent one, forever.
 */
export function recordObservation(
  sql: SqlStorage,
  birdId: string,
  ok: boolean,
  isRateLimit: boolean,
  now: number = Date.now()
): void {
  if (ok) {
    sql.exec(
      `INSERT INTO bird_health
         (bird_id, status, consecutive_failures, cooldown_until, last_ok, total_calls, total_failures)
       VALUES (?, 'healthy', 0, 0, ?, 1, 0)
       ON CONFLICT(bird_id) DO UPDATE SET
         status = 'healthy',
         consecutive_failures = 0,
         cooldown_until = 0,
         last_ok = excluded.last_ok,
         total_calls = bird_health.total_calls + 1`,
      birdId,
      now
    );
    return;
  }
  sql.exec(
    `INSERT INTO bird_health
       (bird_id, status, consecutive_failures, cooldown_until, last_ok, total_calls, total_failures)
     VALUES (?, 'tired', 1, ?, 0, 1, 1)
     ON CONFLICT(bird_id) DO UPDATE SET
       status = 'tired',
       consecutive_failures = bird_health.consecutive_failures + 1,
       cooldown_until = excluded.cooldown_until,
       total_calls = bird_health.total_calls + 1,
       total_failures = bird_health.total_failures + 1`,
    birdId,
    now + cooldownFor(isRateLimit)
  );
}

/**
 * Daily sweep: a cooldown that has run out means the bird is available again, so
 * expire the streak and stop reporting it as 'tired'. Returns rows changed.
 *
 * This only runs in the background, which is the point: at request time a bird is
 * already skipped while `cooldown_until > now`, but nothing would ever clear the row.
 * A bird that failed once and was then never called again — the common case for the
 * two secret-gated birds — would read 'tired' on the dashboard for good.
 *
 * An earlier version of this also tried to retire birds past a failure threshold. That
 * branch was dead on arrival: `recordObservation` already writes 'tired' on the first
 * failure, so `WHERE status != 'tired'` could never match. Removed rather than left
 * sitting there looking meaningful.
 */
export function sweepStale(sql: SqlStorage, now: number): number {
  return sql.exec(
    `UPDATE bird_health
        SET status = 'healthy', consecutive_failures = 0, cooldown_until = 0
      WHERE cooldown_until > 0
        AND cooldown_until <= ?`,
    now
  ).rowsWritten;
}
