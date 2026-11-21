#!/usr/bin/env node
// Differential test: the Rust output shield vs the TypeScript reference.
//
// This is the "negative control" the repo's verification discipline requires for any
// detector (AGENTS.md): a port that agrees with its own fixture is not evidence. Here
// the reference is the REAL `sanitizeModelOutput` from `phoenix-core/src/security.ts`,
// imported live — not a copy, not a re-implementation. If the two ever disagree, this
// script exits 1 and prints the fixture.
//
// Usage: node native/test/differential.mjs
// Requires: a built release binary (cargo build --release) on PATH or at
//           native/simorgh-native/target/release/simorgh-native.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeModelOutput } from "../../phoenix-core/src/security.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(here, "fixtures.json");
// JSON has no \u{...} escape (that is JavaScript syntax), so expand ES6 code-point
// escapes to literal characters before parsing. Keeps astral-plane smuggling fixtures
// readable in the file instead of as surrogate-pair soup.
const fixtures = JSON.parse(
  (await import("node:fs").then((m) => m.readFileSync(fixturesPath, "utf8"))).replace(
    /\\u\{([0-9A-Fa-f]+)\}/g,
    (_, h) => String.fromCodePoint(parseInt(h, 16))
  )
).fixtures;

// Locate the built binary. The differential test grades artifacts, not exit codes.
const binary =
  process.env.SIMORGH_NATIVE_BIN ??
  join(
    here,
    "../target/release/simorgh-native"
  );

// ── Generate adversarial inputs with a seeded RNG so failures are reproducible ──
// xorshift32: deterministic across Node versions, no dependency.
let seed = 0x51a7c0de;
function rnd() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0xffffffff;
}
const generators = [
  () => "<script>alert(1)</script>",
  () => `<img src=x onerror="${"a".repeat(1 + Math.floor(rnd() * 20))}">`,
  () => `<a href="javascript:${"j".repeat(1 + Math.floor(rnd() * 10))}">x</a>`,
  () => `<a href="data:text/html,${"h".repeat(1 + Math.floor(rnd() * 10))}">x</a>`,
  () => `<iframe src="${"i".repeat(1 + Math.floor(rnd() * 10))}">`,
  () => `<a href="java${rnd() < 0.5 ? "\t" : ""}script:alert(1)">x</a>`,
  () => "<b>bold</b> and <i>italic</i>",
  () => "plain prose with on=click and action=on_delete=CASCADE",
  () => `persian: نامه‌ها ${"x".repeat(Math.floor(rnd() * 30))}`,
  () => "<x-custom:danger onclick=\"y\">z</x-custom:danger>",
  () => "<a href=\"  javascript:alert(1)\">spaces</a>",
  () => "<a href=\"blocked:javascript:alert(1)\">already blocked</a>",
];
const generated = [];
for (let i = 0; i < 300; i++) {
  const parts = [];
  const n = 1 + Math.floor(rnd() * 6);
  for (let j = 0; j < n; j++) parts.push(generators[Math.floor(rnd() * generators.length)]());
  generated.push(parts.join(" "));
}
const all = [...fixtures, ...generated];

// ── Run the Rust binary over all inputs in one batch ──
const dir = mkdtempSync(join(tmpdir(), "simorgh-native-diff-"));
const batchPath = join(dir, "batch.bin");
const outPath = join(dir, "out.jsonl");

// Batch format: repeated [u32 LE length][UTF-8 bytes].
const chunks = [];
for (const input of all) {
  const bytes = Buffer.from(input, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  chunks.push(len, bytes);
}
writeFileSync(batchPath, Buffer.concat(chunks));

// The CLI writes JSON Lines to stdout; capture it.
const rustOut = execFileSync(binary, ["sanitize", "--batch", batchPath], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const rustLines = rustOut.trim().split("\n").map((l) => JSON.parse(l));
if (rustLines.length !== all.length) {
  console.error(`FATAL: rust returned ${rustLines.length} lines for ${all.length} inputs`);
  process.exit(1);
}

// ── Compare ──
let mismatches = 0;
for (let i = 0; i < all.length; i++) {
  const ts = sanitizeModelOutput(all[i]);
  const rs = rustLines[i];
  const tsFindings = ts.findings ?? [];
  const rsFindings = rs.findings ?? [];
  const textOk = ts.text === rs.text;
  const findingsOk =
    tsFindings.length === rsFindings.length &&
    tsFindings.every((f, k) => f === rsFindings[k]);
  if (!textOk || !findingsOk) {
    mismatches++;
    console.error(`MISMATCH #${i}:`);
    console.error(`  input:    ${JSON.stringify(all[i]).slice(0, 300)}`);
    if (!textOk) {
      console.error(`  ts.text:  ${JSON.stringify(ts.text).slice(0, 300)}`);
      console.error(`  rs.text:  ${JSON.stringify(rs.text).slice(0, 300)}`);
    }
    if (!findingsOk) {
      console.error(`  ts.findings: ${JSON.stringify(tsFindings)}`);
      console.error(`  rs.findings: ${JSON.stringify(rsFindings)}`);
    }
  }
}

// ── Negative control: the comparator must catch a planted difference ──
// Sabotage one result and assert this script would report it. If this check does not
// fail, the comparison above proves nothing.
let negativeFired = false;
try {
  const victim = rustLines[0];
  const sabotaged = {
    text: victim.text + "x",
    findings: [...victim.findings],
  };
  const ts0 = sanitizeModelOutput(all[0]);
  const textOk = ts0.text === sabotaged.text;
  const findingsOk =
    (ts0.findings ?? []).length === sabotaged.findings.length &&
    (ts0.findings ?? []).every((f, k) => f === sabotaged.findings[k]);
  if (textOk && findingsOk) {
    // Sabotage not caught — the comparator is blind; fail loudly.
    console.error("NEGATIVE CONTROL DID NOT FIRE: a planted text change was not detected");
    process.exit(1);
  }
  negativeFired = true;
} catch (err) {
  console.error("negative control threw:", err);
  process.exit(1);
}

if (mismatches > 0) {
  console.error(`\n${mismatches}/${all.length} mismatches — the port diverges from the reference.`);
  process.exit(1);
}
console.log(
  `OK: ${all.length} inputs (${fixtures.length} fixtures + ${generated.length} generated), ` +
    `rust === typescript byte-identical (text + findings order); negative control ${negativeFired ? "FIRED" : "DID NOT FIRE"}`
);