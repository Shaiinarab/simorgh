// ── Preflight — can this plan actually succeed right now? ────────
//
// A read-only gate that answers "can this deploy plan run in this
// environment, right now?" before any step is attempted. It never
// installs, deploys, or writes anything. It probes reachability, looks
// at the filesystem (via which), and reads the environment.
//
// Every check is derived from the plan, so a new target is covered for
// free as long as its steps declare their argv and its secrets are
// declared in the target definition.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { FetchLike, HttpLike } from "@simorgh/phoenix-core";
import type { DeployPlan } from "./plan.ts";
import { canExecute } from "./plan.ts";

// ── Types ─────────────────────────────────────────────────

export type PreflightSeverity = "blocker" | "warning";

export interface PreflightCheck {
  id: string;
  severity: PreflightSeverity;
  detail: string;
  hint?: string;
}

export interface PreflightReport {
  target: string;
  service: string;
  ok: boolean;
  checks: PreflightCheck[];
  blockers: PreflightCheck[];
}

export interface PreflightOptions {
  plan: DeployPlan;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  which?: (command: string) => Promise<string | null>;
  probeEndpoint?: boolean;
  /** Override the host's Node version for testing. Defaults to process.versions.node. */
  currentNodeVersion?: string;
  /** Override the required Node version for testing. Defaults to workspace engines.node. */
  requiredNodeVersion?: string;
}

// ── Implementation ────────────────────────────────────────────

export async function runPreflight(
  options: PreflightOptions
): Promise<PreflightReport> {
  const { plan, env = {} } = options;
  const checks: PreflightCheck[] = [];

  const fetchImpl = options.fetch ?? defaultFetch;
  const whichImpl = options.which ?? defaultWhich;

  // 1. Required secrets present
  for (const secret of plan.secrets) {
    if (secret.required && !secret.present) {
      checks.push({
        id: "missing-secret",
        severity: "blocker",
        detail: `Required secret ${secret.name} (${secret.description}) is not set`,
        hint: `Set ${secret.name} in the environment`,
      });
    }
  }

  // 2. Executable tools exist — derived from plan steps, not hardcoded
  const toolHeads = new Map<string, string>(); // tool → step id that needs it
  for (const step of plan.steps) {
    if (step.run && step.run.length > 0) {
      const tool = step.run[0];
      if (!toolHeads.has(tool)) {
        toolHeads.set(tool, step.id);
      }
    }
  }
  for (const [tool, stepId] of toolHeads) {
    try {
      const found = await whichImpl(tool);
      if (!found) {
        checks.push({
          id: "missing-tool",
          severity: "blocker",
          detail: `Tool "${tool}" required by step ${stepId} is not on PATH`,
          hint: `Install ${tool} or ensure it is on PATH`,
        });
      }
    } catch (err) {
      checks.push({
        id: "missing-tool",
        severity: "blocker",
        detail: `Tool "${tool}" required by step ${stepId} could not be checked: ${String(err)}`,
        hint: `Install ${tool} or ensure it is on PATH`,
      });
    }
  }

  // 3. Unresolved {origin} in argv or manual text
  for (const step of plan.steps) {
    if (step.run) {
      for (const arg of step.run) {
        if (arg.includes("{origin}")) {
          checks.push({
            id: "unresolved-origin",
            severity: "blocker",
            detail: `Step ${step.id} contains unresolved {origin} in argv: ${arg}`,
            hint: "Provide --origin when building the plan",
          });
          break;
        }
      }
    }
    if (step.manual && step.manual.includes("{origin}")) {
      checks.push({
        id: "unresolved-origin",
        severity: "blocker",
        detail: `Step ${step.id} manual text contains unresolved {origin}`,
        hint: "Provide --origin when building the plan",
      });
    }
  }

  // 4. Mode/plan agreement
  if (plan.mode === "cli" && !canExecute(plan.target)) {
    checks.push({
      id: "mode-target-mismatch",
      severity: "blocker",
      detail: `Plan mode is "cli" but target ${plan.target.id} cannot execute steps`,
      hint: `Use mode "manual" for target ${plan.target.id}`,
    });
  }

  // 5. Is anything already living at the endpoint?
  //
  // Three genuinely different outcomes, and collapsing them is how a preflight starts
  // lying. The first version of this check reported "A core is already responding" for
  // *any* HTTP status — its own demo run printed that sentence for `HTTP 501`, which is
  // not a phoenix-core and never was. So the probe reads the body and only claims a core
  // when the core's own health payload says so.
  if (options.probeEndpoint !== false && !plan.endpoint.includes("{")) {
    try {
      const response = await fetchImpl(`${plan.endpoint}/health`, { method: "GET" });
      const coreStatus = await readCoreStatus(response);
      checks.push(
        coreStatus !== null
          ? {
              id: "endpoint-live",
              severity: "warning",
              detail: `A phoenix-core is already answering at ${plan.endpoint} (HTTP ${response.status}, status=${coreStatus})`,
              hint: "Re-deploying over a live core is legal; review the impact first",
            }
          : {
              id: "endpoint-live",
              severity: "warning",
              detail: `Something is already listening at ${plan.endpoint} (HTTP ${response.status}), but it did not identify itself as a phoenix-core. Deploying here may collide with it.`,
              hint: "Confirm what is running there before deploying",
            }
      );
    } catch (err) {
      // Nothing is listening. That is the normal state before a first deploy, so this is
      // reported at the lowest severity — and it says what was actually observed rather
      // than inventing a cause.
      checks.push({
        id: "endpoint-live",
        severity: "warning",
        detail: `Endpoint probe failed: ${String(err)}`,
        hint: "Check the endpoint or your network",
      });
    }
  }

  // 6. Runtime version (node target only)
  if (plan.target.id === "node") {
    const current = options.currentNodeVersion ?? process.versions.node;
    const required = options.requiredNodeVersion ?? readRequiredNodeVersion();
    const currentMajor = parseInt(current.split(".")[0], 10);
    const requiredMajor = parseInt(required.replace(/[^0-9]/g, ""), 10);
    if (!isNaN(currentMajor) && !isNaN(requiredMajor) && currentMajor < requiredMajor) {
      checks.push({
        id: "runtime-too-old",
        severity: "blocker",
        detail: `Node runtime ${current} is older than required ${required}`,
        hint: `Upgrade Node to ${required} or later`,
      });
    }
  }

  const blockers = checks.filter((c) => c.severity === "blocker");

  return {
    target: plan.target.id,
    service: plan.service,
    ok: blockers.length === 0,
    checks,
    blockers,
  };
}

export function renderPreflight(report: PreflightReport): string {
  const lines: string[] = [];

  if (report.checks.length === 0) {
    lines.push(`Preflight clear — ${report.target}/${report.service} can proceed.`);
    return lines.join("\n");
  }

  const blockers = report.blockers;
  const warnings = report.checks.filter((c) => c.severity === "warning");

  if (blockers.length > 0) {
    lines.push(`Blocked by ${blockers.length} checker${blockers.length > 1 ? "s" : ""}:`);
    for (const b of blockers) {
      lines.push(`  ✗ ${b.id}: ${b.detail}`);
      if (b.hint) lines.push(`    → ${b.hint}`);
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push(`Warnings (${warnings.length}):`);
    for (const w of warnings) {
      lines.push(`  ⚠ ${w.id}: ${w.detail}`);
      if (w.hint) lines.push(`    → ${w.hint}`);
    }
    lines.push("");
  }

  const verdict = report.ok
    ? `Preflight passed — ${report.target}/${report.service} can proceed.`
    : `Preflight blocked — ${report.target}/${report.service} cannot proceed.`;
  lines.push(verdict);

  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────

/**
 * The `status` string from a core's `/health` payload, or `null` if this is not a core.
 *
 * Deliberately tolerant: a stub response with no body, a non-OK status, a body that is not
 * JSON, and JSON that is not a core health payload all mean the same thing to the caller —
 * "not confirmed as a phoenix-core" — and none of them is an error.
 */
async function readCoreStatus(response: HttpLike): Promise<string | null> {
  if (!response.ok || typeof response.json !== "function") return null;
  try {
    // The core's health payload is `{ status, timestamp }` — verified against a live core
    // rather than assumed. Requiring both fields is what keeps an unrelated server's
    // "200 OK" from being mistaken for a phoenix-core, which is the whole point of this
    // function. (`flock` is NOT in the payload; requiring it would make every real core
    // read as an impostor.)
    const body = (await response.json()) as { status?: unknown; timestamp?: unknown };
    return typeof body.status === "string" && typeof body.timestamp === "string"
      ? body.status
      : null;
  } catch {
    return null;
  }
}

async function defaultFetch(
  url: string,
  init?: Parameters<FetchLike>[1]
): Promise<ReturnType<FetchLike>> {
  const fn = (globalThis as Record<string, unknown>).fetch as FetchLike | undefined;
  if (fn) return fn(url, init);
  return Promise.reject(new Error("no fetch available"));
}

async function defaultWhich(command: string): Promise<string | null> {
  try {
    const result = execFileSync("sh", ["-c", `command -v ${command}`], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function readRequiredNodeVersion(): string {
  for (const filePath of [path.resolve("package.json"), path.join(process.cwd(), "package.json")]) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.engines?.node) return pkg.engines.node;
    } catch {
      /* try next */
    }
  }
  return ">=20";
}
