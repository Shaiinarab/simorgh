#!/usr/bin/env node
// TS-vs-Rust benchmark orchestrator for the output shield.
//
// Runs BOTH implementations over the SAME input bytes in one session on one box —
// the only comparison that means anything (the repo's own native-compute audit was
// explicit about method: block-amortised timing, empty-loop baseline, three passes,
// negative control). The Rust side is `native-bench --batch`; the TypeScript side is
// the real `sanitizeModelOutput` imported from `phoenix-core/src/security.ts`.
//
// Usage: node native/test/bench-node.mjs [--markdown]
// Requires: cargo build --release (binary at native/target/release/).

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeModelOutput } from "../../phoenix-core/src/security.ts";

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.SIMORGH_NATIVE_BENCH_BIN ?? join(here, "../target/release/native-bench");
const markdown = process.argv.includes("--markdown");

// ── Identical inputs on both sides ──
// ASCII units only, so byte length === UTF-16 length === repeat count on both
// implementations. The adversarial unit carries the same smuggling classes the shield
// exists for: a dangerous tag, an event handler, a javascript: URL, a bidi override
// and an astral tag-block character.
const cleanUnit =
  "The quick brown fox jumps over the lazy dog. Use `Connection: keep-alive` and let the CDN cache it. ";
const advUnit =
  "<script>alert(1)</script><img src=x onerror=steal()><a href=\"javascript:alert(1)\">x</a>\u202E\u{E0041} ";
const sizes = [1024, 4096, 16384, 32000, 131072];
const inputs = [];
for (const size of sizes) {
  for (const adv of [false, true]) {
    const unit = adv ? advUnit : cleanUnit;
    inputs.push({ size, adv, text: unit.repeat(Math.max(1, Math.floor(size / unit.length))) });
  }
}

// ── Write the shared batch file (length-prefixed UTF-8) ──
const dir = mkdtempSync(join(tmpdir(), "simorgh-shield-bench-"));
const batchPath = join(dir, "batch.bin");
const chunks = [];
for (const input of inputs) {
  const bytes = Buffer.from(input.text, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  chunks.push(len, bytes);
}
writeFileSync(batchPath, Buffer.concat(chunks));

// ── Rust side ──
const rustJson = execFileSync(binary, ["--batch", batchPath], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const rust = JSON.parse(rustJson.trim());

// ── TypeScript side: same block-amortised method as native-bench ──
function measureTs(fn) {
  let k = 1;
  for (;;) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < k; i++) fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= 0.5 || k >= 1_000_000) break;
    k *= 2;
  }
  const samples = [];
  for (let p = 0; p < 3; p++) {
    for (let b = 0; b < 20; b++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < k; i++) fn();
      samples.push(Number(process.hrtime.bigint() - t0) / 1e3 / k);
    }
  }
  samples.sort((a, b) => a - b);
  return {
    median_us: samples[samples.length >> 1],
    p95_us: samples[Math.floor(samples.length * 0.95)],
  };
}

const tsRows = inputs.map((input) => measureTs(() => sanitizeModelOutput(input.text)));

// ── Comparison ──
const rows = inputs.map((input, i) => ({
  label: `${input.size}B`,
  kind: input.adv ? "adversarial" : "clean",
  ts: tsRows[i],
  rs: { median_us: rust.rows[i].median_us, p95_us: rust.rows[i].p95_us },
}));

if (markdown) {
  console.log("| input | kind | TS median µs | Rust median µs | Rust/TS | TS p95 µs | Rust p95 µs |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const ratio = (r.rs.median_us / r.ts.median_us).toFixed(2);
    console.log(
      `| ${r.label} | ${r.kind} | ${r.ts.median_us.toFixed(3)} | ${r.rs.median_us.toFixed(3)} | ${ratio}x | ${r.ts.p95_us.toFixed(3)} | ${r.rs.p95_us.toFixed(3)} |`
    );
  }
} else {
  console.log(
    `${"input".padStart(10)} ${"kind".padEnd(12)} ${"TS µs".padStart(10)} ${"Rust µs".padStart(10)} ${"Rust/TS".padStart(8)}`
  );
  for (const r of rows) {
    console.log(
      `${r.label.padStart(10)} ${r.kind.padEnd(12)} ${r.ts.median_us.toFixed(3).padStart(10)} ${r.rs.median_us.toFixed(3).padStart(10)} ${(r.rs.median_us / r.ts.median_us).toFixed(2).padStart(8)}x`
    );
  }
}

// Machine-readable line for CI / docs.
console.log(
  `\nJSON: ${JSON.stringify({ baseline_us: rust.baseline_us, rows: rows.map((r) => ({ label: r.label, kind: r.kind, ts_median_us: +r.ts.median_us.toFixed(3), rust_median_us: +r.rs.median_us.toFixed(3), ts_p95_us: +r.ts.p95_us.toFixed(3), rust_p95_us: +r.rs.p95_us.toFixed(3) })) })}`
);