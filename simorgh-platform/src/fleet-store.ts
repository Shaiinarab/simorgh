// ── Fleet persistence ─────────────────────────────────────────────────────────
//
// A single JSON file under the operator's home. Deliberately not a database and not
// a config format with a schema: this holds a handful of endpoint records, the user
// is expected to read and edit it, and every failure mode (missing, unreadable,
// hand-edited into nonsense) has to degrade to "no instances yet" rather than a
// crash in a command that was only trying to list something.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CoreInstance } from "./fleet.ts";

export function defaultFleetPath(): string {
  return join(homedir(), ".simorgh", "fleet.json");
}

interface FleetFile {
  version: 1;
  instances: CoreInstance[];
}

function isInstance(value: unknown): value is CoreInstance {
  const candidate = value as Partial<CoreInstance> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.id === "string" &&
    typeof candidate.targetId === "string" &&
    typeof candidate.endpoint === "string" &&
    (candidate.connector === "rest" || candidate.connector === "mcp")
  );
}

/**
 * Read the fleet. Anything unreadable yields an empty list.
 *
 * A corrupt file is reported through `onWarning` rather than thrown so a read-only
 * command (`simorgh status`) still works — an operator with a broken fleet file can
 * still see that they have no instances and fix it.
 */
export async function loadFleet(
  path: string = defaultFleetPath(),
  onWarning?: (message: string) => void
): Promise<CoreInstance[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return []; // No file yet is not an error.
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FleetFile>;
    const instances = Array.isArray(parsed.instances) ? parsed.instances : [];
    const valid = instances.filter(isInstance);
    if (valid.length !== instances.length) {
      onWarning?.(`Ignored ${instances.length - valid.length} malformed instance record(s) in ${path}.`);
    }
    return valid;
  } catch (e) {
    onWarning?.(`Could not parse ${path}: ${String(e)}. Treating the fleet as empty.`);
    return [];
  }
}

export async function saveFleet(
  instances: readonly CoreInstance[],
  path: string = defaultFleetPath()
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload: FleetFile = { version: 1, instances: [...instances] };
  // Write-then-rename: an interrupted write leaves the previous fleet intact rather
  // than a truncated file that reads as "no instances".
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
