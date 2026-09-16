import { DurableObject } from "cloudflare:workers";
import {
  HEALTH_SCHEMA,
  readAllHealth,
  readCooldown,
  recordObservation,
  sweepStale as sweepHealthRows,
} from "./health";

// ── RPC surface ────────────────────────────────────────────────────
//
// Everything crossing a Durable Object RPC boundary must be *structured
// cloneable*. This is load-bearing, not stylistic:
//
//   1. `env` cannot be sent as a parameter. Each Durable Object gets its own
//      `env` from the runtime; the caller's is not cloneable and never was. A
//      method taking `env: Env` typechecks only until you try to call it, then
//      silently collapses its return type to `never` (see 2) and throws at runtime.
//   2. A return type containing `Record<string, unknown>` or `unknown` makes
//      `Result<R>` evaluate to `never`, because `Serializable<T>` has no branch
//      matching `unknown`. The call site then reports "Property 'meta' does not
//      exist on type 'never'".
//
// So: concrete interfaces of primitives, arrays, and plain objects — no `unknown`,
// no index signatures — and the DO reads `this.env` itself.

/** Names of the secrets a bird may need. Kept as a union, not `string`, so
 *  `env[keyEnv]` stays index-checked. */
export type SecretKey = "GROQ_API_KEY" | "HF_TOKEN";

/**
 * The slice of `Env` the flock actually touches.
 *
 * Narrower than `Env` on purpose: `Env` is structurally assignable to it, so
 * production passes the real bindings, while a test can pass a plain object with a
 * fake `AI`. Routing can therefore be exercised with no network and no runtime.
 */
export interface FlockEnv {
  AI: Ai;
  GROQ_API_KEY?: string;
  HF_TOKEN?: string;
}

export interface FlockAttempt {
  birdId: string;
  ok: boolean;
  /** Present when the attempt failed: a provider error, or "dormant". */
  error?: string;
}

export interface FlockMeta {
  answered_by: string;
  bird_id?: string;
  ai_model?: string;
  flock_attempts: FlockAttempt[];
  error?: string;
}

export interface FlockRunResult {
  meta: FlockMeta;
  answer: string;
}

export interface BirdStatus {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
  /** True when the bird needs a secret that is not configured on this deployment. */
  dormant: boolean;
  status: "healthy" | "tired" | "dormant";
  consecutiveFailures: number;
  cooldownUntil: number;
  totalCalls: number;
  totalFailures: number;
}

export interface FlockStatus {
  birds: BirdStatus[];
  timestamp: number;
}

// ── Bird adapter interface ─────────────────────────────────────────
export interface Bird {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
  keyEnv?: SecretKey;
  call(prompt: string, env: FlockEnv): Promise<BirdCallResult>;
}

export interface BirdCallResult {
  ok: boolean;
  answer?: string;
  error?: string;
}

// ── Birds ──────────────────────────────────────────────────────────

// 🦅 Shāhīn — Groq (priority 10, fastest)
const shahin: Bird = {
  id: "shahin",
  name: "Shāhīn",
  provider: "Groq (OpenAI-compat)",
  model: "llama-3.3-70b-versatile",
  priority: 10,
  keyEnv: "GROQ_API_KEY",
  async call(prompt, env) {
    if (!env.GROQ_API_KEY) return { ok: false, error: "dormant" };
    try {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (resp.status === 429) return { ok: false, error: "rate_limit" };
      if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
      const data = (await resp.json()) as { choices: { message: { content: string } }[] };
      return { ok: true, answer: data.choices[0]?.message?.content ?? "" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

// 🐦 Bulbul — HuggingFace Router (priority 20)
const bulbul: Bird = {
  id: "bulbul",
  name: "Bulbul",
  provider: "HuggingFace Router",
  model: "meta-llama/Llama-3.3-70B-Instruct",
  priority: 20,
  keyEnv: "HF_TOKEN",
  async call(prompt, env) {
    if (!env.HF_TOKEN) return { ok: false, error: "dormant" };
    try {
      const resp = await fetch("https://router.huggingface.co/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.HF_TOKEN}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (resp.status === 429) return { ok: false, error: "rate_limit" };
      if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
      const data = (await resp.json()) as { choices: { message: { content: string } }[] };
      return { ok: true, answer: data.choices[0]?.message?.content ?? "" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

// 🕊️ Homā — Cloudflare Workers AI (priority 30, ALWAYS ON, zero-KYC guarantee)
//
// Declared as a const so its *literal* type survives: `env.AI.run()` picks its typed
// overload from the literal model id, and the runtime types maintain a versioned
// `AiModels` list that rejects a widened `string`. One source for both the registry
// entry and the call.
const HOMA_MODEL = "@cf/meta/llama-3.2-3b-instruct";

const homa: Bird = {
  id: "homa",
  name: "Homā",
  provider: "Cloudflare Workers AI",
  model: HOMA_MODEL,
  priority: 30,
  async call(prompt, env) {
    try {
      // Workers AI returns { response: string } for chat models.
      const resp = await env.AI.run(HOMA_MODEL, {
        messages: [{ role: "user", content: prompt }],
      });
      return { ok: true, answer: (resp as { response?: string }).response ?? "" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

// ── Flock ──────────────────────────────────────────────────────────
export const FLOCK: Bird[] = [shahin, bulbul, homa];

// ── Routing core ───────────────────────────────────────────────────
//
// Pulled out of the Durable Object so the routing policy can be tested directly.
// The DO is a thin shell over storage; the decisions — priority order, skipping
// dormant birds, honouring cooldowns, falling through on failure — live here, and
// they are the part worth testing exhaustively. Keeping them inside the DO would
// mean every routing test had to spin up a Durable Object and, because Homā calls
// Workers AI, reach the real internet.
export interface FlyFlockDeps {
  birds: Bird[];
  env: FlockEnv;
  /** Epoch ms until which this bird should be skipped; 0 = available. */
  cooldownUntil(birdId: string): number;
  /** Called once per attempted bird. `error` is undefined on success. */
  record(birdId: string, ok: boolean, error?: string): void;
  now?: number;
}

/**
 * Try each bird in priority order until one answers.
 *
 * A bird whose secret is absent is skipped without charge: a missing key is a
 * deployment fact, not a provider fault, and penalising it would cool down a bird
 * that was never dialled.
 */
export async function flyFlock(
  prompt: string,
  deps: FlyFlockDeps
): Promise<FlockRunResult> {
  const now = deps.now ?? Date.now();
  const attempts: FlockAttempt[] = [];
  const sorted = [...deps.birds].sort((a, b) => a.priority - b.priority);

  for (const bird of sorted) {
    if (bird.keyEnv && !deps.env[bird.keyEnv]) {
      attempts.push({ birdId: bird.id, ok: false, error: "dormant" });
      continue;
    }

    if (deps.cooldownUntil(bird.id) > now) {
      attempts.push({ birdId: bird.id, ok: false, error: "cooling_down" });
      continue;
    }

    const result = await bird.call(prompt, deps.env);
    attempts.push({
      birdId: bird.id,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error ?? "unknown" }),
    });
    deps.record(bird.id, result.ok, result.error);

    if (result.ok && result.answer) {
      return {
        meta: {
          answered_by: `${bird.name} (${bird.provider})`,
          bird_id: bird.id,
          ai_model: bird.model,
          flock_attempts: attempts,
        },
        answer: result.answer,
      };
    }
  }

  return {
    meta: {
      answered_by: "none",
      flock_attempts: attempts,
      error: "flock_exhausted",
    },
    answer: "All birds are tired. Please try again shortly.",
  };
}

// ── FlockCoordinator Durable Object ────────────────────────────────
//
// `DurableObject<Env>` matters: without the type argument `this.env` is the runtime
// default (`Cloudflare.Env`, an empty interface) and every `env.GROQ_API_KEY` read
// is a type error. With it, the DO sees the same bindings the Worker does.
export class FlockCoordinator extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // Schema creation must block: `waitUntil` schedules work *after* the current
    // event and does not gate incoming requests, so a request arriving first would
    // hit "no such table: bird_health". blockConcurrencyWhile is the documented
    // way to finish initialization before any request is delivered.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.sql.exec(HEALTH_SCHEMA);
    });
  }

  async getFlockStatus(): Promise<FlockStatus> {
    const rows = readAllHealth(this.ctx.storage.sql);
    const birds = FLOCK.map((bird): BirdStatus => {
      const row = rows.find((r) => r.bird_id === bird.id);
      // Dormant = this deployment has no secret for the bird. Derived from the live
      // env rather than from "the bird declares a keyEnv", so the dashboard tells the
      // truth about whether the key is actually configured.
      const dormant = bird.keyEnv ? !this.env[bird.keyEnv] : false;
      const state = (row?.status as BirdStatus["status"] | undefined) ?? "healthy";
      return {
        id: bird.id,
        name: bird.name,
        provider: bird.provider,
        model: bird.model,
        priority: bird.priority,
        dormant,
        status: dormant ? "dormant" : state,
        consecutiveFailures: row?.consecutive_failures ?? 0,
        cooldownUntil: row?.cooldown_until ?? 0,
        totalCalls: row?.total_calls ?? 0,
        totalFailures: row?.total_failures ?? 0,
      };
    });
    return { birds, timestamp: Date.now() };
  }

  /**
   * Fly the flock: try each bird in priority order until one answers.
   *
   * No `env` parameter — this DO reads its own bindings. See the RPC note at the
   * top of this file for why passing one in is not merely wrong, it is impossible.
   */
  async runFlock(prompt: string, _tools: string[]): Promise<FlockRunResult> {
    return flyFlock(prompt, {
      birds: FLOCK,
      env: this.env,
      cooldownUntil: (birdId) => readCooldown(this.ctx.storage.sql, birdId),
      record: (birdId, ok, error) =>
        recordObservation(this.ctx.storage.sql, birdId, ok, error === "rate_limit"),
    });
  }

  /**
   * Daily stale sweep — the handler for the `[triggers] crons` entry in
   * wrangler.toml. Clears expired cooldowns and retires birds that have failed
   * repeatedly, so `status` does not stay 'tired' forever after a transient blip.
   * Returns how many rows changed.
   */
  async sweepStale(now: number): Promise<number> {
    return sweepHealthRows(this.ctx.storage.sql, now);
  }
}
