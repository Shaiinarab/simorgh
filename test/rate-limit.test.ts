import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_SCHEMA, consumeRateLimit } from "../src/rate-limit";

const withSql = <T>(fn: (sql: SqlStorage) => T) => runInDurableObject(env.FLOCK_COORDINATOR.get(env.FLOCK_COORDINATOR.idFromName("rate-" + crypto.randomUUID())), (_i, state) => fn(state.storage.sql));
const NOW = 1_700_000_000_000;

describe("consumeRateLimit", () => {
  it("allows the configured number and then blocks", async () => {
    const d = await withSql((sql) => { sql.exec(RATE_LIMIT_SCHEMA); return [consumeRateLimit(sql, "a", 2, 60000, NOW), consumeRateLimit(sql, "a", 2, 60000, NOW + 1), consumeRateLimit(sql, "a", 2, 60000, NOW + 2)]; });
    expect(d.map((x) => x.allowed)).toEqual([true, true, false]);
  });
  it("opens a fresh window after reset", async () => {
    const d = await withSql((sql) => { sql.exec(RATE_LIMIT_SCHEMA); const first = consumeRateLimit(sql, "a", 1, 60000, NOW); return consumeRateLimit(sql, "a", 1, 60000, first.resetAt); });
    expect(d.allowed).toBe(true);
  });
  it("isolates keys", async () => {
    const d = await withSql((sql) => { sql.exec(RATE_LIMIT_SCHEMA); return [consumeRateLimit(sql, "a", 1, 60000, NOW), consumeRateLimit(sql, "b", 1, 60000, NOW), consumeRateLimit(sql, "a", 1, 60000, NOW + 1)]; });
    expect(d.map((x) => x.allowed)).toEqual([true, true, false]);
  });
});
