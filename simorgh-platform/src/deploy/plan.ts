// ── Deploy plans ──────────────────────────────────────────────────────────────
//
// A plan is one target's step list with its values resolved and its secrets checked
// against the environment it will run in. Both modes render the same plan:
//
//   manual — every step is printed for a human, and nothing executes.
//   cli    — steps that carry a runnable command are executed; the rest are reported
//            as still needing a human.
//
// Building the plan *before* deciding who runs it is what keeps the two modes from
// drifting into two documents that disagree about what a deploy involves.

import { getTarget, type DeploymentMode, type DeploymentTarget, type DeployStep } from "../targets.ts";

export interface PlanSecret {
  name: string;
  description: string;
  required: boolean;
  /** Whether the environment this plan was built against actually has it. */
  present: boolean;
}

export interface PlanStep {
  index: number;
  id: string;
  description: string;
  /** Resolved argv, when a machine can run this step. */
  run?: string[];
  manual?: string;
  needs: string[];
  /**
   * Whether *this plan* will execute the step: a command exists, the target supports
   * running steps, and the mode is `cli`. Mode-aware on purpose — a caller holding a
   * manual plan that reports `executable: true` has been told something misleading.
   * `applyDeployPlan` still refuses manual mode independently, so the two agree rather
   * than one depending on the other.
   */
  executable: boolean;
}

export interface DeployPlan {
  target: DeploymentTarget;
  mode: DeploymentMode;
  service: string;
  endpoint: string;
  steps: PlanStep[];
  secrets: PlanSecret[];
  /** Everything the plan cannot do for you, stated up front. */
  warnings: string[];
}

export interface BuildPlanOptions {
  targetId: string;
  /** Service/instance name; substituted into the endpoint template. */
  service?: string;
  /** The address the core will be reachable at, when the target needs one. */
  origin?: string;
  mode: DeploymentMode;
  env?: Record<string, string | undefined>;
}

export const DEFAULT_SERVICE_NAME = "simorgh";

/** Whether a target declares it can execute steps at all. */
export function canExecute(target: DeploymentTarget): boolean {
  return target.modes.includes("cli");
}

export function buildDeployPlan(options: BuildPlanOptions): DeployPlan {
  const target = getTarget(options.targetId);
  const env = options.env ?? {};
  const service = options.service?.trim() || DEFAULT_SERVICE_NAME;
  const warnings: string[] = [];

  if (!target.modes.includes(options.mode)) {
    throw new Error(
      `Target '${target.id}' does not support '${options.mode}' mode (supports: ${target.modes.join(", ")}).`
    );
  }

  // ── Endpoint resolution ──
  const needsOrigin = target.endpoint.includes("{origin}");
  if (needsOrigin && !options.origin) {
    warnings.push(
      `Target '${target.id}' needs an --origin: the host:port its core will listen on.`
    );
  }
  if (!needsOrigin && options.origin) {
    warnings.push(
      `Target '${target.id}' derives its endpoint from the service name; --origin was ignored.`
    );
  }
  const endpoint = target.endpoint
    .replace("{service}", service)
    .replace("{origin}", options.origin ?? "{origin}");

  // ── Secret inventory ──
  const secrets: PlanSecret[] = target.secrets.map((secret) => ({
    ...secret,
    present: Boolean(env[secret.name]?.trim()),
  }));
  for (const secret of secrets) {
    if (secret.required && !secret.present) {
      warnings.push(`Missing required secret: ${secret.name} — ${secret.description}`);
    }
  }
  // An auth-less core fails closed with 503 on every API call, which is a confusing
  // first run. Say it in the plan rather than letting the operator discover it.
  if (target.id !== "byo-endpoint" && !env.SIMORGH_API_KEY?.trim()) {
    warnings.push(
      "SIMORGH_API_KEY is unset. The core fails closed: every authenticated route returns 503 AUTH_NOT_CONFIGURED."
    );
  }

  const executable = canExecute(target) && options.mode === "cli";
  const values = { service, origin: options.origin };
  const steps: PlanStep[] = target.steps.map((step: DeployStep, index: number) => ({
    index,
    id: step.id,
    description: step.description,
    ...(step.run ? { run: substitute(step.run, values) } : {}),
    // Substituted in prose too, not just in argv: an instruction that reads
    // "curl http://{origin}/health" is not an instruction.
    ...(step.manual ? { manual: substituteText(step.manual, values) } : {}),
    needs: [...(step.needs ?? [])],
    executable: executable && Boolean(step.run),
  }));

  if (options.mode === "cli") {
    const manual = steps.filter((step) => !step.executable);
    if (manual.length > 0) {
      warnings.push(
        `${manual.length} step(s) still need a human: ${manual.map((s) => s.id).join(", ")}.`
      );
    }
  }

  return { target, mode: options.mode, service, endpoint, steps, secrets, warnings };
}

function substitute(
  argv: readonly string[],
  values: { service: string; origin?: string }
): string[] {
  return argv.map((arg) => substituteText(arg, values));
}

function substituteText(value: string, values: { service: string; origin?: string }): string {
  return value
    .replace("{service}", values.service)
    .replace("{origin}", values.origin ?? "{origin}");
}

/** Render a plan for a human. The manual mode's entire output. */
export function renderPlan(plan: DeployPlan): string {
  const lines: string[] = [
    `Target:   ${plan.target.id} — ${plan.target.label}`,
    `Runtime:  ${plan.target.runtime}`,
    `Mode:     ${plan.mode}`,
    `Service:  ${plan.service}`,
    `Endpoint: ${plan.endpoint}`,
    `Speaks:   ${plan.target.connectors.join(", ")}`,
    "",
  ];

  if (plan.steps.length === 0) {
    lines.push("Nothing to deploy. Record it and connect:", "", `  simorgh connect ${plan.target.id} ${plan.endpoint}`, "");
  } else {
    lines.push("Steps:");
    for (const step of plan.steps) {
      const marker = step.executable ? "[run] " : "[you] ";
      lines.push(`  ${marker}${step.index + 1}. ${step.description}`);
      if (step.executable && step.run) {
        lines.push(`         $ ${step.run.join(" ")}`);
      } else if (step.manual) {
        lines.push(`         ${step.manual}`);
      }
      if (step.needs.length > 0) {
        lines.push(`         needs: ${step.needs.join(", ")}`);
      }
    }
    lines.push("");
  }

  lines.push("Secrets:");
  for (const secret of plan.secrets) {
    const state = secret.present ? "set" : secret.required ? "MISSING (required)" : "unset (optional)";
    lines.push(`  ${secret.name}: ${state}`);
    lines.push(`    ${secret.description}`);
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  }

  lines.push("", `Notes: ${plan.target.notes}`);
  return lines.join("\n");
}
