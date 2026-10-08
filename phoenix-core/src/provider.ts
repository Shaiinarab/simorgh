// ── Providers — the "birds" of the flock, without the metaphor ────────────────
//
// A provider normalizes one inference backend to a single shape so the routing
// policy in flock.ts never learns which vendor it is talking to. The three factories
// below cover the three shapes that matter: anything OpenAI-compatible (Groq,
// HuggingFace Router, OpenRouter, Cerebras, …), Cloudflare Workers AI, and Google's
// Generative Language API — which is *not* OpenAI-compatible and is the reason
// `geminiProvider` exists rather than another spec of `openAiCompatibleProvider`.
//
// Display names — Shāhīn, Bulbul, Homā — live in the *host's* provider catalog, not
// here. They are Simorgh's branding, and core is the part other products import.

import type { FetchLike, WorkersAiPort } from "./ports.ts";
import type { ComplexityTier } from "./complexity.ts";

export interface ProviderCallResult {
  ok: boolean;
  answer?: string;
  error?: string;
  /**
   * The model that *actually served* the request when it differs from the one
   * asked for — today only the auto-router bird (`cloudflare/auto`, ADR-0006)
   * fills it in. `flyFlock` surfaces it as `meta.ai_model`, so an operator reads
   * the truth instead of the alias. Absent means "the model we requested".
   */
  servedModel?: string;
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
   * Complexity tiers this entry is declared fit to serve — an *ordering* input,
   * never an eligibility one. Absent (the default) means "assume it can serve
   * anything": the complexity signal then leaves this entry's position to its
   * priority alone. A provider that declares tiers but not the wanted one sinks
   * to the back of the queue and is still tried if the fleet ahead of it fails —
   * see `complexity.ts` for why exclusion is forbidden.
   *
   * A declaration slot, not a capability claim: nothing validates that a
   * 7-billion-parameter model is genuinely good at "heavy" work, because the
   * engine has no way to know and pretending otherwise would be the fabricated
   * answer this project refuses to ship. Operators tune it; the router orders by
   * it; every bird still gets its turn.
   */
  servesTiers?: readonly ComplexityTier[];
  /**
   * Which of the operator's accounts for this provider this entry dialled.
   *
   * Defaults to `"default"` — deliberately, so a single-credential deployment is the
   * degenerate case of the account model rather than a special case of it, and so
   * adding a second account changes no existing call site. `phoenix-core/src/quota.ts`
   * keys its whole table on `(providerId, accountId, modelId)`, which is what turns
   * several legitimate accounts on one provider into one compute pool instead of
   * several unrelated rows.
   */
  accountId?: string;
  /**
   * Secret this provider needs. When it is absent the provider is *dormant*: a
   * deployment fact, not a fault, so it is skipped without being cooled down.
   * A provider with no `requires` is always available — that is the zero-KYC
   * guarantee, and Homā is the one that delivers it.
   */
  requires?: string;
  call(prompt: string, ctx: ProviderContext): Promise<ProviderCallResult>;
}

/** The account a provider entry uses when it does not name one. */
export const DEFAULT_ACCOUNT_ID = "default";

/** Resolve a provider's account id, applying the documented default. */
export function accountOf(provider: Provider): string {
  return provider.accountId ?? DEFAULT_ACCOUNT_ID;
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
  /** See `Provider.accountId`. */
  accountId?: string;
  /** See `Provider.servesTiers`. */
  servesTiers?: readonly ComplexityTier[];
  /**
   * Provider-specific headers merged into the request.
   *
   * This is the whole reason there is one parameterised factory instead of a bespoke
   * `openRouterProvider`: OpenRouter is not special, it is OpenAI-compatible plus two
   * attribution headers (`HTTP-Referer`, `X-Title`). A vendor whose only difference is
   * "same body, different URL, one extra header" should cost a spec entry and not a
   * factory — which is what makes "five options per category" cheap to add.
   */
  extraHeaders?: Record<string, string>;
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
    ...(spec.accountId ? { accountId: spec.accountId } : {}),
    ...(spec.servesTiers ? { servesTiers: spec.servesTiers } : {}),
    async call(prompt, ctx) {
      const key = spec.requires ? ctx.secret(spec.requires) : undefined;
      if (spec.requires && !key) return { ok: false, error: "dormant" };

      try {
        const resp = await ctx.fetch(spec.endpoint, {
          method: "POST",
          headers: {
            // `extraHeaders` are spread first so they cannot shadow the two headers this
            // adapter owns. `Authorization` is derived from the *resolved secret*, so a
            // spec-supplied one would send the wrong credential and 401 while the
            // deployment looked correctly configured — the escape hatch is for provider
            // extras, not for overriding the credential.
            ...(spec.extraHeaders ?? {}),
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

/**
 * The Generative Language base, without the model or the `:generateContent` suffix.
 *
 * A constant rather than a spec field on purpose: unlike an OpenAI-compatible endpoint,
 * this URL is not what a host varies per deployment — the model is, and the model
 * already has its own field. Exposing it as a knob would invite a host to point a
 * "Gemini" bird at something that is not Gemini.
 */
const GEMINI_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** The secret a Gemini entry uses when its spec does not name one. */
const GEMINI_DEFAULT_SECRET = "GEMINI_API_KEY";

/** Google's Gemini wire format, which is *not* OpenAI-compatible. */
export interface GeminiSpec {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
  /**
   * Secret holding the key. Defaults to `GEMINI_API_KEY` — see `geminiProvider` for
   * why the default exists rather than being optional-and-absent.
   */
  requires?: string;
  /** See `Provider.accountId`. */
  accountId?: string;
  /** See `Provider.servesTiers`. */
  servesTiers?: readonly ComplexityTier[];
}

/**
 * Google's Generative Language API, verbatim.
 *
 * Fetched from Google's own API docs on 2026-10-08:
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   headers: Content-Type: application/json, x-goog-api-key: {key}
 *   body:    {"contents":[{"parts":[{"text":"{prompt}"}]}]}
 *   200:     {"candidates":[{"content":{"parts":[{"text":"…"}],"role":"model"}}]}
 *
 * Three differences from `openAiCompatibleProvider`, and each one is load-bearing:
 *
 *  1. the model is named in the **path**, not in the body;
 *  2. the credential is an `x-goog-api-key` header, not a bearer token — so there is
 *     no "no key configured" form to fall back on;
 *  3. the answer is at `candidates[0].content.parts[0].text`, with `role: "model"`.
 *
 * Only the URL is shared with the OpenAI shape, which is exactly why this is its own
 * adapter: a spec-only entry would have to lie about the body *and* the read, and a
 * provider that reads the wrong path returns `""` on every call while reporting itself
 * healthy — the quietest possible failure in a gateway that would rather say nothing.
 */
export function geminiProvider(spec: GeminiSpec): Provider {
  // Google's API has no unauthenticated form, so a Gemini entry is keyed by
  // construction. Naming the default here — rather than leaving `requires` unset and
  // sending no header — is what makes that visible in `/api/v1/flock/status`: the
  // status assembler decides dormancy from `Provider.requires`, and a keyless-looking
  // Gemini bird would report `healthy` until its first 403.
  const secretName = spec.requires ?? GEMINI_DEFAULT_SECRET;

  return {
    id: spec.id,
    name: spec.name,
    provider: spec.provider,
    model: spec.model,
    priority: spec.priority,
    requires: secretName,
    ...(spec.accountId ? { accountId: spec.accountId } : {}),
    ...(spec.servesTiers ? { servesTiers: spec.servesTiers } : {}),
    async call(prompt, ctx) {
      const key = ctx.secret(secretName);
      if (!key) return { ok: false, error: "dormant" };

      try {
        const resp = await ctx.fetch(
          `${GEMINI_ENDPOINT_BASE}/${spec.model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": key,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
            }),
          }
        );

        // 429 is separated from other failures for the same reason as everywhere else:
        // it is the one error that means "you are fine, come back later", and the flock
        // backs off longer for it (COOLDOWN_RATE_LIMIT_MS). The string is part of the
        // contract with `recordObservation(…, error === "rate_limit", …)`, so it is
        // matched literally rather than by a pattern.
        if (resp.status === 429) return { ok: false, error: "rate_limit" };
        if (!resp.ok) return { ok: false, error: "http_" + resp.status };

        const data = (await resp.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        // Every step is optional-chained on purpose. A blocked or empty candidate comes
        // back with `finishReason` and no `content`, and `candidates` itself can be
        // absent — neither is an exception, both are "this attempt produced no answer",
        // which the routing loop already knows how to handle (it falls through).
        return { ok: true, answer: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "" };
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
  /** See `Provider.servesTiers`. */
  servesTiers?: readonly ComplexityTier[];
}

/** Read `{ response: string }` off a Workers AI chat reply, loosely. */
function workersAiAnswer(resp: unknown): string {
  // Workers AI returns `{ response: string }` for chat models, but the binding
  // is typed loosely enough to be worth checking rather than asserting.
  return typeof resp === "object" &&
    resp !== null &&
    "response" in resp &&
    typeof (resp as { response?: unknown }).response === "string"
    ? (resp as { response: string }).response
    : String(resp);
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
    ...(spec.servesTiers ? { servesTiers: spec.servesTiers } : {}),
    async call(prompt, ctx) {
      if (!ctx.workersAi) return { ok: false, error: "workers_ai_unavailable" };
      try {
        const resp = await ctx.workersAi.run(spec.model, {
          messages: [{ role: "user", content: prompt }],
        });
        return { ok: true, answer: workersAiAnswer(resp) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
}

/** The model name Cloudflare's Auto Router answers as. */
export const AUTO_ROUTER_MODEL = "cloudflare/auto";

export interface AutoRouterSpec {
  id: string;
  name: string;
  provider: string;
  priority: number;
  /**
   * The AI Gateway id the router fronts. **Required** — an auto-router entry
   * configured without one must never dial, because a permanently-failing dial
   * costs a request and plants a cooldown on a bird that could have served it.
   * The host registers this provider only when the id is configured; the factory
   * refuses to build one without it rather than trusting that discipline.
   */
  gatewayId: string;
  /** See `Provider.servesTiers`. */
  servesTiers?: readonly ComplexityTier[];
}

/**
 * Cloudflare's `cloudflare/auto` as one more bird — TASK-016 §6, ADR-0006.
 *
 * Behind the existing `Provider` port: no new port, no new binding, no engine
 * dependency on Cloudflare. It is Workers-only by construction (it needs
 * `ctx.workersAi`), so a Node host reports `workers_ai_unavailable` and the
 * flock routes around it — the same honest degradation `workersAiProvider`
 * already does, and the catalog's Node page simply lists it as absent.
 *
 * The gateway option threads through `WorkersAiPort.run`'s **additive** third
 * argument: every existing host implementation satisfies the widened port
 * without a change (a function of two parameters is assignable to a signature
 * that declares three when the third is optional), so this bird is the only
 * consumer of the extension and nothing else had to move.
 */
export function autoRouterProvider(spec: AutoRouterSpec): Provider {
  const model = AUTO_ROUTER_MODEL;
  return {
    id: spec.id,
    name: spec.name,
    provider: spec.provider,
    model,
    priority: spec.priority,
    ...(spec.servesTiers ? { servesTiers: spec.servesTiers } : {}),
    async call(prompt, ctx) {
      if (!ctx.workersAi) return { ok: false, error: "workers_ai_unavailable" };
      try {
        const resp = await ctx.workersAi.run(
          model,
          { messages: [{ role: "user", content: prompt }] },
          { gateway: { id: spec.gatewayId } }
        );
        // `cf-aig-routed-model` is a *header* on the AI Gateway HTTP path, and the
        // Workers binding does not surface response headers — UNVERIFIED whether
        // any body field names the chosen model without a live account to probe.
        // So: read a `routed_model`/`model` field if the response happens to carry
        // one, and otherwise report no served model rather than fabricating one.
        const served =
          typeof resp === "object" && resp !== null
            ? (resp as { routed_model?: unknown; model?: unknown })
            : undefined;
        const servedModel =
          typeof served?.routed_model === "string"
            ? served.routed_model
            : typeof served?.model === "string"
              ? served.model
              : undefined;
        return {
          ok: true,
          answer: workersAiAnswer(resp),
          ...(servedModel ? { servedModel } : {}),
        };
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
