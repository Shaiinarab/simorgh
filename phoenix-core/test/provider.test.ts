// The provider adapters, driven through the `Provider` port with a stubbed `fetch`.
//
// Two things are under test and they are not the same thing:
//
//   * the wire formats — what actually goes out, and where the answer comes back from;
//   * the failure modes that must NOT throw. A provider that throws costs more than a
//     failed dial: it escapes `provider.call`, skips the flock's `record()`, and leaves
//     the failure invisible to Swarm-State. So "returns a result" and "throws nothing" are
//     asserted separately, and every failure case asserts the exact error string.
//
// The payloads below are the documented Google and OpenAI response shapes, transcribed
// from the vendors' own docs (Google fetched 2026-10-08). They are deliberately *not*
// the shape the other adapter reads: that asymmetry is what the negative control at the
// bottom of this file exists to catch.
import { describe, expect, it } from "vitest";

import type { FetchLike, HttpInit, HttpLike } from "../src/ports.ts";
import {
  geminiProvider,
  openAiCompatibleProvider,
  type Provider,
  type ProviderContext,
} from "../src/provider.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Google's documented 200 body: the answer is at candidates[0].content.parts[0].text. */
const GEMINI_OK_BODY = {
  candidates: [
    { content: { parts: [{ text: "gemini-says-hi" }], role: "model" } },
  ],
};

/** The OpenAI chat-completions 200 body: the answer is at choices[0].message.content. */
const OPENAI_OK_BODY = {
  choices: [{ message: { content: "openai-says-hi" }, finish_reason: "stop" }],
};

/**
 * One recorded call, so a test can assert on what went out and not only on what came back.
 *
 * Both fields are optional because an unrecorded call is the assertion a dormant test
 * wants: `url` staying `undefined` is how "it never dialled" is observed.
 */
interface Call {
  url?: string;
  init?: HttpInit;
}

function httpLike(overrides: Partial<HttpLike>): HttpLike {
  return { ok: true, status: 200, json: async () => ({}), ...overrides };
}

/** A `FetchLike` that records its arguments and answers with `response`. */
function stubFetch(response: HttpLike, call: Call): FetchLike {
  return async (url, init) => {
    call.url = url;
    call.init = init;
    return response;
  };
}

/** A `FetchLike` that rejects, the way a DNS or TLS failure reaches an adapter. */
function rejectingFetch(message: string, call: Call): FetchLike {
  return async (url, init) => {
    call.url = url;
    call.init = init;
    throw new TypeError(message);
  };
}

function context(fetch: FetchLike, secrets: Record<string, string> = {}): ProviderContext {
  return { fetch, secret: (name) => secrets[name] };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function headers(call: Call): Headers {
  return new Headers(call.init?.headers ?? {});
}

const gemini = (): Provider =>
  geminiProvider({
    id: "gemini",
    name: "Gemini",
    provider: "Google Generative Language",
    model: "gemini-2.5-flash",
    priority: 15,
    requires: "GEMINI_API_KEY",
  });

const openAi = (): Provider =>
  openAiCompatibleProvider({
    id: "openrouter",
    name: "OpenRouter",
    provider: "OpenRouter (OpenAI-compat)",
    model: "openrouter/free",
    priority: 25,
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    requires: "OPENROUTER_API_KEY",
  });

// ── geminiProvider — Google's generateContent shape ───────────────────────────

describe("geminiProvider", () => {
  it("reads the answer out of candidates[0].content.parts[0].text", async () => {
    const call: Call = {};
    const result = await gemini().call(
      "ping",
      context(stubFetch(httpLike({ json: async () => GEMINI_OK_BODY }), call), {
        GEMINI_API_KEY: "g-key",
      })
    );

    expect(result).toEqual({ ok: true, answer: "gemini-says-hi" });
    // The model is named in the path, the key rides in `x-goog-api-key`, and the prompt
    // is wrapped in `contents[].parts[]` — not `messages[]`. Asserting the whole request
    // is the only way to catch a body that happens to still parse as a 200.
    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    );
    expect(headers(call).get("x-goog-api-key")).toBe("g-key");
    expect(headers(call).get("Authorization")).toBeNull();
    expect(body(call).contents).toEqual([{ parts: [{ text: "ping" }] }]);
    expect(body(call).messages).toBeUndefined();
    expect(body(call).model).toBeUndefined();
  });

  it("yields an empty answer when the response carries no candidates", async () => {
    // Not a throw and not a failure: a blocked or empty candidate arrives with a
    // `finishReason` and no content, and the routing loop already knows what to do with
    // an empty answer (fall through). Turning it into an exception would take down the
    // whole request over one unusable candidate.
    for (const payload of [{}, { candidates: [] }, { candidates: [{ finishReason: "SAFETY" }] }]) {
      const result = await gemini().call(
        "ping",
        context(
          stubFetch(httpLike({ json: async () => payload }), {}),
          { GEMINI_API_KEY: "g-key" }
        )
      );

      expect(result).toEqual({ ok: true, answer: "" });
    }
  });

  it("maps HTTP 429 to exactly `rate_limit`", async () => {
    // The string is a contract, not a label: `recordObservation(…, error === "rate_limit", …)`
    // compares it literally to choose the long cooldown, so any other spelling quietly
    // downgrades a rate limit to the short failure cooldown.
    const result = await gemini().call(
      "ping",
      context(
        stubFetch(httpLike({ ok: false, status: 429 }), {}),
        { GEMINI_API_KEY: "g-key" }
      )
    );

    expect(result).toEqual({ ok: false, error: "rate_limit" });
  });

  it("reports other HTTP failures as http_<status>", async () => {
    const result = await gemini().call(
      "ping",
      context(
        stubFetch(httpLike({ ok: false, status: 503 }), {}),
        { GEMINI_API_KEY: "g-key" }
      )
    );

    expect(result).toEqual({ ok: false, error: "http_503" });
  });

  it("degrades a rejected transport to a failure instead of throwing", async () => {
    const result = await gemini().call(
      "ping",
      context(rejectingFetch("network unreachable", {}), { GEMINI_API_KEY: "g-key" })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network unreachable/);
  });

  it("reports itself dormant, without dialling, when its key is absent", async () => {
    // `describeFlock` reads `requires` to decide dormancy, so a keyed provider must
    // declare one — otherwise the status endpoint calls a keyless bird healthy.
    const call: Call = {};
    const result = await gemini().call(
      "ping",
      context(stubFetch(httpLike({ json: async () => GEMINI_OK_BODY }), call), {})
    );

    expect(result).toEqual({ ok: false, error: "dormant" });
    expect(call.url).toBeUndefined();
    expect(gemini().requires).toBe("GEMINI_API_KEY");
  });

  it("defaults its secret name to GEMINI_API_KEY", () => {
    // A spec that names no secret still gets a keyed bird, because Google's API has no
    // unauthenticated form. Without the default the entry would report `healthy` and
    // then 403 on every dial.
    const undeclared = geminiProvider({
      id: "g",
      name: "G",
      provider: "Google",
      model: "gemini-2.5-flash",
      priority: 1,
    });

    expect(undeclared.requires).toBe("GEMINI_API_KEY");
  });
});

// ── openAiCompatibleProvider — the parameterised OpenAI shape ─────────────────

describe("openAiCompatibleProvider", () => {
  it("reads the answer out of choices[0].message.content", async () => {
    const call: Call = {};
    const result = await openAi().call(
      "ping",
      context(stubFetch(httpLike({ json: async () => OPENAI_OK_BODY }), call), {
        OPENROUTER_API_KEY: "or-key",
      })
    );

    expect(result).toEqual({ ok: true, answer: "openai-says-hi" });
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headers(call).get("Authorization")).toBe("Bearer or-key");
    expect(body(call).model).toBe("openrouter/free");
    expect(body(call).messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("yields an empty answer when the response carries no choices", async () => {
    for (const payload of [{}, { choices: [] }, { choices: [{}] }]) {
      const result = await openAi().call(
        "ping",
        context(stubFetch(httpLike({ json: async () => payload }), {}), {
          OPENROUTER_API_KEY: "or-key",
        })
      );

      expect(result).toEqual({ ok: true, answer: "" });
    }
  });

  it("maps HTTP 429 to exactly `rate_limit`", async () => {
    const result = await openAi().call(
      "ping",
      context(stubFetch(httpLike({ ok: false, status: 429 }), {}), {
        OPENROUTER_API_KEY: "or-key",
      })
    );

    expect(result).toEqual({ ok: false, error: "rate_limit" });
  });

  it("reports other HTTP failures as http_<status>", async () => {
    const result = await openAi().call(
      "ping",
      context(stubFetch(httpLike({ ok: false, status: 500 }), {}), {
        OPENROUTER_API_KEY: "or-key",
      })
    );

    expect(result).toEqual({ ok: false, error: "http_500" });
  });

  it("degrades a rejected transport to a failure instead of throwing", async () => {
    const result = await openAi().call(
      "ping",
      context(rejectingFetch("socket hang up", {}), { OPENROUTER_API_KEY: "or-key" })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/socket hang up/);
  });

  it("reports itself dormant, without dialling, when its key is absent", async () => {
    const call: Call = {};
    const result = await openAi().call(
      "ping",
      context(stubFetch(httpLike({ json: async () => OPENAI_OK_BODY }), call), {})
    );

    expect(result).toEqual({ ok: false, error: "dormant" });
    expect(call.url).toBeUndefined();
  });

  it("sends spec.extraHeaders on the request", async () => {
    // The parameterisation is only real if the headers reach the wire. OpenRouter is the
    // reason the field exists: same body and URL shape, plus `HTTP-Referer` and `X-Title`
    // for app attribution.
    const call: Call = {};
    const provider = openAiCompatibleProvider({
      id: "openrouter",
      name: "OpenRouter",
      provider: "OpenRouter (OpenAI-compat)",
      model: "openrouter/free",
      priority: 25,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      requires: "OPENROUTER_API_KEY",
      extraHeaders: {
        "HTTP-Referer": "https://github.com/Shaiinarab/simorgh",
        "X-Title": "Simorgh",
      },
    });

    const result = await provider.call(
      "ping",
      context(stubFetch(httpLike({ json: async () => OPENAI_OK_BODY }), call), {
        OPENROUTER_API_KEY: "or-key",
      })
    );

    expect(headers(call).get("HTTP-Referer")).toBe("https://github.com/Shaiinarab/simorgh");
    expect(headers(call).get("X-Title")).toBe("Simorgh");
    // …and the headers it owns are untouched, so `extraHeaders` is an addition rather
    // than a replacement.
    expect(headers(call).get("Content-Type")).toBe("application/json");
    expect(headers(call).get("Authorization")).toBe("Bearer or-key");
    expect(result.answer).toBe("openai-says-hi");
  });

  it("will not let extraHeaders shadow the credential", async () => {
    // The credential is resolved from the secret; a spec-supplied `Authorization` would
    // send the wrong one and 401 while the deployment looked correctly configured.
    const call: Call = {};
    const provider = openAiCompatibleProvider({
      id: "sneaky",
      name: "Sneaky",
      provider: "p",
      model: "m",
      priority: 1,
      endpoint: "https://example.invalid/v1/chat/completions",
      requires: "OPENROUTER_API_KEY",
      extraHeaders: { Authorization: "Bearer not-the-secret", "Content-Type": "text/plain" },
    });

    await provider.call(
      "ping",
      context(stubFetch(httpLike({ json: async () => OPENAI_OK_BODY }), call), {
        OPENROUTER_API_KEY: "or-key",
      })
    );

    expect(headers(call).get("Authorization")).toBe("Bearer or-key");
    expect(headers(call).get("Content-Type")).toBe("application/json");
  });
});

// ── The negative control ──────────────────────────────────────────────────────
//
// Every fixture above is shaped for the adapter that reads it, so a detector that only
// ever saw matching payloads would also pass if the Gemini path had been changed to read
// the OpenAI field. That failure is invisible in production: the request still returns
// 200, the bird still reports itself healthy, and every answer is "".
//
// So: hand the Gemini adapter a body carrying BOTH shapes and assert the Gemini one
// wins and the OpenAI one is ignored. This assertion fails if and only if the Gemini
// read is swapped for `choices[0].message.content`.

describe("the two wire formats stay distinguishable", () => {
  it("Gemini reads its own shape and ignores an OpenAI-shaped body", async () => {
    const mixed = { ...OPENAI_OK_BODY, ...GEMINI_OK_BODY };
    expect(mixed.choices[0].message.content).toBe("openai-says-hi");
    expect(mixed.candidates[0].content.parts[0].text).toBe("gemini-says-hi");

    const result = await gemini().call(
      "ping",
      context(stubFetch(httpLike({ json: async () => mixed }), {}), {
        GEMINI_API_KEY: "g-key",
      })
    );

    expect(result).toEqual({ ok: true, answer: "gemini-says-hi" });
    expect(result.answer).not.toBe("openai-says-hi");
  });

  it("and the OpenAI adapter does the mirror image", async () => {
    // The reverse direction, because the bug is symmetric: an OpenAI adapter pointed at
    // Gemini's body must also come back empty rather than crash.
    const result = await openAi().call(
      "ping",
      context(stubFetch(httpLike({ json: async () => GEMINI_OK_BODY }), {}), {
        OPENROUTER_API_KEY: "or-key",
      })
    );

    expect(result).toEqual({ ok: true, answer: "" });
  });
});