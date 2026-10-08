import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  runPreflight,
  renderPreflight,
  satisfiesNodeRange,
} from "../src/deploy/preflight.ts";
import { buildDeployPlan } from "../src/deploy/plan.ts";
import type { DeployPlan } from "../src/deploy/plan.ts";
import type { PreflightReport } from "../src/deploy/preflight.ts";

// ── Helpers ───────────────────────────────────────────────

const cloudEnv = {
  SIMORGH_API_KEY: "k",
  CLOUDFLARE_API_TOKEN: "cf",
  CLOUDFLARE_ACCOUNT_ID: "acct",
};

const nodeEnv = { SIMORGH_API_KEY: "k" };

const npmPath = "/usr/bin/npm";
const curlPath = "/usr/bin/curl";
const nodePath = "/usr/bin/node";

// Every `makeWhich(...)` below includes `upm` because the real plans' first step installs
// with it (ADR-0004 — upm installs, `upm.lock` is the committed lockfile). Preflight derives
// the tools a plan needs from each step's argv, so a fixture omitting it would be asserting
// against a tool list the targets no longer produce. That is the derivation working, not a
// regression in it: a machine genuinely without upm *should* be blocked, by `missing-tool`.

const makeWhich = (...paths: string[]): ((cmd: string) => Promise<string | null>) =>
  async (cmd: string) => {
    const map: Record<string, string> = Object.fromEntries(
      paths.map((p) => [p.split("/").pop()!, p])
    );
    return map[cmd] ?? null;
  };

const deadFetch = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8788");
};

const liveFetch = async () => ({ ok: true, status: 200 } as unknown as Response);

const throwFetch = (msg: string) => async () => {
  throw new Error(msg);
};

// Build a real plan via buildDeployPlan so we prove preflight works
// against the actual plan builder, not hand-crafted fixtures.
const nodePlan = (overrides: {
  origin?: string;
  env?: Record<string, string | undefined>;
  mode?: "manual" | "cli";
} = {}) =>
  buildDeployPlan({
    targetId: "node",
    mode: overrides.mode ?? "cli",
    env: overrides.env ?? nodeEnv,
    origin: overrides.origin,
  });

const cfPlan = (overrides: {
  env?: Record<string, string | undefined>;
  mode?: "manual" | "cli";
  origin?: string;
} = {}) =>
  buildDeployPlan({
    targetId: "cloudflare-workers",
    mode: overrides.mode ?? "cli",
    env: overrides.env ?? cloudEnv,
    origin: overrides.origin ?? "127.0.0.1:8787",
  });

// ── The runtime-version gate ───────────────────────────────────────────────
//
// One fixture for every test below, built from the *real* plan builder, and arranged so
// the only blocker it can produce is the runtime check: the node plan's two runnable steps
// invoke `upm` and `node` (both on PATH here), `SIMORGH_API_KEY` is set so no secret is
// missing, the origin is resolved so no `{origin}` survives, and the endpoint probe is
// dead — which is a warning, never a blocker. That is what lets `report.ok` be read as
// *the version gate's verdict* rather than "this plan happened to be fine".

const nodeRuntimeReport = (currentNodeVersion: string, requiredNodeVersion: string) =>
  runPreflight({
    plan: nodePlan({ origin: "127.0.0.1:8788", env: { ...nodeEnv, SIMORGH_API_KEY: "k" } }),
    which: makeWhich("upm", "node"),
    fetch: deadFetch,
    currentNodeVersion,
    requiredNodeVersion,
  });

/** The version-gate check in a report, or `undefined` if the gate stayed quiet. */
const runtimeCheck = (report: PreflightReport, id: string) =>
  report.checks.find((c) => c.id === id);

describe("satisfiesNodeRange — engines.node is a range, not a version", () => {
  it(">=22.3 accepts a modern Node and refuses everything below it", () => {
    // `>=22.3` is the literal in package.json's engines.node. The previous implementation
    // deleted every non-digit, turned it into 223, compared the *major* against it, and so
    // rejected 26, 23 and 22 alike — a gate that could never pass. Verified against the real
    // CLI before the fix: `deploy node --mode cli --dry-run` on Node v26.7.0 printed
    // "Node runtime 26.7.0 is older than required >=22.3".
    expect(satisfiesNodeRange("26.7.0", ">=22.3").satisfied).toBe(true);
    expect(satisfiesNodeRange("23.0.0", ">=22.3").satisfied).toBe(true);
    expect(satisfiesNodeRange("22.3.0", ">=22.3").satisfied).toBe(true);
    expect(satisfiesNodeRange("22.2.9", ">=22.3").satisfied).toBe(false);
    expect(satisfiesNodeRange("22.2.0", ">=22.3").satisfied).toBe(false);
    expect(satisfiesNodeRange("20.11.0", ">=22.3").satisfied).toBe(false);
  });

  it("missing components read as 0, so >=20 is the fallback readRequiredNodeVersion returns", () => {
    expect(satisfiesNodeRange("20.0.0", ">=20").satisfied).toBe(true);
    expect(satisfiesNodeRange("26.7.0", ">=20").satisfied).toBe(true);
    expect(satisfiesNodeRange("19.9.9", ">=20").satisfied).toBe(false);
    // 22.3 means 22.3.0, so the .2 that follows it fails the floor.
    expect(satisfiesNodeRange("22.2.0", ">=22.3").satisfied).toBe(false);
  });

  it("compares numerically, so 22.10 is above 22.9 and not below it", () => {
    // The string comparison this replaces would have got this backwards.
    expect(satisfiesNodeRange("22.10.0", "<=22.9").satisfied).toBe(false);
    expect(satisfiesNodeRange("22.9.0", "<=22.9").satisfied).toBe(true);
    expect(satisfiesNodeRange("9.0.0", "<=10.0.0").satisfied).toBe(true);
  });

  it("space-separated comparators are ANDed, || separates alternatives", () => {
    expect(satisfiesNodeRange("23.5.0", ">=22.3 <24.0.0").satisfied).toBe(true);
    expect(satisfiesNodeRange("26.0.0", ">=22.3 <24.0.0").satisfied).toBe(false);
    expect(satisfiesNodeRange("20.0.0", ">=22.3 <24.0.0").satisfied).toBe(false);
    expect(satisfiesNodeRange("23.5.0", ">=22.3 <24.0.0 || >=26.0.0").satisfied).toBe(true);
    expect(satisfiesNodeRange("26.1.0", ">=22.3 <24.0.0 || >=26.0.0").satisfied).toBe(true);
    expect(satisfiesNodeRange("24.5.0", ">=22.3 <24.0.0 || >=26.0.0").satisfied).toBe(false);
  });

  it("a prerelease orders below its release, and a nightly above an older floor", () => {
    expect(satisfiesNodeRange("22.3.0-rc.1", ">=22.3").satisfied).toBe(false);
    // A 22.3.0 prerelease is *above* all of 22.2.x, so it does not lower the floor for them.
    expect(satisfiesNodeRange("22.2.0", ">=22.3-rc.1").satisfied).toBe(false);
    // …but it does admit the release it is a preview of, which is the point of such a range.
    expect(satisfiesNodeRange("22.3.0", ">=22.3-rc.1").satisfied).toBe(true);
    // Deliberate, documented deviation from npm semver: npm would also refuse a prerelease
    // that the range does not mention. A deployer's runtime floor is not a statement about
    // release candidates, so `23.0.0-nightly` clears `>=22.3` here.
    expect(satisfiesNodeRange("23.0.0-nightly", ">=22.3").satisfied).toBe(true);
    expect(satisfiesNodeRange("22.3.0-rc.2", ">=22.3.0-rc.1").satisfied).toBe(true);
    expect(satisfiesNodeRange("22.3.0-rc.1", ">=22.3.0-rc.2").satisfied).toBe(false);
  });

  it("build metadata is parsed and ignored, as semver precedence requires", () => {
    expect(satisfiesNodeRange("22.3.0+build.7", ">=22.3").satisfied).toBe(true);
    expect(satisfiesNodeRange("22.3.0", ">=22.3+build.7").satisfied).toBe(true);
  });

  it("a bare version is an exact match on all three components", () => {
    expect(satisfiesNodeRange("22.3.0", "22.3.0").satisfied).toBe(true);
    expect(satisfiesNodeRange("22.3.1", "22.3.0").satisfied).toBe(false);
    expect(satisfiesNodeRange("22.3.0", "=22.3.0").satisfied).toBe(true);
  });

  it("refuses every range form it does not implement, rather than guessing", () => {
    // Each of these is real semver syntax. None of it is implemented, so each must come back
    // unverifiable — never silently true, because "cannot tell" is not "fine".
    const refused = [
      "^22.3",
      "~22.3",
      "22.x",
      "22.*",
      "*",
      "x",
      "22.3 - 22.9", // hyphen range
      ">=22.3.0 <24", // 1-part upper bound: <24 is ambiguous between <24.0.0 and <25.0.0
      "=22",
      "22", // bare 1-part
      ">=22.3.0.1",
      ">=v22.3",
      ">=22.3-",
      "latest",
      ">=22.3 ||", // trailing || leaves an empty clause
      "|| >=26", // ditto, before the first alternative
      ">=22.3 || || >=26", // ditto, between two real alternatives
      "",
      "   ",
    ];
    for (const range of refused) {
      const result = satisfiesNodeRange("26.7.0", range);
      expect(
        result.satisfied,
        `range ${JSON.stringify(range)} must not be reported as satisfied`
      ).toBe(false);
      expect(
        result.unverifiable,
        `range ${JSON.stringify(range)} must be reported as unverifiable`
      ).toBeTruthy();
    }
  });

  it("refuses a version it cannot read, and never calls it satisfied", () => {
    for (const version of ["not-a-version", "", "26.7.0.1", "v26.7.0", ">=26", "26.x"]) {
      const result = satisfiesNodeRange(version, ">=22.3");
      expect(result.satisfied, `version ${JSON.stringify(version)}`).toBe(false);
      expect(result.unverifiable, `version ${JSON.stringify(version)}`).toBeTruthy();
    }
    // The version under test is read by the same parser as a range comparator, so a partial
    // one fills with 0: "26" is 26.0.0. `process.versions.node` is always a full triple, so
    // this shape only ever arrives from an override.
    expect(satisfiesNodeRange("26", ">=22.3").satisfied).toBe(true);
    expect(satisfiesNodeRange("26", ">=27").satisfied).toBe(false);
  });
});

describe("runPreflight — the runtime-version gate", () => {
  it("Node 26 against >=22.3 → no runtime check at all", async () => {
    // The regression, at the level an operator meets it. `report.ok` is true because the
    // gate cleared, not because the plan was tidy.
    const report = await nodeRuntimeReport("26.7.0", ">=22.3");
    expect(report.ok).toBe(true);
    expect(runtimeCheck(report, "runtime-unsupported")).toBeUndefined();
    expect(runtimeCheck(report, "runtime-version-unverifiable")).toBeUndefined();
    expect(report.checks.some((c) => c.id.startsWith("runtime-"))).toBe(false);
  });

  it("Node 22.3 exactly → passes, so the floor is inclusive", async () => {
    const report = await nodeRuntimeReport("22.3.0", ">=22.3");
    expect(report.ok).toBe(true);
    expect(report.checks.some((c) => c.id.startsWith("runtime-"))).toBe(false);
  });

  it("Node 22.2 → blocks, and says the range rather than a guess", async () => {
    const report = await nodeRuntimeReport("22.2.0", ">=22.3");
    expect(report.ok).toBe(false);
    const blocker = runtimeCheck(report, "runtime-unsupported");
    expect(blocker).toBeDefined();
    expect(blocker!.severity).toBe("blocker");
    // The old detail claimed "26.7.0 is older than required" for a Node that was newer. The
    // claim now has to be true in both directions, so it names the range and stops.
    expect(blocker!.detail).toContain("22.2.0");
    expect(blocker!.detail).toContain(">=22.3");
    expect(blocker!.detail).toContain("does not satisfy");
  });

  it("Node 20 → blocks", async () => {
    const report = await nodeRuntimeReport("20.11.0", ">=22.3");
    expect(report.ok).toBe(false);
    expect(runtimeCheck(report, "runtime-unsupported")).toBeDefined();
  });

  it("a newer Node is blocked against an upper bound without being called 'too old'", async () => {
    const report = await nodeRuntimeReport("26.0.0", ">=22.3 <24.0.0");
    expect(report.ok).toBe(false);
    const blocker = runtimeCheck(report, "runtime-unsupported")!;
    // "too old" would be false here: 26 is newer than the ceiling. The id and the sentence
    // both have to stay honest for a range that is not a floor.
    expect(blocker.id).not.toBe("runtime-too-old");
    expect(blocker.detail).not.toContain("older than");
    expect(blocker.detail).toContain("does not satisfy");
  });

  it("an unparseable range FAILS CLOSED — a blocker, not a silent pass", async () => {
    // The whole point of refusing unknown syntax. If this returned `ok: true`, a deployer
    // would read the absence of a blocker as a runtime check that had actually run.
    for (const range of ["^22.3", "22.x", "*", ">=22.3 ||", "", "totally bogus"]) {
      const report = await nodeRuntimeReport("26.7.0", range);
      expect(report.ok, `range ${JSON.stringify(range)} must not pass`).toBe(false);
      const blocker = runtimeCheck(report, "runtime-version-unverifiable");
      expect(blocker, `range ${JSON.stringify(range)}`).toBeDefined();
      expect(blocker!.severity).toBe("blocker");
      // The operator needs to know it was an unverifiable range and not a wrong Node.
      expect(blocker!.detail).toContain("Cannot verify");
      expect(blocker!.detail).toContain("26.7.0");
      expect(blocker!.hint).toContain("engines.node");
      expect(runtimeCheck(report, "runtime-unsupported")).toBeUndefined();
    }
  });

  it("an unreadable running version also fails closed", async () => {
    const report = await nodeRuntimeReport("not-a-version", ">=22.3");
    expect(report.ok).toBe(false);
    expect(runtimeCheck(report, "runtime-version-unverifiable")).toBeDefined();
  });

  it("the repo's own engines.node admits the runtime the suite is running on", async () => {
    // Environment-aware on purpose, and it is the deployed scenario: this repo declares
    // engines.node ">=22.3", and the bug made that floor reject every Node from 22 upwards.
    // The value is read from the manifest rather than pasted, so bumping engines.node cannot
    // leave this test asserting a range the repo no longer uses.
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
    ) as { engines?: { node?: string } };
    const declared = manifest.engines?.node;
    expect(declared, "package.json must declare engines.node").toBeTruthy();
    const result = satisfiesNodeRange(process.versions.node, declared!);
    // On a box below the declared floor this fails, and that is the correct answer — the
    // message says the machine is under it, rather than the suite quietly waiving it.
    expect(result.unverifiable ?? "").toBe("");
    expect(result.satisfied, `this Node ${process.versions.node} must satisfy ${declared}`).toBe(
      true
    );
  });
});

// ── Tests ─────────────────────────────────────────────────

describe("runPreflight", () => {
  it("healthy plan → ok: true, zero blockers", async () => {
    const plan = cfPlan();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      fetch: deadFetch,
    });
    expect(report.ok).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it("missing required secret → blocker naming that secret", async () => {
    const plan = cfPlan({ env: { SIMORGH_API_KEY: "k" } }); // no CLOUDFLARE_API_TOKEN
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      fetch: deadFetch,
    });
    expect(report.ok).toBe(false);
    const secretBlockers = report.checks.filter(
      (c) => c.id === "missing-secret" && c.detail.includes("CLOUDFLARE_API_TOKEN")
    );
    expect(secretBlockers).toHaveLength(1);
    expect(secretBlockers[0].severity).toBe("blocker");
  });

  it("optional secret missing → not a blocker", async () => {
    const plan = cfPlan({ env: { ...cloudEnv, GROQ_API_KEY: undefined } });
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      fetch: deadFetch,
    });
    expect(report.ok).toBe(true);
    const secretBlockers = report.checks.filter(
      (c) => c.id === "missing-secret" && c.detail.includes("GROQ_API_KEY")
    );
    expect(secretBlockers).toHaveLength(0);
  });

  it("missing tool → blocker naming the step id that needs it", async () => {
    const plan = cfPlan();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm"), // curl is missing
      fetch: deadFetch,
    });
    expect(report.ok).toBe(false);
    const toolBlocker = report.checks.find(
      (c) => c.id === "missing-tool" && c.detail.includes("curl")
    );
    expect(toolBlocker).toBeDefined();
    expect(toolBlocker!.severity).toBe("blocker");
    expect(toolBlocker!.detail).toMatch(/step [a-z]+/i);
  });

  it("tool list is derived from plan, not hardcoded", async () => {
    // Hand-built plan with a tool that no real target uses
    const handPlan: DeployPlan = {
      target: {
        id: "test-target",
        label: "Test",
        runtime: "test",
        connectors: [],
        endpoint: "http://localhost",
        modes: ["cli"],
        secrets: [],
        steps: [],
        notes: "",
      },
      mode: "cli",
      service: "svc",
      endpoint: "http://localhost",
      steps: [
        {
          index: 0,
          id: "frob-step",
          description: "frobnicate",
          run: ["frobnicate", "--do"],
          needs: [],
          executable: true,
        },
      ],
      secrets: [],
      warnings: [],
    };
    const report = await runPreflight({
      plan: handPlan,
      which: makeWhich(), // frobnicate not on PATH
      fetch: deadFetch,
    });
    const toolBlocker = report.checks.find(
      (c) => c.id === "missing-tool" && c.detail.includes("frobnicate")
    );
    expect(toolBlocker).toBeDefined();
    expect(toolBlocker!.severity).toBe("blocker");
    expect(toolBlocker!.detail).toMatch(/step [a-z]+/i);
  });

  it("unresolved {origin} in argv → blocker", async () => {
    // Node target without --origin leaves {origin} in manual text
    const plan = nodePlan({ origin: undefined });
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "node", "curl"),
      fetch: deadFetch,
    });
    expect(report.ok).toBe(false);
    const originBlocker = report.checks.find(
      (c) => c.id === "unresolved-origin"
    );
    expect(originBlocker).toBeDefined();
    expect(originBlocker!.severity).toBe("blocker");
  });

  it("cli mode on non-executable target → blocker", async () => {
    // byo-endpoint only supports manual; build a hand-built plan
    const handPlan: DeployPlan = {
      target: {
        id: "byo-endpoint",
        label: "Bring your own",
        runtime: "unknown",
        connectors: ["rest", "mcp"],
        endpoint: "{origin}",
        modes: ["manual"],
        secrets: [],
        steps: [],
        notes: "",
      },
      mode: "cli",
      service: "svc",
      endpoint: "http://localhost",
      steps: [],
      secrets: [],
      warnings: [],
    };
    const report = await runPreflight({
      plan: handPlan,
      which: makeWhich(),
      fetch: deadFetch,
    });
    expect(report.ok).toBe(false);
    const mismatch = report.checks.find(
      (c) => c.id === "mode-target-mismatch"
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.severity).toBe("blocker");
  });

  it("live core at endpoint → warning, ok still true", async () => {
    const plan = cfPlan();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      fetch: liveFetch,
    });
    expect(report.ok).toBe(true);
    const liveCheck = report.checks.find((c) => c.id === "endpoint-live");
    expect(liveCheck).toBeDefined();
    expect(liveCheck!.severity).toBe("warning");
  });

  it("dead endpoint → ok: true", async () => {
    const plan = cfPlan();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      fetch: deadFetch,
    });
    expect(report.ok).toBe(true);
  });

  // ── The two cases below exist because the first version of this check got them wrong ──
  //
  // It reported "A core is already responding at <endpoint> (HTTP 501)" for any HTTP
  // status at all. Its own demo run printed that for a plain 501 from an unrelated local
  // server: a confident, false statement about what was running on the operator's box.
  // A preflight that lies is worse than no preflight.

  it("a real core's health payload is recognised as a core", async () => {
    const plan = cfPlan();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      // The exact shape a live core returns, captured from one: `{status, timestamp}`.
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", timestamp: "2026-09-22T09:38:42.965Z" }),
        }) as unknown as Response,
    });
    const check = report.checks.find((c) => c.id === "endpoint-live");
    expect(check!.detail).toContain("phoenix-core is already answering");
    expect(check!.detail).toContain("status=ok");
    expect(report.ok).toBe(true);
  });

  it("an impostor on the port is NOT claimed to be a core", async () => {
    const plan = cfPlan();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      // HTTP 501 from something that is not a phoenix-core — the false positive this
      // check used to produce, with the status it actually produced it for.
      fetch: async () =>
        ({
          ok: false,
          status: 501,
          json: async () => ({}),
        }) as unknown as Response,
    });
    const check = report.checks.find((c) => c.id === "endpoint-live");
    expect(check).toBeDefined();
    expect(check!.detail).not.toContain("phoenix-core is already answering");
    expect(check!.detail).toContain("did not identify itself as a phoenix-core");
    expect(check!.detail).toContain("501");
  });

  it("a 200 that is not a core's payload is still not claimed as a core", async () => {
    const plan = cfPlan();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      // 200 with a JSON body that has no `status`/`timestamp` pair: another server's
      // healthy response, which must not be reported as a core.
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ service: "something-else", version: "1.2.3" }),
        }) as unknown as Response,
    });
    const check = report.checks.find((c) => c.id === "endpoint-live");
    expect(check!.detail).toContain("did not identify itself as a phoenix-core");
  });

  it("probe throws → warning with real message, never rejected", async () => {
    const plan = cfPlan();
    await expect(
      runPreflight({
        plan,
        which: makeWhich("npm", "upm", "curl"),
        fetch: throwFetch("DNS lookup failed:ENOTFOUND example.com"),
      })
    ).resolves.not.toThrow();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      fetch: throwFetch("DNS lookup failed:ENOTFOUND example.com"),
    });
    const probeCheck = report.checks.find((c) => c.id === "endpoint-live");
    expect(probeCheck).toBeDefined();
    expect(probeCheck!.severity).toBe("warning");
    expect(probeCheck!.detail).toContain("DNS lookup failed");
  });

  it("blockers and checks agree", async () => {
    const plan = cfPlan({ env: { SIMORGH_API_KEY: "k" } }); // missing required secret
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "upm", "curl"),
      fetch: deadFetch,
    });
    const checkIds = new Set(report.checks.map((c) => c.id));
    for (const b of report.blockers) {
      expect(checkIds.has(b.id)).toBe(true);
      expect(b.severity).toBe("blocker");
    }
    for (const c of report.checks) {
      if (c.severity === "blocker") {
        expect(report.blockers.some((b) => b.id === c.id)).toBe(true);
      }
    }
  });

  it("renderPreflight — blockers before warnings before verdict", () => {
    const report: PreflightReport = {
      target: "node",
      service: "simorgh",
      ok: false,
      checks: [
        {
          id: "missing-secret",
          severity: "blocker",
          detail: "Missing X",
          hint: "Set X",
        },
        {
          id: "endpoint-live",
          severity: "warning",
          detail: "Endpoint live",
        },
      ],
      blockers: [
        {
          id: "missing-secret",
          severity: "blocker",
          detail: "Missing X",
          hint: "Set X",
        },
      ],
    };
    const rendered = renderPreflight(report);
    expect(rendered).toContain("Blocked");
    const idx = rendered.indexOf("missing-secret");
    expect(idx).toBeLessThan(rendered.indexOf("endpoint-live"));
    expect(rendered).toContain("cannot proceed");
  });

  it("renderPreflight — zero checks says plan is clear", () => {
    const report: PreflightReport = {
      target: "node",
      service: "simorgh",
      ok: true,
      checks: [],
      blockers: [],
    };
    const rendered = renderPreflight(report);
    expect(rendered).toContain("clear");
    expect(rendered).not.toContain("Blocked");
    expect(rendered).not.toContain("Warnings");
  });
});
