// ── simorgh doctor ──────────────────────────────────────────────
//
// Turns fleet failure into a named cause. `simorgh status` reports *that* an
// instance is unreachable; `doctor` says *why*, with a stable code the
// operator can act on.
//
// The four reachability causes need four different fixes:
//   no instances recorded   → connect one
//   connection refused      → wrong endpoint or core not running
//   401                     → recorded --api-key is wrong
//   503 AUTH_NOT_CONFIGURED → core has no SIMORGH_API_KEY (fails closed)
//
// The two conditions that waste an afternoon — core healthy, fleet green,
// every request returns flock_exhausted — are named explicitly:
//   all-providers-dormant   → core is up but has no provider keys
//   all-providers-tired     → flock is cooling down; check the provider

import type { FetchLike } from "@simorgh/phoenix-core";

import type { CoreInstance } from "./fleet.ts";
import type { CoreHealth } from "./connectors/types.ts";
import type { FlockStatus } from "@simorgh/phoenix-core";
import { connectorFor } from "./fleet.ts";
import { loadFleet, defaultFleetPath } from "./fleet-store.ts";

export interface Diagnosis {
  subject: string; // instance id, or "fleet" for fleet-wide conditions
  severity: "ok" | "warn" | "error";
  code: string; // stable, greppable
  detail: string; // one sentence, actionable
  hint?: string; // the command to run to fix it
}

export interface DoctorReport {
  ok: boolean; // false when any diagnosis is "error"
  diagnoses: Diagnosis[];
}

/** Classify a connector error string into a stable code and a fix hint. */
function classifyError(detail: string): { code: string; hint: string } {
  if (detail.includes("http_401") || detail.includes("bearer token rejected")) {
    return {
      code: "auth-unauthorized",
      hint: "simorgh connect <target> <endpoint> --api-key <correct-key>",
    };
  }
  if (detail.includes("http_503") || detail.includes("SIMORGH_API_KEY")) {
    return {
      code: "auth-not-configured",
      hint: "set SIMORGH_API_KEY on the core",
    };
  }
  if (
    detail.includes("ECONNREFUSED") ||
    detail.includes("ENOTFOUND") ||
    detail.includes("ECONNRESET")
  ) {
    return {
      code: "connection-refused",
      hint: "check the endpoint URL or start the core",
    };
  }
  return {
    code: "unreachable",
    hint: "check the endpoint URL or start the core",
  };
}

function isAllDormant(flock: FlockStatus): boolean {
  return flock.birds.length > 0 && flock.birds.every((b) => b.status === "dormant");
}

function isAllTired(flock: FlockStatus): boolean {
  return flock.birds.length > 0 && flock.birds.every((b) => b.status === "tired");
}

/**
 * Diagnose every recorded instance.
 *
 * Never throws — an unreachable core is a finding, not a crash.
 * @param instances fleet instances to diagnose (loaded by the caller)
 * @param options optional injected fetch for testing
 */
export async function diagnoseInstances(
  instances: readonly CoreInstance[],
  options?: { fetch?: FetchLike }
): Promise<DoctorReport> {
  if (instances.length === 0) {
    // Severity `error`, not `warn`: a fleet with nothing in it is not healthy, it is
    // unconfigured. `simorgh status` already exits 1 for this case, and a doctor that
    // reported "all clear" on a fresh checkout would be the one command an operator
    // trusts to tell them the deployment is fine.
    return {
      ok: false,
      diagnoses: [
        {
          subject: "fleet",
          severity: "error",
          code: "no-instances",
          detail: "No instances recorded in the fleet file.",
          hint: "simorgh connect <target> <endpoint>",
        },
      ],
    };
  }

  const diagnoses: Diagnosis[] = [];

  for (const instance of instances) {
    const connector = connectorFor(instance, options);
    let health: CoreHealth;
    let flock: FlockStatus | undefined;
    let error: string | undefined;

    try {
      health = await connector.health();
    } catch (e) {
      health = {
        reachable: false,
        endpoint: instance.endpoint,
        detail: String(e),
      };
    }

    if (!health.reachable) {
      const { code, hint } = classifyError(health.detail);
      diagnoses.push({
        subject: instance.id,
        severity: "error",
        code,
        detail: health.detail,
        hint,
      });
      continue;
    }

    // Core is reachable — try to read the flock status. A 401 here means the
    // recorded --api-key is wrong; a 503 means the core never configured one.
    try {
      flock = await connector.status();
    } catch (e) {
      error = String(e);
    }

    if (error) {
      const { code, hint } = classifyError(error);
      diagnoses.push({
        subject: instance.id,
        severity: "error",
        code,
        detail: error,
        hint,
      });
      continue;
    }

    if (flock && isAllDormant(flock)) {
      diagnoses.push({
        subject: instance.id,
        severity: "warn",
        code: "all-providers-dormant",
        detail: `All ${flock.birds.length} provider(s) on ${instance.id} are dormant — the core has no provider keys.`,
        hint: "configure provider keys on the core",
      });
      continue;
    }

    if (flock && isAllTired(flock)) {
      diagnoses.push({
        subject: instance.id,
        severity: "warn",
        code: "all-providers-tired",
        detail: `All ${flock.birds.length} provider(s) on ${instance.id} are tired — the flock is cooling down.`,
        hint: "check the provider, not the core",
      });
      continue;
    }

    diagnoses.push({
      subject: instance.id,
      severity: "ok",
      code: "ok",
      detail: `${instance.id} is reachable and serving.`,
    });
  }

  return {
    ok: diagnoses.every((d) => d.severity !== "error"),
    diagnoses,
  };
}

/** Human-readable rendering of a doctor report. */
export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  for (const d of report.diagnoses) {
    const icon =
      d.severity === "ok" ? "✓" : d.severity === "warn" ? "⚠" : "✗";
    lines.push(`${icon} [${d.code}] ${d.subject}: ${d.detail}`);
    if (d.hint) lines.push(`  → ${d.hint}`);
  }
  return lines.join("\n");
}

/**
 * Load the fleet from disk and diagnose every recorded instance.
 * Convenience wrapper used by the CLI; separates file loading from diagnosis.
 */
export async function doctorFromFleet(
  path: string = defaultFleetPath(),
  options?: { fetch?: FetchLike }
): Promise<DoctorReport> {
  const instances = await loadFleet(path);
  return diagnoseInstances(instances, options);
}
