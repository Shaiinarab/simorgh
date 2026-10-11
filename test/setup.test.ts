import { describe, expect, it } from "vitest";
import {
  PROVIDER_KEY_CHECKS,
  findProviderKeyCheck,
  secretPutCommand,
  setupProviderRows,
  validateProviderKey,
} from "../src/setup";

// ── What this suite is for ───────────────────────────────────────────────────
//
// `POST /api/v1/setup/validate` is **unauthenticated** and makes outbound calls, which
// makes it the most dangerous new surface in this change. Two properties have to hold
// or the wizard is a vulnerability rather than a convenience:
//
//   1. the URL it dials comes from our table, never from the request (no SSRF);
//   2. the pasted key is never echoed back, not even redacted.
//
// Both are asserted here with a fetch double that records every URL it is handed, so
// property 1 is checked against what was *actually dialled*, not against what the
// function was asked to do.

const KEY = "sk-live-looking-but-fake-key";

function recordingFetch(response: () => Response) {
  const urls: string[] = [];
  const impl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return Promise.resolve(response());
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("the provider table", () => {
  it("names a real Env binding for every row", () => {
    // A row whose `secret` was not a binding name would generate a `wrangler secret
    // put` command that sets a variable nothing reads — the wizard's whole promise is
    // that its command is correct.
    for (const row of PROVIDER_KEY_CHECKS) {
      expect(row.secret).toMatch(/^[A-Z0-9_]+$/);
      expect(row.secret, row.label).toContain("_");
    }
  });

  it("carries Homā only as its absence — it needs no key", () => {
    expect(
      PROVIDER_KEY_CHECKS.some((r) => /homā|workers ai|home/i.test(r.label))
    ).toBe(false);
  });

  it("resolves a provider by label or by binding name", () => {
    expect(findProviderKeyCheck("groq")?.secret).toBe("GROQ_API_KEY");
    expect(findProviderKeyCheck("GROQ_API_KEY")?.label).toBe("Groq");
    // The label, not a shorthand: the dashboard sends `row.label` verbatim, and this
    // resolver is deliberately exact rather than fuzzy. A provider name it cannot
    // match is refused with a clear message instead of dialling something guessed.
    expect(findProviderKeyCheck("  Google Gemini  ")?.secret).toBe("GEMINI_API_KEY");
    expect(findProviderKeyCheck("gemini_api_key")?.label).toBe("Google Gemini");
    expect(findProviderKeyCheck("nope")).toBeUndefined();
  });

  it("generates the exact command, never a guess", () => {
    expect(secretPutCommand("GROQ_API_KEY")).toBe("wrangler secret put GROQ_API_KEY");
    expect(setupProviderRows()).toHaveLength(PROVIDER_KEY_CHECKS.length);
  });
});

describe("validateProviderKey", () => {
  it("accepts a key the provider accepts", async () => {
    const { impl, urls } = recordingFetch(() => json(200));
    const result = await validateProviderKey(impl, "groq", KEY);
    expect(result).toEqual({ ok: true, detail: expect.stringContaining("Shāhīn") });
    expect(urls).toEqual(["https://api.groq.com/openai/v1/models"]);
  });

  it("refuses a rejected key without echoing it", async () => {
    const { impl } = recordingFetch(() => json(401));
    const result = await validateProviderKey(impl, "groq", KEY);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not valid");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("distinguishes rate-limited from rejected, and refused-from-down", async () => {
    const limited = recordingFetch(() => json(429));
    expect((await validateProviderKey(limited.impl, "groq", KEY)).detail).toContain(
      "Rate-limited"
    );

    const down = recordingFetch(() => json(503));
    const result = await validateProviderKey(down.impl, "groq", KEY);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("503");
    // A provider outage must not read as a bad key.
    expect(result.detail).not.toContain("not valid");
  });

  it("treats a network failure as unknown, not as a bad key", async () => {
    const impl = (() => Promise.reject(new Error("ETIMEDOUT"))) as unknown as typeof fetch;
    const result = await validateProviderKey(impl, "groq", KEY);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Could not reach");
    expect(result.detail).not.toContain("not valid");
  });

  it("refuses an unknown provider before dialling anything", async () => {
    const { impl, urls } = recordingFetch(() => json(200));
    const result = await validateProviderKey(impl, "not-a-provider", KEY);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("No such provider");
    // The load-bearing one: nothing was dialled at all.
    expect(urls).toEqual([]);
  });

  it("never dials a host the caller supplied", async () => {
    // The SSRF guard. A provider name that is a URL must resolve to nothing, and the
    // fetch double must never see an attacker-controlled host.
    const { impl, urls } = recordingFetch(() => json(200));
    for (const evil of [
      "https://evil.example/steal",
      "http://169.254.169.254/latest/meta-data",
      "groq https://evil.example",
    ]) {
      const result = await validateProviderKey(impl, evil, KEY);
      expect(result.ok, evil).toBe(false);
    }
    expect(urls).toEqual([]);
  });

  it("puts the key on the wire only the way its row declares", async () => {
    // Two transports, and a row wired to the wrong one would send a bearer where a
    // query parameter belongs — a credential in a log line.
    const bearer = recordingFetch(() => json(200));
    await validateProviderKey(bearer.impl, "groq", KEY);
    const viaQuery = recordingFetch(() => json(200));
    await validateProviderKey(viaQuery.impl, "Google Gemini", KEY);
    expect(viaQuery.urls[0]).toContain("key=");
    expect(viaQuery.urls[0]).toContain("generativelanguage.googleapis.com");
  });

  it("refuses an empty key without a network call", async () => {
    const { impl, urls } = recordingFetch(() => json(200));
    const result = await validateProviderKey(impl, "groq", "   ");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Paste a key");
    expect(urls).toEqual([]);
  });
});
