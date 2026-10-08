// ── Capability negotiation: probe, rank, and explain ─────────────────────────
//
// The product goal is "unify all computing providers — at least 5 options for every
// capability, deployable on the tiniest provider". The tempting way to get there is a
// switch statement: five inference providers, five embedders, five stores, listed once
// per category. That version is wrong in a way that only shows up in production, and
// the reason is structural rather than stylistic:
//
//   * the list is a **claim** about the world, made in source, that nothing checks. It
//     rots the day a provider changes its model list, and it rots silently — the code
//     still "supports" five options while three of them 404.
//   * it cannot answer the question an operator actually has, which is *why* capability
//     number three is missing on this particular box, right now.
//   * it cannot be added to. Every new adapter is an edit in the middle of the core,
//     which is the change most likely to be skipped under deadline pressure.
//
// So this module does the opposite. A **host** probes what it actually has and hands the
// result in; this module is pure over those probe results and returns a matrix plus a
// ranked plan. Adding an adapter is then a probe, not a code edit — which is what makes
// "5 options for every capability" a configuration fact instead of a maintenance
// burden.
//
// Three rules are load-bearing, and each one is a place where the obvious implementation
// is the dishonest one:
//
//   1. **`unknown` cost is not `free`.** `ADR-0005`, restated here because this module
//      is a *second* place that has to honour it. Collapsing a three-state fact into a
//      boolean would let an unclassified adapter look free, and "unclassified" is exactly
//      the state a freshly-added adapter is in. The failure is not a wrong number, it is
//      an invoice. `costVerdict` is reused from `quota.ts` rather than re-derived: a
//      second implementation of the same money rule is a second answer nothing compares
//      to the first, which is the exact trap `ledger.ts` documents having paid for once.
//
//   2. **Nothing is dropped in silence.** Every adapter that was considered appears in
//      the plan with a verdict, including the ones that lost and the ones that were
//      refused. `quota.ts` already argues the point for capacity — "a scheduler that
//      silently drops candidates is indistinguishable from one that lost them" — and it
//      is *more* true here, because the candidate set is assembled by probing rather than
//      by configuration. An adapter that probed and failed is the single most useful line
//      of output this system produces, and omitting it is how "why is embeddings down"
//      becomes unanswerable.
//
//   3. **A dimension mismatch is a defect, not a warning.** See `checkCompatibility`.
//
// It imports nothing but `quota.ts`, because cost classification is the only thing it
// needs from anywhere else, and it touches no port: this module is pure data in, pure
// data out, which is what keeps it testable with no runtime, no network, and no Durable
// Object — and what keeps the runtime boundary where `boundary.test.ts` says it is.

import {
  DEFAULT_COST_MODE,
  costVerdict,
  type CostMode,
  type ProviderCost,
} from "./quota.ts";

// ── What can be negotiated ─────────────────────────────────────────────────────

/**
 * The capabilities the gateway needs more than one implementation of.
 *
 * A closed set on purpose. An open string union would let a host invent a capability
 * name that nothing renders, degrades, or reports — the capability would exist in one
 * file and nowhere else, which is a lie of exactly the kind this module exists to
 * prevent. Adding one is a deliberate edit here, and that friction is the point.
 */
export type CapabilityName =
  | "inference"
  | "embeddings"
  | "vector"
  | "sync"
  | "scheduler";

/** Every capability, in the order a status report should list them. */
export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "inference",
  "embeddings",
  "vector",
  "sync",
  "scheduler",
];

/**
 * What running on an adapter costs. Three states, never two — see rule 1 above and
 * `ADR-0005`.
 *
 * The price itself is deliberately absent, unlike `quota.ts`'s `ProviderCost`. A probe
 * answers "is this reachable and what does it need", not "how much does a token cost",
 * and carrying a price here would invent a unit this project has not agreed on. Only
 * the three-way classification is ever consumed.
 */
export type CapabilityCost = "free" | "paid" | "unknown";

// ── What a host tells us ──────────────────────────────────────────────────────

/**
 * One probe result: what a single adapter can do, right now, on this box.
 *
 * The shape is deliberately *evidence*, not a claim. `ok` is the outcome of something
 * that ran; `reason` is why it did not; `requires` is what it needed. A probe that
 * cannot report failure is not a probe, it is an assumption.
 */
export interface AdapterProbe {
  /** Stable id, e.g. `"groq"`, `"sqlite-vec"`. Used verbatim in output, so it should be greppable. */
  adapter: string;
  capability: CapabilityName;
  /** Did the probe itself succeed? */
  ok: boolean;
  cost: CapabilityCost;
  /**
   * Does the allowance **refill**? A one-time grant is `false`.
   *
   * This is not a nuance of `cost`; it is a separate fact about a different resource,
   * and it is the reason a one-time grant is real capacity that must be *spent last*.
   * `$20 of trial credit` is worth exactly what it says and then nothing, so routing
   * routine work onto it burns the reserve that exists for the incident it was granted
   * for.
   */
  renewing: boolean;
  /** What is missing when `ok` is false. Never leave a rejection unexplained. */
  reason?: string;
  /** Required configuration, e.g. `["GEMINI_API_KEY"]`. Empty/absent means key-free. */
  requires?: string[];
  /** Vector width, for embeddings and vector stores only. */
  dimensions?: number;
  /** Any other probe detail worth surfacing. Structured, not prose. */
  meta?: Record<string, string | number | boolean>;
}

// ── The honest matrix ─────────────────────────────────────────────────────────

/**
 * One adapter's probe result, normalised into the shape the planner reads.
 *
 * `usable` is what the **probe** concluded — did this adapter work here, now. It is
 * deliberately *not* "eligible": whether a usable adapter may be spent is a property of
 * the deployment's money policy, not of the adapter, so that gate belongs to
 * `planCapability` and can change without any probe being re-run. Collapsing the two
 * would make the cost gate look like a hardware fact, which is precisely the confusion
 * `ADR-0005` exists to prevent.
 */
export interface AdapterVerdict {
  adapter: string;
  capability: CapabilityName;
  /** Did the probe succeed? `false` means `reason` explains why. */
  usable: boolean;
  cost: CapabilityCost;
  renewing: boolean;
  /** Key-free (`true`) or needs configuration. Carried so a plan can explain itself. */
  keyFree: boolean;
  dimensions?: number;
  /**
   * Why the probe failed. Stable strings, because they are greppable in a log and
   * comparable across runs. Absent when `usable` is `true`.
   */
  reason?: string;
  /** Position in the original probe order, so "probe order" is auditable after sorting. */
  probeIndex: number;
  /** Configuration the adapter needed, when it declared any. Surfaced, never printed as a secret. */
  requires: string[];
}

/**
 * One capability's state. Present for every capability that was probed, degraded ones
 * included — a capability is never dropped from this list because it had no working
 * adapter.
 *
 * `degraded` here is a statement about **fact**: nothing probed successfully. It is not
 * the same field as `CapabilityPlan.degraded`, which additionally applies the money
 * policy and so can be `true` while every adapter works. Keeping them separate is
 * deliberate: "the box cannot do this" and "you are not allowed to spend on this" are
 * different problems with different fixes, and merging them produces a status line that
 * sends an operator to the wrong one.
 */
export interface CapabilityStatus {
  capability: CapabilityName;
  /** Adapters that probed ok, in probe order. Empty means degraded — never omitted. */
  available: string[];
  /** True when NO adapter is available. The system must still report the capability. */
  degraded: boolean;
  /** EVERY adapter considered, with its verdict and reason — used or not. */
  considered: AdapterVerdict[];
}

// ── The plan ──────────────────────────────────────────────────────────────────

export interface CapabilityPlanOptions {
  /**
   * Whether the deployment may spend money. Defaults to `FREE_ONLY`, because an
   * unconfigured deployment must refuse rather than route onto an adapter nobody has
   * classified — `ADR-0005` rule 2, applied here for the same reason.
   */
  mode?: CostMode;
}

export interface CapabilityPlan {
  capability: CapabilityName;
  /** True when nothing can serve this capability. It is still reported, never omitted. */
  degraded: boolean;
  /**
   * The usable adapters, best first — the degradation ladder. Empty exactly when
   * `degraded`.
   *
   * This is a *ladder* and not a single winner, because "at least 5 options per
   * capability, deployable on the tiniest provider" means the second option is part of
   * the contract. `ranked[0]` is what a caller should use; the rest are what it falls
   * back to.
   */
  ranked: AdapterVerdict[];
  /**
   * Every adapter that is not `ranked[0]`, each with the reason it was not chosen.
   *
   * **This overlaps `ranked` on purpose**, and the overlap is the point rather than an
   * oversight: an adapter at rank 3 is simultaneously a real fallback and something
   * that lost. Reporting only one of those two facts would be misleading in opposite
   * directions — omit it from `notChosen` and the operator is told nothing about why
   * the primary won; omit it from `ranked` and the fleet claims less capacity than it
   * has. So the two lists are not a partition and must not be summed. The invariant
   * that *does* hold, and is the one worth testing, is that their union is exactly the
   * set considered — nothing drops out of both.
   *
   * `reason` distinguishes three different failures that an operator must act on
   * differently: the adapter is broken (`probe_failed`), the operator's money policy
   * refuses it (`cost_unknown_in_free_only`), or it works and simply lost (`outranked_*`).
   * Collapsing the third into the first would be the most damaging version of this
   * feature — it would tell a healthy operator that a healthy adapter is broken.
   */
  notChosen: { adapter: string; reason: string }[];
}

/**
 * Map this module's three-state cost onto `quota.ts`'s, so the money rule has exactly
 * one definition.
 *
 * `usdPerMTokens: 0` is a placeholder, not a price claim: `costVerdict` consumes only
 * `kind`, which is documented as load-bearing in `quota.ts` precisely so that a
 * mis-set reported figure cannot change a routing decision.
 */
function toProviderCost(cost: CapabilityCost): ProviderCost {
  if (cost === "paid") return { kind: "paid", usdPerMTokens: 0 };
  if (cost === "free") return { kind: "free" };
  return { kind: "unknown" };
}

/**
 * Does this probe still need configuration to be usable?
 *
 * Absent and empty both mean key-free, and the distinction is not worth a third state —
 * there is no operator action that differs between "no keys listed" and "an empty list".
 */
function isKeyFree(probe: AdapterProbe): boolean {
  return (probe.requires?.length ?? 0) === 0;
}

/**
 * Explain a failed probe without inventing a reason for it.
 *
 * A probe that reports `ok: false` and nothing else has still told us something — a
 * specific, useful thing — but a bare verdict with no text is indistinguishable from a
 * bug in the probe. Naming which of the two it was is the honest answer, and the
 * `missing_config` form is preferred when the adapter told us what it wanted, because
 * that is directly actionable.
 */
function failedProbeReason(probe: AdapterProbe): string {
  if (probe.reason !== undefined && probe.reason !== "") return probe.reason;
  if ((probe.requires?.length ?? 0) > 0) {
    return `missing_config:${(probe.requires ?? []).join(",")}`;
  }
  return "probe_failed";
}

/**
 * Rank usable adapters, and account for every one that was considered.
 *
 * The ranking is lexicographic over three axes, in this order:
 *
 *   1. **key-free first.** This is the product's zero-KYC promise made operational. A
 *      keyed adapter works only while the operator still holds the key, is only as
 *      reachable as whatever that key's provider is, and disappears entirely the moment
 *      the key is revoked or expires. The key-free adapter is the one that survives
 *      losing them, so it is the one to depend on — a keyed adapter is better *second*,
 *      where losing it costs availability rather than capability.
 *   2. **renewing before one-time.** A one-time grant is real capacity and it is spent
 *      last, not first: it never refills, so every request routed onto it is drawn from
 *      a reserve that will not be replaced. Spending the refillable tier first keeps the
 *      non-refilling one intact for exactly the moment the refillable tier runs out —
 *      which is the only situation the grant was made for. This looks backwards if you
 *      assume "use it before you lose it", which is why the comment is here.
 *   3. **probe order.** The host's own ordering survives all the way to the tiebreak, so
 *      a host that has a preference for equal adapters gets it without inventing a
 *      second ranking mechanism. `Array.sort` is stable in ES2019+, and the target here
 *      is ES2022, so this holds without an explicit index comparison.
 *
 * Cost is a **gate, not a ranking term**, and that is a deliberate non-decision carried
 * from `ADR-0005`. Under `PAID_ALLOWED`, preferring free over paid would be a second
 * objective competing with capacity preservation; an operator who has explicitly allowed
 * spending has already said which they want. Cost still decides *eligibility*, always.
 */
export function planCapability(
  status: CapabilityStatus,
  options: CapabilityPlanOptions = {}
): CapabilityPlan {
  const mode = options.mode ?? DEFAULT_COST_MODE;

  const usable: AdapterVerdict[] = [];
  const notChosen: { adapter: string; reason: string }[] = [];

  for (const probe of status.considered) {
    if (!probe.usable) {
      // The probe failed, or it never ran. Either way the adapter cannot serve, and the
      // money gate is deliberately *not* consulted: a broken adapter is broken whether
      // it is free, and reporting "exceeds nothing" for a probe that crashed would
      // send an operator looking in the wrong place.
      notChosen.push({ adapter: probe.adapter, reason: probe.reason ?? "probe_failed" });
      continue;
    }

    // The money gate, before any preference is considered. Telling an operator that an
    // adapter "lost on preferences" when the real reason is that it costs money
    // describes a problem they do not have until they enable paid capability.
    const verdict = costVerdict(toProviderCost(probe.cost), mode);
    if (!verdict.eligible) {
      notChosen.push({ adapter: probe.adapter, reason: verdict.reason });
      continue;
    }

    usable.push(probe);
  }

  const ranked = [...usable].sort((a, b) => {
    if (a.keyFree !== b.keyFree) return a.keyFree ? -1 : 1;
    if (a.renewing !== b.renewing) return a.renewing ? -1 : 1;
    return a.probeIndex - b.probeIndex;
  });

  // Every usable adapter that lost gets the *axis* on which it lost, compared against
  // the adapter immediately ahead of it. Comparing each loser to the winner rather than
  // to its own predecessor would mislabel the common case: in a queue of three
  // key-free adapters, the third loses to the second on probe order, not to the first
  // for some hypothetical reason. The comparison is lexicographic, so the adapter
  // directly ahead of it always won on the first differing axis, and this names the real
  // reason rather than a generic "was not chosen" — the difference between a report an
  // operator can act on and one they have to re-derive by hand.
  for (let i = 1; i < ranked.length; i += 1) {
    const ahead = ranked[i - 1];
    const loser = ranked[i];
    const reason = loser.keyFree !== ahead.keyFree
      ? "outranked_by_key_free"
      : loser.renewing !== ahead.renewing
        ? "outranked_by_non_renewing"
        : "outranked_by_probe_order";
    notChosen.push({ adapter: loser.adapter, reason });
  }

  return {
    capability: status.capability,
    degraded: ranked.length === 0,
    ranked,
    notChosen,
  };
}

/**
 * Turn raw probe results into the status matrix, one entry per capability present.
 *
 * This is the seam between "a host found out what it has" and "the planner decides".
 * It lives here rather than in a host so that every host produces the same matrix shape
 * from the same probes, and so `degraded` is computed in exactly one place — an omitted
 * capability is the failure mode this whole module is built to prevent, and a derived
 * flag computed by each caller is a flag three of four callers will get wrong.
 *
 * Capabilities that no adapter claimed are absent from the input and therefore absent
 * from the output, because there is nothing to report about a capability nothing
 * attempted. That is different from a capability whose every adapter failed, which is
 * present and `degraded`.
 */
export function buildCapabilityStatus(
  probes: readonly AdapterProbe[]
): CapabilityStatus[] {
  const byCapability = new Map<CapabilityName, AdapterProbe[]>();
  for (const probe of probes) {
    const bucket = byCapability.get(probe.capability);
    if (bucket) bucket.push(probe);
    else byCapability.set(probe.capability, [probe]);
  }

  return [...byCapability].map(([capability, bucket]) => {
    const considered = bucket.map((probe, probeIndex): AdapterVerdict => ({
      adapter: probe.adapter,
      capability: probe.capability,
      usable: probe.ok,
      cost: probe.cost,
      renewing: probe.renewing,
      keyFree: isKeyFree(probe),
      ...(probe.dimensions !== undefined ? { dimensions: probe.dimensions } : {}),
      ...(!probe.ok
        ? { reason: failedProbeReason(probe) }
        : {}),
      probeIndex,
      requires: [...(probe.requires ?? [])],
    }));

    const available = considered.filter((v) => v.usable).map((v) => v.adapter);
    return {
      capability,
      available,
      degraded: available.length === 0,
      considered,
    };
  });
}

// ── The dimension guard ───────────────────────────────────────────────────────

export type CompatibilityIssueKind =
  /** An embedder and a store disagree on vector width. Silent recall collapse. */
  | "dimension_mismatch"
  /** A usable vector store exists with no usable embedder to feed it. */
  | "missing_embedder"
  /** An embedder or store is usable but never reported its width, so nothing can be checked. */
  | "unknown_dimension";

export interface CompatibilityIssue {
  kind: CompatibilityIssueKind;
  detail: string;
}

export interface CompatibilityOptions {
  /**
   * Narrow the check to the pairs the planner actually chose.
   *
   * By default **every** usable embedder is checked against **every** usable store, not
   * just the top-ranked of each. That is deliberately the noisy choice: the planner
   * ranks by key-freeness and renewability, not by dimension, so an incompatible
   * embedder can legitimately sort *first* — and a guard that only inspected the
   * top-ranked pair would report `[]` in exactly the deployments where a landmine is
   * most likely to be sitting in second place.
   *
   * A caller that has already decided which pair it will use passes them here and gets
   * a single verdict about that pair.
   */
  embedder?: string;
  store?: string;
}

/** The usable probes for one capability, in probe order. */
function usableFor(
  probes: readonly AdapterProbe[],
  capability: CapabilityName
): AdapterProbe[] {
  return probes.filter((probe) => probe.capability === capability && probe.ok);
}

function narrowing(
  probes: readonly AdapterProbe[],
  capability: CapabilityName,
  named: string | undefined
): AdapterProbe[] {
  const usable = usableFor(probes, capability);
  if (named === undefined) return usable;
  const match = usable.filter((probe) => probe.adapter === named);
  // A named adapter that is not usable is *not* silently ignored: it means the caller's
  // selection does not exist, and quietly checking a different adapter than the one
  // asked about would report a clean result for a pairing nobody is going to run.
  if (match.length === 0) {
    return [
      {
        adapter: named,
        capability,
        ok: false,
        cost: "free",
        renewing: true,
        reason: `named_adapter_not_usable:${named}`,
      },
    ];
  }
  return match;
}

/**
 * Check that the selected embedder and the selected vector store can actually talk to
 * each other. Returns `[]` when they can.
 *
 * **This is the real correctness bug in the system, and it fails silently.** If an
 * embedder emits `D`-dimensional vectors and a store holds `E`-dimensional ones, then
 * `D !== E` is not a type error, not a thrown exception, and not a failed probe. The
 * store accepts the rows. Queries return results — confident, plausible, wrong. Nothing
 * anywhere reports an error. The only symptom is that RAG quietly stops being good, and
 * it presents as "retrieval quality regressed" months later, after the embedder was
 * swapped during some unrelated upgrade.
 *
 * So this returns **issues**, not a boolean, and the caller is expected to fail loudly
 * on a non-empty result rather than log it. An adapter pairing that cannot be verified
 * is reported as `unknown_dimension` for the same reason: an unmeasured width is not a
 * matching width, and treating it as one would reintroduce the same silence through the
 * back door.
 */
export function checkCompatibility(
  embedders: readonly AdapterProbe[],
  stores: readonly AdapterProbe[],
  options: CompatibilityOptions = {}
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];

  const chosenEmbedders = narrowing(embedders, "embeddings", options.embedder);
  const chosenStores = narrowing(stores, "vector", options.store);

  if (chosenStores.length === 0) return issues;

  if (chosenEmbedders.length === 0) {
    issues.push({
      kind: "missing_embedder",
      detail:
        chosenStores.map((store) => store.adapter).join(",") +
        " available for vectors but no usable embeddings adapter was probed",
    });
    return issues;
  }

  // Every pair, not just the top-ranked one — see `CompatibilityOptions` for why the
  // noisy reading is the honest one. Pair order is embedder-major so the output is
  // stable across runs and diffable in a log.
  for (const embedder of chosenEmbedders) {
    for (const store of chosenStores) {
      if (embedder.dimensions === undefined || store.dimensions === undefined) {
        issues.push({
          kind: "unknown_dimension",
          detail:
            `cannot verify ${embedder.adapter} (${embedder.dimensions ?? "no width"}) against ` +
            `${store.adapter} (${store.dimensions ?? "no width"}): an unreported width is not a matching width`,
        });
        continue;
      }

      if (embedder.dimensions !== store.dimensions) {
        issues.push({
          kind: "dimension_mismatch",
          detail:
            `${embedder.adapter} emits ${embedder.dimensions}-d vectors but ` +
            `${store.adapter} holds ${store.dimensions}-d: queries would return confident nonsense`,
        });
      }
    }
  }

  return issues;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * One plain line per capability, plus a count.
 *
 * No colour, no emoji, no ANSI — this repo's CLI output is plain text, and a status line
 * that only reads correctly in a terminal is not a status line. The trailing count is
 * not a summary for its own sake: a reader who stops after the first four lines must
 * still be unable to miss that something is degraded, so the number is on the last line
 * of the output rather than somewhere a reader may not reach.
 *
 * A degraded capability is rendered with an explicit `(none)` and its rejection reasons,
 * never omitted and never rendered as an empty list — an absent line and a line saying
 * "nothing is here" are different claims, and only one of them is true.
 */
export function renderCapabilitySummary(statuses: readonly CapabilityStatus[]): string[] {
  const lines: string[] = [];
  let degraded = 0;

  for (const status of statuses) {
    const available = status.available.length;
    const considered = status.considered.length;
    if (status.degraded) degraded += 1;

    const head =
      `${status.capability.padEnd(11)} ` +
      `${status.degraded ? "DEGRADED" : "ok      "} ` +
      `${available}/${considered} available: ` +
      (available > 0 ? status.available.join(", ") : "(none)");

    if (!status.degraded) {
      lines.push(head);
      continue;
    }

    const reasons = status.considered
      .map((verdict) => verdict.reason)
      .filter((reason): reason is string => reason !== undefined);
    lines.push(
      reasons.length > 0 ? `${head}  [${reasons.join("; ")}]` : head
    );
  }

  lines.push(
    degraded === 0
      ? `0 of ${statuses.length} capabilities degraded`
      : `${degraded} of ${statuses.length} capabilities degraded`
  );

  return lines;
}