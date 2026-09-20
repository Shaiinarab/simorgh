import { DurableObject } from "cloudflare:workers";
import {
  HEALTH_SCHEMA,
  readAllHealth,
  readCooldown,
  recordObservation,
  sweepStale as sweepHealthRows,
} from "./health";
import {
  RATE_LIMIT_SCHEMA,
  consumeRateLimit,
  type RateLimitDecision,
} from "./rate-limit";

export type SecretKey = "GROQ_API_KEY" | "HF_TOKEN";

export interface FlockEnv {
  AI: Ai;
  GROQ_API_KEY?: string;
  HF_TOKEN?: string;
}

export interface FlockAttempt {
  birdId: string;
  ok: boolean;
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
          Authorization: "Bearer " + env.GROQ_API_KEY,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (resp.status === 429) return { ok: false, error: "rate_limit" };
      if (!resp.ok) return { ok: false, error: "http_" + resp.status };
      const data = (await resp.json()) as { choices: { message: { content: string } }[] };
      return { ok: true, answer: data.choices[0]?.message?.content ?? "" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

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
          Authorization: "Bearer " + env.HF_TOKEN,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (resp.status === 429) return { ok: false, error: "rate_limit" };
      if (!resp.ok) return { ok: false, error: "http_" + resp.status };
      const data = (await resp.json()) as { choices: { message: { content: string } }[] };
      return { ok: true, answer: data.choices[0]?.message?.content ?? "" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

const HOMA_MODEL = "@cf/meta/llama-3.2-3b-instruct";

const homa: Bird = {
  id: "homa",
  name: "Homā",
  provider: "Cloudflare Workers AI",
  model: HOMA_MODEL,
  priority: 30,
  async call(prompt, env) {
    try {
      const resp = await env.AI.run(HOMA_MODEL, {
        messages: [{ role: "user", content: prompt }],
      });
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

export const FLOCK: readonly Bird[] = [shahin, bulbul, homa];

export interface FlyFlockDeps {
  birds: readonly Bird[];
  env: FlockEnv;
  cooldownUntil: (birdId: string) => number;
  record: (birdId: string, ok: boolean, error?: string) => void;
  now?: number;
}

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
          answered_by: bird.name + " (" + bird.provider + ")",
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

export class FlockCoordinator extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.sql.exec(HEALTH_SCHEMA);
      await this.ctx.storage.sql.exec(RATE_LIMIT_SCHEMA);
    });
  }

  async getFlockStatus(): Promise<FlockStatus> {
    const rows = readAllHealth(this.ctx.storage.sql);
    const birds = FLOCK.map((bird): BirdStatus => {
      const row = rows.find((r) => r.bird_id === bird.id);
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
      now
    );
  }

  async runFlock(prompt: string, _tools: string[]): Promise<FlockRunResult> {
    return flyFlock(prompt, {
      birds: FLOCK,
      env: this.env,
      cooldownUntil: (birdId) => readCooldown(this.ctx.storage.sql, birdId),
      record: (birdId, ok, error) =>
        recordObservation(
          this.ctx.storage.sql,
          birdId,
          ok,
          error === "rate_limit"
        ),
    });
  }

  async sweepStale(now: number): Promise<number> {
    return sweepHealthRows(this.ctx.storage.sql, now);
  }
}
