import { describe, expect, it } from "vitest";

import {
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_CHARS,
  buildSynthesisPrompt,
  extractToolArgs,
  runAgentLoop,
  type ToolInvocation,
} from "../src/agent.ts";

const noop = async () => "unused";

describe("extractToolArgs", () => {
  it("gives get_server_time no arguments and search_web the prompt", () => {
    expect(extractToolArgs("get_server_time", "what time is it?", 0)).toEqual({});
    expect(extractToolArgs("search_web", "  simorgh birds  ", 0)).toEqual({
      query: "simorgh birds",
    });
  });

  it("degrades a blank prompt to a searchable query instead of silence", () => {
    expect(extractToolArgs("search_web", "   ", 2)).toEqual({
      query: "search iteration 2",
    });
  });
});

describe("runAgentLoop", () => {
  it("runs one round per requested tool, in order", async () => {
    const seen: ToolInvocation[] = [];
    const result = await runAgentLoop(
      "hello flock",
      ["search_web", "get_server_time"],
      async (invocation) => {
        seen.push(invocation);
        return invocation.tool === "search_web" ? "Simorgh is thirty birds." : "2026-09-21T00:00:00Z";
      }
    );

    expect(seen.map((s) => s.tool)).toEqual(["search_web", "get_server_time"]);
    expect(result.meta.tool_iterations).toBe(2);
    expect(result.meta.tools_requested).toEqual(["search_web", "get_server_time"]);
    expect(result.meta.tool_observations).toEqual([
      { tool: "search_web", iteration: 0, ok: true, result: "Simorgh is thirty birds." },
      { tool: "get_server_time", iteration: 1, ok: true, result: "2026-09-21T00:00:00Z" },
    ]);
  });

  it("captures a failing tool without aborting the loop", async () => {
    const result = await runAgentLoop("will this break?", ["search_web", "get_server_time"], async (
      invocation
    ) => {
      if (invocation.tool === "search_web") throw new TypeError("network unreachable");
      return "2026-09-21T00:00:00Z";
    });

    expect(result.meta.tool_observations[0]).toEqual({
      tool: "search_web",
      iteration: 0,
      ok: false,
      result: "TypeError: network unreachable",
    });
    // The second tool still ran, and the answer still has something to say.
    expect(result.meta.tool_observations[1]?.ok).toBe(true);
  });

  it("skips the loop entirely when no tools were allowed", async () => {
    const result = await runAgentLoop("nothing allowed", [], noop);

    expect(result.meta.tool_iterations).toBe(0);
    expect(result.meta.tool_observations).toEqual([]);
    // A tool-free request must not be wrapped in synthesis scaffolding.
    expect(result.effectivePrompt).toBe("nothing allowed");
  });

  it("caps the loop at the iteration budget", async () => {
    const many = Array.from({ length: MAX_TOOL_ITERATIONS + 3 }, () => "search_web" as const);
    const result = await runAgentLoop("wide request", many, async () => "hit");

    expect(result.meta.tools_requested).toHaveLength(MAX_TOOL_ITERATIONS + 3);
    expect(result.meta.tool_observations).toHaveLength(MAX_TOOL_ITERATIONS);
  });

  it("truncates a huge tool result instead of forwarding it whole", async () => {
    const result = await runAgentLoop("big", ["search_web"], async () =>
      "x".repeat(MAX_TOOL_RESULT_CHARS + 500)
    );

    const observation = result.meta.tool_observations[0];
    expect(observation?.result.length).toBe(MAX_TOOL_RESULT_CHARS + 1); // + the ellipsis
    expect(observation?.result.endsWith("…")).toBe(true);
  });
});

describe("buildSynthesisPrompt", () => {
  it("returns the prompt untouched when there is nothing to fold in", () => {
    expect(buildSynthesisPrompt("plain", [])).toBe("plain");
  });

  it("folds results into prose and forbids raw JSON", () => {
    const prompt = buildSynthesisPrompt("hello flock", [
      { tool: "search_web", iteration: 0, ok: true, result: "Simorgh is thirty birds." },
      { tool: "get_server_time", iteration: 1, ok: false, result: "TypeError: nope" },
    ]);

    expect(prompt).toContain("Request: hello flock");
    expect(prompt).toContain("- [search_web] Simorgh is thirty birds.");
    // A failed tool is reported as failed, so the model cannot invent a result.
    expect(prompt).toContain("- [get_server_time] failed: TypeError: nope");
    expect(prompt).toContain("Do not output raw JSON.");
  });
});
