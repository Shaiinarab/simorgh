// ── The self-hosted flock ─────────────────────────────────────────────────────
//
// The provider catalog for a core running on Node.
//
// ── What is missing from this list, and why that is honest ──
//
// There is no Homā here. Homā is Cloudflare Workers AI, it is what delivers the
// zero-KYC guarantee on the `cloudflare-workers` target, and there is no equivalent
// binding in a Node process. Rather than paper over that with a pretend provider, the
// catalog simply does not contain one — and a core with no keys configured reports
// every provider as `dormant` in `/api/v1/flock/status`, which is the truth.
//
// The one keyless option that *does* exist locally is an Ollama daemon on the same
// box, so it is included when `OLLAMA_BASE_URL` says there is one. It is opt-in
// rather than always-on because a provider that is permanently unreachable costs a
// failed dial plus a cooldown on every single request.

import { openAiCompatibleProvider, type Provider } from "@simorgh/phoenix-core";

export interface ProviderCatalogOptions {
  env: Record<string, string | undefined>;
}

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
    openAiCompatibleProvider({
      id: "bulbul",
      name: "Bulbul",
      provider: "HuggingFace Router",
      model: "meta-llama/Llama-3.3-70B-Instruct",
      priority: 20,
      endpoint: "https://router.huggingface.co/v1/chat/completions",
      requires: "HF_TOKEN",
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
        // After the hosted providers: a local daemon is free and private but usually
        // slower, so it is the fallback rather than the first choice.
        priority: 30,
        endpoint: `${ollamaBase.replace(/\/+$/, "")}/v1/chat/completions`,
      })
    );
  }

  return providers;
}
