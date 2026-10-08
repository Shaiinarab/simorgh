// ── The flock: routing policy ─────────────────────────────────────────────────
//
// Pulled out of the host so the policy can be tested directly. A Durable Object is
// a thin shell over storage; the decisions — priority order, skipping dormant
// providers, honouring cooldowns, falling through on failure — live here, and they
// are the part worth testing exhaustively. Keeping them inside a DO would mean every
// routing test had to spin up a Durable Object and, because Homā dials Workers AI,
// reach the real internet.
//
// ── A note on vocabulary ──
//
// This module is provider-generic: it takes `Provider`s and reads `providerId`. The
// *response* types keep their original bird names (`birdId`, `birds`, `answered_by`)
// because they are a published API contract — `/api/v1/flock/status` is documented in
// the README and a dashboard reads it. Renaming wire fields would be a breaking API
// change with no bearing on modularization, so the metaphor stays where it is load-
// bearing (the product surface) and the abstraction is generic where it matters (the
// engine).

import type { HealthRow } from "./health.ts";
import {
  byPriority,
  type Provider,
  type ProviderCallResult,
  type ProviderContext,
} from "./provider.ts";
import type { SecretReader } from "./ports.ts";
import { estimateComplexity, fitRank, type ComplexityEstimate } from "./complexity.ts";
import { pinnedBySession, type SessionSignal } from "./session.ts";

/**
 * Why a bird was chosen — and, mirrored, why a considered bird was not.
 *
 * The vocabulary is modelled on Cloudflare AI Gateway's `cf-aig-routing-reason`
 * header (`cost_optimal_within_pool`, `forced_by_candidate_pool`, …) because that
 * product solved the same problem first and its shape has survived contact with
 * users. It is Simorgh-native in membership: ADR-0003 already insists a
 * *rejection* names its binding reason, and this is the selection-side mirror of
 * that discipline — plus the `skipped_*` members, because a scheduler that
 * silently drops candidates is indistinguishable from one that lost them.
 *
 * Which layer emits which member (documented in ADR-0006, because the split is
 * load-bearing):
 *
 *   - `flyFlock` (here) emits `selected_by_priority`, `selected_by_complexity`,
 *     `pinned_by_session`, `fallback_previous_unavailable`, `skipped_dormant`,
 *     `skipped_cooldown`.
 *   - `selected_by_capacity` / `skipped_cost_ineligible` belong to the capacity
 *     layer (`quota.ts`): cost and quota facts do not exist inside the routing
 *     loop, and re-deriving them here would create the two-definitions-nothing-
 *     comparing-them trap `ledger.ts` already documents. The members exist in the
 *     vocabulary so a host that pre-filters by capacity speaks the same language;
 *     the flock never emits them itself.
 */
export type RouteReason =
  | "selected_by_priority"
  | "selected_by_capacity"
  | "selected_by_complexity"
  | "pinned_by_session"
  | "fallback_previous_unavailable"
  | "skipped_dormant"
  | "skipped_cooldown"
  | "skipped_cost_ineligible";

export interface FlockAttempt {
  birdId: string;
  ok: boolean;
  error?: string;
  /**
   * Why this bird sat where it sat in the order. Present only when routing
   * signals are supplied (`FlyFlockDeps.routing`) — the default path is kept
   * byte-identical to the pre-vocabulary wire shape, because `flock_attempts` is
   * a published API field and two consumers (`src/dashboard.ts`,
   * `test/flock-routing.test.ts`) assert it with `toEqual`.
   */
  reason?: RouteReason;
}

/**
 * Opt-in routing signals. Absent — the default — behaviour is byte-identical to
 * plain priority order, which is the whole safety story here: a behaviour change
 * on the hot path with no flag is how a gateway starts leaking capacity, and
 * `simorgh-platform/test/conformance.test.ts` exists to catch exactly that.
 */
export interface RoutingOptions {
  /** A pre-computed estimate (see `estimateComplexity`). Orders, never excludes. */
  task?: ComplexityEstimate;
  /** Session affinity. The host owns the signal; the engine never mints one. */
  session?: SessionSignal;
}

/**
 * Order candidates under routing signals: pinned first, then tier fit, then the
 * incoming (priority) order, stably. Pure — `flyFlock` feeds it `byPriority(...)`
 * so "tie" always means "whichever the priority order already preferred".
 *
 * Note what is *not* here: exclusion. `fitRank` 2 (declared tiers that don't
 * include the wanted one) is a position at the back of the queue, not a drop.
 */
export function orderCandidates(
  providers: readonly Provider[],
  routing: RoutingOptions
): Provider[] {
  const pinned = pinnedBySession(routing.session);
  const want = routing.task?.tier;
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => {
      const pa = pinned !== undefined && a.provider.id === pinned ? 0 : 1;
      const pb = pinned !== undefined && b.provider.id === pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const fa = want === undefined ? 1 : fitRank(a.provider.servesTiers, want);
      const fb = want === undefined ? 1 : fitRank(b.provider.servesTiers, want);
      if (fa !== fb) return fa - fb;
      return a.index - b.index;
    })
    .map((entry) => entry.provider);
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

/** One provider's line in the public flock status payload. */
export interface ProviderStatus {
  id: string;
  name: string;
  provider: string;
  model: string;
  priority: number;
  /** True when this deployment has no secret for the provider. */
  dormant: boolean;
  status: "healthy" | "tired" | "dormant";
  consecutiveFailures: number;
  cooldownUntil: number;
  totalCalls: number;
  totalFailures: number;
}

export interface FlockStatus {
  birds: ProviderStatus[];
  timestamp: number;
}

export interface FlyFlockDeps {
  providers: readonly Provider[];
  ctx: ProviderContext;
  /** Epoch ms until which this provider should be skipped; `0` = available. */
  cooldownUntil: (providerId: string) => number;
  /** Called once per attempted provider. `error` is undefined on success. */
  record: (providerId: string, ok: boolean, error?: string) => void;
  now?: number;
  /**
   * Opt-in routing signals (complexity ordering, session affinity, and the
   * per-attempt `reason` vocabulary). Absent = the classic path, untouched.
   * A host may also pass `{}`: reasons without reordering.
   */
  routing?: RoutingOptions;
}

/**
 * Try each provider in priority order until one answers.
 *
 * A provider whose secret is absent is skipped without charge: a missing key is a
 * deployment fact, not a provider fault, and penalising it would cool down a
 * provider that was never dialled.
 */
export async function flyFlock(
  prompt: string,
  deps: FlyFlockDeps
): Promise<FlockRunResult> {
  const now = deps.now ?? 0;
  const attempts: FlockAttempt[] = [];

  // The default branch is *literally* `byPriority` — not an orderCandidates call
  // with empty options — so "no routing signal" cannot drift through a shared
  // code path into "slightly different order". `phoenix-core/test/flock.test.ts`
  // pins the byte-identical wire shape on both sides.
  const ordered = deps.routing
    ? orderCandidates(byPriority(deps.providers), deps.routing)
    : byPriority(deps.providers);
  const priorityIndex = deps.routing
    ? new Map(byPriority(deps.providers).map((p, i) => [p.id, i]))
    : undefined;
  // Why a later bird got its chance: only a *dialled* failure counts. A bird
  // skipped as dormant was never asked, so the winner was the first available
  // bird all along — calling that a "fallback" would tell an operator their
  // fleet is failing when it is merely unconfigured.
  let dialledFailures = 0;

  for (const provider of ordered) {
    if (provider.requires && !deps.ctx.secret(provider.requires)) {
      attempts.push({
        birdId: provider.id,
        ok: false,
        error: "dormant",
        ...(deps.routing ? { reason: "skipped_dormant" as const } : {}),
      });
      continue;
    }

    if (deps.cooldownUntil(provider.id) > now) {
      attempts.push({
        birdId: provider.id,
        ok: false,
        error: "cooling_down",
        ...(deps.routing ? { reason: "skipped_cooldown" as const } : {}),
      });
      continue;
    }

    let result: ProviderCallResult;
    try {
      result = await provider.call(prompt, deps.ctx);
    } catch (e) {
      // A provider is third-party code. One that *throws* rather than returning a
      // failure used to take the entire request down with a 500 — the opposite of
      // what a federation is for. Guarded here, in the single place that dials a
      // provider, rather than requiring every provider to catch its own errors and
      // silently dropping any that forget.
      result = { ok: false, error: String(e) };
    }
    attempts.push({
      birdId: provider.id,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error ?? "unknown" }),
    });
    deps.record(provider.id, result.ok, result.error);
    if (!result.ok || !result.answer) dialledFailures++;

    if (result.ok && result.answer) {
      // Selection reason, most specific first: a session pin beats everything,
      // a retry-after-failure beats a reordering claim, and only a bird that was
      // actually moved forward by the complexity signal claims that signal.
      const pinned =
        deps.routing !== undefined && pinnedBySession(deps.routing.session) === provider.id;
      const movedUp =
        deps.routing?.task !== undefined &&
        priorityIndex !== undefined &&
        (priorityIndex.get(provider.id) ?? 0) >
          ordered.findIndex((p) => p.id === provider.id);
      const reason: RouteReason = pinned
        ? "pinned_by_session"
        : dialledFailures > 0
          ? "fallback_previous_unavailable"
          : movedUp
            ? "selected_by_complexity"
            : "selected_by_priority";
      if (deps.routing && attempts.length > 0) {
        attempts[attempts.length - 1] = { ...attempts[attempts.length - 1]!, reason };
      }
      return {
        meta: {
          answered_by: provider.name + " (" + provider.provider + ")",
          bird_id: provider.id,
          // A provider may report the model that *actually served* the request
          // (the auto-router bird, ADR-0006). Absent means "the model we asked
          // for", which is what every portable provider answers.
          ai_model: result.servedModel ?? provider.model,
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

/**
 * Seconds a caller should wait before retrying an exhausted flock, or `null` when there
 * is no honest answer.
 *
 * Story 5.5 of the PRD asks for "a clear flock-exhausted response with Retry-After".
 * The trap is the obvious implementation: always emit a number, defaulting to something
 * like 60. That is a fabrication, and this project degrades honestly rather than
 * inventing an answer — so `null` is a real return value, and it is the *common* case:
 *
 *   - **Every bird in a cooldown** -> the soonest expiry is a real reset time. Emit it.
 *   - **Some birds dormant, none cooling** -> there is nothing to wait for. The birds
 *     are dormant because they have no configured secret, so retrying in 60 seconds
 *     will fail identically. Emitting `Retry-After: 60` would make a client poll a
 *     configuration problem and call it backpressure. Return `null`; the caller omits
 *     the header, and the operator reads `GET /api/v1/flock/status` to find out why.
 *   - **A cooldown already in the past** -> clamp to `floorSeconds`, because a
 *     `Retry-After: 0` invites an immediate hot loop, which is the opposite of the
 *     intent.
 *
 * `floorSeconds` exists so hosts can share this policy while keeping their own floor:
 * the Workers edge and the Node core are separate deployments and may want different
 * minimums. It is not a default because a hidden default is how the lease bug in
 * `claimTask` happened.
 */
export function flockRetryAfterSeconds(
  cooldownUntils: readonly number[],
  now: number,
  floorSeconds: number
): number | null {
  const pending = cooldownUntils.filter((t) => t > now);
  if (pending.length === 0) return null;
  const soonest = Math.min(...pending);
  return Math.max(floorSeconds, Math.ceil((soonest - now) / 1000));
}

/**
 * Assemble the public flock status from provider declarations, configured secrets,
 * and persisted health rows.
 *
 * Pure, and shared by every host: the Workers Durable Object and a Node process
 * produce byte-identical status payloads from the same three inputs. `dormant` is
 * derived from the live secret reader rather than from "the provider declares a
 * required secret", so the payload tells the truth about whether the key is
 * actually configured on *this* deployment.
 */
export function describeFlock(
  providers: readonly Provider[],
  deps: { secret: SecretReader; health: readonly HealthRow[]; now: number }
): FlockStatus {
  const birds = providers.map((provider): ProviderStatus => {
    const row = deps.health.find((r) => r.bird_id === provider.id);
    const dormant = provider.requires ? !deps.secret(provider.requires) : false;
    const state = (row?.status as ProviderStatus["status"] | undefined) ?? "healthy";
    return {
      id: provider.id,
      name: provider.name,
      provider: provider.provider,
      model: provider.model,
      priority: provider.priority,
      dormant,
      status: dormant ? "dormant" : state,
      consecutiveFailures: row?.consecutive_failures ?? 0,
      cooldownUntil: row?.cooldown_until ?? 0,
      totalCalls: row?.total_calls ?? 0,
      totalFailures: row?.total_failures ?? 0,
    };
  });
  return { birds, timestamp: deps.now };
}
