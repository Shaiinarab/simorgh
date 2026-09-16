// Regression tests for the `bird_health` statements.
//
// These exist because the bug they cover was invisible from the outside. The original
// code ran `UPDATE ... WHERE bird_id = ?`, which matches zero rows for any bird that
// has never been seeded — so on a fresh deployment the very first failure of every
// bird was discarded, `total_calls` stayed at 0, and a provider that was down got
// retried on every single request. Nothing threw. Nothing logged. The counters just
// never moved.
//
// `runInDurableObject` gives the callback the object's real `DurableObjectState`, so
// these run against genuine SQLite while the DO is idle — no provider calls, no
// network, and no need to expose a write path on the public RPC surface.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  COOLDOWN_FAILURE_MS,
  COOLDOWN_RATE_LIMIT_MS,
  HEALTH_SCHEMA,
  readAllHealth,
  readCooldown,
  recordObservation,
  sweepStale,
} from "../src/health";

function coordinator() {
  const ns = env.FLOCK_COORDINATOR;
  return ns.get(ns.idFromName(`health-${crypto.randomUUID()}`));
}

/** Run `fn` against a fresh coordinator's real SQL storage. */
function withSql<T>(fn: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(coordinator(), (_instance, state) => fn(state.storage.sql));
}

const NOW = 1_700_000_000_000;

describe("recordObservation — the upsert that the original UPDATE was missing", () => {
  it("records a bird's very first failure instead of discarding it", async () => {
    const cooldown = await withSql((sql) => {
      recordObservation(sql, "shahin", false, false, NOW);
      return readCooldown(sql, "shahin");
    });

    expect(cooldown).toBe(NOW + COOLDOWN_FAILURE_MS);
  });

  it("shows the first failure in the status the dashboard reads", async () => {
    // The other half of the regression: storage alone being right is not enough — the
    // numbers must survive the RPC boundary and show up on /api/v1/flock/status.
    //
    // Recorded against Homā specifically. Shahin and Bulbul carry a `keyEnv`, and this
    // env has no secrets, so their reported status is overridden to 'dormant' — which
    // would mask exactly the field under test.
    const stub = coordinator();
    await runInDurableObject(stub, (_instance, state) => {
      recordObservation(state.storage.sql, "homa", false, false, NOW);
    });

    const homa = (await stub.getFlockStatus()).birds.find((b) => b.id === "homa");
    expect(homa).toMatchObject({
      dormant: false,
      status: "tired",
      consecutiveFailures: 1,
      totalCalls: 1,
      totalFailures: 1,
      cooldownUntil: NOW + COOLDOWN_FAILURE_MS,
    });
  });

  it("accumulates consecutive failures across calls", async () => {
    const row = await withSql((sql) => {
      recordObservation(sql, "bulbul", false, false, NOW);
      recordObservation(sql, "bulbul", false, false, NOW + 1);
      recordObservation(sql, "bulbul", false, false, NOW + 2);
      return sql
        .exec<{ consecutive_failures: number; total_calls: number; total_failures: number }>(
          "SELECT * FROM bird_health WHERE bird_id = ?",
          "bulbul"
        )
        .toArray()[0];
    });

    expect(row.consecutive_failures).toBe(3);
    expect(row.total_calls).toBe(3);
    expect(row.total_failures).toBe(3);
  });

  it("backs off longer for a 429 than for a plain failure", async () => {
    const [plain, limited] = await withSql((sql) => {
      recordObservation(sql, "plain", false, false, NOW);
      recordObservation(sql, "limited", false, true, NOW);
      return [readCooldown(sql, "plain"), readCooldown(sql, "limited")];
    });

    expect(plain).toBe(NOW + COOLDOWN_FAILURE_MS);
    expect(limited).toBe(NOW + COOLDOWN_RATE_LIMIT_MS);
    expect(COOLDOWN_RATE_LIMIT_MS).toBeGreaterThan(COOLDOWN_FAILURE_MS);
  });

  it("clears the failure streak and the cooldown on a success, without losing the totals", async () => {
    const row = await withSql((sql) => {
      recordObservation(sql, "homa", false, false, NOW);
      recordObservation(sql, "homa", true, false, NOW + 10);
      return sql.exec<Record<string, never>>("SELECT * FROM bird_health WHERE bird_id = ?", "homa").toArray()[0] as unknown as {
        status: string;
        consecutive_failures: number;
        cooldown_until: number;
        total_calls: number;
        total_failures: number;
      };
    });

    expect(row.status).toBe("healthy");
    expect(row.consecutive_failures).toBe(0);
    expect(row.cooldown_until).toBe(0);
    expect(row.total_calls).toBe(2);
    expect(row.total_failures).toBe(1);
  });

  it("leaves other birds untouched", async () => {
    const [shahin, homa] = await withSql((sql) => {
      recordObservation(sql, "shahin", false, false, NOW);
      return [readCooldown(sql, "shahin"), readCooldown(sql, "homa")];
    });

    expect(shahin).toBe(NOW + COOLDOWN_FAILURE_MS);
    expect(homa).toBe(0);
  });
});

describe("sweepStale — the daily cron", () => {
  it("changes nothing on an untouched object", async () => {
    expect(await withSql((sql) => sweepStale(sql, NOW))).toBe(0);
  });

  it("clears an expired cooldown so an idle bird stops reading 'tired'", async () => {
    const [changed, row] = await withSql((sql) => {
      recordObservation(sql, "bulbul", false, false, NOW);
      const changed = sweepStale(sql, NOW + COOLDOWN_FAILURE_MS + 1);
      return [changed, readAllHealth(sql)[0]] as const;
    });

    expect(changed).toBe(1);
    expect(row).toMatchObject({
      bird_id: "bulbul",
      status: "healthy",
      consecutive_failures: 0,
      cooldown_until: 0,
    });
    // Totals are a historical record, not live state — the sweep must not rewrite them.
    expect(row.total_calls).toBe(1);
    expect(row.total_failures).toBe(1);
  });

  it("leaves a bird alone while its cooldown is still running", async () => {
    const changed = await withSql((sql) => {
      recordObservation(sql, "bulbul", false, false, NOW);
      return sweepStale(sql, NOW + COOLDOWN_FAILURE_MS - 1);
    });

    expect(changed).toBe(0);
  });

  it("does not touch a bird that is already healthy", async () => {
    const changed = await withSql((sql) => {
      recordObservation(sql, "homa", true, false, NOW);
      return sweepStale(sql, NOW + 1);
    });

    expect(changed).toBe(0);
  });
});

describe("HEALTH_SCHEMA", () => {
  it("is idempotent, so blockConcurrencyWhile can run it on every cold start", async () => {
    const applied = await withSql((sql) => {
      sql.exec(HEALTH_SCHEMA);
      sql.exec(HEALTH_SCHEMA);
      return true;
    });

    expect(applied).toBe(true);
  });
});
