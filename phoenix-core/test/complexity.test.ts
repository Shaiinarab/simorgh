// Complexity-estimation tests. The estimator is a pure function, so everything
// here is a straight call — no SQLite, no fakes, no clock. What matters most:
// determinism (same input, same output, always) and the ordering-only contract
// (`fitRank` never says "exclude").
import { describe, expect, it } from "vitest";

import {
  COMPLEXITY_TIERS,
  estimateComplexity,
  fitRank,
  MODERATE_SCORE_MAX,
  TRIVIAL_SCORE_MAX,
  type ComplexityTier,
} from "../src/complexity.ts";

const PING = "What time is it?";
const HEAVY_PROMPT = [
  "Please analyse the following architecture and prove its safety:",
  "",
  "```ts",
  "function claim(x: string) { return JSON.parse(x); }",
  "```",
  "",
  "Then design a migration plan, step by step: how would you refactor this,",
  "benchmark the result, and threat-model the input path? Which properties",
  "derive from the types alone?",
].join("\n");

describe("estimateComplexity", () => {
  it("scores an empty prompt as trivial — there is nothing in it to be heavy about", () => {
    expect(estimateComplexity("")).toEqual({
      tier: "trivial",
      score: 0,
      signals: { chars: 0, words: 0, codeFences: 0, paragraphs: 0, questions: 0, directiveHits: 0 },
    });
    expect(estimateComplexity("   \n\t ").tier).toBe("trivial");
  });

  it("keeps a short ping trivial", () => {
    const est = estimateComplexity(PING);
    expect(est.tier).toBe("trivial");
    expect(est.score).toBeLessThan(TRIVIAL_SCORE_MAX);
  });

  it("rates a long, structured, directive-laden prompt as heavy", () => {
    const est = estimateComplexity(HEAVY_PROMPT);
    expect(est.tier).toBe("heavy");
    expect(est.score).toBeGreaterThanOrEqual(MODERATE_SCORE_MAX);
    // The signals are reported, not hidden inside the score — an operator reading
    // a routed decision can see why it landed where it did.
    expect(est.signals.codeFences).toBe(1);
    expect(est.signals.questions).toBeGreaterThan(0);
    expect(est.signals.directiveHits).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic: same input, byte-identical output", () => {
    expect(estimateComplexity(HEAVY_PROMPT)).toEqual(estimateComplexity(HEAVY_PROMPT));
    expect(estimateComplexity(PING)).toEqual(estimateComplexity(PING));
  });

  it("is monotone in length: a longer prompt never scores less than a shorter one", () => {
    const short = estimateComplexity("ping");
    const long = estimateComplexity("ping " + "word ".repeat(400));
    expect(long.score).toBeGreaterThan(short.score);
    expect(long.tier === "trivial").toBe(false);
  });

  it("caps each signal so no single feature can dominate the score", () => {
    // 50 code fences would be 500 raw points; the cap must hold it to 20.
    const fences = Array(50).fill("```").join("\n");
    const est = estimateComplexity(fences);
    expect(est.signals.codeFences).toBe(25);
    expect(est.score).toBeLessThanOrEqual(40 + 20 + 15 + 10 + 15);
  });
});

describe("fitRank — ordering, never exclusion", () => {
  it("reads an absent declaration as neutral (assume anything can serve)", () => {
    expect(fitRank(undefined, "heavy")).toBe(1);
  });

  it("ranks a declared match best and a declared mismatch worst — but a rank, not a drop", () => {
    expect(fitRank(["trivial"], "trivial")).toBe(0);
    expect(fitRank(["trivial"], "heavy")).toBe(2);
    // Rank 2 is a position at the back of the queue. The flock-level test in
    // flock.test.ts proves the mismatched bird is still dialled when the birds
    // ahead of it fail; this file only pins the ordering key itself.
    for (const want of COMPLEXITY_TIERS) {
      for (const declared of COMPLEXITY_TIERS as readonly ComplexityTier[]) {
        expect([0, 2]).toContain(fitRank([declared], want));
      }
    }
  });
});
