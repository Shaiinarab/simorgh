import {
  createToolExecutor,
  executeAgent as coreExecuteAgent,
  type AgentTool,
  type ExecuteAgentResult,
  type LedgerPort,
  type PhoenixPorts,
} from "@simorgh/phoenix-core";
import type { Tier } from "./security";

// ── The Cloudflare request path ────────────────────────────────────────────────
//
// This file used to *be* the pipeline. It re-implemented the same ordering as
// `phoenix-core/src/execute.ts` — run the agent loop, offload the request context, write
// the transparency ledger, then fly the flock — and nothing compared the two. That is
// the duplication with the highest cost here, because the ordering is the Data Trust
// contract: if the two drift, one deployment logs a request before dialling a provider
// and the other logs it after, and only one of them still tells the truth when every
// provider is down.
//
// It is now a binding, and only that. Every decision — the tool loop, the ledger write,
// the offload, the flight, and the order they happen in — comes from the engine.
//
// ── Why this host flies through a Durable Object stub ──
//
// The engine's own `flyFlock` path takes `cooldownUntil` and `record` as *closures*, and
// a closure cannot cross Durable Object RPC. The cooldown and observation rows live in
// the FlockCoordinator's SQLite, reachable only over a stub. So this host uses the
// engine's `fly` dependency: it supplies the flight, the engine supplies the ordering
// around it. That is exactly the seam the engine declares for this case, rather than a
// second pipeline.

export interface ExecuteAgentInput {
  prompt: string;
  tools: AgentTool[];
  userId: string;
  tier: Tier;
  blockedTools?: string[];
  requestId?: string;
}

export type { ExecuteAgentResult };

/**
 * The Cloudflare bindings, as the engine's ports.
 *
 * `fetch` resolves `globalThis.fetch` at call time rather than capturing it — the same
 * rule `flock.ts` documents, and for the same reason: the Workers test suite replaces
 * the global with a stub per test, and a captured reference would bypass every one of
 * them while the tests still passed.
 */
function workerPorts(): PhoenixPorts {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),
    sha256: async (value) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    randomUUID: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
}

/** Read a binding as a secret, or `undefined` when it is not a string. */
function secretReader(env: Env) {
  return (name: string): string | undefined => {
    const value = (env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
}

export async function executeAgent(
  env: Env,
  input: ExecuteAgentInput
): Promise<ExecuteAgentResult> {
  const ports = workerPorts();

  const vault = env.DATA_TRUST_VAULT.get(env.DATA_TRUST_VAULT.idFromName("global"));
  const flock = env.FLOCK_COORDINATOR.get(env.FLOCK_COORDINATOR.idFromName("global"));

  // The Durable Object stub *is* a `LedgerPort` — both methods already return promises,
  // so no adapter is needed, only the type annotation that says so.
  const ledger: LedgerPort = {
    logEntry: (entry) => vault.logEntry(entry),
    getUserLogs: (userId) => vault.getUserLogs(userId),
  };

  return coreExecuteAgent(
    {
      prompt: input.prompt,
      tools: input.tools,
      userId: input.userId,
      tier: input.tier,
      ...(input.blockedTools ? { blockedTools: input.blockedTools } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
    {
      ports,
      secret: secretReader(env),
      workersAi: env.AI,
      contextStore: {
        put: (key, value, options) => env.CONTEXT_STORE.put(key, value, options),
        get: (key) => env.CONTEXT_STORE.get(key),
      },
      ledger,
      executeTool: createToolExecutor({ fetch: ports.fetch, now: ports.now }),
      // The DO's own signature is `(prompt, tools)` and it is passed through verbatim,
      // even though the DO does not read `tools`: the agent loop has already folded every
      // tool *result* into `prompt`. It is forwarded because the DO's RPC call log is how
      // a deployment records what was asked for, and because `test/http.test.ts` pins
      // that contract — dropping it here would narrow a published signature silently.
      fly: (prompt, tools) => flock.runFlock(prompt, [...tools]),
    }
  );
}
