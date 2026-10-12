import { describe, expect, it } from "vitest";
import { checkMcpAddress } from "../src/setup-mcp";

// ── What this suite is for ───────────────────────────────────────────────────
//
// An MCP address is a URL, not a credential, so it must not be checked like one.
// The property that matters is the one a reachability check gets wrong: **a URL that
// answers 200 with something that is not MCP must fail.** A checker that only tested
// "did it respond" would tell an operator their MCP server is wired when the address
// hosts an unrelated page, and that is precisely the belief the check exists to earn.
//
// The response bodies below are real shapes: plain JSON, and the SSE `data:` form the
// protocol also permits. Both must be understood, or a working server reads as broken.

const KEY = "sk-live-looking-but-fake-key";

function recordingFetch(response: () => Response) {
  const calls: { url: string; body: string }[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return Promise.resolve(response());
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** An MCP initialize response, in the plain-JSON shape. */
const mcpOk = (name: string, version: string) =>
  json(200, { jsonrpc: "2.0", id: 1, result: { serverInfo: { name, version } } });

describe("checkMcpAddress", () => {
  it("accepts a server that answers an MCP initialize handshake", async () => {
    const { impl, calls } = recordingFetch(() => mcpOk("Cloudflare", "1.2.3"));
    const result = await checkMcpAddress(impl, "https://mcp.example.com/mcp");
    expect(result.ok).toBe(true);
    expect(result.server).toBe("Cloudflare 1.2.3");
    expect(calls[0].url).toBe("https://mcp.example.com/mcp");
    // The handshake actually sent an initialize, not a GET.
    expect(JSON.parse(calls[0].body).method).toBe("initialize");
  });

  it("accepts the SSE data: form a real MCP server is allowed to send", async () => {
    const sse = new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"GitHub","version":"9.9.9"}}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
    const { impl } = recordingFetch(() => sse);
    const result = await checkMcpAddress(impl, "https://mcp.example.com/sse");
    expect(result.ok).toBe(true);
    expect(result.server).toBe("GitHub 9.9.9");
  });

  it("fails a 200 that is not MCP — the case reachability gets wrong", async () => {
    // A live URL hosting an unrelated page: reachable, and not an MCP server.
    const page = new Response("<!DOCTYPE html><title>It works!</title>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    const { impl } = recordingFetch(() => page);
    const result = await checkMcpAddress(impl, "https://example.com/");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("nothing there speaks MCP");
  });

  it("reports a refusal from a real server honestly", async () => {
    const { impl } = recordingFetch(() => json(401, { error: "unauthorized" }));
    const result = await checkMcpAddress(impl, "https://mcp.example.com/mcp");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
    expect(result.detail).toContain("refused an MCP handshake");
  });

  it("treats a network failure as unknown rather than as a bad address", async () => {
    const impl = (() => Promise.reject(new Error("ETIMEDOUT"))) as unknown as typeof fetch;
    const result = await checkMcpAddress(impl, "https://mcp.example.com/mcp");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Could not reach");
  });

  it("refuses non-http schemes without dialling anything", async () => {
    const { impl, calls } = recordingFetch(() => mcpOk("X", "1"));
    for (const url of ["file:///etc/passwd", "data:text/html,hi", "ftp://x/y"]) {
      expect((await checkMcpAddress(impl, url)).ok, url).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a malformed or empty address without dialling", async () => {
    const { impl, calls } = recordingFetch(() => mcpOk("X", "1"));
    expect((await checkMcpAddress(impl, "not-a-url")).ok).toBe(false);
    expect((await checkMcpAddress(impl, "   ")).detail).toContain("Paste an address");
    expect(calls).toEqual([]);
  });
});
