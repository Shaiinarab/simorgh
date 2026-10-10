// The unified control plane — connectors, tools, and the routes behind the panels.
//
// Three kinds of assertion here, each guarding a different failure:
//
//   1. **Precedence.** `not-wired` must win over a missing secret. Reversing the two
//      produces the wrong-but-plausible page: an operator sent to add a GitHub token
//      for an integration no code calls.
//   2. **Anti-drift.** Every surface the connector registry declares is dialled here
//      for real. A matrix that advertises a route nobody implemented is worse than a
//      missing entry, because it is believed — and this is the cheap check that stops
//      the registry becoming a wishlist.
//   3. **No leaks.** The page is server-rendered with the live environment in hand, so
//      the test plants distinctive secret values and asserts none of them reach the
//      HTML. `present: true` is fine to expose; the value is not.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { app } from "../src/index";
import { renderDashboard } from "../src/dashboard";
import { CONNECTORS, connectorReadiness, toolSurface } from "../src/platform";
import { AGENT_TOOLS, MAX_TOOL_ITERATIONS, MAX_TOOL_RESULT_CHARS } from "../src/agent";

const KEY = "test-bearer-key-0123456789";

/**
 * `env` plus a bearer key, without mutating the shared binding set: the key is the
 * deployment fact this suite varies, and the DO/KV bindings must stay the real ones so
 * the quota and schedule routes are exercised end-to-end rather than against a stub.
 */
const withKey = Object.assign({}, env, { SIMORGH_API_KEY: KEY }) as Env;
const authed = { Authorization: "Bearer " + KEY };

/**
 * The deployment with **no** service key configured — stated explicitly, not inherited.
 *
 * The fail-closed suites used to pass the ambient `env` and expect `503
 * AUTH_NOT_CONFIGURED`. That only held on a machine with no `SIMORGH_API_KEY` set, and
 * `.dev.vars` is gitignored, so CI proved nothing about the local case: an operator who
 * had ever run `upm run dev` with a key in `.dev.vars` got two red tests claiming the
 * app does not fail closed, when in fact the app *is* configured and correctly answers
 * `401` to a request with no token.
 *
 * The premise is now an object, so the test proves the fail-closed branch rather than
 * the absence of a local file. A test that passes because of what is not on disk is
 * not a test.
 */
const unconfigured = Object.assign({}, env, {
  SIMORGH_API_KEY: undefined,
}) as Env;

const UUID = "00000000-0000-4000-8000-000000000000";

/** Substitute the route params so a declared surface can actually be dialled. */
function concrete(path: string): string {
  return path.replace(":refId", UUID).replace(":userId", "dashboard");
}

describe("connectorReadiness — the three states", () => {
  it("reports the host as live with no secrets required", () => {
    const cloudflare = connectorReadiness(env).find((c) => c.id === "cloudflare");

    expect(cloudflare?.status).toBe("live");
    expect(cloudflare?.secrets).toEqual([]);
    expect(cloudflare?.missing).toEqual([]);
  });

  it("reports a declared-but-unbuilt connector as not-wired, even with its secret set", () => {
    // The precedence test. If `needs-secret` were checked first, this would read
    // "needs a secret" the moment the token was absent — and, with the token present,
    // would read "live" for a platform nothing calls. Both are wrong.
    const withToken = Object.assign({}, env, { GITHUB_TOKEN: "gh-present" }) as Env;
    const github = connectorReadiness(withToken).find((c) => c.id === "github");

    expect(github?.status).toBe("not-wired");
    expect(github?.surfaces).toEqual([]);
  });

  it("asks for the one required Telegram secret and is live once it arrives", () => {
    const dark = connectorReadiness(env).find((c) => c.id === "telegram");
    expect(dark?.status).toBe("needs-secret");
    expect(dark?.missing).toEqual(["TELEGRAM_BOT_TOKEN"]);

    const lit = connectorReadiness(
      Object.assign({}, env, { TELEGRAM_BOT_TOKEN: "tg-live" }) as Env
    ).find((c) => c.id === "telegram");
    expect(lit?.status).toBe("live");
    expect(lit?.missing).toEqual([]);
  });

  it("does not block on an optional secret", () => {
    // TELEGRAM_WEBHOOK_SECRET is optional: absent changes the webhook's auth posture,
    // not whether the connector works. A required-flag bug here would mark a working
    // connector dead.
    const lit = connectorReadiness(
      Object.assign({}, env, { TELEGRAM_BOT_TOKEN: "tg-live" }) as Env
    ).find((c) => c.id === "telegram");

    const webhookSecret = lit?.secrets.find((s) => s.name === "TELEGRAM_WEBHOOK_SECRET");
    expect(webhookSecret?.present).toBe(false);
    expect(webhookSecret?.required).toBe(false);
    expect(lit?.missing).toEqual([]);
  });

  it("treats a blank secret as absent rather than present", () => {
    // `wrangler secret put` with an empty value is a real way to get a whitespace
    // secret, and treating it as configured would show a dead connector as live.
    const spaced = connectorReadiness(
      Object.assign({}, env, { TELEGRAM_BOT_TOKEN: "   " }) as Env
    ).find((c) => c.id === "telegram");

    expect(spaced?.status).toBe("needs-secret");
    expect(spaced?.missing).toEqual(["TELEGRAM_BOT_TOKEN"]);
  });
});

describe("the declared surface is the real surface", () => {
  it("routes every declared connector surface", async () => {
    const declared = CONNECTORS.flatMap((c) =>
      c.surfaces.map((s) => ({ connector: c.id, ...s }))
    );
    expect(declared.length).toBeGreaterThan(0);

    for (const surface of declared) {
      const res = await app.request(
        concrete(surface.path),
        { method: surface.method },
        unconfigured
      );

      // 404 is the only answer that means "no such route". The rest are real handlers
      // refusing for their own reasons, which is exactly what an authed route does
      // with no key configured.
      expect(
        res.status,
        `${surface.method} ${surface.path} (${surface.connector}) answered 404`
      ).not.toBe(404);

      if (surface.auth) {
        // Fail-closed is the deployment's stated posture: no key configured is a
        // refusal, never an open route.
        expect(
          res.status,
          `${surface.method} ${surface.path} did not fail closed`
        ).toBe(503);
      }
    }
  });
});

describe("control-plane routes", () => {
  it("fails closed on every authed panel when no key is configured", async () => {
    for (const path of [
      "/api/v1/quota",
      "/api/v1/schedule",
      "/api/v1/platform/connectors",
    ]) {
      const res = await app.request(path, undefined, unconfigured);
      expect(res.status, path).toBe(503);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("AUTH_NOT_CONFIGURED");
    }
  });

  it("refuses a wrong bearer token", async () => {
    const res = await app.request(
      "/api/v1/quota",
      { headers: { Authorization: "Bearer not-the-key" } },
      withKey
    );
    expect(res.status).toBe(401);

    const res2 = await app.request("/api/v1/quota", { headers: authed }, withKey);
    expect(res2.status).toBe(200);
  });

  it("serves the connector matrix the page is rendered from", async () => {
    const res = await app.request(
      "/api/v1/platform/connectors",
      { headers: authed },
      withKey
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      schemaVersion: number;
      connectors: ReturnType<typeof connectorReadiness>;
      tools: ReturnType<typeof toolSurface>;
    };

    expect(body.schemaVersion).toBe(1);
    // Same function the page calls, so the tab and the endpoint cannot disagree.
    expect(body.connectors).toEqual(connectorReadiness(withKey));
    expect(body.tools).toEqual(toolSurface());
  });

  it("reads quota through the real Durable Object binding", async () => {
    const res = await app.request("/api/v1/quota", { headers: authed }, withKey);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("scheduling a flight", () => {
  it("stores a valid schedule and lists it back", async () => {
    const id = "test-schedule-" + Date.now();
    const resumeAt = Date.now() + 60_000;

    const created = await app.request(
      "/api/v1/schedule",
      {
        method: "POST",
        headers: { ...authed, "Content-Type": "application/json" },
        body: JSON.stringify({ id, prompt: "What is the time?", tools: ["get_server_time"], resumeAt }),
      },
      withKey
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id, resumeAt });

    const list = await app.request("/api/v1/schedule", { headers: authed }, withKey);
    const rows = (await list.json()) as { id: string; state: string }[];
    expect(rows.find((r) => r.id === id)?.state).toBe("pending");
  });

  it("refuses the inputs that would become a silent no-op", async () => {
    async function post(body: unknown) {
      return app.request(
        "/api/v1/schedule",
        {
          method: "POST",
          headers: { ...authed, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        withKey
      );
    }

    const now = Date.now();
    const base = { id: "ok-id", prompt: "hello", resumeAt: now + 60_000 };

    const cases: [string, unknown, string][] = [
      ["a blank id", { ...base, id: "" }, "invalid_schedule_id"],
      ["an id with a path separator", { ...base, id: "../../etc" }, "invalid_schedule_id"],
      ["an empty prompt", { ...base, prompt: "   " }, "invalid_prompt"],
      ["a non-numeric resumeAt", { ...base, resumeAt: "tomorrow" }, "invalid_resume_at"],
      [
        "a resumeAt far in the past",
        { ...base, resumeAt: now - 3_600_000 },
        "resume_at_out_of_range",
      ],
      [
        "a resumeAt another year out",
        { ...base, resumeAt: now + 400 * 24 * 3_600_000 },
        "resume_at_out_of_range",
      ],
      [
        "more tools than the cap allows",
        { ...base, tools: Array.from({ length: 9 }, () => "get_server_time") },
        "too_many_tools",
      ],
    ];

    for (const [label, body, code] of cases) {
      const res = await post(body);
      expect(res.status, label).toBe(400);
      expect((await res.json()) as unknown, label).toMatchObject({
        error: { code },
      });
    }
  });
});

describe("the dashboard page", () => {
  const crafted = Object.assign({}, env, {
    SIMORGH_API_KEY: "super-secret-value-xyz",
    TELEGRAM_BOT_TOKEN: "tg-secret-value-xyz",
  }) as Env;

  it("renders the connector matrix server-side, with readiness read from the environment", () => {
    const html = renderDashboard(crafted);

    for (const connector of CONNECTORS) {
      expect(html).toContain(connector.label);
    }
    // The Telegram card must reflect the token that is present, not a constant.
    expect(html).toContain("live");
    expect(html).toContain("not wired");
  });

  it("never emits a secret value, only whether one is present", () => {
    const html = renderDashboard(crafted);

    expect(html).not.toContain("super-secret-value-xyz");
    expect(html).not.toContain("tg-secret-value-xyz");
    // Names are fine — that is how an operator knows what to set.
    expect(html).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("serves the page unauthenticated, because it ships no secret and gates its own calls", async () => {
    const res = await app.request("/dashboard", undefined, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("CONTROL PLANE");
  });
});

describe("toolSurface", () => {
  it("mirrors the allow-list the executor enforces", () => {
    const names = toolSurface().map((t) => t.name);
    for (const tool of AGENT_TOOLS) expect(names).toContain(tool);
  });

  it("states the real budgets", () => {
    const names = toolSurface().map((t) => t.name);
    expect(names).toContain(`≤${MAX_TOOL_ITERATIONS} iterations`);
    expect(names).toContain(`≤${MAX_TOOL_RESULT_CHARS} chars/result`);
  });
});
