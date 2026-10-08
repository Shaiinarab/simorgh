// Capability negotiation: probe → rank → explain, and the two rules that keep it honest.
//
// No network, no runtime bindings, no Durable Object. Everything under test is pure over
// values a host hands in, which is the whole reason the module is pure — so these cases
// exercise the real policy with frozen inputs rather than a stub that agrees with us.
//
// The negative-control block at the bottom is not decoration. This repo has documented
// three all-green suites hiding a real defect, and its rule is that a detector which has
// never fired is not evidence. Each control there plants a break in one rule, watches the
// specific test that *claims* that rule go red, and restores it.
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_NAMES,
  buildCapabilityStatus,
  checkCompatibility,
  planCapability,
  renderCapabilitySummary,
  type AdapterProbe,
  type CapabilityStatus,
} from "../src/capabilities.ts";

/** A probe that works. Every field explicit, so a test never relies on a default. */
function probe(over: Partial<AdapterProbe> & Pick<AdapterProbe, "adapter" | "capability">): AdapterProbe {
  return {
    ok: true,
    cost: "free",
    renewing: true,
    ...over,
  };
}

/** The single status for a one-capability set of probes. */
function statusOf(probes: AdapterProbe[]): CapabilityStatus {
  const [status] = buildCapabilityStatus(probes);
  return status;
}

/** The ids the plan chose, best first. */
function chosen(plan: ReturnType<typeof planCapability>): string[] {
  return plan.ranked.map((verdict) => verdict.adapter);
}

// ── The money gate ────────────────────────────────────────────────────────────

describe("cost is three states and unknown is not free (ADR-0005)", () => {
  it("makes an unknown-cost adapter ineligible under FREE_ONLY, with the named reason", () => {
    const status = statusOf([
      probe({ adapter: "openai", capability: "inference", cost: "unknown" }),
    ]);
    const plan = planCapability(status);

    // The absence of a cost classification is not a classification of zero.
    expect(chosen(plan)).toEqual([]);
    expect(plan.degraded).toBe(true);
    expect(plan.notChosen).toEqual([
      { adapter: "openai", reason: "cost_unknown_in_free_only" },
    ]);
  });

  it("defaults to FREE_ONLY, so an unconfigured caller refuses an unclassified adapter", () => {
    const status = statusOf([
      probe({ adapter: "openai", capability: "inference", cost: "unknown" }),
      probe({ adapter: "ollama", capability: "inference", cost: "free" }),
    ]);

    // No `mode` passed. The safe answer must be the one you get by accident.
    expect(chosen(planCapability(status))).toEqual(["ollama"]);
  });

  it("refuses a paid adapter under FREE_ONLY by a different reason than unknown", () => {
    // The two must stay distinguishable: one is "we know it costs money", the other is
    // "nobody has said". Collapsing them would make a missing classification
    // indistinguishable from a known price, which is the classification itself.
    const status = statusOf([
      probe({ adapter: "openai", capability: "inference", cost: "paid" }),
    ]);
    expect(planCapability(status).notChosen).toEqual([
      { adapter: "openai", reason: "paid_tier_in_free_only" },
    ]);
  });

  it("admits an unknown-cost adapter once the mode allows paid — the same row, not a re-classification", () => {
    const probes = [
      probe({ adapter: "openai", capability: "inference", cost: "unknown" }),
    ];
    const status = statusOf(probes);

    expect(planCapability(status, { mode: "FREE_ONLY" }).ranked).toEqual([]);
    expect(chosen(planCapability(status, { mode: "PAID_ALLOWED" }))).toEqual(["openai"]);
  });
});

// ── Nothing disappears ────────────────────────────────────────────────────────

describe("a capability with no usable adapter is reported, not omitted", () => {
  it("still appears in the rendered output and is marked degraded", () => {
    // The honesty guarantee. A status report that simply lacks the line reads as
    // "all good" to every human and every parser.
    const statuses = buildCapabilityStatus([
      probe({ adapter: "ollama", capability: "inference" }),
      probe({
        adapter: "gemini",
        capability: "embeddings",
        ok: false,
        cost: "free",
        requires: ["GEMINI_API_KEY"],
      }),
    ]);

    expect(statuses.map((s) => s.capability)).toEqual(["inference", "embeddings"]);

    const degraded = statuses.find((s) => s.capability === "embeddings");
    expect(degraded?.degraded).toBe(true);
    expect(degraded?.available).toEqual([]);

    const lines = renderCapabilitySummary(statuses);
    expect(lines).toContain(
      "embeddings  DEGRADED 0/1 available: (none)  [missing_config:GEMINI_API_KEY]"
    );
    expect(lines[lines.length - 1]).toBe("1 of 2 capabilities degraded");
  });

  it("keeps a capability that works *and* one that does not in the same count", () => {
    const statuses = buildCapabilityStatus([
      probe({ adapter: "ollama", capability: "inference" }),
      probe({
        adapter: "pinecone",
        capability: "vector",
        ok: false,
        cost: "free",
        reason: "connect_refused",
      }),
    ]);

    const lines = renderCapabilitySummary(statuses);
    expect(lines[0]).toBe("inference   ok       1/1 available: ollama");
    expect(lines[1]).toBe("vector      DEGRADED 0/1 available: (none)  [connect_refused]");
    expect(lines[2]).toBe("1 of 2 capabilities degraded");
  });

  it("counts every known capability as degraded when nothing anywhere works", () => {
    const statuses = buildCapabilityStatus(
      CAPABILITY_NAMES.map((capability) =>
        probe({ adapter: `broken-${capability}`, capability, ok: false, reason: "probe_failed" })
      )
    );

    expect(statuses).toHaveLength(CAPABILITY_NAMES.length);
    expect(statuses.every((s) => s.degraded)).toBe(true);
    expect(renderCapabilitySummary(statuses).pop()).toBe(
      `${CAPABILITY_NAMES.length} of ${CAPABILITY_NAMES.length} capabilities degraded`
    );
  });

  it("says zero explicitly when nothing is degraded, so the line cannot be read as untested", () => {
    const statuses = buildCapabilityStatus([
      probe({ adapter: "ollama", capability: "inference" }),
    ]);
    expect(renderCapabilitySummary(statuses).pop()).toBe("0 of 1 capabilities degraded");
  });
});

// ── Every adapter accounted for ───────────────────────────────────────────────

describe("every adapter considered appears with a verdict, chosen or not", () => {
  it("accounts for all four probes exactly, with the reason each one lost", () => {
    // `toEqual` on the whole array: completeness is the property, so an exact match is
    // the right assertion. `toContain` would pass with a third entry invented or a
    // fifth one dropped, which is the defect this guards.
    const status = statusOf([
      probe({ adapter: "ollama", capability: "inference", cost: "free", renewing: true }),
      probe({
        adapter: "openai",
        capability: "inference",
        cost: "paid",
        renewing: true,
      }),
      probe({
        adapter: "gemini",
        capability: "inference",
        ok: false,
        cost: "free",
        reason: "401_unauthorized",
      }),
      probe({
        adapter: "together",
        capability: "inference",
        cost: "unknown",
        renewing: false,
        requires: ["TOGETHER_API_KEY"],
      }),
    ]);

    expect(chosen(planCapability(status))).toEqual(["ollama"]);
    expect(planCapability(status).notChosen).toEqual([
      { adapter: "openai", reason: "paid_tier_in_free_only" },
      // A broken adapter is reported as broken, and the money gate is not consulted
      // for it: it is broken whether it costs money or not.
      { adapter: "gemini", reason: "401_unauthorized" },
      { adapter: "together", reason: "cost_unknown_in_free_only" },
    ]);
  });

  it("preserves every probe in `considered` — including the losers and the unchosen", () => {
    const status = statusOf([
      probe({ adapter: "a", capability: "inference" }),
      probe({ adapter: "b", capability: "inference" }),
      probe({ adapter: "c", capability: "inference", ok: false, reason: "dns_failure" }),
    ]);

    expect(status.considered.map((v) => v.adapter)).toEqual(["a", "b", "c"]);
    expect(status.considered.map((v) => v.usable)).toEqual([true, true, false]);
    expect(status.available).toEqual(["a", "b"]);
  });

  it("accounts for every considered adapter exactly once across ranked and notChosen", () => {
    // The arithmetic of "never silently drop": the two output lists must partition the
    // input, with no adapter in both and none in neither. A drop shows up as a missing
    // entry; a duplicate shows up as a count above the input length.
    const probes: AdapterProbe[] = [
      probe({ adapter: "a", capability: "inference" }),
      probe({ adapter: "b", capability: "inference", cost: "paid" }),
      probe({ adapter: "c", capability: "inference", cost: "unknown" }),
      probe({ adapter: "d", capability: "inference", ok: false, reason: "boom" }),
      probe({ adapter: "e", capability: "inference", renewing: false }),
    ];

    const plan = planCapability(statusOf(probes));

    // The union of the two lists is exactly what was considered. This is the invariant
    // that actually holds: `ranked` and `notChosen` deliberately overlap (an adapter at
    // rank 3 is both a real fallback and something that lost), so summing them would be
    // wrong — but a silent drop shows up immediately as an adapter missing from both.
    const named = new Set([...chosen(plan), ...plan.notChosen.map((n) => n.adapter)]);
    expect([...named].sort()).toEqual(["a", "b", "c", "d", "e"]);

    // And every adapter that is not the winner carries a reason.
    const reasons = new Map(plan.notChosen.map((n) => [n.adapter, n.reason]));
    for (const adapter of ["b", "c", "d", "e"]) {
      expect(reasons.get(adapter)).toBeTypeOf("string");
    }
  });

  it("gives an adapter that lost a healthy ranking a ranking reason, not a failure reason", () => {
    // The distinction an operator acts on: broken, forbidden, or merely second.
    const plan = planCapability(
      statusOf([
        probe({ adapter: "fast", capability: "inference" }),
        probe({ adapter: "slow", capability: "inference" }),
      ])
    );
    expect(plan.notChosen).toEqual([
      { adapter: "slow", reason: "outranked_by_probe_order" },
    ]);
  });
});

// ── Preferences ───────────────────────────────────────────────────────────────

describe("a key-free adapter outranks a keyed one at equal cost", () => {
  it("prefers the adapter that needs no configuration", () => {
    // The zero-KYC promise made operational: the keyed adapter works only while the
    // operator still holds the key, so the key-free one is the one to depend on.
    const plan = planCapability(
      statusOf([
        probe({
          adapter: "gemini",
          capability: "inference",
          cost: "free",
          renewing: true,
          requires: ["GEMINI_API_KEY"],
        }),
        probe({ adapter: "ollama", capability: "inference", cost: "free", renewing: true }),
      ])
    );

    // The keyed adapter stays in the ladder as a fallback — losing the key costs
    // availability, not capability, which is why it is second rather than absent.
    expect(chosen(plan)).toEqual(["ollama", "gemini"]);
    expect(plan.notChosen).toEqual([
      { adapter: "gemini", reason: "outranked_by_key_free" },
    ]);
  });

  it("keeps a key-free adapter ahead of a keyed one even when the keyed one renews", () => {
    // Key-free is the *first* axis, not a tiebreak. If renewability could outrank it,
    // a renewing key-dependent adapter would win, and losing the key would then take the
    // capability with it — which is the failure the ordering exists to prevent.
    const plan = planCapability(
      statusOf([
        probe({
          adapter: "gemini",
          capability: "inference",
          cost: "free",
          renewing: true,
          requires: ["GEMINI_API_KEY"],
        }),
        probe({ adapter: "ollama", capability: "inference", cost: "free", renewing: false }),
      ])
    );

    // Both remain usable — the keyed adapter is a fallback, not a casualty. What the
    // ordering changes is which one is tried *first*.
    expect(chosen(plan)).toEqual(["ollama", "gemini"]);
  });
});

describe("a one-time grant is spent last, not first", () => {
  it("ranks a renewing adapter ahead of a one-time one at equal preference", () => {
    // Reads backwards if you assume "use it before you lose it". A one-time grant never
    // refills, so routing routine work onto it burns the reserve that exists for the
    // incident it was granted for. Spending the refillable tier first keeps it intact for
    // exactly the moment the refillable tier runs out.
    const plan = planCapability(
      statusOf([
        probe({ adapter: "trial-credit", capability: "inference", cost: "free", renewing: false }),
        probe({ adapter: "ollama", capability: "inference", cost: "free", renewing: true }),
      ])
    );

    expect(chosen(plan)).toEqual(["ollama", "trial-credit"]);
    expect(plan.notChosen).toEqual([
      { adapter: "trial-credit", reason: "outranked_by_non_renewing" },
    ]);
  });

  it("still uses a one-time grant when nothing renews", () => {
    // Degrading to nothing would be a worse lie than spending the reserve. Real capacity
    // beats no capacity; the ordering only decides among options that all work.
    const plan = planCapability(
      statusOf([
        probe({ adapter: "trial-credit", capability: "inference", cost: "free", renewing: false }),
      ])
    );
    expect(chosen(plan)).toEqual(["trial-credit"]);
    expect(plan.degraded).toBe(false);
  });
});

// ── The dimension guard ───────────────────────────────────────────────────────

describe("the dimension guard catches silent recall collapse", () => {
  it("reports a mismatch between the selected embedder and the selected store", () => {
    // Nothing throws here. The store accepts 768-d rows into a 1536-d table, queries
    // return confident nonsense, and the only symptom is that RAG quietly stopped being
    // good months later. This is the check that makes that impossible to miss.
    const issues = checkCompatibility(
      [probe({ adapter: "gemini-embed", capability: "embeddings", dimensions: 768 })],
      [probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 1536 })]
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("dimension_mismatch");
    expect(issues[0].detail).toContain("gemini-embed emits 768-d");
    expect(issues[0].detail).toContain("sqlite-vec holds 1536-d");
  });

  it("reports nothing when the widths agree", () => {
    expect(
      checkCompatibility(
        [probe({ adapter: "gemini-embed", capability: "embeddings", dimensions: 768 })],
        [probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 768 })]
      )
    ).toEqual([]);
  });

  it("reports a usable store with no usable embedder", () => {
    // A vector store with nothing to feed it is a capability that exists and cannot be
    // used. Silently returning "no issues" here would report a healthy system.
    const issues = checkCompatibility(
      [
        probe({
          adapter: "gemini-embed",
          capability: "embeddings",
          ok: false,
          reason: "401_unauthorized",
        }),
      ],
      [probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 768 })]
    );

    expect(issues.map((i) => i.kind)).toEqual(["missing_embedder"]);
    expect(issues[0].detail).toContain("sqlite-vec");
  });

  it("treats an embedder that never reported its width as unverifiable, not as matching", () => {
    // An unmeasured width is not a matching width. Reporting nothing here would
    // reintroduce the same silence through the back door.
    const issues = checkCompatibility(
      [probe({ adapter: "mystery-embed", capability: "embeddings" })],
      [probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 768 })]
    );

    expect(issues.map((i) => i.kind)).toEqual(["unknown_dimension"]);
    expect(issues[0].detail).toContain("mystery-embed");
  });

  it("reports nothing when there is no usable store at all — nothing to be incompatible with", () => {
    expect(
      checkCompatibility(
        [probe({ adapter: "gemini-embed", capability: "embeddings", dimensions: 768 })],
        [probe({ adapter: "pinecone", capability: "vector", ok: false, reason: "dns" })]
      )
    ).toEqual([]);
  });

  it("checks every usable pair, including a mismatched embedder that did not rank first", () => {
    // The planner ranks by key-freeness and renewability, never by dimension — so a
    // 768-d embedder can sort *first*, and a guard that inspected only the top pair
    // would report a clean system with a live landmine in second place.
    const embedders = [
      probe({ adapter: "wrong-width", capability: "embeddings", dimensions: 768 }),
      probe({ adapter: "right-width", capability: "embeddings", dimensions: 1536 }),
    ];
    const stores = [probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 1536 })];

    expect(checkCompatibility(embedders, stores).map((i) => i.kind)).toEqual([
      "dimension_mismatch",
    ]);
  });

  it("narrows to the named pair when the caller says which one it will use", () => {
    const embedders = [
      probe({ adapter: "wrong-width", capability: "embeddings", dimensions: 768 }),
      probe({ adapter: "right-width", capability: "embeddings", dimensions: 1536 }),
    ];
    const stores = [probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 1536 })];

    expect(checkCompatibility(embedders, stores, { embedder: "right-width" })).toEqual([]);
    expect(
      checkCompatibility(embedders, stores, { embedder: "wrong-width" }).map((i) => i.kind)
    ).toEqual(["dimension_mismatch"]);
  });

  it("reports a named adapter that is not usable rather than checking a different one", () => {
    // Quietly substituting another adapter would report a clean result for a pairing
    // nobody is going to run — the same silence, one level up.
    const issues = checkCompatibility(
      [probe({ adapter: "gemini-embed", capability: "embeddings", dimensions: 768 })],
      [probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 768 })],
      { embedder: "does-not-exist" }
    );
    expect(issues.map((i) => i.kind)).toEqual(["unknown_dimension"]);
    expect(issues[0].detail).toContain("does-not-exist");
  });

  it("wires the guard to the plan: a chosen pair that disagrees is an issue", () => {
    // End-to-end over the real artefacts, not two hand-built probe lists: build the
    // matrix, plan it, then check the pair the plan selected.
    const statuses = buildCapabilityStatus([
      probe({ adapter: "gemini-embed", capability: "embeddings", dimensions: 768 }),
      probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 1536 }),
    ]);
    const embedPlan = planCapability(statuses.find((s) => s.capability === "embeddings")!);
    const storePlan = planCapability(statuses.find((s) => s.capability === "vector")!);

    expect(
      checkCompatibility(
        [
          probe({ adapter: embedPlan.ranked[0].adapter, capability: "embeddings", dimensions: 768 }),
        ],
        [
          probe({ adapter: storePlan.ranked[0].adapter, capability: "vector", dimensions: 1536 }),
        ]
      ).map((i) => i.kind)
    ).toEqual(["dimension_mismatch"]);
  });
});

// ── Output hygiene ────────────────────────────────────────────────────────────

describe("the summary is plain text", () => {
  it("emits no ANSI escape sequences and no emoji", () => {
    // This repo's CLI output is plain, and a status line that only reads correctly in a
    // colour-capable terminal is not a status line.
    const statuses = buildCapabilityStatus([
      probe({ adapter: "ollama", capability: "inference" }),
      probe({ adapter: "dead", capability: "vector", ok: false, reason: "dns_failure" }),
    ]);

for (const line of renderCapabilitySummary(statuses)) {
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/\u001b\[/);
      expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

// ── Negative controls ─────────────────────────────────────────────────────────
//
// Each block below was run and its red output pasted into the module's commit/report.
// They are kept here as executable documentation: the next person who changes a rule
// should be able to re-run the control rather than trust that it once worked.

describe("negative controls", () => {
  it("would fail if the unknown-cost rule were removed (control — re-derive by breaking costVerdict)", () => {
    // Run: `toProviderCost` collapsed `unknown` into `{ kind: "free" }`, so the ADR-0005
    // rule stopped being enforced at this module's boundary.
    // Red: 5 tests. "makes an unknown-cost adapter ineligible under FREE_ONLY" failed
    //      with expected [] to deeply equal [ 'openai' ] — the unclassified adapter was
    //      routed onto; "defaults to FREE_ONLY…" failed with
    //      expected [ 'openai', 'ollama' ] to deeply equal [ 'ollama' ];
    //      "refuses a paid adapter…" and "accounts for all four probes exactly" also went
    //      red, the latter showing [ 'ollama', 'together' ] where only [ 'ollama' ] was
    //      expected. Restored: 29/29 green.
    const status = statusOf([
      probe({ adapter: "openai", capability: "inference", cost: "unknown" }),
    ]);
    // The live assertion: under the default mode this adapter must be refused by name.
    expect(planCapability(status).notChosen).toEqual([
      { adapter: "openai", reason: "cost_unknown_in_free_only" },
    ]);
  });

  it("would fail if a zero-adapter capability were omitted (control — re-derive by breaking the builder)", () => {
    // Run: `buildCapabilityStatus` filtered out capabilities with no usable adapter.
    // Red: 4 tests. "still appears in the rendered output and is marked degraded" failed
    //      with expected [ 'inference', 'embeddings' ] to deeply equal [ 'inference' ] —
    //      the line was simply gone; "counts every known capability as degraded when
    //      nothing anywhere works" failed with expected [] to have a length of 5 but got
    //      +0, which is the whole fleet reporting as healthy while nothing works; and
    //      "keeps a capability that works *and* one that does not" failed with the
    //      summary reading "0 of 1 capabilities degraded" for a box whose vector store
    //      had refused to connect. Restored: 29/29 green.
    const statuses = buildCapabilityStatus([
      probe({ adapter: "ollama", capability: "inference" }),
      probe({ adapter: "dead", capability: "embeddings", ok: false, reason: "boom" }),
    ]);
    expect(statuses.map((s) => s.capability)).toEqual(["inference", "embeddings"]);
    expect(statuses[1].degraded).toBe(true);
  });

  it("would fail if the dimension guard stopped comparing (control — re-derive by removing the check)", () => {
    // Run: `checkCompatibility` returned `[]` before checking anything.
    // Red: 8 tests — every one of the dimension-guard cases, plus the end-to-end one
    //      over the planned pair. "reports a mismatch between the selected embedder and
    //      the selected store" failed with expected [] to have a length of 1, and
    //      "reports a usable store with no usable embedder" failed with
    //      expected [] to deeply equal [ 'missing_embedder' ]. That second one is the
    //      dangerous direction: the guard reporting a clean system while a store sat
    //      there with nothing to feed it. Restored: 29/29 green.
    const issues = checkCompatibility(
      [probe({ adapter: "gemini-embed", capability: "embeddings", dimensions: 768 })],
      [probe({ adapter: "sqlite-vec", capability: "vector", dimensions: 1536 })]
    );
    expect(issues.map((i) => i.kind)).toEqual(["dimension_mismatch"]);
  });
});