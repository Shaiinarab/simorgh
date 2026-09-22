import { describe, expect, it } from "vitest";

import {
  MAX_EXECUTE_BODY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TOOLS,
  authenticateServiceRequest,
  constantTimeEqual,
  extractBearerToken,
  isAllowedOrigin,
  parseExecuteBody,
} from "../src/security.ts";
import { AGENT_TOOLS } from "../src/agent.ts";
import { createNodePorts } from "../src/node/index.ts";

const { sha256 } = createNodePorts();

const headers = (init: Record<string, string>) => new Headers(init);
const request = (init?: Record<string, string>) => headers(init ?? {});

describe("extractBearerToken", () => {
  it("extracts an ordinary token", () => {
    expect(extractBearerToken(headers({ Authorization: "Bearer test-secret" }))).toBe(
      "test-secret"
    );
  });

  it("is case-insensitive on the scheme and tolerates extra whitespace", () => {
    expect(extractBearerToken(headers({ Authorization: "bearer   spaced-token  " }))).toBe(
      "spaced-token"
    );
  });

  it("does not accept a bare token or another scheme", () => {
    expect(extractBearerToken(headers({ Authorization: "test-secret" }))).toBeUndefined();
    expect(extractBearerToken(headers({ Authorization: "Basic dXNlcjpwYXNz" }))).toBeUndefined();
    expect(extractBearerToken(headers({}))).toBeUndefined();
  });

  it("matches the literal characters B-e-a-r-e-r, not a backslash escape", () => {
    // Regression guard. A previous version of this regex was written as
    // `/^Bearer\\s+(.+)$/i` — two literal backslashes — so it required the string
    // "Bearer\ssss" and rejected every real token. Authentication failed closed for
    // *every* request, and the only symptom was a wall of 401s far from the cause.
    const token = extractBearerToken(headers({ Authorization: "Bearer abc" }));
    expect(token).toBe("abc");
    expect(extractBearerToken(headers({ Authorization: "Bearer\\sabc" }))).toBeUndefined();
  });
});

describe("constantTimeEqual", () => {
  it("compares equal and unequal values", async () => {
    expect(await constantTimeEqual("abc", "abc", sha256)).toBe(true);
    expect(await constantTimeEqual("abc", "abd", sha256)).toBe(false);
  });

  it("rejects a prefix and an extension of the same secret", async () => {
    // Length is folded in via the digest length, so neither a prefix nor an
    // extension of the real secret can pass.
    expect(await constantTimeEqual("abc", "abcd", sha256)).toBe(false);
    expect(await constantTimeEqual("abcd", "abc", sha256)).toBe(false);
  });

  it("handles empty inputs without throwing", async () => {
    expect(await constantTimeEqual("", "", sha256)).toBe(true);
    expect(await constantTimeEqual("", "x", sha256)).toBe(false);
  });
});

describe("authenticateServiceRequest", () => {
  it("accepts the configured token", async () => {
    const result = await authenticateServiceRequest(
      request({ Authorization: "Bearer test-secret" }),
      { apiKey: "test-secret", sha256 }
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a missing or wrong token", async () => {
    for (const value of [undefined, "Bearer wrong", "Bearer ", ""]) {
      const result = await authenticateServiceRequest(
        request(value === undefined ? {} : { Authorization: value }),
        { apiKey: "test-secret", sha256 }
      );
      expect(result).toEqual({ ok: false, status: 401, code: "UNAUTHORIZED" });
    }
  });

  it("fails closed when no key is configured", async () => {
    for (const apiKey of [undefined, "", "   "]) {
      const result = await authenticateServiceRequest(
        request({ Authorization: "Bearer anything" }),
        { apiKey, sha256 }
      );
      expect(result).toEqual({
        ok: false,
        status: 503,
        code: "AUTH_NOT_CONFIGURED",
      });
    }
  });
});

describe("parseExecuteBody", () => {
  it("filters unknown tools and reports what it refused", () => {
    const parsed = parseExecuteBody(
      JSON.stringify({
        prompt: "hello",
        tools: ["search_web", "bad", "get_server_time", "bad"],
        userId: "telegram:123",
      }),
      AGENT_TOOLS
    );

    expect(parsed).toEqual({
      prompt: "hello",
      tools: ["search_web", "get_server_time"],
      blockedTools: ["bad"],
      userId: "telegram:123",
      tier: "Free-Volunteer",
    });
  });

  it("rejects a body that is not a JSON object", () => {
    for (const raw of ["not json", "[]", "null", '"str"', "42"]) {
      expect(() => parseExecuteBody(raw, AGENT_TOOLS)).toThrow();
    }
  });

  it("rejects an empty or non-string prompt", () => {
    for (const prompt of ["", "   ", 42, null, undefined]) {
      expect(() =>
        parseExecuteBody(JSON.stringify({ prompt }), AGENT_TOOLS)
      ).toThrow(/prompt/);
    }
  });

  it("enforces the prompt, body, and tool caps", () => {
    expect(() =>
      parseExecuteBody(
        JSON.stringify({ prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }),
        AGENT_TOOLS
      )
    ).toThrow(/exceeds/);
    expect(() => parseExecuteBody("x".repeat(MAX_EXECUTE_BODY_CHARS + 1), AGENT_TOOLS)).toThrow(
      /exceeds/
    );
    expect(() =>
      parseExecuteBody(
        JSON.stringify({
          prompt: "hi",
          tools: Array.from({ length: MAX_TOOLS + 1 }, () => "search_web"),
        }),
        AGENT_TOOLS
      )
    ).toThrow(/At most/);
  });

  it("refuses conflicting identities instead of picking one", () => {
    expect(() =>
      parseExecuteBody(JSON.stringify({ prompt: "hi", userId: "a" }), AGENT_TOOLS, "b")
    ).toThrow(/must match/);
  });

  it("accepts a matching body and header identity", () => {
    const parsed = parseExecuteBody(
      JSON.stringify({ prompt: "hi", userId: "a", tier: "Pro-Data-Pact" }),
      AGENT_TOOLS,
      "a"
    );
    expect(parsed).toMatchObject({ userId: "a", tier: "Pro-Data-Pact" });
  });

  it("defaults an anonymous caller and rejects an unusable user id", () => {
    expect(parseExecuteBody(JSON.stringify({ prompt: "hi" }), AGENT_TOOLS).userId).toBe(
      "anonymous"
    );
    expect(() =>
      parseExecuteBody(JSON.stringify({ prompt: "hi", userId: "<script>" }), AGENT_TOOLS)
    ).toThrow(/userId/);
  });
});

describe("isAllowedOrigin", () => {
  it("allow-lists exact origins and nothing else", () => {
    const configured = "http://localhost:3000, https://simorgh.example";
    expect(isAllowedOrigin("http://localhost:3000", configured)).toBe(true);
    expect(isAllowedOrigin("https://simorgh.example", configured)).toBe(true);
    expect(isAllowedOrigin("https://evil.example", configured)).toBe(false);
  });

  it("allows nothing when unconfigured rather than defaulting to a wildcard", () => {
    for (const configured of [undefined, "", "  "]) {
      expect(isAllowedOrigin("https://anything.example", configured)).toBe(false);
    }
  });
});
