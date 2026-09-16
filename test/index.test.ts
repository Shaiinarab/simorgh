// The Worker entry contract. `src/index.ts` no longer default-exports the bare Hono
// app — it exports a handler object so a `scheduled` handler can sit beside `fetch` —
// and a bare app cannot carry one. These assertions pin that shape, because getting it
// wrong is silent: `wrangler deploy` succeeds and the cron trigger simply never runs.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { DataTrustVault, FlockCoordinator, app } from "../src/index";

describe("worker entry", () => {
  it("exports a fetch handler and a scheduled handler", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });

  it("exposes the Durable Object classes the bindings name", () => {
    // wrangler.toml binds class_name FlockCoordinator / DataTrustVault. If either
    // top-level export disappears, the deploy fails at the migration step.
    expect(typeof FlockCoordinator).toBe("function");
    expect(typeof DataTrustVault).toBe("function");
  });

  it("routes through the exported Hono app", async () => {
    const res = await app.request("/health", undefined, env);
    expect(res.status).toBe(200);
  });

  it("the scheduled handler runs the flock sweep without throwing", async () => {
    // The cron contract: this must not throw, or the trigger fails every morning at
    // 06:15 and nothing reports it.
    await expect(
      worker.scheduled!(
        { scheduledTime: Date.now(), cron: "15 6 * * *", noRetry: () => {} },
        env,
        { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
      )
    ).resolves.toBeUndefined();
  });
});
