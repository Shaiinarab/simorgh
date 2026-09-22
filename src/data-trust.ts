import { DurableObject } from "cloudflare:workers";
import {
  createLedger,
  ensureLedgerSchema,
  type LedgerEntry,
  type LedgerPort,
  type UserLogs,
} from "@simorgh/phoenix-core";

// ── DataTrustVault Durable Object ─────────────────────────────────
// Immutable transparency ledger for all data-sharing events.
// Every execute call is logged here with userId, tier, and refId.
//
// `DurableObject<Env>` (not bare `DurableObject`) is required for `this.env` to be
// this project's bindings instead of the runtime's empty default. See the RPC note
// in flock.ts — this class crosses the same boundary.
//
// ── What changed, and why it is smaller ──
//
// This class used to carry its own `CREATE TABLE`, its own INSERT, and its own SELECT.
// They were byte-identical to the ones in the Node host, because the ledger lived behind
// phoenix-core's `/node` subpath and a Worker must never import a `node:` module — so the
// only way to run this SQL here was to copy it.
//
// The ledger is now in phoenix-core's *main* barrel, because the only thing it needs is a
// `SqlPort`, and `this.ctx.storage.sql` **is** one — structurally, with no adapter. So this
// Durable Object is what it should always have been: a host binding for the port. The
// class survives because Durable Object RPC needs a named class with RPC-shaped methods;
// the *logic* lives in the core, once.
//
// The ledger being append-only is still enforced by the core, not by this file.

export class DataTrustVault extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // Must block, not `waitUntil`: a request arriving before the CREATE TABLE lands
    // would fail with "no such table: ledger".
    this.ctx.blockConcurrencyWhile(async () => {
      ensureLedgerSchema(this.ctx.storage.sql);
    });
  }

  /**
   * A ledger bound to this object's storage.
   *
   * A getter rather than a field: `createLedger` only closes over the `SqlPort` and holds
   * no state, so there is nothing here worth caching — and a field would have to survive
   * the Durable Object's hibernation, which it cannot.
   */
  private get ledger(): LedgerPort {
    return createLedger(this.ctx.storage.sql);
  }

  async logEntry(entry: LedgerEntry): Promise<{ logged: boolean }> {
    return this.ledger.logEntry(entry);
  }

  async getUserLogs(userId: string): Promise<UserLogs> {
    return this.ledger.getUserLogs(userId);
  }
}
