import { DurableObject } from "cloudflare:workers";

// ── DataTrustVault Durable Object ─────────────────────────────────
// Immutable transparency ledger for all data-sharing events.
// Every execute call is logged here with userId, tier, and refId.
//
// `DurableObject<Env>` (not bare `DurableObject`) is required for `this.env` to be
// this project's bindings instead of the runtime's empty default. See the RPC note
// in flock.ts — this class crosses the same boundary.
export class DataTrustVault extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // Must block, not `waitUntil`: a request arriving before the CREATE TABLE lands
    // would fail with "no such table: ledger".
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          tier TEXT NOT NULL,
          ref_id TEXT,
          timestamp INTEGER NOT NULL,
          action TEXT,
          details TEXT
        );
      `);
    });
  }

  async logEntry(entry: LogEntry): Promise<LogAck> {
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger (user_id, tier, ref_id, timestamp, action, details) VALUES (?, ?, ?, ?, ?, ?)`,
      entry.userId,
      entry.tier,
      entry.refId,
      entry.timestamp,
      entry.action ?? "execute",
      entry.details ?? "{}"
    );
    return { logged: true };
  }

  async getUserLogs(userId: string): Promise<UserLogs> {
    const rows = [
      ...this.ctx.storage.sql
        .exec<LedgerRow>(
          "SELECT * FROM ledger WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100",
          userId
        )
        .toArray(),
    ];
    return {
      userId,
      entries: rows,
      count: rows.length,
    };
  }
}

// ── RPC types ──────────────────────────────────────────────────────
// Concrete and structured-cloneable. `SELECT *` returns a well-defined column set,
// so spelling it out costs nothing and keeps `Result<R>` from collapsing to `never`.

interface LogEntry {
  userId: string;
  tier: string;
  refId: string;
  timestamp: number;
  action?: string;
  details?: string;
}

interface LogAck {
  logged: boolean;
}

// A `type` alias, not an `interface`: `sql.exec<T>` constrains T to
// `Record<string, SqlStorageValue>`, and only type aliases get an implicit index
// signature. As an interface this is rejected outright.
type LedgerRow = {
  id: number;
  user_id: string;
  tier: string;
  ref_id: string | null;
  timestamp: number;
  action: string | null;
  details: string | null;
};

interface UserLogs {
  userId: string;
  entries: LedgerRow[];
  count: number;
}
