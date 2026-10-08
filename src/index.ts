import { Hono } from "hono";
import type { Context } from "hono";
import { FlockCoordinator, readFlockStatus } from "./flock";
import { DataTrustVault } from "./data-trust";
import { renderDashboard } from "./dashboard";
import { AGENT_TOOLS } from "./agent";
import { flockRetryAfterSeconds, rateLimitHeaders } from "@simorgh/phoenix-core";
import { executeAgent } from "./agent-service";
import {
  authenticateServiceIdentity,
  authenticateServiceRequest,
  isAllowedOrigin,
  MAX_EXECUTE_BODY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TOOLS,
  parseExecuteBody,
  RequestValidationError,
  subjectMatches,
} from "./security";
import { connectorReadiness, toolSurface } from "./platform";
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

/**
 * Auth *and* identity, for the routes that return a resource named in the URL.
 *
 * `requireServiceAuth` above answers "is somebody with a valid token calling?". That was
 * the whole check on `/api/v1/user/:userId/logs` and `/api/v1/context/:refId`, and it is
 * not sufficient for either: both read the thing they return *out of the URL*, so a
 * valid token let any caller name any user and take their ledger — and, because the
 * ledger returns each request's `refId`, then take that user's stored prompts too.
 *
 * Resolving a subject from the credential is what turns the URL parameter into a claim
 * that gets checked rather than a value that gets trusted.
 *
 * Returns the subject on success, or the `Response` to send instead. The middle case,
 * `503 IDENTITY_UNRESOLVED`, is deliberate: the token is valid but the deployment cannot
 * say which user it speaks for (no `SIMORGH_API_KEYS` map). Guessing an identity there
 * would reintroduce exactly the bug this closes, so it refuses instead — and the remedy
 * named in the message is configuration, not a new credential.
 */
async function requireIdentity(
  c: Context<{ Bindings: Env }>
): Promise<{ subject: string } | Response> {
  const auth = await authenticateServiceIdentity(c.req.raw, c.env);
  if (auth.ok) return { subject: auth.subject };

  const response = c.json(
    {
      success: false,
      error: {
        code: auth.code,
        message:
          auth.code === "AUTH_NOT_CONFIGURED"
            ? "Simorgh API authentication is not configured."
            : auth.code === "IDENTITY_UNRESOLVED"
              ? "This deployment cannot attribute the token to a user. Set SIMORGH_API_KEYS to a JSON map of token to user id."
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
  // Story 5.2: read through the KV fallback — if the Durable Object is unreachable,
  // the last snapshot answers (marked `source: "kv-cache"`) instead of a 500. The
  // route itself is intentionally unauthenticated; see SECURITY.md AUTH-001.
  return c.json(await readFlockStatus(c.env));
});

/** The one Durable Object every control-plane read goes to. */
function flockStub(env: Env) {
  return env.FLOCK_COORDINATOR.get(env.FLOCK_COORDINATOR.idFromName("global"));
}

/**
 * The connector matrix, as the dashboard's Platforms tab reads it.
 *
 * Bearer-gated even though the page also server-renders the same matrix: the page
 * is a rendering an operator looks at, this is a payload a client acts on, and the
 * readiness booleans say which secrets exist in the deployment. `connectorReadiness`
 * is shared by both, so the tab and this endpoint cannot drift apart.
 */
app.get("/api/v1/platform/connectors", async (c) => {
  const denied = await requireServiceAuth(c);
  if (denied) return denied;

  return c.json({
    schemaVersion: 1,
    connectors: connectorReadiness(c.env),
    tools: toolSurface(),
  });
});

app.get("/api/v1/quota", async (c) => {
  const denied = await requireServiceAuth(c);
  if (denied) return denied;

  return c.json(await flockStub(c.env).getQuotaState());
});

app.get("/api/v1/schedule", async (c) => {
  const denied = await requireServiceAuth(c);
  if (denied) return denied;

  return c.json(await flockStub(c.env).listScheduled());
});

/** Max id length, mirrored by the `id` pattern below. */
const MAX_SCHEDULE_ID_CHARS = 64;

/**
 * How far ahead a client may schedule.
 *
 * An unbounded `resumeAt` is a row that sits on the dashboard looking scheduled while
 * doing nothing: a year out never fires, and a timestamp in the past fires on the next
 * alarm — neither is an error the scheduler reports. Bounding it here turns both into
 * a refusal the caller can see, rather than a silent no-op the operator cannot.
 */
const MAX_RESUME_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

interface ParsedScheduleRequest {
  id: string;
  prompt: string;
  tools: string[];
  resumeAt: number;
}

/**
 * Validate a schedule request. Same bounds and same posture as `parseExecuteBody`:
 * a schedule is a delayed execute, so it earns the identical prompt and tool caps,
 * and unknown tools are dropped rather than refused.
 */
function parseScheduleBody(raw: string): ParsedScheduleRequest {
  if (raw.length > MAX_EXECUTE_BODY_CHARS) {
    throw new RequestValidationError(
      413,
      "request_too_large",
      "Request body exceeds " + MAX_EXECUTE_BODY_CHARS + " characters."
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body_not_object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    throw new RequestValidationError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!new RegExp(`^[A-Za-z0-9._:-]{1,${MAX_SCHEDULE_ID_CHARS}}$`).test(id)) {
    throw new RequestValidationError(
      400,
      "invalid_schedule_id",
      "id must be 1-" + MAX_SCHEDULE_ID_CHARS + " characters of [A-Za-z0-9._:-]."
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    throw new RequestValidationError(400, "invalid_prompt", "prompt must be a non-empty string.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new RequestValidationError(
      413,
      "prompt_too_large",
      "prompt exceeds " + MAX_PROMPT_CHARS + " characters."
    );
  }

  const rawTools = body.tools;
  if (
    rawTools !== undefined &&
    (!Array.isArray(rawTools) || rawTools.some((tool) => typeof tool !== "string"))
  ) {
    throw new RequestValidationError(400, "invalid_tools", "tools must be an array of strings.");
  }
  const requested = (rawTools as string[] | undefined) ?? [];
  if (requested.length > MAX_TOOLS) {
    throw new RequestValidationError(
      400,
      "too_many_tools",
      "At most " + MAX_TOOLS + " tools may be requested."
    );
  }
  const available = new Set<string>(AGENT_TOOLS);
  const tools = requested.filter((tool) => available.has(tool));

  const resumeAt = body.resumeAt;
  const now = Date.now();
  if (typeof resumeAt !== "number" || !Number.isFinite(resumeAt)) {
    throw new RequestValidationError(
      400,
      "invalid_resume_at",
      "resumeAt must be an epoch-millisecond number."
    );
  }
  if (resumeAt < now - 60_000 || resumeAt > now + MAX_RESUME_HORIZON_MS) {
    throw new RequestValidationError(
      400,
      "resume_at_out_of_range",
      "resumeAt must fall within the next 30 days, and no more than a minute in the past."
    );
  }

  return { id, prompt, tools, resumeAt: Math.round(resumeAt) };
}

app.post("/api/v1/schedule", async (c) => {
  const denied = await requireServiceAuth(c);
  if (denied) return denied;

  const request = parseScheduleBody(await c.req.text());
  return c.json(await flockStub(c.env).scheduleDelayed(request), 201);
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

  for (const [k, v] of Object.entries(rateLimitHeaders(decision))) c.header(k, v);

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
  const identity = await requireIdentity(c);
  if (identity instanceof Response) return identity;

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

  // Ownership is resolved from the ledger, which is the record that binds a `refId` to
  // the principal that created it. `null` (no row carries this refId) is treated as
  // "not yours" rather than "unowned" — the direction that fails closed.
  const vaultId = c.env.DATA_TRUST_VAULT.idFromName("global");
  const vault = c.env.DATA_TRUST_VAULT.get(vaultId);
  const owner = await vault.findByRef(refId);
  if (!owner || !subjectMatches(identity.subject, owner.user_id)) {
    // Deliberately the same 404 the "no such context" case returns. Distinguishing them
    // would make this route an oracle for which references exist — and the whole point
    // of AUTH-003 is that the refId was never the secret. The payload is not read at all
    // on this path, so a non-owner never causes a KV lookup.
    return c.json({ error: "not_found" }, 404);
  }

  const data = await c.env.CONTEXT_STORE.get("ctx_" + refId);
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json(JSON.parse(data));
});

app.get("/api/v1/user/:userId/logs", async (c) => {
  const identity = await requireIdentity(c);
  if (identity instanceof Response) return identity;

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

  // The token says who is calling; the URL says whose data they want. They must agree.
  // `403` for *every* non-matching userId, including one that does not exist, so this
  // cannot be used to probe which user ids are real.
  if (!subjectMatches(identity.subject, userId)) {
    return c.json(
      {
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "This token may not read another user's logs.",
          requestId: c.res.headers.get("X-Request-Id"),
        },
      },
      403
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
