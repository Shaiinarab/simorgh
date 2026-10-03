// Rate limiting: the counter itself, and the headers Simorgh emits about it.
//
// These are split deliberately. The counter is exercised in the workerd suite
// (`test/rate-limit.test.ts`) against a real Durable Object, because the interesting
// question there is concurrency — see `test/durable-concurrency.test.ts` for the 10-way
// race that pins the read-modify-write. What is tested HERE is the reporting, which is
// pure and belongs with the engine.
import { beforeEach, describe, expect, it } from "vitest";

import {
  RATE_LIMIT_SCHEMA,
  consumeRateLimit,
  rateLimitHeaders,
} from "../src/rate-limit.ts";
import { openMemorySql } from "../src/node/index.ts";
import type { SqlPort } from "../src/ports.ts";

const NOW = 1_700_000_000_000;
const WINDOW = 60_000;

let sql: SqlPort;

beforeEach(() => {
  sql = openMemorySql().sql;
  sql.exec(RATE_LIMIT_SCHEMA);
});

describe("consumeRateLimit", () => {
  it("admits up to the limit and then refuses", () => {
    const first = consumeRateLimit(sql, "u1", 3, WINDOW, NOW);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    expect(consumeRateLimit(sql, "u1", 3, WINDOW, NOW).remaining).toBe(1);
    expect(consumeRateLimit(sql, "u1", 3, WINDOW, NOW).remaining).toBe(0);

    const denied = consumeRateLimit(sql, "u1", 3, WINDOW, NOW);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("does not consume quota on a denied request", () => {
    // A refusal that incremented the counter would push the window's reset further out
    // for a user who was already being refused, which is the wrong direction.
    consumeRateLimit(sql, "u1", 1, WINDOW, NOW);
    expect(consumeRateLimit(sql, "u1", 1, WINDOW, NOW).allowed).toBe(false);
    expect(consumeRateLimit(sql, "u1", 1, WINDOW, NOW).allowed).toBe(false);
    expect(consumeRateLimit(sql, "u1", 1, WINDOW, NOW + 1).allowed).toBe(false);
  });

  it("opens a fresh window after reset", () => {
    consumeRateLimit(sql, "u1", 1, WINDOW, NOW);
    expect(consumeRateLimit(sql, "u1", 1, WINDOW, NOW).allowed).toBe(false);

    const nextWindow = consumeRateLimit(sql, "u1", 1, WINDOW, NOW + WINDOW);
    expect(nextWindow.allowed).toBe(true);
    expect(nextWindow.remaining).toBe(0);
  });

  it("keeps keys independent", () => {
    consumeRateLimit(sql, "u1", 1, WINDOW, NOW);
    expect(consumeRateLimit(sql, "u1", 1, WINDOW, NOW).allowed).toBe(false);
    expect(consumeRateLimit(sql, "u2", 1, WINDOW, NOW).allowed).toBe(true);
  });

  it("keeps exactly one live row per key", () => {
    // Without the expired-row delete in `consumeRateLimit`, the table grows one row per
    // user per window forever. This is the assertion that catches its removal.
    for (let i = 0; i < 5; i++) {
      consumeRateLimit(sql, "u1", 100, WINDOW, NOW + i * WINDOW);
    }
    const rows = sql
      .exec<{ n: number } & Record<string, never>>(
        "SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?",
        "u1"
      )
      .toArray()[0];
    expect(rows?.n).toBe(1);
  });
});

// The standardised form is `draft-ietf-httpapi-ratelimit-headers`, an active IETF
// Internet-Draft in the httpapi working group (v11, 2026-05-23, advancing toward RFC;
// it replaces `draft-polli-ratelimit-headers`). It uses RFC 8941 structured fields:
//
//   RateLimit-Policy: "default";q=100;w=60
//   RateLimit: "default";r=15;t=23
//
// Cloudflare has emitted this since September 2025; GitLab, CircleCI and OKX already do.
// The legacy names are still emitted too, because draft-10 drew an HTTPDIR early review
// marked "Not ready" — so the draft is not an RFC and a client that only knows the old
// names must keep working.
describe("rateLimitHeaders", () => {
  // Typed to exactly what `rateLimitHeaders` reads, not to the full `RateLimitDecision`.
  // `allowed` is not a header input, and widening the helper to the whole decision would
  // let a test pass an `allowed` that the function ignores — a test asserting something
  // the code does not do.
  const decision = (
    over: Partial<{ limit: number; remaining: number; resetAt: number }> = {}
  ): { limit: number; remaining: number; resetAt: number } => ({
    limit: 20,
    remaining: 7,
    resetAt: Date.now() + 60_000,
    ...over,
  });

  it("emits RateLimit-Policy with quota and window", () => {
    const headers = rateLimitHeaders(decision());
    // q = quota, w = window seconds.
    expect(headers["RateLimit-Policy"]).toMatch(/^"default";q=20;w=\d+$/);
  });

  it("emits RateLimit with remaining and time to reset", () => {
    const headers = rateLimitHeaders(decision());
    // r = remaining, t = seconds until reset.
    expect(headers.RateLimit).toMatch(/^"default";r=7;t=\d+$/);
  });

  it("still emits the legacy X- names, because the draft is not an RFC", () => {
    const headers = rateLimitHeaders(decision());
    expect(headers["X-RateLimit-Limit"]).toBe("20");
    expect(headers["X-RateLimit-Remaining"]).toBe("7");
    expect(headers["X-RateLimit-Reset"]).toMatch(/^\d+$/);
  });

  it("keeps the two forms in agreement across the whole range", () => {
    // The property that actually matters. A gateway reporting two different quotas is
    // worse than one reporting none, because a client cannot tell which to believe.
    for (const remaining of [0, 1, 19, 20]) {
      const headers = rateLimitHeaders(decision({ remaining }));
      const fromStructured = Number(/r=(\d+)/.exec(headers.RateLimit)![1]);
      expect(headers["X-RateLimit-Remaining"]).toBe(String(fromStructured));
    }
  });

  it("clamps negative remaining to zero in the structured field", () => {
    // A counter that has overshot reports 0, not a negative quota. A client that
    // arithmetically extends a negative budget will believe it has more than it does.
    const headers = rateLimitHeaders(decision({ remaining: -5 }));
    expect(headers.RateLimit).toContain("r=0");
  });

  it("reports a window of at least one second rather than zero", () => {
    // `w=0` reads as "no window", which a client may interpret as unlimited.
    const headers = rateLimitHeaders(decision({ resetAt: Date.now() }));
    expect(headers["RateLimit-Policy"]).toMatch(/;w=[1-9]\d*$/);
  });

  it("never reports a negative time to reset", () => {
    // An already-elapsed window would produce a negative `t`, which is meaningless.
    const headers = rateLimitHeaders(decision({ resetAt: Date.now() - 10_000 }));
    expect(headers.RateLimit).toMatch(/;t=0$/);
  });
});