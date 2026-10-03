// HTTP contract tests.
//
// Bindings are real: KV really stores the offloaded context, and the ledger really
// writes to a Durable Object's SQLite. Only the *flock* is replaced, because the real
// one would dial Workers AI on every case (Homā is always-on by design) — which is why
// the routing policy gets its own fully-hermetic suite in flock-routing.test.ts.
//
// Faking the flock also lets these tests assert the thing that actually needs pinning:
// that the router hands the Durable Object the *allow-listed* tools, never the raw list
// a caller sent.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../src/index";

interface FlockCall {
  prompt: string;
  tools: string[];
}

const calls: FlockCall[] = [];

/**
 * A recording stand-in for the FLOCK_COORDINATOR namespace.
 *
 * `exhausted` exists because the happy-path stand-in made one whole behaviour
 * untestable: every `/execute` test took the answered branch, so the exhaustion path —
 * and with it the `Retry-After` header of Story 5.5 — had never been executed at the HTTP
 * layer by any test in this file. A stand-in that can only say "yes" is not a fixture, it
 * is a way of never finding out.
 */
function fakeFlockNamespace(opts: { exhausted?: boolean; cooldownUntil?: number } = {}) {
  const exhausted = opts.exhausted === true;
  const cooldownUntil = opts.cooldownUntil ?? 0;
  return {
    idFromName: (name: string) => name,
    get: () => ({
      async runFlock(prompt: string, tools: string[]) {
        calls.push({ prompt, tools });
        if (exhausted) {
          return {
            meta: {
              answered_by: "none",
              flock_attempts: [{ birdId: "stub", ok: false, error: "rate limited" }],
              error: "flock_exhausted",
            },
            answer: "All birds are tired. Please try again shortly.",
          };
        }
        return {
          meta: {
            answered_by: "Stub (test)",
            bird_id: "stub",
            ai_model: "stub-model",
            flock_attempts: [{ birdId: "stub", ok: true }],
          },
          answer: "stub-answer",
        };
      },
      async getFlockStatus() {
        // `dormant` is derived from the live secret reader in the real coordinator, so a
        // minimal bird needs the fields the retry policy actually reads.
        return {
          birds: [
            {
              id: "stub",
              name: "Stub",
              provider: "test",
              model: "stub-model",
              dormant: cooldownUntil === 0,
              status: cooldownUntil > 0 ? "tired" : "healthy",
              consecutiveFailures: cooldownUntil > 0 ? 1 : 0,
              totalCalls: 1,
              totalFailures: cooldownUntil > 0 ? 1 : 0,
              cooldownUntil,
            },
          ],
          timestamp: 0,
        };
      },
      async sweepStale() {
        return 0;
      },
      async checkRateLimit(_key: string, limit: number, windowMs: number) {
        return { allowed: true, limit, remaining: limit - 1, resetAt: Date.now() + windowMs };
      },
    }),
  };
}

function testEnv(flock: unknown = fakeFlockNamespace()): Env {
  return {
    AI: env.AI,
    CONTEXT_STORE: env.CONTEXT_STORE,
    DATA_TRUST_VAULT: env.DATA_TRUST_VAULT,
    FLOCK_COORDINATOR: flock,
    ENVIRONMENT: env.ENVIRONMENT,
    SIMORGH_API_KEY: "test-secret",
  } as unknown as Env;
}

const post = (body: unknown, flock?: unknown) =>
  app.request(
    "/api/v1/agent/execute",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify(body),
    },
    testEnv(flock)
  );

/**
 * Authenticated GET. The production-readiness change put `/api/v1/context/:refId`
 * and `/api/v1/user/:userId/logs` behind the same bearer token as `/execute`, so a
 * test that reads them anonymously asserts 401 and not the behaviour it names.
 */
const authedGet = (path: string) =>
  app.request(path, { headers: { Authorization: "Bearer test-secret" } }, testEnv());

describe("static routes", () => {
  it("GET / identifies the gateway", async () => {
    const res = await app.request("/", undefined, testEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Simorgh");
  });

  it("GET /health returns ok with a timestamp", async () => {
    const res = await app.request("/health", undefined, testEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("GET /dashboard serves the mission-control HTML", async () => {
    const res = await app.request("/dashboard", undefined, testEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("SIMORGH");
  });
});

describe("GET /api/v1/flock/status", () => {
  it("returns the live flock from the Durable Object", async () => {
    // Real bindings here, not `testEnv()`: this route only reads SQL, so it is fully
    // hermetic, and using the real FLOCK_COORDINATOR means the test covers the actual
    // namespace rather than the stand-in used by the /execute cases.
    const res = await app.request("/api/v1/flock/status", undefined, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { birds: { id: string; dormant: boolean }[] };
    expect(body.birds.map((b) => b.id)).toEqual(["shahin", "bulbul", "homa"]);
    // No secrets are configured in the test env; Homā must still be available.
    expect(body.birds.find((b) => b.id === "homa")?.dormant).toBe(false);
  });
});

describe("POST /api/v1/agent/execute", () => {
  // The agent loop runs real tools (search_web fetches DDG, get_server_time reads the
  // clock), so these tests stub `fetch` — the same hermeticity discipline as
  // flock-routing.test.ts. Without the stub, every /execute case would make an
  // outbound request, and a suite that needs the internet will eventually be disabled.
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("filters tools to the allow-list, runs them, and hands the DO a synthesis prompt", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ AbstractText: "Simorgh is thirty birds." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    calls.length = 0;
    const res = await post({
      prompt: "hello flock",
      tools: ["search_web", "rm_rf_root", "get_server_time", "drop_tables"],
      userId: "u-allow",
      tier: "Free-Volunteer",
    });

    expect(res.status).toBe(200);
    // The security property: unknown tools are dropped, order preserved — and the
    // DO receives the *synthesis prompt* (original request + folded tool results),
    // not the raw prompt, because the bird answers from real tool output.
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toEqual(["search_web", "get_server_time"]);
    expect(calls[0].prompt).toContain("Request: hello flock");
    expect(calls[0].prompt).toContain("[search_web] Simorgh is thirty birds.");
    expect(calls[0].prompt).toContain("- [get_server_time] ");
    expect(calls[0].prompt).not.toContain("rm_rf_root");

    const body = (await res.json()) as {
      success: boolean;
      agentResponse: string;
      meta: {
        answered_by: string;
        contextRefId: string;
        loggedToLedger: boolean;
        tool_iterations: number;
        tools_requested: string[];
        tool_observations: { tool: string; iteration: number; ok: boolean }[];
      };
    };
    expect(body.success).toBe(true);
    expect(body.agentResponse).toBe("stub-answer");
    expect(body.meta.loggedToLedger).toBe(true);
    expect(body.meta.contextRefId).toMatch(/^[0-9a-f-]{36}$/);
    // Real loop telemetry, not the old hardcoded zero.
    expect(body.meta.tool_iterations).toBe(2);
    expect(body.meta.tools_requested).toEqual(["search_web", "get_server_time"]);
    // Observations carry their results: the transparency story means the caller
    // sees exactly what each tool returned, not just that it ran.
    expect(body.meta.tool_observations).toEqual([
      { tool: "search_web", iteration: 0, ok: true, result: "Simorgh is thirty birds." },
      { tool: "get_server_time", iteration: 1, ok: true, result: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
  });

  it("reports a failing tool as a failed observation and still answers", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("network unreachable");
    }) as typeof fetch;

    calls.length = 0;
    const res = await post({ prompt: "will this break?", tools: ["search_web"] });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      meta: { tool_observations: { tool: string; iteration: number; ok: boolean; result: string }[] };
    };
    expect(body.success).toBe(true);
    expect(body.meta.tool_observations).toEqual([
      { tool: "search_web", iteration: 0, ok: false, result: expect.stringContaining("network unreachable") },
    ]);
    // The DO was still asked to answer — with the failure folded in as prose.
    expect(calls[0].prompt).toContain("[search_web] failed:");
  });

  it("passes an empty tool list and skips the loop entirely", async () => {
    calls.length = 0;
    await post({ prompt: "nothing allowed", tools: ["rm_rf_root"] });
    expect(calls[0].tools).toEqual([]);
    // No tools ⇒ no iterations, and the prompt is passed through untouched —
    // a tool-free request must not be wrapped in synthesis scaffolding.
    expect(calls[0].prompt).toBe("nothing allowed");
  });

  it("offloads the context to KV and serves it back by reference", async () => {
    const res = await post({ prompt: "remember this", tools: ["get_server_time"] });
    const { meta } = (await res.json()) as { meta: { contextRefId: string } };

    const stored = await authedGet(`/api/v1/context/${meta.contextRefId}`);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({
      prompt: "remember this",
      tools: ["get_server_time"],
    });
  });

  it("404s a well-formed but unknown context reference", async () => {
    const res = await authedGet("/api/v1/context/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("400s a malformed context reference before it reaches KV", async () => {
    // Shape is checked ahead of the lookup on purpose: without it, any authenticated
    // caller could probe arbitrary KV keys by guessing reference strings.
    const res = await authedGet("/api/v1/context/does-not-exist");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_CONTEXT_REF"
    );
  });

  it("records the call in the transparency ledger, defaulting identity for anonymous callers", async () => {
    const res = await post({ prompt: "anonymous please", tools: [] });
    const { meta } = (await res.json()) as { meta: { contextRefId: string } };

    const logs = await authedGet("/api/v1/user/anonymous/logs");
    expect(logs.status).toBe(200);

    const body = (await logs.json()) as {
      userId: string;
      count: number;
      entries: { ref_id: string; tier: string; action: string }[];
    };
    expect(body.userId).toBe("anonymous");
    // Find *this* call's row rather than asserting an absolute count: every anonymous
    // call in this file lands in the same 'global' vault, and the object is not reset
    // between tests. Counting rows would make the assertion order-dependent.
    const entry = body.entries.find((e) => e.ref_id === meta.contextRefId);
    expect(entry).toMatchObject({ tier: "Free-Volunteer", action: "execute" });
  });

  it("logs the caller's own identity when given one", async () => {
    await post({ prompt: "identify me", tools: [], userId: "u-ledger", tier: "Pro-Data-Pact" });

    const logs = await authedGet("/api/v1/user/u-ledger/logs");
    const body = (await logs.json()) as { count: number; entries: { tier: string }[] };
    expect(body.count).toBe(1);
    expect(body.entries[0].tier).toBe("Pro-Data-Pact");
  });
});


// Story 5.5 — an exhausted flock is backpressure, and backpressure a client cannot read
// is indistinguishable from a gateway that is simply broken. These run at the HTTP layer
// because the engine-level tests cannot see whether the route emits the header at all.
describe("flock exhaustion (Story 5.5)", () => {
  it("tells a cooling flock how long to wait", async () => {
    // 30s of cooldown left must read as Retry-After: 30, not 29 and not 60.
    const res = await post(
      { prompt: "hello" },
      fakeFlockNamespace({ exhausted: true, cooldownUntil: Date.now() + 30_000 })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = (await res.json()) as { agentResponse: string; meta: { error?: string } };
    expect(body.meta.error).toBe("flock_exhausted");
  });

  it("omits Retry-After when no bird is cooling down, rather than inventing a wait", async () => {
    // The honest case, and the one a lazy implementation gets wrong. Dormant birds fail
    // for a reason retrying cannot fix — no API key — so a fabricated 60s would make a
    // client machine poll a configuration problem and call it backpressure.
    const res = await post(
      { prompt: "hello" },
      fakeFlockNamespace({ exhausted: true, cooldownUntil: 0 })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBeNull();
    const body = (await res.json()) as { meta: { error?: string } };
    expect(body.meta.error).toBe("flock_exhausted");
  });

  it("never emits Retry-After: 0, which would invite an immediate hot loop", async () => {
    // A cooldown 100ms out rounds to 0 seconds. The header must be clamped to the floor.
    const res = await post(
      { prompt: "hello" },
      fakeFlockNamespace({ exhausted: true, cooldownUntil: Date.now() + 100 })
    );

    expect(res.headers.get("Retry-After")).toBe("1");
  });

  it("leaves Retry-After off a successful answer", async () => {
    // Completeness, not containment: the header must be absent, not merely correct when
    // present. A `Retry-After` on a 200 would make clients back off a request that
    // succeeded.
    const res = await post({ prompt: "hello" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBeNull();
    const body = (await res.json()) as { agentResponse: string };
    expect(body.agentResponse).toBe("stub-answer");
  });

  it("keeps the exhaustion answer honest rather than fabricating one", async () => {
    // The engine's own contract: exhaustion says so in `meta.error` and answers in prose.
    // A client that only reads the body must still be able to tell this apart from success.
    const res = await post(
      { prompt: "hello" },
      fakeFlockNamespace({ exhausted: true, cooldownUntil: Date.now() + 5_000 })
    );
    const body = (await res.json()) as {
      agentResponse: string;
      meta: { answered_by: string; error?: string; flock_attempts: unknown[] };
    };

    expect(body.agentResponse).not.toBe("stub-answer");
    expect(body.meta.answered_by).toBe("none");
    expect(body.meta.error).toBe("flock_exhausted");
    expect(body.meta.flock_attempts).toHaveLength(1);
  });
});
