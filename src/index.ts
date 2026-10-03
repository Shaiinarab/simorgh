import { Hono } from "hono";
import type { Context } from "hono";
import { FlockCoordinator } from "./flock";
import { DataTrustVault } from "./data-trust";
import { renderDashboard } from "./dashboard";
import { AGENT_TOOLS } from "./agent";
import { flockRetryAfterSeconds } from "@simorgh/phoenix-core";
import { executeAgent } from "./agent-service";
import {
  authenticateServiceRequest,
  isAllowedOrigin,
  parseExecuteBody,
  RequestValidationError,
} from "./security";
import { handleTelegramWebhook } from "./telegram";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.header("X-Request-Id", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  await next();
});

app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin");

  if (origin) {
    if (!isAllowedOrigin(origin, c.env)) {
      return c.json(
        {
          success: false,
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message: "Origin is not allow-listed.",
            requestId: c.res.headers.get("X-Request-Id"),
          },
        },
        403
      );
    }

    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Simorgh-User-Id"
    );
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Expose-Headers", "X-Request-Id, Retry-After");
    c.header("Access-Control-Max-Age", "86400");
  }

  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

async function requireServiceAuth(
  c: Context<{ Bindings: Env }>
): Promise<Response | undefined> {
  const auth = await authenticateServiceRequest(c.req.raw, c.env);
  if (auth.ok) return undefined;

  const response = c.json(
    {
      success: false,
      error: {
        code: auth.code,
        message:
          auth.code === "AUTH_NOT_CONFIGURED"
            ? "Simorgh API authentication is not configured."
            : "A valid Bearer token is required.",
        requestId: c.res.headers.get("X-Request-Id"),
      },
    },
    auth.status
  );
  if (auth.status === 401) response.headers.set("WWW-Authenticate", "Bearer");
  return response;
}

app.onError((error, c) => {
  const requestId = c.res.headers.get("X-Request-Id") ?? "unknown";
  console.error(
    JSON.stringify({
      event: "request_error",
      requestId,
      error: String(error),
      path: c.req.path,
      method: c.req.method,
    })
  );

  if (error instanceof RequestValidationError) {
    return c.json(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          requestId,
        },
      },
      error.status
    );
  }

  return c.json(
    {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        requestId,
      },
    },
    500
  );
});

app.get("/", (c) => c.text("Simorgh Edge Gateway — the flock is awake."));

app.get("/health", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/dashboard", (c) => c.html(renderDashboard(c.env)));

app.get("/api/v1/flock/status", async (c) => {
  const id = c.env.FLOCK_COORDINATOR.idFromName("global");
  const stub = c.env.FLOCK_COORDINATOR.get(id);
  return c.json(await stub.getFlockStatus());
});

/**
 * Minimum `Retry-After` for an exhausted flock. One second is enough to break a hot loop
 * without being so coarse that a 3-second cooldown becomes a minute-long stall.
 */
const FLOCK_RETRY_FLOOR_SECONDS = 1;

app.post("/api/v1/agent/execute", async (c) => {
  const denied = await requireServiceAuth(c);
  if (denied) return denied;

  const raw = await c.req.text();
  const request = parseExecuteBody(
    raw,
    AGENT_TOOLS,
    c.req.header("X-Simorgh-User-Id")
  );

  const id = c.env.FLOCK_COORDINATOR.idFromName("global");
  const limiter = c.env.FLOCK_COORDINATOR.get(id);
  const decision = await limiter.checkRateLimit(
    "execute:" + request.userId,
    20,
    60_000
  );

  c.header("X-RateLimit-Limit", String(decision.limit));
  c.header("X-RateLimit-Remaining", String(decision.remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));

  if (!decision.allowed) {
    const retryAfter = Math.max(
      1,
      Math.ceil((decision.resetAt - Date.now()) / 1000)
    );
    c.header("Retry-After", String(retryAfter));
    return c.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Execution rate limit reached.",
          requestId: c.res.headers.get("X-Request-Id"),
        },
      },
      429
    );
  }

  const result = await executeAgent(c.env, {
    prompt: request.prompt,
    tools: request.tools,
    userId: request.userId,
    tier: request.tier,
    blockedTools: request.blockedTools,
    requestId: c.res.headers.get("X-Request-Id") ?? undefined,
  });

  // Story 5.5: exhaustion is backpressure, and backpressure without a machine-readable
  // retry hint forces every client to invent a backoff. `flockRetryAfterSeconds` returns
  // null when no bird is cooling down, and the header is then omitted deliberately — see
  // its comment for why a made-up number would be worse than no number.
  if (result.meta.error === "flock_exhausted") {
    const status = await limiter.getFlockStatus();
    const retryAfter = flockRetryAfterSeconds(
      status.birds.map((b) => b.cooldownUntil),
      Date.now(),
      FLOCK_RETRY_FLOOR_SECONDS
    );
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter));
    }
  }

  return c.json(result);
});

app.get("/api/v1/context/:refId", async (c) => {
  const denied = await requireServiceAuth(c);
  if (denied) return denied;

  const refId = c.req.param("refId");
  if (!/^[0-9a-f-]{36}$/i.test(refId)) {
    return c.json(
      {
        success: false,
        error: {
          code: "INVALID_CONTEXT_REF",
          message: "Invalid context reference.",
          requestId: c.res.headers.get("X-Request-Id"),
        },
      },
      400
    );
  }

  const data = await c.env.CONTEXT_STORE.get("ctx_" + refId);
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json(JSON.parse(data));
});

app.get("/api/v1/user/:userId/logs", async (c) => {
  const denied = await requireServiceAuth(c);
  if (denied) return denied;

  const userId = c.req.param("userId");
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(userId)) {
    return c.json(
      {
        success: false,
        error: {
          code: "INVALID_USER_ID",
          message: "Invalid user ID.",
          requestId: c.res.headers.get("X-Request-Id"),
        },
      },
      400
    );
  }

  const vaultId = c.env.DATA_TRUST_VAULT.idFromName("global");
  const vault = c.env.DATA_TRUST_VAULT.get(vaultId);
  return c.json(await vault.getUserLogs(userId));
});

app.post("/api/v1/telegram/webhook", (c) =>
  handleTelegramWebhook(c.req.raw, c.env)
);

app.notFound((c) =>
  c.json(
    {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
        requestId: c.res.headers.get("X-Request-Id"),
      },
    },
    404
  )
);

const scheduled: ExportedHandlerScheduledHandler<Env> = async (
  _controller,
  env
) => {
  const id = env.FLOCK_COORDINATOR.idFromName("global");
  const stub = env.FLOCK_COORDINATOR.get(id);
  const changed = await stub.sweepStale(Date.now());
  console.log(JSON.stringify({ event: "flock_sweep", changed }));
};

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
export { app, FlockCoordinator, DataTrustVault };
