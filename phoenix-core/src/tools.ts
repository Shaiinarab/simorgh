// ── The tool executor ─────────────────────────────────────────────────────────
//
// `agent.ts` owns the *loop*: it decides which vetted tool to run, in what order,
// how many times, and how to fold the results back into the prompt. It deliberately
// injects the *executor*, because a tool is a product decision.
//
// But "a product decision" was read too strictly. Both hosts ended up writing the
// same two tool bodies — the same DuckDuckGo URL, the same `search_http_<status>`
// error string, the same "no instant answer" fallback — once in the Cloudflare
// request path and once in the self-hosted Node runtime. Two copies of a behaviour,
// and nothing comparing them.
//
// So the executor lives here too. The line is now drawn where it belongs:
//
//   core owns  what the tools *do* — the request, the parsing, the failure text
//   host owns  how the tools *reach out* — via the injected `fetch` port
//
// A host with a genuinely different tool set injects its own executor instead; this
// is the shared default, not a requirement. Requests still go through the port, so
// the same stubbed fetch that drives the engine's tests drives these too.

import type { AgentTool, ToolInvocation } from "./agent.ts";
import type { FetchLike } from "./ports.ts";

/** Where `search_web` looks. One definition, so the endpoint is greppable. */
export const SEARCH_ENDPOINT = "https://api.duckduckgo.com/";

/** The answer when the search API has no instant answer for the query. */
export function noInstantAnswer(query: string): string {
  return `No instant answer found for "${query}".`;
}

/**
 * The error a failed search throws.
 *
 * Exported so a caller can match on it without string-building the same prefix — and
 * so the `http_<status>` convention stays consistent with the providers'.
 */
export function searchHttpError(status: number): Error {
  return new Error("search_http_" + status);
}

export interface ToolExecutorDeps {
  fetch: FetchLike;
  /** Injected clock, so `get_server_time` is testable without faking a global. */
  now(): number;
  /** Search endpoint override, for a host behind a proxy or a test that wants a local stub. */
  searchEndpoint?: string;
}

/**
 * The default executor for every tool on `AGENT_TOOLS`.
 *
 * Every branch either returns a value or throws; the loop catches per-tool and turns a
 * throw into a failed observation, so a dead search never costs the caller their time
 * answer.
 */
export function createToolExecutor(
  deps: ToolExecutorDeps
): (invocation: ToolInvocation) => Promise<string> {
  const endpoint = deps.searchEndpoint ?? SEARCH_ENDPOINT;

  return async function execute(invocation) {
    switch (invocation.tool) {
      case "get_server_time":
        return new Date(deps.now()).toISOString();

      case "search_web": {
        const query = String(invocation.args.query ?? "").trim();
        // An empty query is a malformed request, not an error: say so and let the
        // provider answer with what it has. Throwing here would burn the whole
        // observation on a usage mistake the caller can read.
        if (!query) return "No search query supplied.";

        const url =
          endpoint + "?q=" + encodeURIComponent(query) + "&format=json&no_html=1";
        const response = await deps.fetch(url);
        if (!response.ok) throw searchHttpError(response.status);

        const data = (await response.json()) as { AbstractText?: string };
        return data.AbstractText || noInstantAnswer(query);
      }

      default: {
        // Exhaustiveness guard, and the reason this switch has no `default` fallthrough
        // value: adding a member to `AgentTool` without a case here makes this
        // assignment fail to compile. A new tool cannot be silently unhandled — which
        // would return `undefined` into the loop and fold the string "undefined" into
        // the prompt the provider is asked to trust.
        const unhandled: never = invocation.tool;
        throw new Error(`no executor for tool: ${String(unhandled)}`);
      }
    }
  };
}

/** Every tool this executor handles, for a host that wants to assert it covers them all. */
export const EXECUTED_TOOLS: readonly AgentTool[] = ["search_web", "get_server_time"];
