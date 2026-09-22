// ── In-process fake phoenix-core ────────────────────────────
//
// Speaks both REST and MCP through a single `FetchLike`, so both
// connectors can be pointed at the same double and their answers
// compared.
//
// Scripted, not hardcoded: every response is driven by `FakeCoreScript`.

import type { FetchLike, FlockStatus } from "@simorgh/phoenix-core";
import type { HeaderAccessor } from "@simorgh/phoenix-core";

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

const DEFAULT_ANSWER = "the fake core answers";
const DEFAULT_ANSWERED_BY = "fake-provider (test)";

export function fakeCore(script: FakeCoreScript = {}): {
  fetch: FetchLike;
  calls: () => { url: string; method: string; body?: string }[];
} {
  const captured: { url: string; method: string; body?: string }[] = [];

  function recordCall(url: string, method: string, body?: string): void {
    captured.push({ url, method, body });
  }

  function buildExecutePayload(): {
    success: boolean;
    agentResponse: string;
    meta: {
      answered_by: string;
      flock_attempts: { birdId: string; ok: boolean; error?: string }[];
      error?: string;
    };
  } {
    const attempts = (script.attempts ?? []).map((a) => ({
      birdId: a.providerId,
      ok: a.ok,
      ...(a.error ? { error: a.error } : {}),
    }));
    const success = attempts.length > 0 && attempts.some((a) => a.ok);
    return {
      success,
      agentResponse: script.answer ?? DEFAULT_ANSWER,
      meta: {
        answered_by: script.answeredBy ?? DEFAULT_ANSWERED_BY,
        flock_attempts: attempts,
        ...(!success ? { error: "flock_exhausted" } : {}),
      },
    };
  }

  function jsonBody(body: unknown): {
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  } {
    return {
      json: async () => body,
      text: async () => (body !== undefined ? JSON.stringify(body) : ""),
    };
  }

  async function handleRest(url: string, init?: Parameters<FetchLike>[1]) {
    recordCall(url, init?.method ?? "GET", init?.body);

    if (script.httpStatus) {
      return {
        ok: false,
        status: script.httpStatus,
        headers: { get: () => null },
        ...jsonBody({ error: "http_failure" }),
      };
    }

    if (url.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        ...jsonBody({ status: "ok" }),
      };
    }

    if (url.endsWith("/api/v1/flock/status")) {
      const status: FlockStatus =
        script.flockStatus ?? {
          birds: [
            {
              id: "shahin",
              name: "Shāhīn",
              provider: "Groq (OpenAI-compat)",
              model: "llama-3.3-70b-versatile",
              priority: 10,
              dormant: false,
              status: "healthy",
              consecutiveFailures: 0,
              cooldownUntil: 0,
              totalCalls: 0,
              totalFailures: 0,
            },
          ],
          timestamp: Date.now(),
        };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        ...jsonBody(status),
      };
    }

    if (url.endsWith("/api/v1/agent/execute")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        ...jsonBody(buildExecutePayload()),
      };
    }

    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      ...jsonBody({ error: "not_found" }),
    };
  }

  async function handleMcp(url: string, init?: Parameters<FetchLike>[1]) {
    recordCall(url, init?.method ?? "POST", init?.body);

    if (script.httpStatus) {
      return {
        ok: false,
        status: script.httpStatus,
        headers: { get: () => null },
        ...jsonBody({
          jsonrpc: "2.0",
          error: { code: -32603, message: "http_failure" },
        }),
      };
    }

    const raw = init?.body ?? "";
    let msg: {
      jsonrpc?: string;
      id?: number | null;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null } as HeaderAccessor,
        ...jsonBody({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      };
    }

    // initialize: issue a session id
    if (msg.method === "initialize") {
      const sessionId = String(Date.now());
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === "Mcp-Session-Id" ? sessionId : null),
        } as HeaderAccessor,
        ...jsonBody({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2026-07-28",
            capabilities: { tools: {} },
            serverInfo: { name: "phoenix-core", version: "0.1.0" },
          },
        }),
      };
    }

    // notifications/initialized: 202, empty body
    if (msg.method === "notifications/initialized") {
      return {
        ok: true,
        status: 202,
        headers: { get: () => null } as HeaderAccessor,
        json: async () => undefined,
        text: async () => "",
      };
    }

    // tools/call: session required
    if (msg.method === "tools/call") {
      const session = (init?.headers as Record<string, string> | undefined)?.[
        "Mcp-Session-Id"
      ];
      if (!session) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null } as HeaderAccessor,
          ...jsonBody({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32001, message: "Session required" },
          }),
        };
      }

      const name = msg.params?.name ?? "";

      if (name === "simorgh_status") {
        const status: FlockStatus =
          script.flockStatus ?? {
            birds: [
              {
                id: "shahin",
                name: "Shāhīn",
                provider: "Groq (OpenAI-compat)",
                model: "llama-3.3-70b-versatile",
                priority: 10,
                dormant: false,
                status: "healthy",
                consecutiveFailures: 0,
                cooldownUntil: 0,
                totalCalls: 0,
                totalFailures: 0,
              },
            ],
            timestamp: Date.now(),
          };
        return {
          ok: true,
          status: 200,
          headers: { get: () => null } as HeaderAccessor,
          ...jsonBody({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: JSON.stringify(status) }] },
          }),
        };
      }

      if (name === "simorgh_ask") {
        const payload = buildExecutePayload();
        return {
          ok: true,
          status: 200,
          headers: { get: () => null } as HeaderAccessor,
          ...jsonBody({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        headers: { get: () => null } as HeaderAccessor,
        ...jsonBody({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${String(name)}` },
        }),
      };
    }

    // Unknown method
    return {
      ok: true,
      status: 200,
      headers: { get: () => null } as HeaderAccessor,
      ...jsonBody({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
      }),
    };
  }

  const fetch: FetchLike = async (url, init?) => {
    if (url.includes("/mcp")) {
      return handleMcp(url, init);
    }
    return handleRest(url, init);
  };

  return { fetch, calls: () => captured };
}
