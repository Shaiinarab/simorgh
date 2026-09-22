// The whole request path, end to end, on plain Node: tools run, context offloads,
// the ledger records, and the flock answers — all through injected ports, with real
// SQLite underneath. Nothing here is a mock of phoenix-core; the only stand-in is the
// outbound HTTP the provider makes.
import { beforeEach, describe, expect, it } from "vitest";

import { executeAgent, type ExecuteAgentDeps } from "../src/execute.ts";
import { HEALTH_SCHEMA, readCooldown, readAllHealth, recordObservation } from "../src/health.ts";
import { openAiCompatibleProvider, type Provider } from "../src/provider.ts";
import {
  LEDGER_SCHEMA,
  createNodePorts,
  memoryContextStore,
  openMemorySql,
  sqlLedger,
} from "../src/node/index.ts";
import type { SqlPort } from "../src/ports.ts";

const NOW = 1_700_000_000_000;

const groq = openAiCompatibleProvider({
  id: "shahin",
  name: "Shāhīn",
  provider: "Groq (OpenAI-compat)",
  model: "llama-3.3-70b-versatile",
  priority: 10,
  endpoint: "https://api.groq.com/openai/v1/chat/completions",
  requires: "GROQ_API_KEY",
});

const homa: Provider = {
  id: "homa",
  name: "Homā",
  provider: "Cloudflare Workers AI",
  model: "@cf/meta/llama-3.2-3b-instruct",
  priority: 30,
  async call() {
    return { ok: true, answer: "homa-answer" };
  },
};

let sql: SqlPort;

beforeEach(() => {
  sql = openMemorySql().sql;
  sql.exec(HEALTH_SCHEMA);
  sql.exec(LEDGER_SCHEMA);
});

function harness(
  overrides: {
    secrets?: Record<string, string>;
    providers?: readonly Provider[];
    fetch?: ExecuteAgentDeps["ports"]["fetch"];
  } = {}
) {
  const secrets = overrides.secrets ?? {};
  const contextStore = memoryContextStore(() => NOW);
  const ledger = sqlLedger(sql);

  const deps: ExecuteAgentDeps = {
    ports: createNodePorts({
      now: () => NOW,
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    }),
    providers: overrides.providers ?? [groq, homa],
    secret: (name) => secrets[name],
    contextStore,
    ledger,
    cooldownUntil: (id) => readCooldown(sql, id),
    record: (id, ok, error) => recordObservation(sql, id, ok, error === "rate_limit", NOW),
    executeTool: async (invocation) => {
      if (invocation.tool === "get_server_time") return new Date(NOW).toISOString();
      return `result for ${invocation.args.query}`;
    },
  };

  return { deps, contextStore, ledger };
}

describe("executeAgent", () => {
  it("runs the tools, offloads the context, logs the ledger, and answers", async () => {
    const { deps, contextStore } = harness({
      secrets: { GROQ_API_KEY: "sk-test" },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "groq-says-hi" } }] }),
      }),
    });

    const result = await executeAgent(
      {
        prompt: "hello flock",
        tools: ["search_web", "get_server_time"],
        userId: "u-1",
        tier: "Pro-Data-Pact",
        requestId: "req-1",
      },
      deps
    );

    expect(result.success).toBe(true);
    expect(result.agentResponse).toBe("groq-says-hi");
    expect(result.meta).toMatchObject({
      answered_by: "Shāhīn (Groq (OpenAI-compat))",
      bird_id: "shahin",
      ai_model: "llama-3.3-70b-versatile",
      loggedToLedger: true,
      tool_iterations: 2,
      tools_requested: ["search_web", "get_server_time"],
      blocked_tools: [],
      requestId: "req-1",
      contextRefId: "00000000-0000-4000-8000-000000000000",
    });

    // The offloaded context is retrievable by reference...
    const stored = await contextStore.get("ctx_" + result.meta.contextRefId);
    expect(JSON.parse(stored ?? "null")).toEqual({
      prompt: "hello flock",
      tools: ["search_web", "get_server_time"],
    });

    // ...and the ledger recorded the call against the caller's own identity.
    const logs = await deps.ledger.getUserLogs("u-1");
    expect(logs.count).toBe(1);
    expect(logs.entries[0]).toMatchObject({ tier: "Pro-Data-Pact", action: "execute" });
    expect(JSON.parse(logs.entries[0]?.details ?? "{}")).toMatchObject({ requestId: "req-1" });
  });

  it("delivers the zero-KYC promise: with no secrets, Homā still answers", async () => {
    const { deps } = harness({ secrets: {} });

    const result = await executeAgent(
      { prompt: "what is the server time?", tools: [], userId: "anonymous", tier: "Free-Volunteer" },
      deps
    );

    expect(result.success).toBe(true);
    expect(result.agentResponse).toBe("homa-answer");
    expect(result.meta.flock_attempts).toEqual([
      { birdId: "shahin", ok: false, error: "dormant" },
      { birdId: "homa", ok: true },
    ]);
  });

  it("reports refused tools without failing the request", async () => {
    const { deps } = harness({});

    const result = await executeAgent(
      {
        prompt: "hi",
        tools: ["get_server_time"],
        blockedTools: ["rm_rf_root", "drop_tables"],
        userId: "anonymous",
        tier: "Free-Volunteer",
      },
      deps
    );

    expect(result.success).toBe(true);
    expect(result.meta.blocked_tools).toEqual(["rm_rf_root", "drop_tables"]);
    expect(result.meta.tool_observations.map((o) => o.tool)).toEqual(["get_server_time"]);
  });

  it("fails the result but still logs when every provider is down", async () => {
    const { deps } = harness({
      secrets: { GROQ_API_KEY: "sk-test" },
      providers: [
        openAiCompatibleProvider({
          id: "down",
          name: "Down",
          provider: "Down",
          model: "down",
          priority: 1,
          endpoint: "https://down.example/v1/chat/completions",
          requires: "GROQ_API_KEY",
        }),
      ],
      fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });

    const result = await executeAgent(
      { prompt: "hi", tools: [], userId: "u-2", tier: "Free-Volunteer" },
      deps
    );

    expect(result.success).toBe(false);
    expect(result.meta.answered_by).toBe("none");
    expect(result.meta.error).toBe("flock_exhausted");
    // The transparency contract holds even when nothing answered: the request
    // happened, so it is on the ledger.
    expect(result.meta.loggedToLedger).toBe(true);
    expect((await deps.ledger.getUserLogs("u-2")).count).toBe(1);
  });

  it("cools down a provider that failed, so the next request skips it", async () => {
    const { deps } = harness({
      secrets: { GROQ_API_KEY: "sk-test" },
      fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    });

    await executeAgent(
      { prompt: "hi", tools: [], userId: "u-3", tier: "Free-Volunteer" },
      deps
    );

    expect(readAllHealth(sql).find((r) => r.bird_id === "shahin")).toMatchObject({
      total_failures: 1,
    });
    expect(readCooldown(sql, "shahin")).toBe(NOW + 60_000);

    // Next request inside the cooldown window: skipped outright, not retried.
    const second = await executeAgent(
      { prompt: "hi again", tools: [], userId: "u-3", tier: "Free-Volunteer" },
      deps
    );
    expect(second.meta.flock_attempts[0]).toEqual({
      birdId: "shahin",
      ok: false,
      error: "cooling_down",
    });
  });

  it("generates its own request id when the host supplies none", async () => {
    const { deps } = harness({});
    const result = await executeAgent(
      { prompt: "hi", tools: [], userId: "anonymous", tier: "Free-Volunteer" },
      deps
    );
    expect(result.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("openAiCompatibleProvider", () => {
  it("sends the OpenAI chat-completions shape", async () => {
    let seenURL = "";
    let seenAuth = "";
    let seenBody: { model?: string; messages?: { role: string; content: string }[] } = {};

    const { deps } = harness({
      secrets: { GROQ_API_KEY: "sk-test" },
      providers: [groq],
      fetch: async (url, init) => {
        seenURL = url;
        seenAuth = init?.headers?.Authorization ?? "";
        seenBody = JSON.parse(init?.body ?? "{}");
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
      },
    });

    await executeAgent(
      { prompt: "ping", tools: [], userId: "anonymous", tier: "Free-Volunteer" },
      deps
    );

    expect(seenURL).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(seenAuth).toBe("Bearer sk-test");
    expect(seenBody.model).toBe("llama-3.3-70b-versatile");
    expect(seenBody.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("reports a transport throw as a failure rather than escaping", async () => {
    const { deps } = harness({
      secrets: { GROQ_API_KEY: "sk-test" },
      providers: [groq, homa],
      fetch: async () => {
        throw new TypeError("network unreachable");
      },
    });

    const result = await executeAgent(
      { prompt: "ping", tools: [], userId: "anonymous", tier: "Free-Volunteer" },
      deps
    );

    // The throwing provider did not take the flock down; Homā picked it up.
    expect(result.meta.bird_id).toBe("homa");
    expect(result.meta.flock_attempts[0]?.error).toMatch(/network unreachable/);
  });
});
