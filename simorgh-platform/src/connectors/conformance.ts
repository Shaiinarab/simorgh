// ── Connector conformance kit ───────────────────────────────
//
// A list of assertions every `CoreConnector` must satisfy, run against
// each implementation. A future connector (gRPC, plain WebSocket, ...)
// is validated by running the kit, not by re-reading test files.
//
// The kit takes a factory `(script) => CoreConnector` so it can script
// the double per check without importing from `test/`. `FakeCoreScript`
// is defined here in `src/` (a configuration type for the kit), and
// `test/support/fake-core.ts` imports it — dependency direction is
// always `test → src`, never the reverse.

import type { FlockStatus } from "@simorgh/phoenix-core";

import type { CoreConnector } from "./types.ts";

export interface FakeCoreScript {
  /** What each provider did, in order. Drives meta.flock_attempts. */
  attempts?: { providerId: string; ok: boolean; error?: string }[];
  /** agentResponse; default a fixed string. */
  answer?: string;
  /** meta.answered_by. */
  answeredBy?: string;
  /** Force a bare HTTP failure from every route. */
  httpStatus?: number;
  /** FlockStatus the status route reports. */
  flockStatus?: FlockStatus;
  /** Capture every request the double saw, for assertions. */
  record?: { url: string; method: string; body?: string }[];
}

export interface ConformanceCheck {
  name: string; // stable, greppable
  ok: boolean;
  detail: string; // what was observed — includes actual value on failure
}

export interface ConformanceOptions {
  /** Factory: creates a fresh connector for each check, given the script. */
  connector: (script: FakeCoreScript) => CoreConnector;
  /** The endpoint the connector was constructed with, for the endpoint check. */
  endpoint: string;
}

const HEALTHY_SCRIPT: FakeCoreScript = {
  attempts: [{ providerId: "shahin", ok: true }],
  answer: "the fake core answers",
  answeredBy: "Shāhīn (Groq (OpenAI-compat))",
};

async function tryCatch(
  fn: () => Promise<unknown>,
): Promise<{ ok: boolean; value: unknown; error: string }> {
  try {
    const value = await fn();
    return { ok: true, value, error: "" };
  } catch (e) {
    return { ok: false, value: undefined, error: String(e) };
  }
}

async function check(
  name: string,
  fn: () => Promise<unknown>,
): Promise<ConformanceCheck> {
  const { ok, value, error } = await tryCatch(fn);
  const detail = ok && value !== undefined
    ? JSON.stringify(value)
    : error;
  return { name, ok, detail };
}

export async function runConnectorConformance(
  options: ConformanceOptions,
): Promise<ConformanceCheck[]> {
  const { connector: makeConnector, endpoint } = options;
  const checks: ConformanceCheck[] = [];

  // 1. health() resolves — never rejects — when the core is unreachable,
  //    and reports reachable: false.
  checks.push(
    await check("health-resolves-when-core-is-down", async () => {
      const c = makeConnector({ httpStatus: 503 });
      const h = await c.health();
      if (h.reachable !== false) {
        throw new Error(
          `expected reachable=false, got reachable=${h.reachable}`,
        );
      }
      return { reachable: h.reachable, detail: h.detail };
    }),
  );

  // 2. health() reports reachable: true and a numeric latencyMs against
  //    a healthy core.
  checks.push(
    await check("health-reachable-when-core-is-up", async () => {
      const c = makeConnector(HEALTHY_SCRIPT);
      const h = await c.health();
      if (h.reachable !== true) {
        throw new Error(`expected reachable=true, got ${h.reachable}`);
      }
      if (typeof h.latencyMs !== "number") {
        throw new Error(`expected numeric latencyMs, got ${h.latencyMs}`);
      }
      return { reachable: h.reachable, latencyMs: h.latencyMs };
    }),
  );

  // 3. status() returns a payload whose providers carry the core's real
  //    field names (id on each bird at minimum).
  checks.push(
    await check("status-returns-providers", async () => {
      const c = makeConnector(HEALTHY_SCRIPT);
      const s = await c.status();
      const firstBird = s.birds[0];
      if (s.birds.length === 0 || typeof firstBird?.id !== "string") {
        throw new Error(
          `expected non-empty birds with id, got birds=${s.birds.length}`,
        );
      }
      return { birds: s.birds.length, firstId: firstBird.id };
    }),
  );

  // 4. ask() maps answered_by into AskResult.answeredBy and
  //    flock_attempts[].birdId into attempts[].providerId — the same
  //    mapping for both connectors.
  checks.push(
    await check("ask-maps-answered-by-and-attempts", async () => {
      const script: FakeCoreScript = {
        ...HEALTHY_SCRIPT,
        answeredBy: "Shāhīn (Groq (OpenAI-compat))",
        attempts: [
          { providerId: "shahin", ok: true },
          { providerId: "homa", ok: false, error: "dormant" },
        ],
      };
      const c = makeConnector(script);
      const r = await c.ask({ prompt: "hi" });
      const answeredByOk = r.answeredBy === "Shāhīn (Groq (OpenAI-compat))";
      const attemptsOk =
        r.attempts.length === 2 &&
        r.attempts[0].providerId === "shahin" &&
        r.attempts[1].providerId === "homa";
      if (!answeredByOk || !attemptsOk) {
        throw new Error(
          `answeredBy=${r.answeredBy} attempts=${JSON.stringify(r.attempts)}`,
        );
      }
      return { answeredBy: r.answeredBy, attempts: r.attempts };
    }),
  );

  // 5. ask() on a core with no usable provider returns success: false with
  //    an error, rather than throwing. A user-visible failure must be a
  //    value, not an exception.
  checks.push(
    await check("ask-returns-value-when-no-provider", async () => {
      const script: FakeCoreScript = {
        attempts: [{ providerId: "shahin", ok: false, error: "flock_exhausted" }],
        answer: "",
      };
      const c = makeConnector(script);
      const r = await c.ask({ prompt: "hi" });
      if (r.success !== false) {
        throw new Error(`expected success=false, got ${r.success}`);
      }
      if (!r.error) {
        throw new Error("expected error to be defined");
      }
      return { success: r.success, error: r.error };
    }),
  );

  // 6. The failure modes are distinguishable: a 401 and a 503 must not
  //    produce identical error text.
  checks.push(
    await check("failure-modes-are-distinguishable", async () => {
      const c401 = makeConnector({ httpStatus: 401 });
      const c503 = makeConnector({ httpStatus: 503 });
      const r401 = await tryCatch(() => c401.ask({ prompt: "x" }));
      const r503 = await tryCatch(() => c503.ask({ prompt: "x" }));
      const err401 = r401.error || "";
      const err503 = r503.error || "";
      if (err401 === err503 || err401 === "" || err503 === "") {
        throw new Error(`401="${err401}" 503="${err503}"`);
      }
      return { "401": err401, "503": err503 };
    }),
  );

  // 7. connector.endpoint is exactly the endpoint it was constructed with
  //    (no silent rewriting).
  checks.push(
    await check("endpoint-is-exact", async () => {
      const c = makeConnector(HEALTHY_SCRIPT);
      if (c.endpoint !== endpoint) {
        throw new Error(
          `expected endpoint="${endpoint}", got="${c.endpoint}"`,
        );
      }
      return { endpoint: c.endpoint };
    }),
  );

  return checks;
}
