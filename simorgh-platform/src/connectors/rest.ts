// ── The REST connector ────────────────────────────────────────────────────────
//
// Talks to a core through the documented HTTP API: `/health`, `/api/v1/flock/status`,
// and `POST /api/v1/agent/execute`. Always available, and the only connector a
// minimal core needs to implement.
//
// Unlike the engine, this runs host-side (Node), so `Date.now` and `fetch` are used
// directly rather than injected — the ports discipline protects *portability* of the
// core, and there is nothing to port here.

import type { FetchLike, FlockStatus } from "@simorgh/phoenix-core";

import {
  toAskResult,
  type AskRequest,
  type AskResult,
  type CoreConnector,
  type CoreHealth,
} from "./types.ts";

export interface RestConnectorConfig {
  endpoint: string;
  apiKey?: string;
  fetch: FetchLike;
  /** Sends the request as an explicit authenticated read rather than relying on ambient auth. */
  node?: string;
}

export function restConnector(config: RestConnectorConfig): CoreConnector {
  const base = config.endpoint.replace(/\/+$/, "");

  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
  });

  async function json<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
    const response = await config.fetch(base + path, {
      method: init?.method ?? "GET",
      headers: headers(),
      ...(init?.body ? { body: init.body } : {}),
    });
    if (!response.ok) {
      // 401 and 503 are the two a caller will actually hit, and they mean different
      // things — a bad token versus a core that never configured one. Saying which
      // saves a support round trip.
      const hint =
        response.status === 401
          ? "bearer token rejected"
          : response.status === 503
            ? "core has no SIMORGH_API_KEY configured (fails closed)"
            : "unexpected response";
      throw new Error(`${path} → http_${response.status} (${hint})`);
    }
    return (await response.json()) as T;
  }

  return {
    kind: "rest",
    endpoint: base,

    async health(): Promise<CoreHealth> {
      const started = Date.now();
      try {
        const body = await json<{ status?: string }>("/health");
        return {
          reachable: true,
          endpoint: base,
          latencyMs: Date.now() - started,
          detail: body.status ?? "ok",
        };
      } catch (e) {
        return {
          reachable: false,
          endpoint: base,
          latencyMs: Date.now() - started,
          detail: String(e),
        };
      }
    },

    async status(): Promise<FlockStatus> {
      return json<FlockStatus>("/api/v1/flock/status");
    },

    async ask(request: AskRequest): Promise<AskResult> {
      const payload = await json<Parameters<typeof toAskResult>[0]>("/api/v1/agent/execute", {
        method: "POST",
        body: JSON.stringify({
          prompt: request.prompt,
          tools: request.tools ?? [],
          userId: request.userId ?? config.node ?? "simorgh-platform",
          tier: request.tier ?? "Free-Volunteer",
        }),
      });
      return toAskResult(payload);
    },
  };
}
