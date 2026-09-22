// ── The flock — the Cloudflare host ───────────────────────────────────────────
//
// This file is now a *host adapter*, not an engine. It owns the two things that are
// genuinely the Cloudflare deployment's business:
//
//   1. the provider catalog — which birds exist, under what display names, on which
//      endpoints, reading which secrets; and
//   2. the Durable Object shell — the SQLite handle, the AI binding, the cron.
//
// Everything decision-shaped moved to `phoenix-core`: priority routing, the dormant
// skip, cooldowns, failover, status assembly, and the rate limiter. Those are the
// parts worth testing exhaustively, and they are now tested once, in the engine's
// own suite, without spinning up a Durable Object or dialling Workers AI.
//
// ── Two behaviour changes, both inherited from the engine ──
//
//   * A provider that *throws* no longer escapes the routing loop. The engine wraps
//     the single `provider.call` in try/catch, so one third-party adapter raising an
//     exception degrades to a failed attempt and the flock moves on, instead of
//     failing the whole request with a 500. The engine's `flyFlock` documents why.
//   * `recordObservation` and `consumeRateLimit` now *require* `now`. Both call sites
//     pass the DO's clock explicitly.
//
// ── On the bird-shaped surface ──
//
// `Bird`, `FLOCK`, and the `flyFlock(prompt, {birds, env, …})` signature are kept.
// They are the shape `test/flock-routing.test.ts` drives the policy through, and the
// bird names are the product surface (`/api/v1/flock/status` is documented in the
// README). Rather than delete them, they are now a thin view over `Provider`s: the
// hand-written fetch bodies that used to live here are gone, and every bird delegates
// to the engine's factories.

import { DurableObject } from "cloudflare:workers";
import {
  HEALTH_SCHEMA,
  RATE_LIMIT_SCHEMA,
  consumeRateLimit,
  describeFlock,
  flyFlock as coreFlyFlock,
  openAiCompatibleProvider,
  readAllHealth,
  readCooldown,
  recordObservation,
  sweepStale as sweepHealthRows,
  workersAiProvider,
  type Provider,
  type ProviderContext,
  type ProviderStatus,
  type RateLimitDecision,
  type SecretReader,
  type FlockAttempt,
  type FlockMeta,
  type FlockRunResult,
  type FlockStatus,
} from "@simorgh/phoenix-core";

export type { FlockAttempt, FlockMeta, FlockRunResult, FlockStatus };

/** One provider's line in the public flock status payload. */
export type BirdStatus = ProviderStatus;

export type SecretKey = "GROQ_API_KEY" | "HF_TOKEN";

export interface FlockEnv {
  AI: Ai;
  GROQ_API_KEY?: string;
  HF_TOKEN?: string;
}

export interface BirdCallResult {
  ok: boolean;
  answer?: string;
  error?: string;
}

export interface Bird {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
  keyEnv?: SecretKey;
  call(prompt: string, env: FlockEnv): Promise<BirdCallResult>;
}

// ── The catalog ───────────────────────────────────────────────────────────────
//
// Built from the engine's factories, so the OpenAI-compatible request shape (and its
// 429/`http_<status>`/throw handling) exists in exactly one place. Display names stay
// here: they are Simorgh's branding, and core is the part other products import.

const HOMA_MODEL = "@cf/meta/llama-3.2-3b-instruct";

export const PROVIDERS: readonly Provider[] = [
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
  workersAiProvider({
    id: "homa",
    name: "Homā",
    provider: "Cloudflare Workers AI",
    model: HOMA_MODEL,
    priority: 30,
  }),
];

/**
 * A fetch that resolves `globalThis.fetch` at *call* time, not at module load.
 *
 * This is not incidental: `test/flock-routing.test.ts` replaces `globalThis.fetch`
 * with a stub inside each test, and a captured reference would silently bypass every
 * one of those stubs — the tests would pass while dialling the real Groq API.
 */
const liveFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  globalThis.fetch(url, init);

function contextFor(env: FlockEnv): ProviderContext {
  return {
    fetch: liveFetch,
    secret: (name) => env[name as SecretKey],
    workersAi: env.AI,
  };
}

// ── The bird-shaped view ──────────────────────────────────────────────────────

/** Adapt one engine provider to the host's public `Bird` shape. */
function asBird(provider: Provider): Bird {
  return {
    id: provider.id,
    name: provider.name,
    provider: provider.provider,
    model: provider.model,
    priority: provider.priority,
    ...(provider.requires ? { keyEnv: provider.requires as SecretKey } : {}),
    call: (prompt, env) => provider.call(prompt, contextFor(env)),
  };
}

export const FLOCK: readonly Bird[] = PROVIDERS.map(asBird);

/** Adapt a `Bird` back to a provider so the engine can route it. */
function birdToProvider(bird: Bird, env: FlockEnv): Provider {
  return {
    id: bird.id,
    name: bird.name,
    provider: bird.provider,
    model: bird.model,
    priority: bird.priority,
    ...(bird.keyEnv ? { requires: bird.keyEnv } : {}),
    call: (prompt) => bird.call(prompt, env),
  };
}

export interface FlyFlockDeps {
  birds: readonly Bird[];
  env: FlockEnv;
  cooldownUntil: (birdId: string) => number;
  record: (birdId: string, ok: boolean, error?: string) => void;
  now?: number;
}

/**
 * Try each bird in priority order until one answers — delegated to the engine.
 *
 * Kept as a wrapper rather than replaced by a direct `coreFlyFlock` import so the
 * Worker's existing call sites and tests keep the shape they were written against.
 */
export async function flyFlock(
  prompt: string,
  deps: FlyFlockDeps
): Promise<FlockRunResult> {
  return coreFlyFlock(prompt, {
    providers: deps.birds.map((bird) => birdToProvider(bird, deps.env)),
    ctx: contextFor(deps.env),
    cooldownUntil: deps.cooldownUntil,
    record: deps.record,
    now: deps.now ?? Date.now(),
  });
}

// ── The Durable Object shell ──────────────────────────────────────────────────

export class FlockCoordinator extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.sql.exec(HEALTH_SCHEMA);
      await this.ctx.storage.sql.exec(RATE_LIMIT_SCHEMA);
    });
  }

  /** Secrets live on the binding, so the reader closes over `this.env`. */
  private secretReader(): SecretReader {
    return (name) => {
      const value = (this.env as unknown as Record<string, unknown>)[name];
      return typeof value === "string" ? value : undefined;
    };
  }

  async getFlockStatus(): Promise<FlockStatus> {
    return describeFlock(PROVIDERS, {
      secret: this.secretReader(),
      health: readAllHealth(this.ctx.storage.sql),
      now: Date.now(),
    });
  }

  async checkRateLimit(
    key: string,
    limit: number,
    windowMs: number,
    now?: number
  ): Promise<RateLimitDecision> {
    const safeLimit = Math.min(1_000, Math.max(1, Math.floor(limit)));
    const safeWindowMs = Math.min(
      86_400_000,
      Math.max(1_000, Math.floor(windowMs))
    );
    return consumeRateLimit(
      this.ctx.storage.sql,
      key.slice(0, 256),
      safeLimit,
      safeWindowMs,
      now ?? Date.now()
    );
  }

  async runFlock(prompt: string, _tools: string[]): Promise<FlockRunResult> {
    return coreFlyFlock(prompt, {
      providers: PROVIDERS,
      ctx: {
        fetch: liveFetch,
        secret: this.secretReader(),
        workersAi: this.env.AI,
      },
      cooldownUntil: (birdId) => readCooldown(this.ctx.storage.sql, birdId),
      record: (birdId, ok, error) =>
        recordObservation(
          this.ctx.storage.sql,
          birdId,
          ok,
          error === "rate_limit",
          Date.now()
        ),
      now: Date.now(),
    });
  }

  async sweepStale(now: number): Promise<number> {
    return sweepHealthRows(this.ctx.storage.sql, now);
  }
}
