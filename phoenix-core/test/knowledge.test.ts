// Knowledge API validation tests. Pure functions, no runtime, no SQLite: these pin the
// rules that make the C2 routes safe before either host wires them.
import { describe, expect, it } from "vitest";

import {
  MAX_KNOWLEDGE_BODY_CHARS,
  MAX_KNOWLEDGE_TEXT_CHARS,
  knowledgeNamespaceFor,
  parseKnowledgeIndex,
  parseKnowledgeSearch,
  parseKnowledgeTarget,
  publicKnowledgeNamespace,
  toPublicKnowledgeHit,
} from "../src/knowledge.ts";

const GENERATED_ID = "00000000-0000-4000-8000-000000000000";

describe("parseKnowledgeIndex", () => {
  it("accepts a minimal document and uses the generated id", () => {
    const doc = parseKnowledgeIndex(JSON.stringify({ namespace: "notes", text: "hello" }), GENERATED_ID);
    expect(doc).toEqual({
      id: GENERATED_ID,
      namespace: "notes",
      title: undefined,
      text: "hello",
      metadata: undefined,
      timestamp: undefined,
    });
  });

  it("keeps a caller-supplied id", () => {
    const doc = parseKnowledgeIndex(
      JSON.stringify({ id: "doc1", namespace: "notes", text: "hello", title: "T", timestamp: 123 }),
      GENERATED_ID
    );
    expect(doc.id).toBe("doc1");
    expect(doc.title).toBe("T");
    expect(doc.timestamp).toBe(123);
  });

  it("rejects an invalid namespace", () => {
    expect(() => parseKnowledgeIndex(JSON.stringify({ namespace: "bad ns", text: "x" }), GENERATED_ID)).toThrowError(
      /namespace/
    );
  });

  it("rejects empty text", () => {
    expect(() => parseKnowledgeIndex(JSON.stringify({ namespace: "n", text: "   " }), GENERATED_ID)).toThrowError(
      /empty/i
    );
  });

  it("rejects text over the cap", () => {
    const text = "x".repeat(MAX_KNOWLEDGE_TEXT_CHARS + 1);
    expect(() => parseKnowledgeIndex(JSON.stringify({ namespace: "n", text }), GENERATED_ID)).toThrowError(/exceeds/);
  });

  it("rejects a body over the cap with 413 semantics", () => {
    const raw = JSON.stringify({ namespace: "n", text: "x", pad: "y".repeat(MAX_KNOWLEDGE_BODY_CHARS) });
    expect(() => parseKnowledgeIndex(raw, GENERATED_ID)).toThrowError(/exceeds/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseKnowledgeIndex("{", GENERATED_ID)).toThrowError(/JSON/);
  });

  it("keeps only scalar metadata", () => {
    const doc = parseKnowledgeIndex(
      JSON.stringify({
        namespace: "n",
        text: "x",
        metadata: { a: 1, b: "two", c: true, d: null, e: [1, 2], f: { g: 1 } },
      }),
      GENERATED_ID
    );
    expect(doc.metadata).toEqual({ a: 1, b: "two", c: true, d: null });
  });
});

describe("parseKnowledgeSearch", () => {
  it("defaults the limit to 10", () => {
    expect(parseKnowledgeSearch(JSON.stringify({ namespace: "n", text: "x" })).limit).toBe(10);
  });

  it("clamps the limit to 1..100", () => {
    expect(parseKnowledgeSearch(JSON.stringify({ namespace: "n", text: "x", limit: 0 })).limit).toBe(1);
    expect(parseKnowledgeSearch(JSON.stringify({ namespace: "n", text: "x", limit: 5000 })).limit).toBe(100);
  });

  it("rejects an empty query", () => {
    expect(() => parseKnowledgeSearch(JSON.stringify({ namespace: "n", text: " " }))).toThrowError(/empty/i);
  });
});

describe("parseKnowledgeTarget", () => {
  it("accepts a valid id and namespace", () => {
    expect(() => parseKnowledgeTarget("doc1", "notes")).not.toThrow();
  });

  it("rejects an invalid id", () => {
    expect(() => parseKnowledgeTarget("bad id", "notes")).toThrowError(/id/);
  });

  it("rejects an invalid namespace", () => {
    expect(() => parseKnowledgeTarget("doc1", "bad ns")).toThrowError(/namespace/);
  });
});

describe("namespace prefixing", () => {
  it("stores a label under the principal prefix", () => {
    expect(knowledgeNamespaceFor("user-a", "notes")).toBe("user-a::notes");
  });

  it("returns the caller-facing label from a hit", () => {
    const hit = toPublicKnowledgeHit("user-a", {
      documentId: "d1",
      namespace: "user-a::notes",
      text: "x",
      score: 1,
      source: "fts5",
    });
    expect(hit.namespace).toBe("notes");
    expect(publicKnowledgeNamespace("user-a", "user-a::notes")).toBe("notes");
  });

  it("leaves a foreign namespace unchanged, so a bug is visible rather than silently rewritten", () => {
    expect(publicKnowledgeNamespace("user-a", "user-b::notes")).toBe("user-b::notes");
  });
});