// ── Task complexity — a crude, deterministic, ordering-only signal ────────────
//
// Why this exists. Routing today is static: `Provider.priority` is tried in
// ascending order and nothing about the *request* influences it, so a
// `get_server_time` ping and a 100k-token research job burn the same scarce
// free-tier allocation in the same order. The insight adopted from Cloudflare's
// Auto Router framing is small and worth taking: *you don't need Opus-level
// intelligence if you are looking to summarize an email* — mapped onto Simorgh:
// do not burn a scarce allocation on a trivial task when a cheaper bird would
// do.
//
// ── The honesty clause, stated up front ──
//
// This module is a **crude lexical proxy** and says so everywhere it can. It
// counts characters, fences, paragraphs, question marks and a small list of
// heavyweight directive verbs. It will misjudge a poetic 400-word prompt as
// "heavy" and a dense systems question phrased simply as "trivial". That is
// acceptable *only* because of the two rules below, and fatal if either is
// relaxed:
//
//   1. **Ordering, never exclusion.** A heuristic that drops candidates silently
//      loses capability — ADR-0003's own rule, applied to selection instead of
//      rejection. Every provider stays in the candidate set regardless of its
//      declared tier; the estimate only changes where they sit in the order.
//   2. **No LLM in the routing path.** An LLM deciding scheduling is a feedback
//      loop this project has explicitly rejected. The estimate is a pure
//      function of the prompt text — same input, same output, on every runtime,
//      with no clock, no randomness and no I/O.
//
// It is opt-in at the flock layer (`FlyFlockDeps.routing`): when no routing
// signal is supplied, ordering is byte-identical to plain `byPriority`.

/** The three classes of work a prompt can be, from the router's point of view. */
export type ComplexityTier = "trivial" | "moderate" | "heavy";

/** Every tier, cheapest first — the order a cost-aware flock prefers to try in. */
export const COMPLEXITY_TIERS: readonly ComplexityTier[] = ["trivial", "moderate", "heavy"];

/** Numeric order of the tiers, for comparisons. */
export const TIER_ORDER: Readonly<Record<ComplexityTier, number>> = {
  trivial: 0,
  moderate: 1,
  heavy: 2,
};

/**
 * The raw features the score is computed from. Exposed rather than hidden inside
 * the score so a test — and an operator reading a routed decision — can see *why*
 * a prompt landed where it did instead of trusting an unexplained number.
 */
export interface ComplexitySignals {
  chars: number;
  words: number;
  codeFences: number;
  paragraphs: number;
  questions: number;
  directiveHits: number;
}

export interface ComplexityEstimate {
  tier: ComplexityTier;
  /** 0 upwards. Tier boundaries are the constants below. */
  score: number;
  signals: ComplexitySignals;
}

/** Below this score a prompt is `trivial`. ≈ 12 lightweight English words. */
export const TRIVIAL_SCORE_MAX = 12;
/** Below this (and ≥ trivial) a prompt is `moderate`; at or above, `heavy`. */
export const MODERATE_SCORE_MAX = 35;

/**
 * Directive verbs that correlate with real work. A deliberately tiny list: every
 * entry added is a false-positive surface, and the cost of a missed signal is one
 * suboptimal ordering — while the cost of a bloated list is a signal nobody can
 * trust. Matched word-wise, case-insensitively.
 */
const DIRECTIVE_VERBS =
  /\b(analy[sz]e|architect|benchmark|debug|deriv(?:e|ing)|design|implement|migrat(?:e|ing)|optimi[sz]e|prove|refactor|step[- ]by[- ]step|threat[- ]model)\b/gi;

/** Split on blank lines; a single-line prompt is one paragraph. */
function paragraphsOf(text: string): number {
  const parts = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  return parts.length;
}

/**
 * Estimate a prompt's routing complexity. Pure, total, and deterministic.
 *
 * Scoring (each component capped so no single feature can dominate):
 *
 *   length      min(40, words / 25)        25 words ≈ the size of a ping
 *   code        min(20, fences × 10)       a fenced block is a real request
 *   structure   min(15, (paragraphs−1)×5)  multi-part asks are real work
 *   questions   min(10, questions × 5)     interrogatives multiply intent
 *   directives  min(15, verbs × 5)         see DIRECTIVE_VERBS above
 *
 * An empty or whitespace-only prompt scores 0 — `trivial`, which is the honest
 * answer: there is nothing in it to be heavy about.
 */
export function estimateComplexity(prompt: string): ComplexityEstimate {
  const trimmed = prompt.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  const fences = Math.floor((prompt.match(/```/g)?.length ?? 0) / 2);
  const paragraphs = paragraphsOf(prompt);
  const questions = (prompt.match(/\?/g) ?? []).length;
  const directiveHits = (prompt.match(DIRECTIVE_VERBS) ?? []).length;

  const score = Math.round(
    Math.min(40, words / 25) +
      Math.min(20, fences * 10) +
      Math.min(15, Math.max(0, paragraphs - 1) * 5) +
      Math.min(10, questions * 5) +
      Math.min(15, directiveHits * 5)
  );

  const tier: ComplexityTier =
    score < TRIVIAL_SCORE_MAX ? "trivial" : score < MODERATE_SCORE_MAX ? "moderate" : "heavy";

  return {
    tier,
    score,
    signals: { chars: prompt.length, words, codeFences: fences, paragraphs, questions, directiveHits },
  };
}

/**
 * How well a provider's declared tier set fits the wanted tier. The ordering key:
 *
 *   0 — the provider declares it can serve this tier (best fit, try first)
 *   1 — the provider declares nothing (neutral: assume it can serve anything)
 *   2 — the provider declares tiers and this is not one of them (worst fit)
 *
 * Rank 2 is *ordering*, not exclusion: a heavy-only bird still gets its turn if
 * every better-fitted bird fails. That is the rule at the top of this file.
 */
export function fitRank(declared: readonly ComplexityTier[] | undefined, want: ComplexityTier): number {
  if (declared === undefined) return 1;
  return declared.includes(want) ? 0 : 2;
}
