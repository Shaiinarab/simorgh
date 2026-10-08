// ── The fleet ─────────────────────────────────────────────────────────────────
//
// A fleet is the platform's view of every phoenix-core it can reach. This is where
// "connects phoenix-core from different providers" stops being a diagram: each
// instance names a target, an endpoint, and a connector, and the fleet treats them
// as interchangeable capacity.
//
// Failover here is deliberately *not* a health precheck. A closed port and a core
// that answers with `flock_exhausted` are both failures, the call has to be made to
// find out which, and a precheck would double the round trips to discover the same
// thing. So `ask` simply tries, and moves on.

import type { FetchLike, FlockStatus } from "@simorgh/phoenix-core";

import { mcpConnector } from "./connectors/mcp.ts";
import { restConnector } from "./connectors/rest.ts";
import type {
  AskRequest,
  AskResult,
  ConnectorKind,
  CoreConnector,
  CoreHealth,
} from "./connectors/types.ts";

export interface CoreInstance {
  /** Stable local handle, e.g. `cloudflare-workers:simorgh`. */
  id: string;
  targetId: string;
  endpoint: string;
  connector: ConnectorKind;
  apiKey?: string;
  /** Free-form operator note, e.g. why this one is slow. */
  note?: string;
}

export interface FleetOptions {
  fetch?: FetchLike;
}

/** `globalThis.fetch` satisfies `FetchLike` structurally; this is the one cast. */
export function defaultFetch(): FetchLike {
  return (url, init) => fetch(url, init as RequestInit);
}

export function connectorFor(instance: CoreInstance, options: FleetOptions = {}): CoreConnector {
  const fetchImpl = options.fetch ?? defaultFetch();
  return instance.connector === "mcp"
    ? mcpConnector({
        endpoint: instance.endpoint,
        fetch: fetchImpl,
        ...(instance.apiKey ? { apiKey: instance.apiKey } : {}),
        clientName: `simorgh-platform/${instance.id}`,
      })
    : restConnector({
        endpoint: instance.endpoint,
        fetch: fetchImpl,
        ...(instance.apiKey ? { apiKey: instance.apiKey } : {}),
        node: instance.id,
      });
}

export interface InstanceReport {
  instance: CoreInstance;
  health: CoreHealth;
  /** Absent when the core was unreachable, or spoke a shape we could not read. */
  flock?: FlockStatus;
  error?: string;
}

export interface AskOutcome {
  instance: CoreInstance;
  result: AskResult;
  /** Instances tried and rejected before this one answered. */
  skipped: { id: string; error: string }[];
}

export interface Fleet {
  readonly instances: readonly CoreInstance[];
  status(): Promise<InstanceReport[]>;
  ask(request: AskRequest, options?: { prefer?: readonly string[] }): Promise<AskOutcome>;
}

export function createFleet(
  instances: readonly CoreInstance[],
  options: FleetOptions = {}
): Fleet {
  return {
    instances,

    async status(): Promise<InstanceReport[]> {
      return Promise.all(
        instances.map(async (instance) => {
          const connector = connectorFor(instance, options);
          const health = await connector.health();
          if (!health.reachable) {
            return { instance, health, error: health.detail };
          }
          try {
            return { instance, health, flock: await connector.status() };
          } catch (e) {
            // Reachable but unreadable: a 401 or a shape we do not recognize. Report
            // the health we do have rather than pretending the instance is dead.
            return { instance, health, error: String(e) };
          }
        })
      );
    },

    async ask(request, askOptions): Promise<AskOutcome> {
      const skipped: { id: string; error: string }[] = [];
      for (const instance of orderInstances(instances, askOptions?.prefer)) {
        try {
          const result = await connectorFor(instance, options).ask(request);
          if (result.success) return { instance, result, skipped };
          skipped.push({ id: instance.id, error: result.error ?? "flock_exhausted" });
        } catch (e) {
          skipped.push({ id: instance.id, error: String(e) });
        }
      }
      // Every failure, not just the last: with three cores down for three different
      // reasons, "connection refused" alone sends you to the wrong one.
      throw new Error(
        `No instance answered. ${skipped.map((s) => `${s.id}: ${s.error}`).join(" | ")}`
      );
    },
  };
}

/** Preferred instances first, everything else after, original order preserved. */
function orderInstances(
  instances: readonly CoreInstance[],
  prefer: readonly string[] | undefined
): CoreInstance[] {
  if (!prefer || prefer.length === 0) return [...instances];
  const rank = new Map(prefer.map((id, index) => [id, index]));
  return [...instances].sort((a, b) => {
    const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

/** Upsert by id: reconnecting to the same endpoint replaces rather than duplicates. */
export function addInstance(
  instances: readonly CoreInstance[],
  instance: CoreInstance
): CoreInstance[] {
  const next = instances.filter((i) => i.id !== instance.id);
  next.push(instance);
  return next;
}

export function removeInstance(
  instances: readonly CoreInstance[],
  id: string
): CoreInstance[] {
  return instances.filter((i) => i.id !== id);
}

/** Derive a stable handle from a target and an endpoint. */
export function instanceIdFor(targetId: string, endpoint: string): string {
  let host = endpoint;
  // Guard on an explicit authority rather than relying on `new URL` to throw.
  // `new URL("localhost:9000")` does *not* throw — it reads `localhost:` as a scheme
  // and yields an empty host, which would collapse every bare `host:port` to the same
  // id and make two different cores indistinguishable in the fleet.
  if (endpoint.includes("://")) {
    try {
      host = new URL(endpoint).host || endpoint;
    } catch {
      // Malformed despite the scheme: use it as written.
    }
  }
  return `${targetId}:${host}`;
}
