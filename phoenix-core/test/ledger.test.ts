// The ledger, now that it is in the main barrel.
//
// It moved here from `src/node/index.ts`, and the move is only worth anything if it is
// *actually* shared: the Cloudflare Durable Object imports it from the main barrel while
// the Node host reaches it through the `/node` subpath. So these tests run the ledger on
// a `SqlPort`, and separately assert that the subpath export is the same function — a
// re-export that silently became a copy would defeat the entire exercise.
import { beforeEach, describe, expect, it } from "vitest";

import {
  LEDGER_PAGE_LIMIT,
  LEDGER_SCHEMA,
  createLedger,
  ensureLedgerSchema,
} from "../src/ledger.ts";
import { openMemorySql, sqlLedger } from "../src/node/index.ts";
import type { LedgerPort, SqlPort } from "../src/ports.ts";

const NOW = 1_700_000_000_000;

let sql: SqlPort;
let ledger: LedgerPort;

beforeEach(() => {
  sql = openMemorySql().sql;
  ensureLedgerSchema(sql);
  ledger = createLedger(sql);
});

describe("the schema", () => {
  it("is idempotent — applied twice, it does not throw", () => {
    expect(() => ensureLedgerSchema(sql)).not.toThrow();
  });

  it("matches the shape the Durable Object used to create by hand", () => {
    const columns = sql
      .exec<{ name: string }>("PRAGMA table_info(ledger)")
      .toArray()
      .map((row) => row.name);
    expect(columns).toEqual([
      "id",
      "user_id",
      "tier",
      "ref_id",
      "timestamp",
      "action",
      "details",
    ]);
  });

  it("is what a host reads when it applies the schema itself", () => {
    // A host may prefer the raw DDL over `ensureLedgerSchema`; both must agree.
    expect(LEDGER_SCHEMA).toContain("CREATE TABLE IF NOT EXISTS ledger");
    expect(LEDGER_SCHEMA).toContain("AUTOINCREMENT");
  });
});

describe("logEntry", () => {
  it("acknowledges the write", async () => {
    await expect(
      ledger.logEntry({ userId: "u1", tier: "free", refId: "r1", timestamp: NOW })
    ).resolves.toEqual({ logged: true });
  });

  it("defaults action and details rather than storing nulls", async () => {
    await ledger.logEntry({ userId: "u1", tier: "free", refId: "r1", timestamp: NOW });
    const logs = await ledger.getUserLogs("u1");
    expect(logs.entries[0]?.action).toBe("execute");
    expect(logs.entries[0]?.details).toBe("{}");
  });

  it("keeps the caller's action and details when given", async () => {
    await ledger.logEntry({
      userId: "u1",
      tier: "pro",
      refId: "r1",
      timestamp: NOW,
      action: "ask",
      details: '{"requestId":"abc"}',
    });
    const logs = await ledger.getUserLogs("u1");
    expect(logs.entries[0]).toMatchObject({ action: "ask", details: '{"requestId":"abc"}' });
  });

  it("appends — every call is a new row, none overwritten", async () => {
    await ledger.logEntry({ userId: "u1", tier: "free", refId: "r1", timestamp: NOW });
    await ledger.logEntry({ userId: "u1", tier: "free", refId: "r2", timestamp: NOW + 1 });
    await ledger.logEntry({ userId: "u1", tier: "free", refId: "r3", timestamp: NOW + 2 });
    expect((await ledger.getUserLogs("u1")).count).toBe(3);
  });
});

describe("getUserLogs", () => {
  beforeEach(async () => {
    await ledger.logEntry({ userId: "u1", tier: "free", refId: "oldest", timestamp: NOW });
    await ledger.logEntry({ userId: "u1", tier: "free", refId: "newest", timestamp: NOW + 10 });
    await ledger.logEntry({ userId: "u2", tier: "pro", refId: "other-user", timestamp: NOW + 5 });
  });

  it("is scoped to one user — another user's entries never appear", async () => {
    const logs = await ledger.getUserLogs("u1");
    expect(logs.count).toBe(2);
    expect(logs.entries.map((e) => e.ref_id)).toEqual(["newest", "oldest"]);
  });

  it("is newest-first", async () => {
    const logs = await ledger.getUserLogs("u1");
    expect(logs.entries[0]?.timestamp).toBeGreaterThan(logs.entries[1]?.timestamp ?? 0);
  });

  it("echoes the user id it was asked about", async () => {
    expect((await ledger.getUserLogs("nobody")).userId).toBe("nobody");
  });

  it("answers with an empty ledger rather than throwing for a stranger", async () => {
    await expect(ledger.getUserLogs("nobody")).resolves.toEqual({
      userId: "nobody",
      entries: [],
      count: 0,
    });
  });

  it("caps the page so a long-lived user cannot return an unbounded result", async () => {
    for (let i = 0; i < LEDGER_PAGE_LIMIT + 5; i++) {
      await ledger.logEntry({
        userId: "heavy",
        tier: "free",
        refId: `r${i}`,
        timestamp: NOW + i,
      });
    }
    const logs = await ledger.getUserLogs("heavy");
    expect(logs.count).toBe(LEDGER_PAGE_LIMIT);
    // The cap must keep the *newest* rows: the transparency contract is about recent
    // activity, and a page of the oldest 100 rows would answer the wrong question.
    expect(logs.entries[0]?.ref_id).toBe(`r${LEDGER_PAGE_LIMIT + 4}`);
  });
});

describe("the /node subpath re-export", () => {
  it("is the same function, not a second copy", () => {
    // This is the whole point of moving it. `src/node/index.ts` used to *define* the
    // ledger, which is why the Cloudflare Durable Object could not use it and kept its
    // own SQL instead. If this identity ever breaks, the duplication is back.
    expect(sqlLedger).toBe(createLedger);
  });

  it("still works through the subpath a host already imports", async () => {
    const viaSubpath = sqlLedger(sql);
    await viaSubpath.logEntry({ userId: "u9", tier: "free", refId: "r9", timestamp: NOW });
    const logs = await viaSubpath.getUserLogs("u9");
    expect(logs.entries[0]?.ref_id).toBe("r9");
  });
});
