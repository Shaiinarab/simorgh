// ── The transparency ledger ───────────────────────────────────────────────────
//
// The Data Trust contract, as code: every request that a core handles is written
// down — who asked, under which tier, and what it was allowed to do — before the
// flock is dialled. That ordering is deliberate and lives in `execute.ts`: the
// record must exist even when every provider is down, because "this request
// happened" is not contingent on whether it succeeded.
//
// ── Why this is in the main barrel, not behind `/node` ──
//
// It started life inside `src/node/index.ts`, which was the wrong home. The ledger
// needs exactly one thing — a `SqlPort` — and a `SqlPort` is by definition not a
// Node thing: Cloudflare's `SqlStorage` satisfies it, `node:sqlite` satisfies it,
// and a test stub satisfies it. Sitting behind the `/node` subpath meant the
// Cloudflare Durable Object *could not* import it, so `src/data-trust.ts` kept its
// own copy of this same SQL — a copy that would have drifted silently, because
// nothing compared the two.
//
// `CREATE TABLE` text, the insert, the read, and the 100-row cap now have one
// definition. The `/node` subpath still re-exports them, so nothing that reached
// for `@simorgh/phoenix-core/node` breaks.

import type { LedgerEntry, LedgerPort, LedgerRow, SqlPort, SqlRow } from "./ports.ts";

/**
 * The ledger table.
 *
 * Applied by whichever host opens the database. `id` is an autoincrement primary key
 * rather than a caller-supplied id so the ledger cannot be rewritten from outside —
 * there is no path that updates or deletes a row, by design.
 */
export const LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    ref_id TEXT,
    timestamp INTEGER NOT NULL,
    action TEXT,
    details TEXT
  );
`;

/** Newest-first page size for `getUserLogs`. */
export const LEDGER_PAGE_LIMIT = 100;

/**
 * The action vocabulary.
 *
 * `action` is deliberately an unconstrained `TEXT` column, and that is now load-bearing
 * rather than merely permissive: it is what lets a *third* kind of row exist alongside the
 * request record, without a migration and without widening the column every time the
 * pipeline learns a new thing worth writing down. `ledger.test.ts` already pins that an
 * arbitrary action (`"ask"`) round-trips, and `getUserLogs` filters on nothing — it
 * `SELECT *`s and hands every row back — so an action nobody has seen at read time is
 * returned verbatim like any other, and `/api/v1/user/{id}/logs` needs no change to show it.
 *
 * So this is an additive vocabulary, not an enum:
 *
 *   * `"execute"` — the request record. Written *before* the flock is dialled; see the
 *     header comment and `execute.ts`. Still the default when no action is supplied.
 *   * `SHIELD_BLOCK_ACTION` — the model-output shield fired: something was neutralised on
 *     the way back. Written *after* the flight, because that fact does not exist until an
 *     answer comes back, and writing it for every request would mean recording a
 *     speculative row that is wrong almost every time.
 *
 * The asymmetry is the whole design, and it is why the request row keeps its place: "this
 * request happened and here is what it was allowed to do" must hold even when every provider
 * is down, while "the shield caught something" plainly cannot hold when nothing answered.
 */
export const SHIELD_BLOCK_ACTION = "shield_block";

/**
 * The ledger on any `SqlPort`.
 *
 * Append-only: `logEntry` inserts, `getUserLogs` reads, and there is deliberately no
 * update or delete. A ledger you can edit is not a ledger.
 *
 * `LedgerRow & SqlRow` rather than `LedgerRow` alone: the port constrains its row type
 * to `SqlRow`, and intersecting keeps the explicit columns visible to callers while
 * satisfying the port. Same trick as every other row type in this package.
 */
export function createLedger(sql: SqlPort): LedgerPort {
  return {
    async logEntry(entry: LedgerEntry) {
      sql.exec(
        "INSERT INTO ledger (user_id, tier, ref_id, timestamp, action, details) VALUES (?, ?, ?, ?, ?, ?)",
        entry.userId,
        entry.tier,
        entry.refId,
        entry.timestamp,
        entry.action ?? "execute",
        entry.details ?? "{}"
      );
      return { logged: true };
    },

    async getUserLogs(userId) {
      const entries = sql
        .exec<LedgerRow & SqlRow>(
          `SELECT * FROM ledger WHERE user_id = ? ORDER BY timestamp DESC LIMIT ${LEDGER_PAGE_LIMIT}`,
          userId
        )
        .toArray();
      return { userId, entries, count: entries.length };
    },
  };
}

/**
 * Apply the schema.
 *
 * A separate call from `createLedger` because hosts apply schema at different moments:
 * the Node host opens the database at boot, and a Durable Object must block on it
 * inside its constructor so a request arriving a millisecond later does not meet a
 * missing table. Fusing the two would force one host's timing on the other.
 */
export function ensureLedgerSchema(sql: SqlPort): void {
  sql.exec(LEDGER_SCHEMA);
}
