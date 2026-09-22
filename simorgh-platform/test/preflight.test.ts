import { describe, expect, it } from "vitest";

import { runPreflight, renderPreflight } from "../src/deploy/preflight.ts";
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

// ── Tests ─────────────────────────────────────────────────

describe("runPreflight", () => {
  it("healthy plan → ok: true, zero blockers", async () => {
    const plan = cfPlan();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "curl"),
      fetch: deadFetch,
    });
    expect(report.ok).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it("missing required secret → blocker naming that secret", async () => {
    const plan = cfPlan({ env: { SIMORGH_API_KEY: "k" } }); // no CLOUDFLARE_API_TOKEN
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "curl"),
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
      which: makeWhich("npm", "curl"),
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
      which: makeWhich("npm"), // curl is missing
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
      which: makeWhich("npm", "node", "curl"),
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
      which: makeWhich("npm", "curl"),
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
      which: makeWhich("npm", "curl"),
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
      which: makeWhich("npm", "curl"),
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
      which: makeWhich("npm", "curl"),
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
      which: makeWhich("npm", "curl"),
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
        which: makeWhich("npm", "curl"),
        fetch: throwFetch("DNS lookup failed:ENOTFOUND example.com"),
      })
    ).resolves.not.toThrow();
    const report = await runPreflight({
      plan,
      which: makeWhich("npm", "curl"),
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
      which: makeWhich("npm", "curl"),
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
