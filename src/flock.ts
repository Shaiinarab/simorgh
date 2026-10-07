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
  QUOTA_SCHEMA,
  RATE_LIMIT_SCHEMA,
  consumeRateLimit,
  describeFlock,
  flyFlock as coreFlyFlock,
  openAiCompatibleProvider,
  readAllHealth,
  readAllQuota,
  readCooldown,
  SCHEDULED_LEASE_MS,
  claimTask,
  failTask,
  finishTask,
  listTasks,
  nextDueTasks,
  nextWakeAt,
  SCHEDULED_SCHEMA,
  scheduleTask,
  recordObservation,
  sweepStale as sweepHealthRows,
  workersAiProvider,
  type Provider,
  type ProviderContext,
  type ProviderStatus,
  type QuotaRow,
  type RateLimitDecision,
  type SecretReader,
  type FlockAttempt,
  type FlockMeta,
  type FlockRunResult,
  type FlockStatus,
} from "@simorgh/phoenix-core";

export type { FlockAttempt, FlockMeta, FlockRunResult, FlockStatus };

// ── Status with a KV fallback (Story 5.2) ─────────────────────────────────────

/**
 * A flock status served from the KV snapshot because the Durable Object could not
 * be reached.
 *
 * `source` exists only on the degraded path. The published wire contract is
 * `{ birds, timestamp }` and a live answer must stay byte-identical to what it was
 * before this story — so absence of `source` IS the live marker, and seeing
 * `"kv-cache"` is how a dashboard tells a stale picture from a fresh one. The
 * snapshot's `timestamp` is when the picture was actually true, which is what makes
 * the fallback honestly eventual rather than quietly wrong.
 */
export interface CachedFlockStatus extends FlockStatus {
  source: "kv-cache";
}

/**
 * What callers see: the published shape, plus an *optional* marker. Intersection
 * rather than a union so `status.source` reads without narrowing — a union would
 * make every consumer narrow before it could tell a fresh picture from a stale one,
 * and most would just cast, which is how the marker would end up ignored.
 */
export type HostFlockStatus = FlockStatus & { source?: "kv-cache" };

/** One key, overwritten on every successful live read. */
export const FLOCK_STATUS_SNAPSHOT_KEY = "flock_status:snapshot";

/**
 * The slice of a KV namespace this fallback needs. Declared structurally so the
 * function can be driven by a Map-backed stand-in in tests, exactly like the engine's
 * ports — `env.CONTEXT_STORE` satisfies it.
 */
export interface SnapshotStore {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

/**
 * Read the flock status, falling back to the last KV snapshot when the DO is
 * unreachable (Story 5.2: "If DO is unavailable, fall back to KV-cached bird health
 * with eventual consistency").
 *
 * The cache is written on success and never synthesised, so a fallback answer is a
 * real past answer, not a guess. The three failure rules are each the opposite of a
 * trap this repo has already paid for:
 *
 *  - a snapshot *write* failure never fails a live read: a cache that cannot be
 *    written degrades freshness, not availability;
 *  - a snapshot *read* failure surfaces as the DO's own error, because the operator
 *    needs the root cause, not a secondary one from the cache;
 *  - no snapshot rethrows the original DO error — returning an empty flock from
 *    nothing would be exactly the fabrication this gateway refuses to do.
 */
export async function flockStatusWithFallback(
  readLive: () => Promise<FlockStatus>,
  snapshots: SnapshotStore
): Promise<HostFlockStatus> {
  let liveError: unknown;
  try {
    const status = await readLive();
    try {
      await snapshots.put(FLOCK_STATUS_SNAPSHOT_KEY, JSON.stringify(status));
    } catch {
      // Best-effort: freshness degrades, availability does not.
    }
    return status;
  } catch (e) {
    liveError = e;
  }

  let snapshot: unknown = null;
  try {
    snapshot = await snapshots.get(FLOCK_STATUS_SNAPSHOT_KEY, "json");
  } catch {
    // Swallow: the DO error below is the reason the operator is here.
  }

  if (
    snapshot !== null &&
    typeof snapshot === "object" &&
    Array.isArray((snapshot as FlockStatus).birds)
  ) {
    return { ...(snapshot as FlockStatus), source: "kv-cache" };
  }

  throw liveError;
}

/**
 * The deployment-wired entry point used by the status route and the Telegram
 * `/status` command: same fallback, bound to this Worker's own namespace and KV.
 */
export function readFlockStatus(env: Env): Promise<HostFlockStatus> {
  const id = env.FLOCK_COORDINATOR.idFromName("global");
  const stub = env.FLOCK_COORDINATOR.get(id);
  return flockStatusWithFallback(() => stub.getFlockStatus(), env.CONTEXT_STORE);
}

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
      await this.ctx.storage.sql.exec(QUOTA_SCHEMA);
      await this.ctx.storage.sql.exec(SCHEDULED_SCHEMA);
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

  /**
   * Every declared account's quota, over RPC.
   *
   * Exists so the capacity table is reachable from a host rather than only from the
   * engine's own tests — and, incidentally, so its shape is pinned by the workerd
   * suite: this returns `QuotaRow`s across a Durable Object boundary, which is where
   * a stray `unknown` or an index signature would collapse the generated stub to
   * `never` and break the build rather than the request.
   */
  async getQuotaState(): Promise<QuotaRow[]> {
    return readAllQuota(this.ctx.storage.sql);
  }

  /**
   * Schedule a prompt to run through the flock at or after `resumeAt`.
   *
   * Re-inserting the same id rewrites the request while the row is still `pending`. Once it
   * has been claimed, or has finished, the insert is a no-op on state: a run that already
   * happened cannot be un-happened, and a run in flight cannot be edited underneath its own
   * executor. See `scheduleTask` for why `running` is as immutable as `done`.
   */
  async scheduleDelayed(input: {
    id: string;
    prompt: string;
    tools?: string[];
    resumeAt: number;
  }): Promise<{ id: string; resumeAt: number }> {
    const now = Date.now();
    scheduleTask(
      this.ctx.storage.sql,
      {
        id: input.id,
        prompt: input.prompt,
        tools: input.tools ?? [],
        resumeAt: input.resumeAt,
      },
      now
    );
    await this.rearmAlarm(now);
    return { id: input.id, resumeAt: input.resumeAt };
  }

  /**
   * Point the alarm at whatever this table needs next, or clear it when nothing is outstanding.
   *
   * The engine owns the *policy* (`nextWakeAt`); only a Durable Object can arm an alarm, so
   * the binding lives here. Both the insert path and the alarm path funnel through this one
   * method so they cannot drift — an earlier version inlined "earliest pending" separately in
   * each, which is exactly how the recovery gap documented on `nextWakeAt` would have been
   * reintroduced by the next person who edited one of the two copies.
   */
  private async rearmAlarm(now: number): Promise<void> {
    const next = nextWakeAt(this.ctx.storage.sql, now, SCHEDULED_LEASE_MS);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  async listScheduled(): Promise<{
    id: string; state: string; resume_at: number; attempts: number; result: string | null; error: string | null;
  }[]> {
    return listTasks(this.ctx.storage.sql).map((t) => ({
      id: t.id, state: t.state, resume_at: t.resume_at, attempts: t.attempts, result: t.result, error: t.error,
    }));
  }

  /**
   * The Durable Object alarm handler.
   *
   * Awakes at whatever `nextWakeAt` names, claims everything due, and flies each through the
   * flock *once*. Three layers of idempotence, and each answers a different question:
   *
   *   1. **Durable Objects do not re-enter `alarm()` concurrently.** A second alarm is
   *      delivered only after this one returns, so the loop is serial by construction.
   *   2. **`claimTask` is a compare-and-set on the expected state.** It reports whether *it*
   *      performed the transition, so a caller that lost a race runs nothing. Defence in
   *      depth: the guarantee has to survive a host that one day does deliver two at once.
   *   3. **A terminal row is never claimable.** `done` and `failed` are absent from the
   *      claim's `WHERE`, so an alarm arriving after a task completed finds nothing to do.
   *      This is what makes "an already-completed task is not executed twice" a property of
   *      the state machine rather than a property of the scheduler's mood.
   *
   * A row whose claiming host died loses its lease and is reclaimed on a later pass — a pass
   * that `rearmAlarm` guarantees will exist, since a `running` row contributes a wake at its
   * lease expiry. At-least-once, never-forgetting.
   */
  async alarm(): Promise<void> {
    const startedAt = Date.now();
    const due = nextDueTasks(this.ctx.storage.sql, startedAt, SCHEDULED_LEASE_MS);

    for (const task of due) {
      if (!claimTask(this.ctx.storage.sql, task.id, startedAt, SCHEDULED_LEASE_MS)) {
        continue; // lost the race, or already terminal
      }
      try {
        const result = await this.runFlock(task.prompt, parseTools(task.tools));
        finishTask(this.ctx.storage.sql, task.id, JSON.stringify(result));
      } catch (e) {
        // The only way out of a `catch` here is a *thrown* error: `runFlock` does not throw
        // for a failed provider, because the engine catches those and returns
        // `flock_exhausted`, which is a result and is stored as one. So this is a host-level
        // fault, and the row must not be left `running` — an un-closed row is reclaimed and
        // retried forever against a fault that will never resolve.
        failTask(this.ctx.storage.sql, task.id, String(e));
      }
    }

    // The clock moved: a task that ran for a minute is no longer overdue, and a row claimed
    // during this pass contributes a *future* lease expiry. Recomputing from a fresh `now` is
    // what stops the alarm being pinned into the past and spinning.
    await this.rearmAlarm(Date.now());
  }
}

/**
 * Read a persisted `tools` column back into the flight's second argument.
 *
 * A malformed column must not throw. This runs inside the alarm loop, so a `JSON.parse`
 * failure would not be caught by the `try` around the flight — it would abort the *entire*
 * alarm and leave every other due row unclaimed until its lease expired. An unreadable tool
 * record is metadata, so the safe reading is an empty one: it changes what this deployment
 * records about the run, not what the run does.
 */
function parseTools(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}
