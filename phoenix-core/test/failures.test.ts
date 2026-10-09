// The one definition of "rate limit", pinned — and the cooldown split it
// drives, asserted end-to-end through health.cooldownFor so a future edit to
// either module has to fail here rather than silently bench birds for the
// wrong duration.
import { describe, expect, it } from "vitest";

import { isRateLimitError } from "../src/failures.ts";
import {
  COOLDOWN_FAILURE_MS,
  COOLDOWN_RATE_LIMIT_MS,
  cooldownFor,
} from "../src/health.ts";

describe("isRateLimitError", () => {
  it("matches the literal the providers emit", () => {
    expect(isRateLimitError("rate_limit")).toBe(true);
  });

  // The negative this test exists for: a *thrown* transport error whose text
  // happens to contain 429. provider.ts matched literally on purpose, because
  // pattern-matching here would bench a healthy bird for a full minute every
  // time the network hiccuped.
  it("does not pattern-match a thrown error whose text contains 429", () => {
    expect(
      isRateLimitError("TypeError: fetch failed — upstream returned 429 Too Many Requests"),
    ).toBe(false);
  });

  it("treats dormant, http, unavailable and absent errors as plain failures", () => {
    expect(isRateLimitError("dormant")).toBe(false);
    expect(isRateLimitError("http_429")).toBe(false);
    expect(isRateLimitError("http_503")).toBe(false);
    expect(isRateLimitError("workers_ai_unavailable")).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });

  it("keeps the cooldown split intact: only the literal buys the longer wait", () => {
    expect(cooldownFor(isRateLimitError("rate_limit"))).toBe(COOLDOWN_RATE_LIMIT_MS);
    expect(cooldownFor(isRateLimitError("http_429"))).toBe(COOLDOWN_FAILURE_MS);
    expect(cooldownFor(isRateLimitError(undefined))).toBe(COOLDOWN_FAILURE_MS);
  });
});
