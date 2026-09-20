import { describe, expect, it } from "vitest";
import { MAX_EXECUTE_BODY_CHARS, MAX_PROMPT_CHARS, MAX_TOOLS, authenticateServiceRequest, constantTimeEqual, parseExecuteBody } from "../src/security";
const tools = ["search_web", "get_server_time"] as const;
const req = (headers?: Record<string, string>) => new Request("https://simorgh.example/api/v1/agent/execute", { headers });
const secureEnv = () => ({ SIMORGH_API_KEY: "test-secret", ENVIRONMENT: "production" } as unknown as Env);

describe("authentication", () => {
  it("accepts configured bearer token", async () => expect((await authenticateServiceRequest(req({ Authorization: "Bearer test-secret" }), secureEnv())).ok).toBe(true));
  it("rejects missing and wrong credentials", async () => { expect((await authenticateServiceRequest(req(), secureEnv())).status).toBe(401); expect((await authenticateServiceRequest(req({ Authorization: "Bearer wrong" }), secureEnv())).status).toBe(401); });
  it("compares equal and unequal values", async () => { expect(await constantTimeEqual("abc", "abc")).toBe(true); expect(await constantTimeEqual("abc", "abd")).toBe(false); expect(await constantTimeEqual("abc", "abcd")).toBe(false); });
  it("fails closed without configuration", async () => expect((await authenticateServiceRequest(req({ Authorization: "Bearer anything" }), { ENVIRONMENT: "production" } as unknown as Env)).status).toBe(503));
});
describe("validation", () => {
  it("filters unknown tools", () => expect(parseExecuteBody(JSON.stringify({ prompt: "hello", tools: ["search_web", "bad", "get_server_time"], userId: "telegram:123" }), tools)).toEqual({ prompt: "hello", tools: ["search_web", "get_server_time"], blockedTools: ["bad"], userId: "telegram:123", tier: "Free-Volunteer" }));
  it("rejects conflicting identities", () => expect(() => parseExecuteBody(JSON.stringify({ prompt: "hello", userId: "a" }), tools, "b")).toThrow("must match"));
  it("enforces limits", () => { expect(MAX_TOOLS).toBeGreaterThan(0); expect(() => parseExecuteBody(JSON.stringify({ prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }), tools)).toThrow("exceeds"); expect(() => parseExecuteBody("x".repeat(MAX_EXECUTE_BODY_CHARS + 1), tools)).toThrow("exceeds"); });
});
