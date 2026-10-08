// ── The self-hosted flock ─────────────────────────────────────────────────────
//
// The provider catalog for a core running on Node.
//
// ── It is the Workers catalog, minus Homā ──
//
// `src/flock.ts` is the reference implementation and owns the roster: Shāhīn 10, Gemini 15,
// Bulbul 20, OpenRouter 25, Homā 30. Every hosted entry here must match it on id, display
// name, vendor label, model and priority, because `/api/v1/flock/status` is a published
// contract and a client must not be able to tell which host answered it. That is not a
// preference, it is the bug this file last shipped: with two of these birds missing, the
// same endpoint answered with different rosters depending on where a core was deployed, and
// the self-hosted path silently had fewer options than the managed one.
//
// `simorgh-platform/test/providers-parity.test.ts` pins the two lists against each other, so
// a future bird added on one host and not the other goes red rather than waiting to be
// noticed by a user.
//
// **The one entry that does not carry over is Homā.** Homā is Cloudflare Workers AI, it is
// what delivers the zero-KYC guarantee on the `cloudflare-workers` target, and there is no
// equivalent binding in a Node process. Rather than paper over that with a pretend provider,
// the catalog simply does not contain one — and a core with no keys configured reports every
// provider as `dormant` in `/api/v1/flock/status`, which is the truth.
//
// The other difference runs the other way: the one keyless option that *does* exist locally
// is an Ollama daemon on the same box, so it is included when `OLLAMA_BASE_URL` says there is
// one. It is opt-in rather than always-on because a provider that is permanently unreachable
// costs a failed dial plus a cooldown on every single request.
//
// ── Dormancy is the same rule as the edge ──
//
// A keyed bird names its secret in `requires`. The engine's `describeFlock` then reports it
// `dormant` and `flyFlock` skips it *without* a cooldown, because a missing key is a
// deployment fact rather than a provider fault. Registering a bird and discovering its key at
// dial time is the "registered-and-broken" shape this avoids: it costs a failed dial and a
// cooldown on every request, forever, and it makes the deployment look misconfigured rather
// than merely unkeyed.
//
// The two keyed birds sit ahead of the keyless local one for the same reason they sit ahead
// of Homā on the edge: anything that needs a secret is worthless to a zero-key deployment, so
// appended last it would be unreachable behind a bird that always answers.

import { geminiProvider, openAiCompatibleProvider, type Provider } from "@simorgh/phoenix-core";

export interface ProviderCatalogOptions {
  env: Record<string, string | undefined>;
}

const GEMINI_MODEL = "gemini-2.5-flash";

/**
 * OpenRouter's router over its free-model pool, not a fixed model.
 *
 * `openrouter/free` dispatches to whichever `:free` models are available, so the weights
 * behind an answer can change between two calls to the same bird. That is accepted on purpose
 * for this flock — the bird's identity is "a free OpenAI-compatible endpoint", and the
 * transparency ledger records the bird. See the longer note on the same constant in
 * `src/flock.ts`, which is where the catalog is defined.
 */
const OPENROUTER_MODEL = "openrouter/free";

export function defaultProviders(options: ProviderCatalogOptions): Provider[] {
  const { env } = options;
  const providers: Provider[] = [
    openAiCompatibleProvider({
      id: "shahin",
      name: "Shāhīn",
      provider: "Groq (OpenAI-compat)",
      model: "llama-3.3-70b-versatile",
      priority: 10,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      requires: "GROQ_API_KEY",
    }),
    // Its own factory, not an `openAiCompatibleProvider` spec: Google's Generative
    // Language API puts the model in the URL path, authenticates with `x-goog-api-key`
    // rather than a bearer token, and answers at `candidates[0].content.parts[0].text`.
    // A spec-only entry would return "" on every call while the bird reported itself
    // healthy. `geminiProvider` is keyed by construction, which is also what makes an
    // unconfigured deployment show it as `dormant` instead of failing on first use.
    geminiProvider({
      id: "gemini",
      name: "Gemini",
      provider: "Google Generative Language",
      model: GEMINI_MODEL,
      priority: 15,
      requires: "GEMINI_API_KEY",
    }),
    openAiCompatibleProvider({
      id: "bulbul",
      name: "Bulbul",
      provider: "HuggingFace Router",
      model: "meta-llama/Llama-3.3-70B-Instruct",
      priority: 20,
      endpoint: "https://router.huggingface.co/v1/chat/completions",
      requires: "HF_TOKEN",
    }),
    // Not a bespoke `openRouterProvider`: OpenRouter *is* OpenAI-compatible, and the only
    // things it adds are a URL and two attribution headers. `extraHeaders` on the shared
    // spec is what that costs, so the next OpenAI-compatible vendor is one entry here.
    openAiCompatibleProvider({
      id: "openrouter",
      name: "OpenRouter",
      provider: "OpenRouter (OpenAI-compat)",
      model: OPENROUTER_MODEL,
      priority: 25,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      requires: "OPENROUTER_API_KEY",
      extraHeaders: {
        "HTTP-Referer": "https://github.com/Shaiinarab/simorgh",
        "X-Title": "Simorgh",
      },
    }),
  ];

  const ollamaBase = env.OLLAMA_BASE_URL?.trim();
  if (ollamaBase) {
    providers.push(
      openAiCompatibleProvider({
        id: "ollama",
        name: "Ollama",
        provider: "Ollama (local daemon)",
        model: env.OLLAMA_MODEL?.trim() || "llama3.2",
        // After every hosted bird, including the two keyed ones: a local daemon is free and
        // private but usually slower, so it is the fallback rather than the first choice.
        // 30 is also Homā's slot on the edge, which is free here precisely because Homā is
        // absent — no hosted bird uses it, so this cannot tie with one.
        priority: 30,
        endpoint: `${ollamaBase.replace(/\/+$/, "")}/v1/chat/completions`,
      })
    );
  }

  return providers;
}
