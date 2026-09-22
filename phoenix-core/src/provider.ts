// ── Providers — the "birds" of the flock, without the metaphor ────────────────
//
// A provider normalizes one inference backend to a single shape so the routing
// policy in flock.ts never learns which vendor it is talking to. The two factories
// below cover the two shapes that matter: anything OpenAI-compatible (Groq,
// HuggingFace Router, OpenRouter, Cerebras, …) and Cloudflare Workers AI.
//
// Display names — Shāhīn, Bulbul, Homā — live in the *host's* provider catalog, not
// here. They are Simorgh's branding, and core is the part other products import.

import type { FetchLike, WorkersAiPort } from "./ports.ts";

export interface ProviderCallResult {
  ok: boolean;
  answer?: string;
  error?: string;
}

/** What a provider is handed when it is dialled. */
export interface ProviderContext {
  fetch: FetchLike;
  /** Resolves a secret by name; `undefined` means it is not configured. */
  secret: (name: string) => string | undefined;
  /** Present only on a Workers AI host. */
  workersAi?: WorkersAiPort;
}

export interface Provider {
  id: string;
  /** Display name, e.g. "Shāhīn". */
  name: string;
  /** Vendor label, e.g. "Groq (OpenAI-compat)". */
  provider: string;
  model: string;
  /** Tried in ascending order. */
  priority: number;
  /**
   * Secret this provider needs. When it is absent the provider is *dormant*: a
   * deployment fact, not a fault, so it is skipped without being cooled down.
   * A provider with no `requires` is always available — that is the zero-KYC
   * guarantee, and Homā is the one that delivers it.
   */
  requires?: string;
  call(prompt: string, ctx: ProviderContext): Promise<ProviderCallResult>;
}

export interface OpenAiCompatibleSpec {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
  /** Full chat-completions URL. */
  endpoint: string;
  requires?: string;
}

/**
 * A provider that speaks the OpenAI chat-completions shape.
 *
 * Every failure is turned into a `ProviderCallResult` rather than thrown: the
 * routing loop survives a throwing provider, but only because the providers it
 * ships with catch their own transport errors. A provider that threw would skip
 * the flock's `record()` call and leave the failure invisible to Swarm-State.
 */
export function openAiCompatibleProvider(spec: OpenAiCompatibleSpec): Provider {
  return {
    id: spec.id,
    name: spec.name,
    provider: spec.provider,
    model: spec.model,
    priority: spec.priority,
    ...(spec.requires ? { requires: spec.requires } : {}),
    async call(prompt, ctx) {
      const key = spec.requires ? ctx.secret(spec.requires) : undefined;
      if (spec.requires && !key) return { ok: false, error: "dormant" };

      try {
        const resp = await ctx.fetch(spec.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { Authorization: "Bearer " + key } : {}),
          },
          body: JSON.stringify({
            model: spec.model,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        // 429 is separated from other failures because it is the one error that
        // means "you are fine, come back later" — and the flock backs off longer
        // for it (COOLDOWN_RATE_LIMIT_MS).
        if (resp.status === 429) return { ok: false, error: "rate_limit" };
        if (!resp.ok) return { ok: false, error: "http_" + resp.status };

        const data = (await resp.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        return { ok: true, answer: data.choices?.[0]?.message?.content ?? "" };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
}

export interface WorkersAiSpec {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
}

/**
 * A provider backed by Cloudflare Workers AI.
 *
 * This is the only provider with no portable equivalent, so it degrades instead of
 * throwing when the host has no `workersAi` binding — a Node host simply reports it
 * as unavailable and the flock routes around it.
 */
export function workersAiProvider(spec: WorkersAiSpec): Provider {
  return {
    id: spec.id,
    name: spec.name,
    provider: spec.provider,
    model: spec.model,
    priority: spec.priority,
    async call(prompt, ctx) {
      if (!ctx.workersAi) return { ok: false, error: "workers_ai_unavailable" };
      try {
        const resp = await ctx.workersAi.run(spec.model, {
          messages: [{ role: "user", content: prompt }],
        });
        // Workers AI returns `{ response: string }` for chat models, but the binding
        // is typed loosely enough to be worth checking rather than asserting.
        const answer =
          typeof resp === "object" &&
          resp !== null &&
          "response" in resp &&
          typeof (resp as { response?: unknown }).response === "string"
            ? (resp as { response: string }).response
            : String(resp);
        return { ok: true, answer };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
}

/** Convenience: the providers a host wants tried, in priority order. */
export function byPriority(providers: readonly Provider[]): Provider[] {
  return [...providers].sort((a, b) => a.priority - b.priority);
}
