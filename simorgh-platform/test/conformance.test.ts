// ── Connector conformance tests ─────────────────────────────
//
// Run the kit against restConnector and mcpConnector, against the same
// fake core. Assert the two connectors produce the same number of checks
// (that is the drift detector). Also define a deliberately broken
// connector inline to prove the kit is not decorative.

import { describe, expect, it } from "vitest";

import type { CoreConnector } from "../src/connectors/types.ts";
import type { FlockStatus } from "@simorgh/phoenix-core";

import {
  runConnectorConformance,
  type ConformanceCheck,
  type FakeCoreScript,
} from "../src/connectors/conformance.ts";
import { fakeCore } from "./support/fake-core.ts";
import { mcpConnector } from "../src/connectors/mcp.ts";
import { restConnector } from "../src/connectors/rest.ts";
import type { FetchLike } from "@simorgh/phoenix-core";

const BASE_URL = "https://fake-core.example";
const MCP_URL = `${BASE_URL}/mcp`;

/** Run the kit against a connector factory and collect results. */
async function runKit(
  factory: (script: FakeCoreScript) => CoreConnector,
  endpoint: string,
): Promise<ConformanceCheck[]> {
  return runConnectorConformance({ connector: factory, endpoint });
}

describe("conformance — REST connector", () => {
  it("produces checks", async () => {
    const factory = (script: FakeCoreScript) => {
      const { fetch } = fakeCore(script);
      return restConnector({ endpoint: BASE_URL, fetch });
    };
    const checks = await runKit(factory, BASE_URL);
    expect(checks.length).toBeGreaterThan(0);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      console.log("REST failures:", JSON.stringify(failed, null, 2));
    }
    expect(failed).toEqual([]);
  });
});

describe("conformance — MCP connector", () => {
  it("produces the same number of checks as REST", async () => {
    const restFactory = (script: FakeCoreScript) => {
      const { fetch } = fakeCore(script);
      return restConnector({ endpoint: BASE_URL, fetch });
    };
    const mcpFactory = (script: FakeCoreScript) => {
      const { fetch } = fakeCore(script);
      return mcpConnector({ endpoint: MCP_URL, fetch });
    };

    const restChecks = await runKit(restFactory, BASE_URL);
    const mcpChecks = await runKit(mcpFactory, MCP_URL);

    expect(mcpChecks.length).toBe(restChecks.length);
  });

  it("all REST and MCP checks pass", async () => {
    const restFactory = (script: FakeCoreScript) => {
      const { fetch } = fakeCore(script);
      return restConnector({ endpoint: BASE_URL, fetch });
    };
    const mcpFactory = (script: FakeCoreScript) => {
      const { fetch } = fakeCore(script);
      return mcpConnector({ endpoint: MCP_URL, fetch });
    };

    const restChecks = await runKit(restFactory, BASE_URL);
    const mcpChecks = await runKit(mcpFactory, MCP_URL);

    const all = [...restChecks, ...mcpChecks];
    const failed = all.filter((c) => !c.ok);
    if (failed.length > 0) {
      console.log("Failures:", JSON.stringify(failed, null, 2));
    }
    expect(failed).toEqual([]);
  });
});

describe("conformance — drift detector", () => {
  it("reports every check name explicitly", async () => {
    const factory = (script: FakeCoreScript) => {
      const { fetch } = fakeCore(script);
      return restConnector({ endpoint: BASE_URL, fetch });
    };
    const checks = await runKit(factory, BASE_URL);
    const names = checks.map((c) => c.name);
    expect(names).toContain("health-resolves-when-core-is-down");
    expect(names).toContain("health-reachable-when-core-is-up");
    expect(names).toContain("status-returns-providers");
    expect(names).toContain("ask-maps-answered-by-and-attempts");
    expect(names).toContain("ask-returns-value-when-no-provider");
    expect(names).toContain("failure-modes-are-distinguishable");
    expect(names).toContain("endpoint-is-exact");
  });
});

describe("conformance — kit is not decorative (broken connector)", () => {
  /** A connector whose ask() throws instead of returning success: false. */
  function brokenConnector(
    _script: FakeCoreScript,
  ): CoreConnector {
    return {
      kind: "rest",
      endpoint: BASE_URL,
      async health() {
        return {
          reachable: true,
          endpoint: BASE_URL,
          detail: "ok",
        };
      },
      async status() {
        return { birds: [], timestamp: 0 } as FlockStatus;
      },
      async ask() {
        throw new Error("broken-ask-throws");
      },
    };
  }

  it("the kit fails the broken connector, naming the specific check", async () => {
    const checks = await runConnectorConformance({
      connector: brokenConnector,
      endpoint: BASE_URL,
    });

    const failed = checks.filter((c) => !c.ok);
    const failNames = failed.map((c) => c.name);

    // ask-returns-value-when-no-provider must fail: ask() throws instead
    // of returning { success: false, error }.
    expect(failNames).toContain("ask-returns-value-when-no-provider");
    // The broken connector may also fail other checks. The point is the
    // kit detects it.
    expect(failed.length).toBeGreaterThan(0);
  });
});

describe("conformance — session enforcement", () => {
  it("MCP fake core rejects tools/call without Mcp-Session-Id", async () => {
    const { fetch } = fakeCore();
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "simorgh_ask", arguments: { prompt: "hi" } },
      }),
    });
    const body = (await res.json()) as {
      jsonrpc: string;
      error?: { message?: string };
    };
    expect(body.error?.message).toContain("Session");
  });
});
