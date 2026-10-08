// The tool executor, tested where it now lives.
//
// These bodies used to exist twice — once in the Cloudflare request path and once in the
// self-hosted Node runtime — with no test in the engine at all. The engine only ever saw
// an injected executor, so its own suite could not tell whether either copy worked. Now
// the executor is engine code, and this file is the only place its behaviour is pinned.
import { describe, expect, it } from "vitest";

import { runAgentLoop, type AgentTool } from "../src/agent.ts";
import type { HttpLike } from "../src/ports.ts";
import {
  EXECUTED_TOOLS,
  SEARCH_ENDPOINT,
  createToolExecutor,
  noInstantAnswer,
  searchHttpError,
} from "../src/tools.ts";

const NOW = 1_700_000_000_000;
const ISO = new Date(NOW).toISOString();

/** A fetch that records every URL it was asked for and answers with `body`. */
function stubFetch(
  body: unknown = { AbstractText: "Simorgh is thirty birds." },
  status = 200
): { fetch: (url: string) => Promise<HttpLike>; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url: string) => {
      urls.push(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return body;
        },
        async text() {
          return JSON.stringify(body);
        },
      };
    },
  };
}

function executor(body?: unknown, status?: number) {
  const stub = stubFetch(body, status);
  return {
    urls: stub.urls,
    execute: createToolExecutor({ fetch: stub.fetch, now: () => NOW }),
  };
}

describe("createToolExecutor — get_server_time", () => {
  it("reports the injected clock, not the real one", async () => {
    const { execute } = executor();
    await expect(execute({ tool: "get_server_time", args: {} })).resolves.toBe(ISO);
  });

  it("takes no arguments — a query in args is ignored", async () => {
    const { urls, execute } = executor();
    await execute({ tool: "get_server_time", args: { query: "ignored" } });
    expect(urls).toHaveLength(0);
  });
});

describe("createToolExecutor — search_web", () => {
  it("queries the documented endpoint with the documented parameters", async () => {
    const { urls, execute } = executor();
    await execute({ tool: "search_web", args: { query: "simorgh" } });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(SEARCH_ENDPOINT);
    expect(urls[0]).toContain("q=simorgh");
    expect(urls[0]).toContain("format=json");
    expect(urls[0]).toContain("no_html=1");
  });

  it("URL-encodes a query with spaces and punctuation", async () => {
    const { urls, execute } = executor();
    await execute({ tool: "search_web", args: { query: "thirty birds & the hoopoe?" } });

    expect(urls[0]).toContain("q=thirty%20birds%20%26%20the%20hoopoe%3F");
    // The raw query must not leak into the URL unencoded — that is what turns a search
    // into a malformed request, or into a second query string parameter.
    expect(urls[0]).not.toContain("thirty birds");
  });

  it("returns the instant answer when the API supplies one", async () => {
    const { execute } = executor({ AbstractText: "Simorgh is thirty birds." });
    await expect(execute({ tool: "search_web", args: { query: "simorgh" } })).resolves.toBe(
      "Simorgh is thirty birds."
    );
  });

  it("falls back to the shared 'no instant answer' text when the API has none", async () => {
    const { execute } = executor({ AbstractText: "" });
    await expect(execute({ tool: "search_web", args: { query: "obscure" } })).resolves.toBe(
      noInstantAnswer("obscure")
    );
  });

  it("treats a missing AbstractText field as no answer rather than as undefined", async () => {
    const { execute } = executor({});
    const result = await execute({ tool: "search_web", args: { query: "obscure" } });
    expect(result).toBe(noInstantAnswer("obscure"));
    expect(result).not.toContain("undefined");
  });

  it("throws the shared http_<status> error on a failed response", async () => {
    const { execute } = executor({}, 503);
    await expect(execute({ tool: "search_web", args: { query: "simorgh" } })).rejects.toThrow(
      searchHttpError(503).message
    );
  });

  it("does not dial the network for an empty query — it says so instead", async () => {
    const { urls, execute } = executor();
    await expect(execute({ tool: "search_web", args: { query: "   " } })).resolves.toBe(
      "No search query supplied."
    );
    expect(urls).toHaveLength(0);
  });

  it("honours a searchEndpoint override", async () => {
    const stub = stubFetch({ AbstractText: "local" });
    const execute = createToolExecutor({
      fetch: stub.fetch,
      now: () => NOW,
      searchEndpoint: "http://127.0.0.1:9999/search",
    });
    await execute({ tool: "search_web", args: { query: "x" } });
    expect(stub.urls[0]).toContain("http://127.0.0.1:9999/search");
    expect(stub.urls[0]).not.toContain(SEARCH_ENDPOINT);
  });
});

describe("createToolExecutor — the coverage guard", () => {
  it("handles every tool on the registry", () => {
    // If a tool is added to `AGENT_TOOLS` and not to the executor, this fails — the
    // compile-time exhaustiveness check in the switch is the other half.
    expect([...EXECUTED_TOOLS].sort()).toEqual(["get_server_time", "search_web"]);
  });

  it("throws for a tool it does not know, instead of folding 'undefined' into a prompt", async () => {
    const { execute } = executor();
    await expect(
      execute({ tool: "summon_rocs" as AgentTool, args: {} })
    ).rejects.toThrow(/no executor for tool/);
  });
});

describe("createToolExecutor — through the agent loop", () => {
  it("produces a real observation the loop folds into the synthesis prompt", async () => {
    const stub = stubFetch({ AbstractText: "Simorgh is thirty birds." });
    const execute = createToolExecutor({ fetch: stub.fetch, now: () => NOW });

    const result = await runAgentLoop("who is simorgh", ["search_web"], execute);

    expect(result.meta.tool_iterations).toBe(1);
    expect(result.meta.tool_observations[0]).toMatchObject({
      tool: "search_web",
      iteration: 0,
      ok: true,
      result: "Simorgh is thirty birds.",
    });
    expect(result.effectivePrompt).toContain("[search_web] Simorgh is thirty birds.");
  });

  it("turns a failed search into a failed observation rather than a thrown request", async () => {
    const stub = stubFetch({}, 500);
    const execute = createToolExecutor({ fetch: stub.fetch, now: () => NOW });

    const result = await runAgentLoop("who is simorgh", ["search_web"], execute);

    expect(result.meta.tool_observations[0]?.ok).toBe(false);
    expect(result.effectivePrompt).toContain("[search_web] failed:");
  });
});
