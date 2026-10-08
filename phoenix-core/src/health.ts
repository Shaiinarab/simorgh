// ── Provider health storage (Swarm-State) ─────────────────────────────────────
//
// These statements are their own module for one reason: they must be testable in
// isolation. The bug that motivated it was invisible from the Durable Object's
// public surface — `UPDATE ... WHERE bird_id = ?` matched zero rows for a provider
// that had never been seeded, so `total_calls` and `cooldown_until` were discarded
// and nothing could ever actually cool down. Nothing failed; the counters just sat
// at zero forever.
//
// The statements take a `SqlPort` instead of reaching for a host's storage handle.
// That is what makes them reachable from a plain unit test with no runtime at all.
//
// Column names keep their original `bird_id`: the table is created with
// `CREATE TABLE IF NOT EXISTS`, so renaming the column would not reach an existing
// deployment's rows and every query against the new name would fail there. The
// *provider* vocabulary is the TypeScript surface; the storage detail stays put.

import type { SqlPort, SqlRow } from "./ports.ts";

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

/** Cooldown after a provider failure. A 429 means "come back later", so it waits. */
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

/** Every provider with a row. Providers never dialled are absent, not zeroed. */
export function readAllHealth(sql: SqlPort): HealthRow[] {
  return [...sql.exec<HealthRow & SqlRow>("SELECT * FROM bird_health").toArray()];
}

/** Epoch ms until which `providerId` should be skipped. `0` when it has no row. */
export function readCooldown(sql: SqlPort, providerId: string): number {
  const row = sql
    .exec<HealthRow & SqlRow>(
      "SELECT cooldown_until FROM bird_health WHERE bird_id = ?",
      providerId
    )
    .toArray()[0];
  return row?.cooldown_until ?? 0;
}

/**
 * Record one observation, upserting.
 *
 * The upsert is the fix, not a style choice. With a plain `UPDATE`, the first
 * observation of any provider matched no row and was silently dropped — so a
 * provider that failed on its very first request was retried on every subsequent
 * one, forever.
 */
export function recordObservation(
  sql: SqlPort,
  providerId: string,
  ok: boolean,
  isRateLimit: boolean,
  now: number
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
      providerId,
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
    providerId,
    now + cooldownFor(isRateLimit)
  );
}

/**
 * Sweep: a cooldown that has run out means the provider is available again, so
 * expire the streak and stop reporting it as `tired`. Returns rows changed.
 *
 * This only runs in the background, which is the point: at request time a provider
 * is already skipped while `cooldown_until > now`, but nothing would ever clear the
 * row. A provider that failed once and was then never called again — the common case
 * for the two secret-gated providers — would read `tired` on the dashboard for good.
 */
export function sweepStale(sql: SqlPort, now: number): number {
  return sql.exec(
    `UPDATE bird_health
        SET status = 'healthy', consecutive_failures = 0, cooldown_until = 0
      WHERE cooldown_until > 0
        AND cooldown_until <= ?`,
    now
  ).rowsWritten;
}
