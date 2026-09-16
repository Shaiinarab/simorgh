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
import { describe, expect, it } from "vitest";
import { app } from "../src/index";

interface FlockCall {
  prompt: string;
  tools: string[];
}

const calls: FlockCall[] = [];

/** A recording stand-in for the FLOCK_COORDINATOR namespace. */
function fakeFlockNamespace() {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      async runFlock(prompt: string, tools: string[]) {
        calls.push({ prompt, tools });
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
        return { birds: [], timestamp: 0 };
      },
      async sweepStale() {
        return 0;
      },
    }),
  };
}

function testEnv(): Env {
  return {
    AI: env.AI,
    CONTEXT_STORE: env.CONTEXT_STORE,
    DATA_TRUST_VAULT: env.DATA_TRUST_VAULT,
    FLOCK_COORDINATOR: fakeFlockNamespace(),
    ENVIRONMENT: env.ENVIRONMENT,
  } as unknown as Env;
}

const post = (body: unknown) =>
  app.request(
    "/api/v1/agent/execute",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    testEnv()
  );

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
  it("filters tools to the allow-list before they reach the agent", async () => {
    calls.length = 0;
    const res = await post({
      prompt: "hello flock",
      tools: ["search_web", "rm_rf_root", "get_server_time", "drop_tables"],
      userId: "u-allow",
      tier: "Free-Volunteer",
    });

    expect(res.status).toBe(200);
    // The security property: unknown tools are dropped, order preserved.
    expect(calls).toEqual([{ prompt: "hello flock", tools: ["search_web", "get_server_time"] }]);

    const body = (await res.json()) as {
      success: boolean;
      agentResponse: string;
      meta: { answered_by: string; contextRefId: string; loggedToLedger: boolean };
    };
    expect(body.success).toBe(true);
    expect(body.agentResponse).toBe("stub-answer");
    expect(body.meta.loggedToLedger).toBe(true);
    expect(body.meta.contextRefId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes an empty tool list when the caller asks only for disallowed tools", async () => {
    calls.length = 0;
    await post({ prompt: "nothing allowed", tools: ["rm_rf_root"] });
    expect(calls[0].tools).toEqual([]);
  });

  it("offloads the context to KV and serves it back by reference", async () => {
    const res = await post({ prompt: "remember this", tools: ["get_server_time"] });
    const { meta } = (await res.json()) as { meta: { contextRefId: string } };

    const stored = await app.request(`/api/v1/context/${meta.contextRefId}`, undefined, testEnv());
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({
      prompt: "remember this",
      tools: ["get_server_time"],
    });
  });

  it("404s an unknown context reference", async () => {
    const res = await app.request("/api/v1/context/does-not-exist", undefined, testEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("records the call in the transparency ledger, defaulting identity for anonymous callers", async () => {
    const res = await post({ prompt: "anonymous please", tools: [] });
    const { meta } = (await res.json()) as { meta: { contextRefId: string } };

    const logs = await app.request("/api/v1/user/anonymous/logs", undefined, testEnv());
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

    const logs = await app.request("/api/v1/user/u-ledger/logs", undefined, testEnv());
    const body = (await logs.json()) as { count: number; entries: { tier: string }[] };
    expect(body.count).toBe(1);
    expect(body.entries[0].tier).toBe("Pro-Data-Pact");
  });
});
