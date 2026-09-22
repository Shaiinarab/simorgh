// The health and rate-limit statements, exercised against real SQLite through the
// Node `SqlPort` — same code the Worker runs against Durable Object storage, no
// Durable Object required. Both modules exist because their bugs were invisible from
// a host's public surface; testing them through a host would reintroduce that.
import { beforeEach, describe, expect, it } from "vitest";

import {
  COOLDOWN_FAILURE_MS,
  COOLDOWN_RATE_LIMIT_MS,
  HEALTH_SCHEMA,
  cooldownFor,
  readAllHealth,
  readCooldown,
  recordObservation,
  sweepStale,
} from "../src/health.ts";
import { RATE_LIMIT_SCHEMA, consumeRateLimit } from "../src/rate-limit.ts";
import { openMemorySql } from "../src/node/index.ts";
import type { SqlPort } from "../src/ports.ts";

const NOW = 1_700_000_000_000;

let sql: SqlPort;

beforeEach(() => {
  sql = openMemorySql().sql;
  sql.exec(HEALTH_SCHEMA);
  sql.exec(RATE_LIMIT_SCHEMA);
});

describe("health", () => {
  it("records the very first observation of a provider", () => {
    // The bug this module was written for: a plain UPDATE matched no row for a
    // provider that had never been seeded, so its first failure was discarded and it
    // was retried forever. The upsert is the fix.
    recordObservation(sql, "fresh", false, false, NOW);

    expect(readAllHealth(sql)).toEqual([
      {
        bird_id: "fresh",
        status: "tired",
        consecutive_failures: 1,
        cooldown_until: NOW + COOLDOWN_FAILURE_MS,
        last_ok: 0,
        total_calls: 1,
        total_failures: 1,
      },
    ]);
  });

  it("backs off longer for a rate limit than for a generic failure", () => {
    expect(cooldownFor(true)).toBe(COOLDOWN_RATE_LIMIT_MS);
    expect(cooldownFor(false)).toBe(COOLDOWN_FAILURE_MS);

    recordObservation(sql, "limited", false, true, NOW);
    expect(readCooldown(sql, "limited")).toBe(NOW + COOLDOWN_RATE_LIMIT_MS);
  });

  it("accumulates failures and clears them on the next success", () => {
    recordObservation(sql, "flaky", false, false, NOW);
    recordObservation(sql, "flaky", false, false, NOW + 1);
    expect(readAllHealth(sql)[0]).toMatchObject({
      consecutive_failures: 2,
      total_calls: 2,
      total_failures: 2,
      status: "tired",
    });

    recordObservation(sql, "flaky", true, false, NOW + 2);
    expect(readAllHealth(sql)[0]).toMatchObject({
      status: "healthy",
      consecutive_failures: 0,
      cooldown_until: 0,
      last_ok: NOW + 2,
      total_calls: 3,
      total_failures: 2,
    });
  });

  it("reports no cooldown for a provider that has never been dialled", () => {
    expect(readCooldown(sql, "unknown")).toBe(0);
  });

  it("sweeps only cooldowns that have expired", () => {
    recordObservation(sql, "expired", false, false, NOW);
    recordObservation(sql, "active", false, true, NOW);

    const changed = sweepStale(sql, NOW + COOLDOWN_FAILURE_MS);
    expect(changed).toBe(1);

    const rows = readAllHealth(sql);
    expect(rows.find((r) => r.bird_id === "expired")).toMatchObject({
      status: "healthy",
      consecutive_failures: 0,
      cooldown_until: 0,
    });
    // Still inside its 60s window: untouched.
    expect(rows.find((r) => r.bird_id === "active")).toMatchObject({ status: "tired" });
  });
});

describe("rate limiting", () => {
  it("allows up to the limit and then refuses until the window rolls", () => {
    const decision1 = consumeRateLimit(sql, "execute:u1", 3, 60_000, NOW);
    expect(decision1).toMatchObject({ allowed: true, remaining: 2 });

    const decision2 = consumeRateLimit(sql, "execute:u1", 3, 60_000, NOW + 1);
    expect(decision2).toMatchObject({ allowed: true, remaining: 1 });

    const decision3 = consumeRateLimit(sql, "execute:u1", 3, 60_000, NOW + 2);
    expect(decision3).toMatchObject({ allowed: true, remaining: 0 });

    const refused = consumeRateLimit(sql, "execute:u1", 3, 60_000, NOW + 3);
    expect(refused).toMatchObject({ allowed: false, remaining: 0 });
    expect(refused.resetAt).toBe(Math.floor(NOW / 60_000) * 60_000 + 60_000);
  });

  it("starts a fresh window once the boundary passes", () => {
    consumeRateLimit(sql, "execute:u1", 1, 60_000, NOW);
    expect(consumeRateLimit(sql, "execute:u1", 1, 60_000, NOW + 1).allowed).toBe(false);

    const nextWindow = consumeRateLimit(sql, "execute:u1", 1, 60_000, NOW + 60_000);
    expect(nextWindow).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("keys independently per user", () => {
    consumeRateLimit(sql, "execute:u1", 1, 60_000, NOW);
    expect(consumeRateLimit(sql, "execute:u2", 1, 60_000, NOW).allowed).toBe(true);
  });

  it("does not grow a row per window", () => {
    for (let i = 0; i < 10; i++) {
      consumeRateLimit(sql, "execute:u1", 5, 60_000, NOW + i * 60_000);
    }
    const rows = sql.exec("SELECT key FROM rate_limits").toArray();
    expect(rows).toHaveLength(1);
  });
});
