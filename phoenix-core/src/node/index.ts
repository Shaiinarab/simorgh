// ── The Node host adapter ─────────────────────────────────────────────────────
//
// phoenix-core ships its own Node bindings, as a *subpath* export
// (`@simorgh/phoenix-core/node`) rather than from the main barrel. That asymmetry is
// deliberate: a Cloudflare Worker importing the main barrel must never pull
// `node:sqlite` into its bundle, and this file is the only place in the package that
// names a `node:` module.
//
// With this, the same engine that answers on the edge answers in a plain Node
// process — real SQLite, real crypto, real fetch. No adapter layer, no shim.

import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  ContextStorePort,
  PhoenixPorts,
  SqlCursor,
  SqlPort,
  SqlRow,
  SqlValue,
} from "../ports.ts";

/**
 * Statements that return rows. `node:sqlite` exposes reads (`all()`) and writes
 * (`run()`) as separate calls, while Cloudflare's `SqlStorage.exec` fuses them into
 * one — this is the single place the two dialects differ, so it is bridged here
 * rather than at every call site.
 *
 * ponytail: a leading-keyword sniff, which is ample for the four statements the
 * engine issues. If a future statement needs `RETURNING`, switch to `all()` plus a
 * `changes` read; no caller changes either way.
 */
const RETURNS_ROWS = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i;

export function nodeSqlPort(db: DatabaseSync): SqlPort {
  return {
    exec<T extends SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      const statement = db.prepare(query);
      // `ArrayBuffer` is a legal `SqlValue` but not a legal `node:sqlite` binding, so
      // it is converted rather than cast away.
      const args = bindings.map((b) =>
        b instanceof ArrayBuffer ? new Uint8Array(b) : b
      ) as never[];

      if (RETURNS_ROWS.test(query)) {
        const rows = statement.all(...args) as T[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const result = statement.run(...args);
      return { toArray: () => [], rowsWritten: Number(result.changes) };
    },
  };
}

/** Open an in-memory SQLite database and wrap it as a `SqlPort`. */
export function openMemorySql(): { sql: SqlPort; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return { sql: nodeSqlPort(db), db };
}

/**
 * The Node bindings for every `PhoenixPorts` member.
 *
 * `overrides` exists so a test can freeze the clock or point `fetch` at a stub
 * without reimplementing the rest.
 */
export function createNodePorts(overrides: Partial<PhoenixPorts> = {}): PhoenixPorts {
  return {
    fetch: (url, init) => fetch(url, init as RequestInit),
    sha256: async (value) =>
      new Uint8Array(createHash("sha256").update(value, "utf8").digest()),
    randomUUID: () => randomUUID(),
    now: () => Date.now(),
    ...overrides,
  };
}

/**
 * An in-process context store with TTL eviction.
 *
 * The engine only ever needs to hand back what it just put in, and a self-hosted
 * core is a single process — so a Map is the honest implementation. A host that
 * wants durability across restarts passes its own port instead.
 */
export function memoryContextStore(now: () => number = Date.now): ContextStorePort {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  return {
    async put(key, value, options) {
      entries.set(key, {
        value,
        expiresAt: now() + (options?.expirationTtl ?? 3_600) * 1_000,
      });
    },
    async get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return hit.value;
    },
  };
}

// ── The ledger is no longer defined here ──
//
// It used to be, and that was the wrong home: its only dependency is a `SqlPort`, which
// Cloudflare's `SqlStorage` satisfies exactly as well as `node:sqlite` does. Because this file
// is only reachable through the `/node` subpath, the Cloudflare Durable Object could not
// import it — so `src/data-trust.ts` carried a second copy of the same `CREATE TABLE`, the
// same insert, and the same read. Two definitions, nothing comparing them.
//
// It now lives in the main barrel (`../ledger.ts`) and is re-exported here so that anything
// reaching for `@simorgh/phoenix-core/node` keeps working. `sqlLedger` stays as an alias
// because that was the published name.
export {
  createLedger,
  createLedger as sqlLedger,
  ensureLedgerSchema,
  LEDGER_SCHEMA,
  LEDGER_PAGE_LIMIT,
} from "../ledger.ts";

export type { DatabaseSync };
