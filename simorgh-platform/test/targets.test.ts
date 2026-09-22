import { describe, expect, it } from "vitest";

import { buildDeployPlan, renderPlan } from "../src/deploy/plan.ts";
import { getTarget, listTargets } from "../src/targets.ts";

const env = { SIMORGH_API_KEY: "test-key", CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "acct" };

describe("target catalog", () => {
  it("declares unique ids", () => {
    const ids = listTargets().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only offers modes it can actually honour", () => {
    for (const target of listTargets()) {
      expect(target.modes.length).toBeGreaterThan(0);
      // A target offering `cli` must have at least one runnable step, or `--mode cli`
      // would be a no-op that looks like a successful deploy.
      if (target.modes.includes("cli")) {
        expect(target.steps.some((step) => step.run)).toBe(true);
      }
    }
  });

  it("gives every step either a command or instructions for a human", () => {
    for (const target of listTargets()) {
      for (const step of target.steps) {
        expect(
          Boolean(step.run) || Boolean(step.manual),
          `${target.id}/${step.id} has neither run nor manual`
        ).toBe(true);
      }
    }
  });

  it("points every step at a secret the target declares", () => {
    // A `needs:` naming a secret the target does not list is a plan warning nobody
    // can act on, because it will never be reported as missing.
    for (const target of listTargets()) {
      const declared = new Set(target.secrets.map((s) => s.name));
      for (const step of target.steps) {
        for (const need of step.needs ?? []) {
          expect(declared.has(need), `${target.id}/${step.id} needs undeclared ${need}`).toBe(true);
        }
      }
    }
  });

  it("rejects an unknown target with the known ones listed", () => {
    expect(() => getTarget("kubernetes")).toThrow(/Known targets/);
  });
});

describe("buildDeployPlan", () => {
  it("substitutes the service name into the endpoint", () => {
    const plan = buildDeployPlan({ targetId: "cloudflare-workers", service: "my-flock", mode: "manual", env });
    expect(plan.endpoint).toBe("https://my-flock.workers.dev");
  });

  it("substitutes the origin into step argv", () => {
    const plan = buildDeployPlan({
      targetId: "node",
      mode: "cli",
      origin: "localhost:8788",
      env,
    });
    const verify = plan.steps.find((step) => step.id === "verify");
    expect(plan.endpoint).toBe("http://localhost:8788");
    // `verify` is a manual step for the node target, so its placeholder survives into
    // the rendered instruction rather than an argv.
    expect(verify?.manual).toContain("http://localhost:8788");
  });

  it("reports missing required secrets instead of failing later", () => {
    const plan = buildDeployPlan({ targetId: "cloudflare-workers", mode: "cli", env: {} });
    expect(plan.warnings).toContainEqual(
      expect.stringContaining("CLOUDFLARE_API_TOKEN")
    );
    expect(plan.secrets.find((s) => s.name === "SIMORGH_API_KEY")?.present).toBe(false);
  });

  it("warns that an auth-less core fails closed", () => {
    const plan = buildDeployPlan({ targetId: "node", mode: "manual", env: {} });
    expect(plan.warnings).toContainEqual(expect.stringContaining("fails closed"));
  });

  it("does not warn about auth when the key is present", () => {
    const plan = buildDeployPlan({ targetId: "node", mode: "manual", env });
    expect(plan.warnings).not.toContainEqual(expect.stringContaining("fails closed"));
  });

  it("marks runnable steps executable in cli mode only", () => {
    const cli = buildDeployPlan({ targetId: "cloudflare-workers", mode: "cli", env });
    const manual = buildDeployPlan({ targetId: "cloudflare-workers", mode: "manual", env });
    expect(cli.steps.find((s) => s.id === "deploy")?.executable).toBe(true);
    expect(manual.steps.find((s) => s.id === "deploy")?.executable).toBe(false);
    // …and a step with no command is never executable in either mode.
    expect(cli.steps.find((s) => s.id === "kv")?.executable).toBe(false);
  });

  it("counts the steps still needing a human", () => {
    const plan = buildDeployPlan({ targetId: "cloudflare-workers", mode: "cli", env });
    expect(plan.warnings).toContainEqual(expect.stringContaining("still need a human"));
  });

  it("warns when a target that needs an origin is not given one", () => {
    const plan = buildDeployPlan({ targetId: "byo-endpoint", mode: "manual", env });
    expect(plan.warnings).toContainEqual(expect.stringContaining("--origin"));
  });

  it("refuses a mode the target does not support", () => {
    expect(() =>
      buildDeployPlan({ targetId: "byo-endpoint", mode: "cli", env })
    ).toThrow(/does not support/);
  });

  it("renders a plan a human can follow", () => {
    const plan = buildDeployPlan({ targetId: "cloudflare-workers", mode: "manual", env });
    const rendered = renderPlan(plan);
    expect(rendered).toContain("cloudflare-workers");
    expect(rendered).toContain("[you]");
    expect(rendered).toContain("SIMORGH_API_KEY: set");
    // The human steps carry their instructions, not just a label.
    expect(rendered).toContain("npx wrangler kv namespace create CONTEXT_STORE");
  });

  it("renders warnings, and omits the section when there are none", () => {
    const clean = renderPlan(buildDeployPlan({ targetId: "cloudflare-workers", mode: "manual", env }));
    expect(clean).not.toContain("Warnings:");

    const risky = renderPlan(buildDeployPlan({ targetId: "cloudflare-workers", mode: "cli", env: {} }));
    expect(risky).toContain("Warnings:");
    expect(risky).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("tells the operator to connect rather than pretending there is anything to deploy", () => {
    const plan = buildDeployPlan({
      targetId: "byo-endpoint",
      mode: "manual",
      origin: "https://core.example",
      env,
    });
    expect(renderPlan(plan)).toContain("simorgh connect byo-endpoint https://core.example");
  });
});
