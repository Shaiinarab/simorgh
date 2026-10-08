// Parity between the Node catalog and the Cloudflare catalog — the detector for the
// bug this file was written for.
//
// The bug: `/api/v1/flock/status` is one published endpoint, but it is served by two hosts
// that each declared their own provider list. When Gemini and OpenRouter landed in
// `src/flock.ts` and not in `simorgh-platform/src/runtimes/providers.ts`, the same request
// answered with five birds on Cloudflare and two on a self-hosted core — so "the flock has
// five options" was true of the managed target only, which is exactly the claim the
// self-hosted path has to keep.
//
// ── Why this is not a straight import of the reference ──
//
// `src/flock.ts` imports `cloudflare:workers` (it also holds the Durable Object shell), so it
// cannot be resolved in the Node suite — importing it would be a collection-time failure, not
// a failed assertion, which is a hard stop. So parity is pinned two ways instead:
//
//   1. against an explicit expected roster below, which is the authoritative list; and
//   2. against the *text* of `src/flock.ts`, read with `node:fs`, which is the direction a
//      hardcoded list cannot cover on its own: a bird added on the Workers host and forgotten
//      here would leave list (1) green and the two hosts disagreeing again.
//
// (2) is a source read, not an import, and it is deliberately paired with a non-vacuity guard:
// a parser that silently found nothing must fail rather than pass every `every()` over an
// empty array. That failure mode is the reason a detector that "has never fired" is not
// evidence.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeFlock } from "@simorgh/phoenix-core";
import type { FetchLike, HttpInit, HttpLike } from "@simorgh/phoenix-core";
import { defaultProviders } from "../src/runtimes/providers.ts";

const NOW = 1_700_000_000_000;

/**
 * The Cloudflare catalog, `src/flock.ts` → `export const PROVIDERS`, as of 2026-10-08.
 *
 * Keep in sync with `src/flock.ts`, which is the reference implementation and owns the roster.
 * `homa` is the one entry the Node catalog does not mirror: it is a Cloudflare Workers AI
 * binding with no portable equivalent, and the absence is deliberate rather than a gap.
 */
const WORKERS_ROSTER = [
  { id: "shahin", name: "Shāhīn", provider: "Groq (OpenAI-compat)", model: "llama-3.3-70b-versatile", priority: 10 },
  { id: "gemini", name: "Gemini", provider: "Google Generative Language", model: "gemini-2.5-flash", priority: 15 },
  { id: "bulbul", name: "Bulbul", provider: "HuggingFace Router", model: "meta-llama/Llama-3.3-70B-Instruct", priority: 20 },
  { id: "openrouter", name: "OpenRouter", provider: "OpenRouter (OpenAI-compat)", model: "openrouter/free", priority: 25 },
  { id: "homa", name: "Homā", provider: "Cloudflare Workers AI", model: "@cf/meta/llama-3.2-3b-instruct", priority: 30 },
];

/** The keys that wake each keyed bird, as the edge declares them. */
const WORKERS_SECRET_OF: Record<string, string> = {
  shahin: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  bulbul: "HF_TOKEN",
  openrouter: "OPENROUTER_API_KEY",
  homa: "",
};

const SECRET_VALUES: Record<string, string> = {
  GROQ_API_KEY: "gsk-test",
  GEMINI_API_KEY: "gemini-test",
  HF_TOKEN: "hf-test",
  OPENROUTER_API_KEY: "or-test",
};

/** What the Node catalog must contain when nothing local is configured. */
const EXPECTED_NODE_ROSTER = WORKERS_ROSTER.filter((b) => b.id !== "homa").map((b) => ({
  ...b,
  requires: WORKERS_SECRET_OF[b.id],
}));

// ── Reading the reference catalog ─────────────────────────────────────────────

interface RosterEntry {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
  requires?: string;
}

const WORKERS_SOURCE = fileURLToPath(new URL("../../src/flock.ts", import.meta.url));

/** Field patterns, in the order `PROVIDERS` writes them. Missing ⇒ the shape changed. */
const FIELD_PATTERNS = {
  id: /id:\s*"([^"]+)"/,
  name: /name:\s*"([^"]+)"/,
  provider: /provider:\s*"([^"]+)"/,
  model: /model:\s*([^\n,]+)/,
  priority: /priority:\s*(\d+)/,
  requires: /requires:\s*"([^"]+)"/,
} as const;

/**
 * Parse `PROVIDERS` out of the Workers catalog *as source text*.
 *
 * Standalone comment lines are dropped first so a comment that happens to mention `priority:`
 * cannot become a bird's priority. `//` inside a string literal is untouched because only
 * whole-line comments are stripped, and `https://` never starts a line in that file.
 */
function parseWorkersCatalog(source: string): RosterEntry[] {
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  const start = code.indexOf("export const PROVIDERS");
  if (start === -1) throw new Error("PROVIDERS is gone from src/flock.ts");
  const body = code.slice(start, code.indexOf("\n];", start));

  const constants = new Map<string, string>();
  for (const m of code.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) {
    constants.set(m[1], m[2]);
  }

  const ids = [...body.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m.index);
  return ids.map((at, index) => {
    const entry = body.slice(at, ids[index + 1] ?? body.length);
    const read = (key: keyof typeof FIELD_PATTERNS): string | undefined =>
      FIELD_PATTERNS[key].exec(entry)?.[1]?.trim();
    const model = (read("model") ?? "").replace(/^"|"$/g, "");
    return {
      id: read("id") ?? "",
      name: read("name") ?? "",
      provider: read("provider") ?? "",
      // A model may be a named constant (`GEMINI_MODEL`) rather than a literal. Resolving it
      // is what lets the model string itself be compared, which is the field whose divergence
      // would fail quietly: a wrong model still answers.
      model: constants.get(model) ?? model,
      priority: Number(read("priority")),
      ...(read("requires") ? { requires: read("requires") } : {}),
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const withKeys = (): Record<string, string> => ({ ...SECRET_VALUES });
const noKeys = (): Record<string, string | undefined> => ({});

function statusOf(env: Record<string, string | undefined>) {
  const providers = defaultProviders({ env });
  return describeFlock(providers, {
    secret: (name) => env[name],
    health: [],
    now: NOW,
  });
}

function catalogOf(env: Record<string, string | undefined>) {
  return defaultProviders({ env }).map((p) => ({
    id: p.id,
    name: p.name,
    provider: p.provider,
    model: p.model,
    priority: p.priority,
    requires: p.requires,
  }));
}

interface Recorded {
  url?: string;
  init?: HttpInit;
}

function httpLike(overrides: Partial<HttpLike>): HttpLike {
  return { ok: true, status: 200, json: async () => ({}), ...overrides };
}

/** A `FetchLike` that records what went out; `throwIfCalled` proves "never dialled". */
function recordingFetch(response: HttpLike, call: Recorded, onDial?: () => never): FetchLike {
  return async (url, init) => {
    onDial?.();
    call.url = url;
    call.init = init;
    return response;
  };
}

// ── 1. The roster matches the Workers host ─────────────────────────────────────

describe("the Node provider catalog", () => {
  it("declares every bird the Workers host declares, on the same ids and priorities", () => {
    // Completeness, not containment: `toContain` would pass while a bird went missing, which
    // is the bug this test exists for. `toEqual` is order-sensitive too, and order is the
    // wire order — `describeFlock` maps the catalog as given rather than sorting it.
    expect(catalogOf(noKeys())).toEqual(EXPECTED_NODE_ROSTER);
  });

  it("agrees with the Workers catalog source, bird for bird", () => {
    const parsed = parseWorkersCatalog(readFileSync(WORKERS_SOURCE, "utf8"));

    // Non-vacuity guard. Without it, a parser that found nothing would satisfy every
    // comparison below and this file would be a detector that never fires — the exact thing
    // AGENTS.md's negative-control rule exists to rule out.
    expect(parsed.map((b) => b.id)).toEqual(WORKERS_ROSTER.map((b) => b.id));
    expect(parsed.every((b) => b.id !== "" && b.name !== "" && b.model !== "")).toBe(true);

    // The reference, minus the one bird that cannot exist on Node, must equal this host.
    const portable = parsed
      .filter((b) => b.id !== "homa")
      .map((b) => ({ ...b, requires: WORKERS_SECRET_OF[b.id] }));
    expect(catalogOf(noKeys())).toEqual(portable);

    // And the direction a hardcoded list cannot see on its own: nothing here may be a bird
    // the edge does not have, apart from the local keyless daemon.
    const known = new Set([...parsed.map((b) => b.id), "ollama"]);
    for (const bird of catalogOf(noKeys())) {
      expect(known.has(bird.id), `${bird.id} exists on Node but not on Workers`).toBe(true);
    }
  });

  it("omits Homā, which has no portable equivalent, rather than faking it", () => {
    const ids = catalogOf(noKeys()).map((b) => b.id);
    expect(ids).not.toContain("homa");
    // Nothing else in the catalog may quietly claim to be the keyless one either.
    expect(ids).toEqual(EXPECTED_NODE_ROSTER.map((b) => b.id));
  });

  it("adds the local daemon only when one is configured, and only after every hosted bird", () => {
    expect(catalogOf(noKeys()).map((b) => b.id)).not.toContain("ollama");

    const local = catalogOf({ OLLAMA_BASE_URL: "http://127.0.0.1:11434/" });
    const ollama = local.find((b) => b.id === "ollama");
    expect(ollama).toEqual({
      id: "ollama",
      name: "Ollama",
      provider: "Ollama (local daemon)",
      model: "llama3.2",
      priority: 30,
      requires: undefined,
    });

    // Last, always: a hosted bird arriving at 30 later would otherwise tie with it, and
    // `describeFlock` reports catalog order rather than sorting.
    expect(local.at(-1)?.id).toBe("ollama");
    expect(Math.max(...local.slice(0, -1).map((b) => b.priority))).toBeLessThan(30);

    expect(catalogOf({ OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: " qwen3 " }))
      .toContainEqual(expect.objectContaining({ id: "ollama", model: "qwen3" }));
  });

  it("serves /api/v1/flock/status in the same order, with the same ids and priorities", () => {
    // The payload is assembled by the engine from the catalog *as given*, so catalog order is
    // the order a client sees. Asserted on the assembled payload, not on the catalog.
    const status = statusOf(withKeys());
    expect(status.birds.map((b) => [b.id, b.priority])).toEqual(
      EXPECTED_NODE_ROSTER.map((b) => [b.id, b.priority])
    );
    expect(status.birds.map((b) => b.name)).toEqual(
      EXPECTED_NODE_ROSTER.map((b) => b.name)
    );
  });
});

// ── 2. Dormancy, identical to the edge ────────────────────────────────────────

describe("dormancy on the self-hosted path", () => {
  it("reports every keyed bird dormant when its key is absent", () => {
    const status = statusOf(noKeys());
    expect(status.birds.map((b) => [b.id, b.dormant, b.status])).toEqual(
      EXPECTED_NODE_ROSTER.map((b) => [b.id, true, "dormant"])
    );
  });

  it("wakes each bird when its own key is configured, and only that one", () => {
    for (const bird of EXPECTED_NODE_ROSTER) {
      const key = WORKERS_SECRET_OF[bird.id];
      const status = statusOf({ [key]: SECRET_VALUES[key] });
      const row = status.birds.find((b) => b.id === bird.id);
      expect([bird.id, row?.dormant, row?.status]).toEqual([bird.id, false, "healthy"]);
      expect(status.birds.filter((b) => !b.dormant).map((b) => b.id)).toEqual([bird.id]);
    }
  });

  it("never dials a bird whose key is absent", async () => {
    // Dormancy must be decided before transport, or an unkeyed deployment pays a failed dial
    // and a cooldown on every single request — worse than the bird not existing.
    for (const bird of defaultProviders({ env: noKeys() })) {
      const call: Recorded = {};
      const ctx = {
        fetch: recordingFetch(httpLike({}), call, () => {
          throw new Error(`${bird.id} dialled with no key configured`);
        }),
        secret: () => undefined,
      };
      expect(await bird.call("prompt", ctx)).toEqual({ ok: false, error: "dormant" });
      expect(call.url).toBeUndefined();
    }
  });

  it("keeps the local daemon available with no keys at all", () => {
    // The Node analogue of the zero-KYC guarantee: a deployment that sets OLLAMA_BASE_URL and
    // no other secret still answers, because a bird with no `requires` is never dormant.
    const status = statusOf({ OLLAMA_BASE_URL: "http://127.0.0.1:11434" });
    const awake = status.birds.filter((b) => !b.dormant);
    expect(awake.map((b) => b.id)).toEqual(["ollama"]);
  });
});

// ── 3. The two new birds are wired to their own wire shapes ───────────────────

describe("the added birds dial the endpoints the edge dials", () => {
  it("sends Gemini to Google's generateContent path with an x-goog-api-key header", async () => {
    // Proves this catalog used `geminiProvider`, not an OpenAI-shaped spec. An OpenAI-shaped
    // entry would post an OpenAI body to a URL that does not exist and return "" on every
    // call while the bird reported itself healthy — the quietest failure in this gateway.
    const call: Recorded = {};
    const gemini = defaultProviders({ env: { GEMINI_API_KEY: "gemini-test" } }).find(
      (p) => p.id === "gemini"
    );
    const result = await gemini?.call("who is simorgh", {
      fetch: recordingFetch(
        httpLike({
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "gemini-says-hi" }], role: "model" } }],
          }),
        }),
        call
      ),
      secret: (name) => (name === "GEMINI_API_KEY" ? "gemini-test" : undefined),
    });

    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    );
    expect(call.init?.headers).toMatchObject({ "x-goog-api-key": "gemini-test" });
    expect(result).toEqual({ ok: true, answer: "gemini-says-hi" });
  });

  it("sends OpenRouter its attribution headers alongside the bearer token", async () => {
    const call: Recorded = {};
    const openrouter = defaultProviders({ env: { OPENROUTER_API_KEY: "or-test" } }).find(
      (p) => p.id === "openrouter"
    );
    const result = await openrouter?.call("who is simorgh", {
      fetch: recordingFetch(
        httpLike({
          json: async () => ({ choices: [{ message: { content: "openrouter-says-hi" } }] }),
        }),
        call
      ),
      secret: (name) => (name === "OPENROUTER_API_KEY" ? "or-test" : undefined),
    });

    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.init?.headers).toMatchObject({
      Authorization: "Bearer or-test",
      "HTTP-Referer": "https://github.com/Shaiinarab/simorgh",
      "X-Title": "Simorgh",
    });
    expect(result).toEqual({ ok: true, answer: "openrouter-says-hi" });
  });
});