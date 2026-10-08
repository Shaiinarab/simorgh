import { describe, expect, it } from "vitest";

import { applyDeployPlan, renderReport } from "../src/deploy/apply.ts";
import { buildDeployPlan } from "../src/deploy/plan.ts";
import { recordingRunner, type RunResult } from "../src/deploy/runner.ts";
import { listTargets } from "../src/targets.ts";

const env = { SIMORGH_API_KEY: "k", CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "acct" };

const plan = (mode: "manual" | "cli" = "cli", overrides: Partial<Parameters<typeof buildDeployPlan>[0]> = {}) =>
  buildDeployPlan({ targetId: "cloudflare-workers", mode, env, ...overrides });

const failure = (code = 1, stderr = "boom"): RunResult => ({
  command: "x",
  code,
  stdout: "",
  stderr,
  durationMs: 1,
});

describe("applyDeployPlan — the consent gate", () => {
  it("refuses to execute without explicit confirmation", async () => {
    const runner = recordingRunner();
    await expect(
      applyDeployPlan(plan(), { runner, env, confirmed: false })
    ).rejects.toThrow(/without explicit confirmation/);
    expect(runner.calls).toEqual([]);
  });

  it("never executes in manual mode, even when confirmed", async () => {
    // The strongest form of the guard: `confirmed` is true and the mode still wins.
    const runner = recordingRunner();
    const report = await applyDeployPlan(plan("manual"), { runner, env, confirmed: true });

    expect(runner.calls).toEqual([]);
    expect(report.outcomes.every((o) => o.status === "manual")).toBe(true);
    expect(report.ok).toBe(true);
  });
});

describe("applyDeployPlan — step semantics", () => {
  it("runs the runnable steps in order and reports what it ran", async () => {
    const runner = recordingRunner();
    const report = await applyDeployPlan(plan(), { runner, env, confirmed: true });

    expect(runner.calls.map((c) => c.command)).toEqual(["upm", "npm", "curl"]);
    expect(runner.calls[0]?.args).toEqual(["install", "--frozen-lockfile"]);
    expect(report.ok).toBe(true);
    // The two human steps are named, not silently dropped.
    expect(report.needsHuman).toEqual(["kv", "secrets"]);
  });

  it("installs the way this repository installs, on every target", async () => {
    // The regression this pins: ADR-0004 deleted `package-lock.json` on 2026-10-03, so
    // `npm ci` on a deploy target exits 1 with `EUSAGE` and `--mode cli` could never get
    // past step 1. `upm.lock` is the committed lockfile, so the install step must say upm.
    //
    // Two things are asserted, not one. The exact argv pins *reproducibility* — a deploy
    // must not quietly re-resolve a tree nobody reviewed. The sweep over every target is
    // the part that catches the bug coming back on a target nobody was looking at; the
    // two literal checks in the test above would still pass if only one target were fixed.
    for (const targetId of ["cloudflare-workers", "node"]) {
      const deps = buildDeployPlan({ targetId, mode: "cli", env, origin: "127.0.0.1:8787" })
        .steps.find((step) => step.id === "deps");

      expect(deps?.run, `${targetId}/deps`).toEqual(["upm", "install", "--frozen-lockfile"]);
    }

    for (const target of listTargets()) {
      for (const step of target.steps) {
        expect(step.run ?? [], `${target.id}/${step.id}`).not.toContain("ci");
      }
    }
  });

  it("tells the operator how to install when the plan's tool is missing", async () => {
    // Fail-with-instructions, not fail-silently. Preflight derives its tool check from
    // each step's argv, so a machine without upm is blocked before anything runs and
    // names the step that wanted it — and the step carries the command that fixes it.
    // The alternative, a fallback to `npm install`, would resolve a *different* tree from
    // a lockfile that is required not to exist, and would do it without saying so.
    const deps = buildDeployPlan({ targetId: "cloudflare-workers", mode: "manual", env })
      .steps.find((step) => step.id === "deps");

    expect(deps?.manual).toContain("npm i -g upm");
    expect(deps?.manual).toContain("upm install --frozen-lockfile");
    expect(deps?.manual).toMatch(/no npm-install fallback/i);
  });

  it("blocks a step whose declared secrets are absent, before running it", async () => {
    const runner = recordingRunner();
    const report = await applyDeployPlan(plan(), {
      runner,
      env: { SIMORGH_API_KEY: "k" }, // no Cloudflare credentials
      confirmed: true,
    });

    expect(report.outcomes.find((o) => o.step.id === "deploy")).toMatchObject({
      status: "failed",
      reason: "missing-env",
      detail: expect.stringContaining("CLOUDFLARE_API_TOKEN"),
    });
    // `upm install` ran; `wrangler deploy` never did.
    expect(runner.calls.map((c) => c.command)).toEqual(["upm"]);
  });

  it("stops at the first failure rather than cascading", async () => {
    const runner = recordingRunner({
      "upm install --frozen-lockfile": failure(1, "upm could not read upm.lock"),
    });
    const report = await applyDeployPlan(plan(), { runner, env, confirmed: true });

    expect(report.ok).toBe(false);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({ status: "failed", reason: "exit" });
    expect(runner.calls).toHaveLength(1);
  });

  it("distinguishes a timeout from an ordinary exit", async () => {
    const runner = recordingRunner({ "upm install --frozen-lockfile": failure(-2, "timed out") });
    const report = await applyDeployPlan(plan(), { runner, env, confirmed: true });
    expect(report.outcomes[0]).toMatchObject({ reason: "timeout" });
  });

  it("reports each step as it happens", async () => {
    const seen: string[] = [];
    await applyDeployPlan(plan(), {
      runner: recordingRunner(),
      env,
      confirmed: true,
      onStep: (outcome) => seen.push(`${outcome.step.id}:${outcome.status}`),
    });
    expect(seen).toEqual([
      "deps:ok",
      "kv:manual",
      "secrets:manual",
      "deploy:ok",
      "verify:ok",
    ]);
  });
});

describe("renderReport", () => {
  it("summarizes outcomes and the remaining manual work", async () => {
    const report = await applyDeployPlan(plan(), {
      runner: recordingRunner(),
      env,
      confirmed: true,
    });
    const rendered = renderReport(report);

    expect(rendered).toContain("Deploy finished");
    expect(rendered).toContain("ok      deps");
    expect(rendered).toContain("manual  kv");
    expect(rendered).toContain("Still yours to do: kv, secrets");
  });

  it("says FAILED when a step failed", async () => {
    const report = await applyDeployPlan(plan(), {
      runner: recordingRunner({ "upm install --frozen-lockfile": failure() }),
      env,
      confirmed: true,
    });
    expect(renderReport(report)).toContain("Deploy FAILED");
  });
});

describe("recordingRunner", () => {
  it("records calls and invents nothing", async () => {
    const runner = recordingRunner();
    const result = await runner.run("echo", ["hi"]);
    expect(runner.calls).toEqual([{ command: "echo", args: ["hi"] }]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dry run");
  });

  it("plays back a canned failure", async () => {
    const runner = recordingRunner({ "echo hi": failure(3, "nope") });
    const result = await runner.run("echo", ["hi"]);
    expect(result).toMatchObject({ code: 3, stderr: "nope" });
  });
});
