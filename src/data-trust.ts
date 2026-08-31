import { DurableObject } from "cloudflare:workers";

// ── DataTrustVault Durable Object ─────────────────────────────────
// Immutable transparency ledger for all data-sharing events.
// Every execute call is logged here with userId, tier, and refId.
export class DataTrustVault extends DurableObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.waitUntil(
      (async () => {
        await this.state.storage.sql.exec(`
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
      })()
    );
  }

  async logEntry(entry: {
    userId: string;
    tier: string;
    refId: string;
    timestamp: number;
    action?: string;
    details?: string;
  }) {
    this.state.storage.sql.exec(
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

  async getUserLogs(userId: string) {
    const rows = [
      ...this.state.storage.sql
        .exec("SELECT * FROM ledger WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100", userId)
        .toArray(),
    ];
    return {
      userId,
      entries: rows,
      count: rows.length,
    };
  }
}
