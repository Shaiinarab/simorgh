// ── Applying a plan ───────────────────────────────────────────────────────────
//
// The only place `simorgh-platform` executes anything. Two guards stand between a
// plan and a command being run, and both are deliberate:
//
//   1. `confirmed` must be true. The CLI sets it only from `--yes`. There is no
//      default and no environment variable that turns it on.
//   2. `mode: "manual"` never executes, regardless of `confirmed`. Manual means
//      manual — a plan built for a human must not run because a caller passed the
//      wrong flag.
//
// A step whose declared secrets are absent is not attempted. Failing before the
// command runs gives a real error message; failing inside wrangler gives a 401 three
// steps later with the deploy half-applied.

import type { DeployPlan, PlanStep } from "./plan.ts";
import type { Runner, RunResult } from "./runner.ts";

export type StepOutcome =
  | { step: PlanStep; status: "manual"; detail: string }
  | { step: PlanStep; status: "ok"; durationMs: number; command: string; stdout: string }
  | {
      step: PlanStep;
      status: "failed";
      reason: "missing-env" | "exit" | "timeout";
      detail: string;
      code: number;
    };

export interface DeployReport {
  target: string;
  mode: DeployPlan["mode"];
  endpoint: string;
  ok: boolean;
  outcomes: StepOutcome[];
  /** Steps a human still has to do, in order. */
  needsHuman: string[];
}

export interface ApplyOptions {
  runner: Runner;
  env?: Record<string, string | undefined>;
  /** Must be explicitly true. Never inferred. */
  confirmed: boolean;
  cwd?: string;
  timeoutMs?: number;
  onStep?: (outcome: StepOutcome) => void;
}

export async function applyDeployPlan(
  plan: DeployPlan,
  options: ApplyOptions
): Promise<DeployReport> {
  if (!options.confirmed) {
    throw new Error(
      "Refusing to execute a deployment plan without explicit confirmation."
    );
  }

  const env = options.env ?? {};
  const outcomes: StepOutcome[] = [];

  for (const step of plan.steps) {
    const outcome = await runStep(plan, step, options, env);
    outcomes.push(outcome);
    options.onStep?.(outcome);
    // A failed step means the steps after it are describing a state that does not
    // exist yet. Stop rather than cascade.
    if (outcome.status === "failed") break;
  }

  return {
    target: plan.target.id,
    mode: plan.mode,
    endpoint: plan.endpoint,
    ok: outcomes.every((o) => o.status !== "failed"),
    outcomes,
    needsHuman: outcomes.filter((o) => o.status === "manual").map((o) => o.step.id),
  };
}

async function runStep(
  plan: DeployPlan,
  step: PlanStep,
  options: ApplyOptions,
  env: Record<string, string | undefined>
): Promise<StepOutcome> {
  if (plan.mode === "manual" || !step.executable || !step.run) {
    return {
      step,
      status: "manual",
      detail: step.manual ?? (step.run ? `would run: ${step.run.join(" ")}` : "manual step"),
    };
  }

  const missing = step.needs.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return {
      step,
      status: "failed",
      reason: "missing-env",
      detail: `missing required env: ${missing.join(", ")}`,
      code: -1,
    };
  }

  const [command, ...args] = step.run;
  const result: RunResult = await options.runner.run(command!, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (result.code !== 0) {
    return {
      step,
      status: "failed",
      reason: result.code === -2 ? "timeout" : "exit",
      detail: result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`,
      code: result.code,
    };
  }

  return {
    step,
    status: "ok",
    durationMs: result.durationMs,
    command: result.command,
    stdout: result.stdout.trim(),
  };
}

export function renderReport(report: DeployReport): string {
  const lines: string[] = [
    `Deploy ${report.ok ? "finished" : "FAILED"} — ${report.target} (${report.mode})`,
    `Endpoint: ${report.endpoint}`,
    "",
  ];
  for (const outcome of report.outcomes) {
    if (outcome.status === "ok") {
      lines.push(`  ok      ${outcome.step.id} (${outcome.durationMs}ms) $ ${outcome.command}`);
      if (outcome.stdout) lines.push(indent(outcome.stdout));
    } else if (outcome.status === "manual") {
      lines.push(`  manual  ${outcome.step.id} — ${outcome.detail}`);
    } else {
      lines.push(`  FAILED  ${outcome.step.id} (${outcome.reason}) — ${outcome.detail}`);
    }
  }
  if (report.needsHuman.length > 0) {
    lines.push("", `Still yours to do: ${report.needsHuman.join(", ")}`);
  }
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");
}
