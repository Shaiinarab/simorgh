// Session-affinity tests. The bias is the whole decaying mechanism, so the
// boundary values are pinned here rather than left to a flock-level test to
// discover: fresh session = 1, half the reference = 0.5, at/past reference = 0,
// and a pin exists only while the bias is above zero.
import { describe, expect, it } from "vitest";

import {
  pinnedBySession,
  sessionBias,
  SESSION_AFFINITY_REF_CHARS,
  type SessionSignal,
} from "../src/session.ts";

describe("sessionBias", () => {
  it("is 1 for a fresh session", () => {
    expect(sessionBias(0)).toBe(1);
  });

  it("decays linearly and hits 0 exactly at the reference context size", () => {
    expect(sessionBias(SESSION_AFFINITY_REF_CHARS / 2)).toBeCloseTo(0.5, 10);
    expect(sessionBias(SESSION_AFFINITY_REF_CHARS)).toBe(0);
  });

  it("clamps: past the reference it stays 0, nonsense inputs read as fresh", () => {
    expect(sessionBias(SESSION_AFFINITY_REF_CHARS * 4)).toBe(0);
    // A negative context is not a deep conversation, it is a bug — and a caller
    // that has not measured its context has not demonstrated a deep one.
    expect(sessionBias(-1)).toBe(1);
    expect(sessionBias(Number.NaN)).toBe(1);
  });

  it("honours a deployment-supplied reference horizon", () => {
    expect(sessionBias(4_000, 8_000)).toBeCloseTo(0.5, 10);
    expect(sessionBias(8_000, 8_000)).toBe(0);
    // A non-positive reference means "no affinity window at all", not a crash.
    expect(sessionBias(1_000, 0)).toBe(0);
  });
});

describe("pinnedBySession", () => {
  it("pins nothing when there is no signal or no previous winner", () => {
    expect(pinnedBySession(undefined)).toBeUndefined();
    expect(pinnedBySession({ contextChars: 100 })).toBeUndefined();
  });

  it("pins the previous winner while the bias is above zero", () => {
    const signal: SessionSignal = { previousWinnerId: "shahin", contextChars: 1_000 };
    expect(pinnedBySession(signal)).toBe("shahin");
  });

  it("releases the pin once the context reaches the reference size — the decay, end to end", () => {
    const deep: SessionSignal = { previousWinnerId: "shahin", contextChars: SESSION_AFFINITY_REF_CHARS };
    expect(pinnedBySession(deep)).toBeUndefined();
  });
});
