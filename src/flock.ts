import { DurableObject } from "cloudflare:workers";

// ── Bird adapter interface ─────────────────────────────────────────
interface Bird {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
  keyEnv?: string;
  call(prompt: string, env: Env): Promise<{ ok: boolean; answer?: string; error?: string }>;
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
  async call(prompt: string, env: Env) {
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
  async call(prompt: string, env: Env) {
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
const homa: Bird = {
  id: "homa",
  name: "Homā",
  provider: "Cloudflare Workers AI",
  model: "@cf/meta/llama-3.2-3b-instruct",
  priority: 30,
  async call(prompt: string, env: Env) {
    try {
      const resp = await env.AI.run(this.model as AiModelsID, {
        messages: [{ role: "user", content: prompt }],
      });
      // Cloudflare AI returns { response: string } for chat models
      return { ok: true, answer: (resp as { response: string }).response ?? "" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

// ── Flock ──────────────────────────────────────────────────────────
export const FLOCK: Bird[] = [shahin, bulbul, homa];

// ── FlockCoordinator Durable Object ────────────────────────────────
export class FlockCoordinator extends DurableObject {
  // SQLite table: bird_health
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // Initialize schema
    this.ctx.waitUntil(
      (async () => {
        await this.state.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS bird_health (
            bird_id TEXT PRIMARY KEY,
            status TEXT DEFAULT 'healthy',
            consecutive_failures INTEGER DEFAULT 0,
            cooldown_until INTEGER DEFAULT 0,
            last_ok INTEGER DEFAULT 0,
            total_calls INTEGER DEFAULT 0,
            total_failures INTEGER DEFAULT 0
          );
        `);
      })()
    );
  }

  async getFlockStatus() {
    const rows = [...this.state.storage.sql.exec("SELECT * FROM bird_health").toArray()];
    const birds = FLOCK.map((bird) => {
      const row = rows.find((r) => r.bird_id === bird.id);
      return {
        id: bird.id,
        name: bird.name,
        provider: bird.provider,
        model: bird.model,
        priority: bird.priority,
        dormant: bird.keyEnv ? true : false,
        status: (row?.status as string) ?? "healthy",
        consecutiveFailures: (row?.consecutive_failures as number) ?? 0,
        cooldownUntil: (row?.cooldown_until as number) ?? 0,
      };
    });
    return { birds, timestamp: Date.now() };
  }

  async runFlock(
    prompt: string,
    _tools: string[],
    env: Env
  ): Promise<{ meta: Record<string, unknown>; answer: string }> {
    const now = Date.now();
    const attempts: { birdId: string; ok: boolean }[] = [];

    // pickRoute: healthy birds in priority order
    const sorted = [...FLOCK].sort((a, b) => a.priority - b.priority);

    for (const bird of sorted) {
      // Check cooldown
      const row = this.state.storage.sql
        .exec("SELECT cooldown_until FROM bird_health WHERE bird_id = ?", bird.id)
        .toArray()[0];
      const cooldownUntil = (row?.cooldown_until as number) ?? 0;
      if (cooldownUntil > now) {
        attempts.push({ birdId: bird.id, ok: false });
        continue;
      }

      // Call the bird
      const result = await bird.call(prompt, env);
      attempts.push({ birdId: bird.id, ok: result.ok });

      // Update health
      this.updateHealth(bird.id, result.ok, result.error === "rate_limit");

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

    // All birds failed
    return {
      meta: {
        answered_by: "none",
        flock_attempts: attempts,
        error: "flock_exhausted",
      },
      answer: "All birds are tired. Please try again shortly.",
    };
  }

  private updateHealth(birdId: string, ok: boolean, isRateLimit: boolean) {
    const now = Date.now();
    if (ok) {
      this.state.storage.sql.exec(
        `UPDATE bird_health SET status='healthy', consecutive_failures=0, cooldown_until=0, last_ok=?, total_calls=total_calls+1 WHERE bird_id=?`,
        now,
        birdId
      );
    } else {
      const cooldown = isRateLimit ? 60000 : 15000;
      this.state.storage.sql.exec(
        `UPDATE bird_health SET status='tired', consecutive_failures=consecutive_failures+1, cooldown_until=?, total_calls=total_calls+1, total_failures=total_failures+1 WHERE bird_id=?`,
        now + cooldown,
        birdId
      );
    }
  }
}
