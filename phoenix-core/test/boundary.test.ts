// ── The boundary guard ────────────────────────────────────────────────────────
//
// The claim "phoenix-core is runtime-agnostic" is only worth anything if something
// fails when it stops being true. This is that something.
//
// A single stray `import { DurableObject } from "cloudflare:workers"` in a core
// module would happily bundle, typecheck, and pass every behavioural test in this
// package — because the tests run on Node, where the import would only fail at
// runtime. Worse, it would fail *there* and not in the suite that gates the change.
//
// So the rule is asserted at the source level, where it is cheap and unambiguous:
//
//   * no `cloudflare:` import anywhere in `src/`
//   * no `node:` import outside `src/node/` (the one deliberate host adapter)
//   * no bare runtime globals — those are the port-versus-global distinction
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(PACKAGE_ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const sources = walk(SRC);
const rel = (file: string) => relative(SRC, file);

/**
 * Strip comments before scanning for globals.
 *
 * Without this the guard matches the *documentation*: ports.ts explains that
 * `SqlPort` is narrower than Cloudflare's `SqlStorage`, and a naive scan reads that
 * sentence as a dependency. Checking prose for code is exactly the false positive
 * that gets a guard deleted instead of fixed.
 *
 * ponytail: `//` is only treated as a comment start when it is not preceded by `:`,
 * which is what keeps `https://` inside a string literal intact. A pathological
 * string containing an unescaped `//` would still be over-stripped; that would hide a
 * violation, never invent one, and the import checks below do not rely on this.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Files that are allowed to name a `node:` module. */
const isNodeAdapter = (file: string) => rel(file).startsWith("node/");

describe("phoenix-core runtime boundary", () => {
  it("has sources to check", () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it("imports no Cloudflare runtime module", () => {
    const offenders = sources.filter((file) =>
      /from\s+["']cloudflare:/.test(readFileSync(file, "utf8"))
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("confines `node:` imports to the deliberate host adapter", () => {
    const offenders = sources.filter(
      (file) => !isNodeAdapter(file) && /from\s+["']node:/.test(readFileSync(file, "utf8"))
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("does not reach for runtime globals instead of its ports", () => {
    // Each of these would compile under a DOM or Workers type library and then be
    // missing on some other runtime — the exact failure mode the ports exist to
    // prevent. `TextEncoder` is the one that actually bit us: the original
    // constant-time comparison used it to feed `crypto.subtle`.
    const forbidden: { label: string; pattern: RegExp }[] = [
      { label: "TextEncoder", pattern: /\bnew\s+TextEncoder\b/ },
      { label: "TextDecoder", pattern: /\bnew\s+TextDecoder\b/ },
      { label: "Response", pattern: /\bnew\s+Response\b/ },
      { label: "Request", pattern: /\bnew\s+Request\b/ },
      { label: "crypto global", pattern: /(?<![.\w])crypto\s*\./ },
      { label: "DurableObject", pattern: /\bDurableObject\b/ },
      { label: "SqlStorage", pattern: /\bSqlStorage\b/ },
    ];

    const hits: string[] = [];
    for (const file of sources) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const { label, pattern } of forbidden) {
        if (pattern.test(code)) hits.push(`${rel(file)}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("declares every port it needs in ports.ts and nowhere else", () => {
    // A port defined in two places is two ports. `SqlPort` in particular must have a
    // single definition, or the Node adapter and the Workers host silently drift.
    const definitions = sources.filter((file) =>
      /export\s+interface\s+(SqlPort|PhoenixPorts|ContextStorePort|LedgerPort|WorkersAiPort)\b/.test(
        stripComments(readFileSync(file, "utf8"))
      )
    );
    expect(definitions.map(rel)).toEqual(["ports.ts"]);
  });
});
