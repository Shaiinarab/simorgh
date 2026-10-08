// TASK-012 — native compute audit benchmark.
//
// Times the REAL functions from phoenix-core/src/*.ts over representative inputs.
// Nothing is copied: every candidate imports the module it measures, so a number
// here is a number about the code that ships. Plain Node, node:perf_hooks only,
// no network, no new dependencies.
//
// ── Why block timing ───────────────────────────────────────────────────────────
// The obvious method — `performance.now()` around one call — is wrong on this box,
// and the failure is visible in the numbers rather than hidden. Single-call timing
// reports a mean 2-4x the median, because a 50 ns timer cannot see a 50 us kernel
// preemption: a call that takes 50 ns gets charged the 40 us the scheduler stole.
// The first version of this harness timed one call per sample and produced
// pass-A/pass-B median ratios from 0.70 to 1.60. That is a methodology bug, not
// machine noise, and the fix is to amortise.
//
// So: each SAMPLE is a BLOCK of K calls, K chosen so a block lasts ~500 us — long
// enough that one preemption moves a sample by <10%, short enough that K stays
// small. Per-call cost is blockElapsed / K. Median over samples is then robust to
// preemption, and the reported N is the true total call count.
//
// The block loop itself is not free, so an empty-loop baseline is measured through
// the identical path and SUBTRACTED. It measures 0.002 us/call — three orders below
// the smallest candidate — but it is measured rather than assumed, and it is
// reported.
//
// The suite runs three times (passes A/B/C) and every median is reported, because
// a number that cannot be shown to hold still is not a measurement. A planted-failure
// self-test proves the correctness assertions can actually fail.
//
// Run from the repo root:  node bench/native-audit/run.mjs
// Pin a core for cleaner numbers:  taskset -c 2 node bench/native-audit/run.mjs

import { performance } from "node:perf_hooks";
import os from "node:os";
import { createHash } from "node:crypto";

import {
  planQuotaRun,
  postSpendValue,
  windowRemaining,
  capacityFor,
  nextLatencyEma,
} from "../../phoenix-core/src/quota.ts";
import {
  sanitizeModelOutput,
  parseExecuteBody,
  constantTimeEqual,
  markUntrusted,
} from "../../phoenix-core/src/security.ts";
import { describeFlock, flockRetryAfterSeconds } from "../../phoenix-core/src/flock.ts";
import { buildSynthesisPrompt } from "../../phoenix-core/src/agent.ts";

// ── Machine ───────────────────────────────────────────────────────────────────

const machine = {
  node: process.version,
  platform: process.platform + " " + os.release(),
  arch: process.arch,
  cpu: os.cpus()[0]?.model ?? "unknown",
  cores: os.cpus().length,
  memGiB: (os.totalmem() / 1024 ** 3).toFixed(1),
  pinned: process.env.RUN_PINNED ?? "no (taskset -c 2 for cleaner numbers)",
};

// ── Correctness assertions (the negative control's foundation) ─────────────────

let assertionsRun = 0;
function check(label, actual, expected) {
  assertionsRun += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`ASSERTION FAILED [${label}]: got ${a}, expected ${e}`);
  }
}

// The planted failure: run ONE deliberately wrong expectation through the same
// check() and confirm it throws. If this does not throw, the assertions below
// prove nothing. Reported in results.json so the control cannot be silently lost.
function plantedFailureSelfTest() {
  let threw = false;
  try {
    check("planted", 1, 2);
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error("PLANTED FAILURE DID NOT FIRE — assertion machinery is broken");
  }
  return threw;
}

// ── Inputs ────────────────────────────────────────────────────────────────────

const NOW = 1_760_000_000_000; // frozen clock, matches the module's own test style

function window(limit, used, resetAt) {
  return { kind: "day", limit, used, resetAt };
}

function state(id, opts) {
  return {
    providerId: id,
    accountId: "default",
    modelId: "m1",
    requests: window(opts.reqLimit ?? 100, opts.reqUsed ?? 0, opts.reqReset ?? 0),
    tokens: window(opts.tokLimit ?? 100_000, opts.tokUsed ?? 0, opts.tokReset ?? 0),
    cost: opts.cost ?? { kind: "free" },
    latencyEmaMs: opts.latency ?? 0,
  };
}

// A realistic fleet. 3 providers is what this repo ships by default; 8 is a busy
// self-hosted deployment; 64 is generous headroom, deliberately past any real one.
function fleet(n) {
  const states = [];
  for (let i = 0; i < n; i += 1) {
    states.push(
      state(`p${i}`, {
        reqUsed: (i * 7) % 40,
        tokUsed: (i * 5_000) % 60_000,
        reqReset: i % 3 === 0 ? NOW + 3_600_000 : 0,
        tokReset: i % 4 === 0 ? NOW + 21_600_000 : 0,
        latency: (i % 5) * 120,
        cost: i % 5 === 0 ? { kind: "unknown" } : { kind: "free" },
      })
    );
  }
  return states;
}

const WORKLOAD = { requests: 1, tokens: 2_048 };

function answerBytes(n) {
  const sentence =
    "The quota scheduler picks the account that leaves the most usable capacity after the spend. ";
  const out = sentence.repeat(Math.ceil(n / sentence.length));
  return out.slice(0, n);
}

function adversarialBytes(n) {
  // Every rule the shield owns, planted repeatedly, plus clean prose around it.
  const payload =
    'Hello <script>alert(1)</script> world <a href="javascript:alert(2)">x</a> ' +
    "<a href='data:text/html,<b>'>y</a> ‮bidi‬ ctrl <iframe src='x'></iframe>";
  const filler = "Ordinary answer prose that must survive byte-identical. ";
  const unit = payload + filler;
  const out = unit.repeat(Math.ceil(n / unit.length));
  return out.slice(0, n);
}

function executeBody(totalChars) {
  // The prompt cap (12_000) sits below the body cap (32_000), so a body at the body
  // cap must keep the prompt small and pad an ignored field to reach totalChars.
  const prompt = "x".repeat(11_000);
  const wrapper = JSON.stringify({ prompt, tools: ["search_web", "get_server_time"], userId: "u1" });
  const pad = totalChars - wrapper.length - 9;
  if (pad <= 0) return wrapper;
  return wrapper.slice(0, -1) + ',"pad":"' + "y".repeat(pad) + '"}';
}

const AVAILABLE_TOOLS = ["search_web", "get_server_time"];

// Byte-identical to phoenix-core/src/node/index.ts:71-72 — the node host's sha256.
// This IS the port injection the brief asked me to check: constantTimeEqual takes
// the digest function as an argument, so the engine never hashes itself.
const sha256 = async (value) =>
  new Uint8Array(createHash("sha256").update(value, "utf8").digest());

// ── Block-based timing ────────────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

const BLOCK_TARGET_MS = 0.5; // one sample ≈ 500 us
const TOTAL_TARGET_MS = 1_200; // per candidate, per pass

/**
 * Measure `fn` with block-amortised sampling.
 *
 * Returns per-call microseconds plus the honest bookkeeping: how many calls, how
 * many samples, how large a block, and the raw total wall time — so a reader can
 * check the arithmetic instead of trusting it.
 */
function timeIt(label, fn) {
  // Warmup: let the JIT settle before any sample is taken. Budgeted in TIME, not
  // call count — a fixed count costs 1.8 s on the 128 KB sanitize and is wasted
  // on the sub-microsecond ones.
  const warmStart = performance.now();
  while (performance.now() - warmStart < 200) fn();

  // Calibrate: how long does one call actually take? Budgeted the same way.
  const calibStart = performance.now();
  let calibCalls = 0;
  while (performance.now() - calibStart < 50) {
    fn();
    calibCalls += 1;
  }
  const perCallMs = Math.max((performance.now() - calibStart) / calibCalls, 1e-9);

  // Block size: enough calls per sample to amortise a preemption.
  const block = Math.max(1, Math.min(500_000, Math.round(BLOCK_TARGET_MS / perCallMs)));
  const samples = Math.max(40, Math.min(20_000, Math.round(TOTAL_TARGET_MS / BLOCK_TARGET_MS)));

  const perCall = new Array(samples);
  const wallStart = performance.now();
  for (let s = 0; s < samples; s += 1) {
    const t0 = performance.now();
    for (let i = 0; i < block; i += 1) fn();
    perCall[s] = (performance.now() - t0) / block;
  }
  const wallMs = performance.now() - wallStart;

  const sorted = [...perCall].sort((a, b) => a - b);
  const mean = perCall.reduce((a, b) => a + b, 0) / samples;
  const round3 = (x) => Number((x * 1000).toFixed(3));

  return {
    label,
    n: samples * block, // total calls, not samples — a number without its sample size is not a measurement
    samples,
    block,
    medianUs: round3(percentile(sorted, 50)),
    p95Us: round3(percentile(sorted, 95)),
    p99Us: round3(percentile(sorted, 99)),
    meanUs: round3(mean),
    wallMs: Number(wallMs.toFixed(0)),
  };
}

// ── Correctness checks (run before timing; a wrong answer voids the number) ────

async function correctnessChecks() {
  // windowRemaining: published limit, elapsed reset, unpublished limit.
  check("windowRemaining.fresh", windowRemaining(window(100, 30, 0), NOW), 70);
  check("windowRemaining.rolled", windowRemaining(window(100, 30, NOW - 1), NOW), 100);
  check("windowRemaining.unpublished", windowRemaining(window(0, 30, 0), NOW), Number.POSITIVE_INFINITY);

  // capacityFor: ready / impossible.
  check("capacityFor.ready", capacityFor(state("a", {}), WORKLOAD, NOW).kind, "ready");
  check(
    "capacityFor.impossible",
    capacityFor(state("a", { tokLimit: 100 }), WORKLOAD, NOW).kind,
    "impossible"
  );

  // planQuotaRun: the account leaving more capacity wins; the cost gate refuses
  // unless PAID_ALLOWED. Known reset times, matching the repo's own quota tests.
  const scarce = state("scarce", { tokLimit: 100_000, tokUsed: 95_000, tokReset: NOW + 12 * 3_600_000 });
  const abundant = state("abundant", { tokLimit: 100_000, tokUsed: 10_000, tokReset: NOW + 60_000 });
  check(
    "planQuotaRun.picksAbundant",
    planQuotaRun([scarce, abundant], WORKLOAD, NOW).run?.providerId,
    "abundant"
  );
  const paid = state("paid", { cost: { kind: "paid", usdPerMTokens: 1 } });
  check("planQuotaRun.refusesPaid", planQuotaRun([paid], WORKLOAD, NOW).action, "unavailable");
  check(
    "planQuotaRun.paidAllowed",
    planQuotaRun([paid], WORKLOAD, NOW, { mode: "PAID_ALLOWED" }).run?.providerId,
    "paid"
  );

  // postSpendValue: more remaining → higher value.
  check(
    "postSpendValue.ordering",
    postSpendValue(abundant, WORKLOAD, NOW, 3_600_000) > postSpendValue(scarce, WORKLOAD, NOW, 3_600_000),
    true
  );

  // sanitizeModelOutput: planted payload neutralised, clean text byte-identical.
  // The tag tokens are removed; text between them is deliberately left alone
  // (security.ts: pairing tags on untrusted input is how sanitizers get bypassed).
  const dirty = sanitizeModelOutput("a <script>alert(1)</script> b");
  check("sanitize.stripsScript", dirty.text, "a alert(1) b");
  check("sanitize.findingRecorded", dirty.findings.includes("tag:script"), true);
  const clean = sanitizeModelOutput(answerBytes(4096));
  check("sanitize.cleanIsIdentity", clean.text, answerBytes(4096));
  check("sanitize.cleanNoFindings", clean.findings, []);

  // parseExecuteBody: 32_000 chars allowed, 32_001 rejected.
  check("parseExecuteBody.atCap", parseExecuteBody(executeBody(32_000), AVAILABLE_TOOLS).tools.length, 2);
  let rejected = false;
  try {
    parseExecuteBody(executeBody(32_001), AVAILABLE_TOOLS);
  } catch {
    rejected = true;
  }
  check("parseExecuteBody.overCapRejected", rejected, true);

  // constantTimeEqual: equal and unequal tokens, through the injected sha256 port.
  check("constantTimeEqual.match", await constantTimeEqual("sk-test", "sk-test", sha256), true);
  check("constantTimeEqual.mismatch", await constantTimeEqual("sk-test", "sk-other", sha256), false);

  // describeFlock + retry-after: shape and soonest cooldown.
  const providers = Array.from({ length: 8 }, (_, i) => ({
    id: `b${i}`,
    name: `Bird ${i}`,
    provider: "p",
    model: "m",
    priority: i,
    requires: undefined,
  }));
  check(
    "describeFlock.count",
    describeFlock(providers, { secret: () => true, health: [], now: NOW }).birds.length,
    8
  );
  check("flockRetryAfter.soonest", flockRetryAfterSeconds([NOW + 5_000, NOW + 9_000], NOW, 1), 5);

  // nextLatencyEma: first sample seeds.
  check("nextLatencyEma.seed", nextLatencyEma(0, 250), 250);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

/** The complete synchronous CPU of one POST /api/v1/agent/execute, at given answer size. */
function oneExecuteRequest(answerChars, bodyChars, { shield = true } = {}) {
  const body = executeBody(bodyChars);
  const answer = answerBytes(answerChars);
  const observations = Array.from({ length: 4 }, (_, i) => ({
    tool: "search_web",
    iteration: i,
    ok: true,
    result: answerBytes(2_000),
  }));

  // 1. router parses the body                    (security.ts:104)
  parseExecuteBody(body, AVAILABLE_TOOLS);
  // 2. agent loop folds tool results into prompt  (agent.ts:198 -> buildSynthesisPrompt)
  const prompt = buildSynthesisPrompt("original prompt", observations);
  // 3. the flight returns an answer               (execute.ts:166)
  // 4. every tool observation is re-sanitized on the way out (execute.ts:210-213)
  // 5. details payload for the ledger             (execute.ts:139)
  if (!shield) return prompt.length + answer.length;

  const sanitized = sanitizeModelOutput(answer);
  for (const o of observations) sanitizeModelOutput(o.result).text;
  return prompt.length + sanitized.text.length;
}

function runPass(passLabel) {
  const results = [];
  const loadavg = os.loadavg().map((n) => n.toFixed(2)).join(", ");

  // Measured through the identical path, then subtracted from every candidate.
  const overhead = timeIt("__blockLoopOverhead__", () => {});

  // ── The primary named candidate: the quota scheduler ──────────────────────
  for (const n of [3, 8, 64]) {
    const states = fleet(n);
    results.push(timeIt(`planQuotaRun.n=${n}`, () => planQuotaRun(states, WORKLOAD, NOW)));
  }
  {
    const states = fleet(8);
    results.push(
      timeIt("planQuotaRun.urgent.n=8", () =>
        planQuotaRun(states, { ...WORKLOAD, deadline: NOW + 1_000 }, NOW)
      )
    );
  }
  results.push(timeIt("postSpendValue", () => postSpendValue(fleet(1)[0], WORKLOAD, NOW, 3_600_000)));
  results.push(timeIt("windowRemaining", () => windowRemaining(window(100, 30, 0), NOW)));
  results.push(timeIt("capacityFor", () => capacityFor(fleet(1)[0], WORKLOAD, NOW)));
  results.push(timeIt("nextLatencyEma", () => nextLatencyEma(120, 250)));

  // ── The output shield: the largest CPU item measured anywhere ──────────────
  for (const kb of [1, 4, 16, 128]) {
    const text = answerBytes(kb * 1024);
    results.push(timeIt(`sanitize.clean.${kb}KB`, () => sanitizeModelOutput(text)));
  }
  {
    const dirty = adversarialBytes(4 * 1024);
    results.push(timeIt("sanitize.adversarial.4KB", () => sanitizeModelOutput(dirty)));
    results.push(timeIt("sanitize.adversarial.16KB", () => sanitizeModelOutput(adversarialBytes(16 * 1024))));
  }

  // ── Request-body parse ─────────────────────────────────────────────────────
  for (const chars of [8 * 1024, 31_990]) {
    const body = executeBody(chars);
    results.push(timeIt(`parseExecuteBody.${chars}chars`, () => parseExecuteBody(body, AVAILABLE_TOOLS)));
  }

  // ── Agent-loop string work ─────────────────────────────────────────────────
  {
    const observations = Array.from({ length: 4 }, (_, i) => ({
      tool: "search_web",
      iteration: i,
      ok: true,
      result: answerBytes(2_000),
    }));
    results.push(timeIt("buildSynthesisPrompt.4x2KB", () => buildSynthesisPrompt("original prompt", observations)));
    results.push(timeIt("markUntrusted.8KB", () => markUntrusted(answerBytes(8 * 1024))));
  }

  // ── Auth: two SHA-256 of a short token, delegated to the node host's port ──
  results.push(
    timeIt("constantTimeEqual.sha256", () => constantTimeEqual("sk-test-1234", "sk-test-1234", sha256))
  );

  // ── /api/v1/flock/status only ──────────────────────────────────────────────
  {
    const providers = Array.from({ length: 8 }, (_, i) => ({
      id: `b${i}`,
      name: `Bird ${i}`,
      provider: "p",
      model: "m",
      priority: i,
      requires: undefined,
    }));
    results.push(
      timeIt("describeFlock.n=8", () => describeFlock(providers, { secret: () => true, health: [], now: NOW }))
    );
  }

  // ── The composite: everything one execute request does, synchronously ──────
  // With and without the shield, so the sanitizer's share is MEASURED as a
  // difference rather than inferred by adding up separately-timed rows.
  for (const kb of [1, 4, 16]) {
    results.push(
      timeIt(`oneExecuteRequest.answer=${kb}KB`, () => oneExecuteRequest(kb * 1024, 8 * 1024))
    );
    results.push(
      timeIt(`oneExecuteRequest.noShield.answer=${kb}KB`, () =>
        oneExecuteRequest(kb * 1024, 8 * 1024, { shield: false })
      )
    );
  }
  {
    // The one shape that could actually hurt: a large answer carrying every
    // planted rule. provider.ts:122 returns the answer with no length cap.
    results.push(
      timeIt("oneExecuteRequest.answer=128KB", () => oneExecuteRequest(128 * 1024, 8 * 1024))
    );
    results.push(
      timeIt("oneExecuteRequest.adversarial=128KB", () => {
        const dirty = adversarialBytes(128 * 1024);
        const observations = Array.from({ length: 4 }, () => ({
          tool: "search_web",
          iteration: 0,
          ok: true,
          result: adversarialBytes(2_000),
        }));
        parseExecuteBody(executeBody(8 * 1024), AVAILABLE_TOOLS);
        const prompt = buildSynthesisPrompt("original prompt", observations);
        const s = sanitizeModelOutput(dirty);
        for (const o of observations) sanitizeModelOutput(o.result).text;
        return prompt.length + s.text.length;
      })
    );
  }

  // Net = raw − measured block-loop overhead, so the arithmetic is auditable.
  const net = results.map((r) => ({
    label: r.label,
    n: r.n,
    samples: r.samples,
    block: r.block,
    medianUs: r.medianUs,
    p95Us: r.p95Us,
    p99Us: r.p99Us,
    meanUs: r.meanUs,
    wallMs: r.wallMs,
    netMedianUs: Number(Math.max(0, r.medianUs - overhead.medianUs).toFixed(3)),
    netP95Us: Number(Math.max(0, r.p95Us - overhead.p95Us).toFixed(3)),
  }));

  return {
    pass: passLabel,
    loadavg,
    overheadPerCallUs: overhead.medianUs,
    overheadN: overhead.n,
    results: net,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const negativeControlFired = plantedFailureSelfTest();
await correctnessChecks();

const passes = [runPass("A"), runPass("B"), runPass("C")];

// Stability: the worst median spread across the three passes, per candidate.
const stability = passes[0].results.map((a, i) => {
  const medians = passes.map((p) => p.results[i].medianUs);
  const worst = Math.max(...medians) / Math.min(...medians);
  return {
    label: a.label,
    mediansUs: medians,
    worstSpreadPct: Number(((worst - 1) * 100).toFixed(1)),
  };
});

const output = {
  machine,
  negativeControl: negativeControlFired ? "FIRED (a planted wrong expectation was caught and thrown)" : "DID NOT FIRE",
  assertionsRun,
  loadavgAtPassA: passes[0].loadavg,
  note: "Block-amortised timing: each sample is a block of `block` calls lasting ~500us, so one kernel preemption moves a sample by <10%. N is total calls. netMedianUs = medianUs minus the measured empty-loop overhead.",
  passes,
  stability,
};

console.log(JSON.stringify(output, null, 2));

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(output, null, 2));
const worstSpread = Math.max(...stability.map((s) => s.worstSpreadPct));
console.error(
  `\nWrote results.json — ${assertionsRun} correctness assertions passed; ` +
    `negative control: ${output.negativeControl}; worst 3-pass median spread: ${worstSpread}%`
);