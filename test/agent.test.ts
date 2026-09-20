// Agent core tests — the tool loop, the synthesis prompt, and the story 4.5 bar.
//
// Like flock-routing.test.ts, this suite is fully hermetic: the loop is a pure
// function over an injected executor, so no workerd, no Durable Object, no
// network. The route-level e2e for story 4.5 (real route, real tool adapters,
// fetch stubbed, an answering bird) lives in http.test.ts; this file pins the
// core decisions themselves.
import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_CHARS,
  buildSynthesisPrompt,
  extractToolArgs,
  runAgentLoop,
  runToolRound,
  type ToolInvocation,
} from "../src/agent";

/** A scripted executor: returns per-tool answers, records every invocation. */
function scriptedExecutor(
  answers: Partial<Record<string, string | Error>>,
  log: ToolInvocation[] = []
) {
  return async (invocation: ToolInvocation): Promise<string> => {
    log.push(invocation);
    const a = answers[invocation.tool];
    if (a instanceof Error) throw a;
    return a ?? `${invocation.tool}-result`;
  };
}

describe("the registry — one source of truth with the Intent Shield", () => {
  it("lists exactly the tools the boundary vets", () => {
    // index.ts derives TOOL_ALLOW_LIST from this registry, so the registry IS the
    // allow-list. This pins its content: a tool added here becomes vetted AND
    // runnable; one absent here is neither.
    expect(AGENT_TOOLS).toEqual(["search_web", "get_server_time"]);
  });
});

describe("extractToolArgs", () => {
  it("get_server_time takes no arguments", () => {
    expect(extractToolArgs("get_server_time", "what time is it?", 0)).toEqual({});
  });

  it("search_web uses the prompt as the query", () => {
    expect(extractToolArgs("search_web", "who wrote the Conference of the Birds?", 0)).toEqual({
      query: "who wrote the Conference of the Birds?",
    });
  });

  it("an empty prompt degrades to a placeholder query, not an empty one", () => {
    // An empty DDG query is a wasted fetch; the placeholder keeps the observation
    // honest about what was actually searched.
    expect(extractToolArgs("search_web", "   ", 2)).toEqual({ query: "search iteration 2" });
  });
});

describe("runToolRound", () => {
  it("executes tools in order and captures their results", async () => {
    const log: ToolInvocation[] = [];
    const observations = await runToolRound(
      ["search_web", "get_server_time"],
      "hi",
      0,
      scriptedExecutor({ search_web: "found it", get_server_time: "2026-09-20T00:00:00.000Z" }, log)
    );

    expect(log.map((i) => i.tool)).toEqual(["search_web", "get_server_time"]);
    expect(observations).toEqual([
      { tool: "search_web", iteration: 0, ok: true, result: "found it" },
      { tool: "get_server_time", iteration: 0, ok: true, result: "2026-09-20T00:00:00.000Z" },
    ]);
  });

  it("a thrown tool becomes a failed observation and does not stop later tools", async () => {
    const observations = await runToolRound(
      ["search_web", "get_server_time"],
      "hi",
      1,
      scriptedExecutor({ search_web: new Error("network unreachable") })
    );

    expect(observations).toEqual([
      { tool: "search_web", iteration: 1, ok: false, result: "Error: network unreachable" },
      { tool: "get_server_time", iteration: 1, ok: true, result: "get_server_time-result" },
    ]);
  });

  it("truncates an oversized result to the fold budget", async () => {
    const observations = await runToolRound(["search_web"], "hi", 0, async () =>
      "x".repeat(MAX_TOOL_RESULT_CHARS + 500)
    );

    expect(observations[0].result.length).toBe(MAX_TOOL_RESULT_CHARS + 1); // + ellipsis
    expect(observations[0].result.endsWith("…")).toBe(true);
  });
});

describe("buildSynthesisPrompt", () => {
  it("passes the prompt through untouched when there is nothing to fold", () => {
    // A tool-free request must not be wrapped in scaffolding: the bird should see
    // the caller's words, not a template around them.
    expect(buildSynthesisPrompt("hello flock", [])).toBe("hello flock");
  });

  it("folds results as prose lines, one per tool", () => {
    const prompt = buildSynthesisPrompt("what time is it?", [
      { tool: "get_server_time", iteration: 0, ok: true, result: "2026-09-20T00:00:00.000Z" },
    ]);

    expect(prompt).toContain("Request: what time is it?");
    expect(prompt).toContain("- [get_server_time] 2026-09-20T00:00:00.000Z");
    expect(prompt).toContain("Now answer the request using these results.");
  });

  it("marks failed tools so the bird can say so honestly", () => {
    const prompt = buildSynthesisPrompt("search", [
      { tool: "search_web", iteration: 0, ok: false, result: "Error: network unreachable" },
    ]);

    expect(prompt).toContain("- [search_web] failed: Error: network unreachable");
    expect(prompt).toContain("If a result failed, say so plainly.");
  });

  it("asks for prose, not JSON (story 4.3)", () => {
    // The no-raw-JSON-dumps bar starts with what we hand the model.
    const prompt = buildSynthesisPrompt("q", [
      { tool: "search_web", iteration: 0, ok: true, result: "result text" },
    ]);
    expect(prompt).toContain("Do not output raw JSON");
    expect(prompt).toContain("natural-language answer");
  });
});

describe("runAgentLoop", () => {
  it("no tools means zero iterations and a pass-through prompt", async () => {
    const result = await runAgentLoop("just answer", [], scriptedExecutor({}));

    expect(result.meta.tool_iterations).toBe(0);
    expect(result.meta.tools_requested).toEqual([]);
    expect(result.meta.tool_observations).toEqual([]);
    expect(result.effectivePrompt).toBe("just answer");
  });

  it("runs one iteration per requested tool, sequentially, in order", async () => {
    const log: ToolInvocation[] = [];
    const result = await runAgentLoop(
      "complex prompt",
      ["search_web", "get_server_time"],
      scriptedExecutor({}, log)
    );

    expect(log.map((i) => i.tool)).toEqual(["search_web", "get_server_time"]);
    expect(result.meta.tool_iterations).toBe(2);
    expect(result.meta.tool_observations.map((o) => o.iteration)).toEqual([0, 1]);
    expect(result.meta.tools_requested).toEqual(["search_web", "get_server_time"]);
  });

  it("caps runaway requests at the iteration budget", async () => {
    // Ten copies of one tool is either a bug or an abuse; either way the budget
    // bounds the cost: 4 executor calls, not 10.
    const log: ToolInvocation[] = [];
    const result = await runAgentLoop(
      "spam",
      Array.from({ length: 10 }, () => "search_web" as const),
      scriptedExecutor({}, log)
    );

    expect(log).toHaveLength(MAX_TOOL_ITERATIONS);
    expect(result.meta.tool_iterations).toBe(MAX_TOOL_ITERATIONS);
  });

  it("folds the observations into the prompt the bird will answer", async () => {
    const result = await runAgentLoop(
      "search for simorgh",
      ["search_web"],
      scriptedExecutor({ search_web: "thirty birds" })
    );

    expect(result.effectivePrompt).toContain("Request: search for simorgh");
    expect(result.effectivePrompt).toContain("- [search_web] thirty birds");
  });
});

describe("story 4.5 — the quality bar, at the core", () => {
  it("\"What time is it?\" → the folded context carries a real ISO-8601 timestamp", async () => {
    // The executor here is the real get_server_time contract: a live ISO-8601
    // string. The synthesis prompt must carry it through so the answering bird
    // can quote it — that is the property the route-level e2e asserts end to end.
    const result = await runAgentLoop("What time is it?", ["get_server_time"], async () =>
      new Date().toISOString()
    );

    expect(result.effectivePrompt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("\"Search for X\" → the folded context references the search results", async () => {
    const result = await runAgentLoop(
      "Search for Simorgh",
      ["search_web"],
      async () => "The Simorgh is thirty birds."
    );

    expect(result.effectivePrompt).toContain("The Simorgh is thirty birds.");
  });
});
