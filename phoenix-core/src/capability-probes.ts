// ── From a provider list to honest probes ─────────────────────────────────────
//
// `capabilities.ts` is pure over probe results, and its header says it imports nothing but
// `quota.ts` and that **a host probes what it actually has**. This module is the shared
// half of that host work — in the engine rather than copied into each host, for the reason
// `ledger.ts` gives for its own move: two copies of the same mapping drift, and nothing
// compares them. The edge host and the self-hosted host already keep two provider rosters,
// which is why `providers-parity.test.ts` exists; the probe mapping is not going to become
// the third thing that can disagree.
//
// It reads a `Provider` and a secret reader, both engine concepts, and it touches no port
// and no runtime binding — so `boundary.test.ts` is unaffected and this stays testable with
// no network and no Durable Object.

import { CAPABILITY_NAMES, type AdapterProbe, type CapabilityCost, type CapabilityName } from "./capabilities.ts";
import type { Provider } from "./provider.ts";

/**
 * What a host says one adapter costs, and whether that allowance refills.
 *
 * Two fields rather than one because they are facts about different resources: a provider
 * can be free and non-renewing (a one-time credit grant), and the planner has to spend
 * those *last*. See the `renewing` comment in `capabilities.ts`.
 */
export interface AdapterCost {
  cost: CapabilityCost;
  renewing: boolean;
}

/**
 * The safe default: a cost nobody has classified.
 *
 * `unknown`, never `free`. Rule 1 of `capabilities.ts` restated as a default value — the
 * failure mode of getting this wrong is an invoice, not a wrong number, so the default has
 * to be the direction that fails closed.
 */
export const UNCLASSIFIED_COST: AdapterCost = { cost: "unknown", renewing: false };

/**
 * Turn a deployment's provider list into capability probes for `inference`.
 *
 * `ok` is the *same rule* `phoenix-core/src/flock.ts` uses to decide `dormant`: a provider
 * that declares no secret is always configured, and one that declares `requires` is
 * configured exactly when that secret resolves. Reusing the rule rather than restating it
 * is the point — a status endpoint that disagrees with the routing loop about which birds
 * are usable is worse than no status endpoint, because an operator debugs the wrong one.
 *
 * `reason` is left unset on purpose when a secret is missing: `failedProbeReason` derives
 * `missing_config:<NAME>` from `requires`, which is more actionable than any string this
 * function could invent, and deriving it in one place keeps every refusal phrased alike.
 */
export function providerProbes(
  providers: readonly Provider[],
  secret: (name: string) => string | undefined,
  costOf: (providerId: string) => AdapterCost = () => UNCLASSIFIED_COST
): AdapterProbe[] {
  return providers.map((provider) => {
    const needs = provider.requires;
    const configured = needs === undefined || secret(needs) !== undefined;
    const { cost, renewing } = costOf(provider.id);

    return {
      adapter: provider.id,
      capability: "inference" as const,
      ok: configured,
      cost,
      renewing,
      ...(needs !== undefined ? { requires: [needs] } : {}),
      meta: {
        priority: provider.priority,
        model: provider.model,
        vendor: provider.provider,
      },
    };
  });
}

/**
 * Probes for the capabilities that no adapter claimed.
 *
 * `buildCapabilityStatus` documents that a capability missing from its input is missing
 * from its output, "because there is nothing to report about a capability nothing
 * attempted". That is correct as an *input contract* — it cannot invent rows — but it is
 * the wrong answer to the question an operator is actually asking. "Can this box do
 * embeddings?" has an answer, and it is no. Omitting the line invites a reader to infer
 * "not applicable" where the truth is "not available", and `renderCapabilitySummary`
 * already draws exactly this distinction for a capability whose every adapter failed: *an
 * absent line and a line saying "nothing is here" are different claims, and only one of
 * them is true.* So the unclaimed set is probed too, and reported as failed with a reason.
 *
 * The launch plan states the same rule from the product side: *"A capability may be
 * satisfied by zero adapters, and the runtime must say so."*
 */
export function unclaimedCapabilityProbes(
  claimed: readonly CapabilityName[]
): AdapterProbe[] {
  const seen = new Set<CapabilityName>(claimed);

  return CAPABILITY_NAMES.filter((capability) => !seen.has(capability)).map((capability) => ({
    // Greppable and obviously not a vendor, so `no-adapter:vector` cannot be mistaken for
    // an adapter id in a log.
    adapter: `no-adapter:${capability}`,
    capability,
    ok: false,
    // Not `free`. Nothing is running and nothing is being spent, but "free" is a claim
    // about a cost, and there is no cost here to make a claim about.
    cost: "unknown" as const,
    renewing: false,
    reason: "no_adapter_registered",
  }));
}

/** The capability names that actually have an adapter, given a probe set. */
export function claimedCapabilities(probes: readonly AdapterProbe[]): CapabilityName[] {
  return [...new Set(probes.map((probe) => probe.capability))];
}

/**
 * What this project believes each built-in bird costs, and whether its allowance refills.
 *
 * A **claim**, and deliberately a single one so the edge host and the self-hosted host
 * cannot disagree about it. A provider absent from this table falls back to
 * `UNCLASSIFIED_COST` = `unknown`, and `unknown` is refused under `FREE_ONLY` (ADR-0005) —
 * so *forgetting to classify a newly-added bird fails closed* instead of quietly becoming
 * free. That is the property that makes a hand-maintained table acceptable here at all.
 *
 * `bulbul` is the row worth reading, and it is deliberately **not** `free`. It was
 * classified free when HuggingFace had a free inference tier; TASK-015 found that tier gone
 * (`projects/simorgh-prd-research/one-million-users.md`). So its cost is now *unclassified*
 * rather than assumed — which is the honest state, and precisely the case this vocabulary
 * exists for: the bird still appears in the matrix, and `planCapability` under `FREE_ONLY`
 * refuses it with a reason an operator can act on, instead of routing routine work onto an
 * allowance that is not there.
 */
export const DEFAULT_PROVIDER_COST: Readonly<Record<string, AdapterCost>> = {
  shahin: { cost: "free", renewing: true },
  gemini: { cost: "free", renewing: true },
  openrouter: { cost: "free", renewing: true },
  homa: { cost: "free", renewing: true },
  bulbul: { cost: "unknown", renewing: false },
};

/** `DEFAULT_PROVIDER_COST` with the fail-closed fallback applied. */
export function builtInCostOf(providerId: string): AdapterCost {
  return DEFAULT_PROVIDER_COST[providerId] ?? UNCLASSIFIED_COST;
}
