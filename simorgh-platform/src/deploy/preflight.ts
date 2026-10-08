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
  //
  // `engines.node` is a semver RANGE, not a version, so it is evaluated as one. The first
  // implementation deleted every non-digit out of it — ">=22.3" became 223 — and then
  // compared the running major against that integer, so `26 < 223` held and every Node
  // from 22 onwards was reported as too old. Verified against the real CLI, not a
  // fixture: `simorgh deploy node --mode cli --dry-run` on Node v26.7.0 printed
  //   ✗ runtime-too-old: Node runtime 26.7.0 is older than required >=22.3
  //     → Upgrade Node to >=22.3 or later
  // which blocked the `node` target on every machine running a modern Node. The check had
  // no test at all, which is how a gate that cannot ever pass stays green.
  //
  // The id is `runtime-unsupported` rather than `runtime-too-old` because a range need not
  // be a floor — against `>=22.3 <25`, Node 26 is *newer*, and calling it "too old" would
  // be the same confidently-false claim in a smaller package.
  if (plan.target.id === "node") {
    const current = options.currentNodeVersion ?? process.versions.node;
    const required = options.requiredNodeVersion ?? readRequiredNodeVersion();
    const result = satisfiesNodeRange(current, required);
    if (result.unverifiable) {
      // Fail closed, deliberately. A range this parser does not understand must not pass
      // silently: "cannot tell" is not "fine", and a gate that quietly approves a runtime
      // it never compared is worse than no gate, because the operator reads the absence of
      // a blocker as a check that ran.
      checks.push({
        id: "runtime-version-unverifiable",
        severity: "blocker",
        detail: `Cannot verify Node ${current} against engines.node ${JSON.stringify(required)}: ${result.unverifiable}`,
        hint: 'Use a supported range in package.json engines.node (e.g. ">=22.3"); the supported subset is documented on satisfiesNodeRange',
      });
    } else if (!result.satisfied) {
      checks.push({
        id: "runtime-unsupported",
        severity: "blocker",
        detail: `Node runtime ${current} does not satisfy the required range ${JSON.stringify(required)}`,
        hint: `Install a Node that satisfies ${required}, or correct engines.node in package.json`,
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
 * Does `version` fall inside the semver **range** `range`? `range` is what `engines.node`
 * actually contains.
 *
 * ## The supported subset — everything else is REFUSED, not guessed
 *
 * ```
 * range      := clause ( "||" clause )*          // OR
 * clause     := comparator ( WS comparator )*    // AND, whitespace-separated
 * comparator := op? version
 * op         := ">=" | ">" | "<=" | "<" | "=" | ""   (no operator means "=")
 * version    := NUM ( "." NUM ){0,2} [ "-" pre ] [ "+" build ]
 * NUM        := DIGIT+                                  // strictly digits
 * ```
 *
 * Missing components are filled with `0`, and how many were *written* decides what is
 * allowed, because the count is the only thing that makes the bound's direction
 * unambiguous:
 *
 * | operator         | components accepted | reading                                       |
 * |------------------|---------------------|-----------------------------------------------|
 * | `>=`, `>`        | 1, 2 or 3           | lower bound only; missing parts are `0`       |
 * | `<`, `<=`        | 2 or 3              | upper bound; the 1-part form is refused here  |
 * | `=`, or none     | 3 only              | exact match on the triple                     |
 *
 * So `>=22.3` is `>=22.3.0`, `>=20` is `>=20.0.0`, and a bare `22.3` is **refused** rather
 * than invented as either `=22.3.0` or `22.3.x`. Refusing is the point: this check gates a
 * deploy, so every case it cannot decide must stop the deploy. Anything outside the table
 * above — `^`, `~`, `x`/`X`/`*` wildcards, hyphen ranges (`22.3 - 22.9`), `1.x`, a
 * non-numeric component, an empty range, an empty clause — returns `unverifiable` and the
 * caller blocks on it.
 *
 * Prereleases are ordered by semver precedence, so `22.3.0-rc.1` is *below* `22.3.0` and
 * `22.3.0` is below `22.4.0`. Note one deliberate deviation from npm's `semver`: npm has a
 * second, separate rule under which a prerelease does not satisfy a range that does not
 * itself mention one. That rule is **not** implemented here, because it would reject a Node
 * nightly — `23.0.0-nightly` — against `>=22.3`, which is not what a deployer writing a
 * runtime floor means. Build metadata (`+…`) is parsed and ignored, per precedence rules.
 */
export function satisfiesNodeRange(
  version: string,
  range: string
): { satisfied: boolean; unverifiable?: string } {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) {
    return { satisfied: false, unverifiable: `${JSON.stringify(version)} is not a version` };
  }

  const parsedRange = parseRange(range);
  if ("error" in parsedRange) {
    return { satisfied: false, unverifiable: parsedRange.error };
  }

  // `||` is an OR of clauses, so one satisfied clause is enough.
  const matched = parsedRange.clauses.some((clause) =>
    clause.every((comparator) => satisfiesComparator(parsedVersion, comparator))
  );
  return { satisfied: matched };
}

/** One version read off disk or off `process.versions.node`, split into comparable parts. */
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; absent for a plain release. */
  prerelease?: string[];
  /** How many numeric components the text actually wrote — see the table above. */
  precision: 1 | 2 | 3;
}

interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  version: ParsedVersion;
}

/**
 * `major[.minor[.patch]][-prerelease][+build]`, digits only.
 *
 * Build metadata is dropped rather than rejected: semver precedence ignores it, and
 * `engines.node` values carrying it are asking a comparison question, not making a claim
 * about metadata.
 */
function parseVersion(text: string): ParsedVersion | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    text.trim()
  );
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  const precision = (minor !== undefined ? 1 : 0) + (patch !== undefined ? 1 : 0) + 1;
  return {
    major: Number(major),
    minor: minor === undefined ? 0 : Number(minor),
    patch: patch === undefined ? 0 : Number(patch),
    ...(prerelease !== undefined ? { prerelease: prerelease.split(".") } : {}),
    precision: precision as 1 | 2 | 3,
  };
}

/** Splits a range into its `||` clauses, or explains why it could not. */
function parseRange(range: string): { clauses: Comparator[][] } | { error: string } {
  if (range.trim() === "") {
    return { error: "the range is empty" };
  }

  const clauses: Comparator[][] = [];
  for (const rawClause of range.split("||")) {
    // A trailing or leading "||" produces an empty clause. It is not a range.
    if (rawClause.trim() === "") {
      return { error: 'has an empty clause around a "||"' };
    }

    const comparators: Comparator[] = [];
    for (const rawComparator of rawClause.trim().split(/\s+/)) {
      const comparator = parseComparator(rawComparator);
      if ("error" in comparator) {
        // Returned verbatim: the comparator error already names the offending text, and the
        // caller already prints the whole range, so prefixing it here would quote it twice.
        return { error: comparator.error };
      }
      comparators.push(comparator.comparator);
    }
    clauses.push(comparators);
  }

  return { clauses };
}

function parseComparator(
  text: string
): { comparator: Comparator } | { error: string } {
  const match = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(text);
  if (!match) {
    return { error: `${JSON.stringify(text)} is not a supported comparator` };
  }
  const [, op = "=", versionText] = match;

  const version = parseVersion(versionText);
  if (!version) {
    return { error: `${JSON.stringify(versionText)} is not a version` };
  }

  // The component count is load-bearing, not cosmetic: it is what distinguishes
  // ">=22.3" (a floor) from "22.3" (ambiguous), so the ambiguous form is refused rather
  // than resolved by guessing which way the operator was meant to point.
  const needsAtLeastTwo = op === "<" || op === "<=" || op === "=";
  if (needsAtLeastTwo && version.precision < 2) {
    return {
      error: `${JSON.stringify(text)} needs at least major.minor for "${op}" — write a full version or use ">="`,
    };
  }

  return { comparator: { op: op as Comparator["op"], version } };
}

function satisfiesComparator(version: ParsedVersion, comparator: Comparator): boolean {
  const order = compareVersions(version, comparator.version);
  switch (comparator.op) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    case "=":
      return order === 0;
  }
}

/** Semver precedence: numeric triple first, then a prerelease orders *below* its release. */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: string[] | undefined, b: string[] | undefined): number {
  // A release outranks any prerelease of the same triple: 1.0.0 > 1.0.0-rc.1.
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    // A shorter set of identifiers is the lower one, once the shared prefix matches.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftIsNumeric = /^\d+$/.test(left);
    const rightIsNumeric = /^\d+$/.test(right);
    if (leftIsNumeric && rightIsNumeric) {
      const diff = Number(left) - Number(right);
      return diff === 0 ? 0 : diff < 0 ? -1 : 1;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

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
