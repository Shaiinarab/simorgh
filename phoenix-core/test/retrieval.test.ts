// Retrieval tests. No network, no Durable Object, no runtime bindings: the adapter is
// pure over `SqlPort`, and the statements run against real SQLite through the Node
// `SqlPort` — the same dialect the Worker runs against Durable Object storage.
//
// The point these pin is EPIC-C1's first slice: a retrieval contract that works on
// both hosts with **zero dependencies**, because FTS5 is in both SQLite builds.
import { beforeEach, describe, expect, it } from "vitest";

import {
  RETRIEVAL_SCHEMA,
  createFts5Retrieval,
  mergeRetrievalHits,
  normalizeFtsQuery,
} from "../src/retrieval.ts";
import { openMemorySql } from "../src/node/index.ts";
import type { RetrievalHit, SqlPort } from "../src/ports.ts";

const NOW = 1_700_000_000_000;

function fresh(): { sql: SqlPort; retrieval: ReturnType<typeof createFts5Retrieval> } {
  const { sql } = openMemorySql();
  return { sql, retrieval: createFts5Retrieval(sql, () => NOW) };
}

function hit(partial: Partial<RetrievalHit> & Pick<RetrievalHit, "documentId">): RetrievalHit {
  return {
    namespace: "ns",
    text: "body",
    score: 0,
    source: "test",
    ...partial,
  };
}

describe("FTS5 retrieval adapter", () => {
  let retrieval: ReturnType<typeof createFts5Retrieval>;

  beforeEach(() => {
    retrieval = fresh().retrieval;
  });

  it("creates its schema idempotently", () => {
    expect(RETRIEVAL_SCHEMA).toContain("USING fts5");
    // A second construction against the same database must not throw.
    const { sql } = openMemorySql();
    expect(() => {
      createFts5Retrieval(sql);
      createFts5Retrieval(sql);
    }).not.toThrow();
  });

  it("indexes a document and returns it with provenance", async () => {
    await retrieval.index({
      id: "d1",
      namespace: "ns1",
      title: "Falcon",
      text: "the peregrine falcon is the fastest bird",
      timestamp: 123,
    });

    const hits = await retrieval.search({ namespace: "ns1", text: "falcon" });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      documentId: "d1",
      namespace: "ns1",
      title: "Falcon",
      text: "the peregrine falcon is the fastest bird",
      source: "fts5",
      timestamp: 123,
    });
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("gets a document by id within its namespace", async () => {
    await retrieval.index({ id: "d1", namespace: "ns1", title: "Falcon", text: "falcon" });

    await expect(retrieval.get("ns1", "d1")).resolves.toMatchObject({
      documentId: "d1",
      namespace: "ns1",
      title: "Falcon",
      source: "fts5",
    });
    await expect(retrieval.get("ns1", "missing")).resolves.toBeNull();
    await expect(retrieval.get("ns2", "d1")).resolves.toBeNull();
  });

  it("isolates namespaces", async () => {
    await retrieval.index({ id: "d1", namespace: "ns1", text: "falcon birds" });
    await retrieval.index({ id: "d2", namespace: "ns2", text: "falcon birds" });

    const hits = await retrieval.search({ namespace: "ns1", text: "falcon" });

    expect(hits.map((h) => h.documentId)).toEqual(["d1"]);
  });

  it("returns [] for a query with no searchable tokens", async () => {
    await retrieval.index({ id: "d1", namespace: "ns1", text: "falcon" });

    expect(await retrieval.search({ namespace: "ns1", text: "   " })).toEqual([]);
    expect(await retrieval.search({ namespace: "ns1", text: "AND OR NOT" })).toEqual([]);
  });

  it("treats FTS5 operators as literal text, not syntax", async () => {
    await retrieval.index({ id: "d1", namespace: "ns1", text: "falcon" });
    await retrieval.index({ id: "d2", namespace: "ns1", text: "and" });

    // `"AND"` is a quoted token here, so it searches for the word "and" rather than
    // acting as the boolean operator.
    const hits = await retrieval.search({ namespace: "ns1", text: "AND" });
    expect(hits.map((h) => h.documentId)).toEqual(["d2"]);
  });

  it("orders by relevance, best first", async () => {
    // Equal term frequency; BM25's length normalization favors the shorter document.
    await retrieval.index({
      id: "long",
      namespace: "ns1",
      text: "quick brown fox jumps over the lazy dog",
    });
    await retrieval.index({ id: "short", namespace: "ns1", text: "quick" });

    const hits = await retrieval.search({ namespace: "ns1", text: "quick" });

    expect(hits.length).toBe(2);
    expect(hits[0].documentId).toBe("short");
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  it("caps the limit and never returns more than asked", async () => {
    for (let i = 0; i < 5; i += 1) {
      await retrieval.index({ id: `d${i}`, namespace: "ns1", text: "falcon" });
    }

    expect(await retrieval.search({ namespace: "ns1", text: "falcon", limit: 2 })).toHaveLength(2);
  });

  it("deletes one document without touching its namespace", async () => {
    await retrieval.index({ id: "d1", namespace: "ns1", text: "falcon" });
    await retrieval.index({ id: "d2", namespace: "ns1", text: "falcon" });

    await retrieval.delete("ns1", "d1");

    expect((await retrieval.search({ namespace: "ns1", text: "falcon" })).map((h) => h.documentId)).toEqual([
      "d2",
    ]);
  });

  it("round-trips metadata as JSON", async () => {
    await retrieval.index({
      id: "d1",
      namespace: "ns1",
      text: "falcon",
      metadata: { source: "han", year: 2026, verified: true, note: null },
    });

    const [result] = await retrieval.search({ namespace: "ns1", text: "falcon" });

    expect(result.metadata).toEqual({ source: "han", year: 2026, verified: true, note: null });
  });

  it("falls back to the injected clock when the document has no timestamp", async () => {
    await retrieval.index({ id: "d1", namespace: "ns1", text: "falcon" });

    const [result] = await retrieval.search({ namespace: "ns1", text: "falcon" });

    expect(result.timestamp).toBe(NOW);
  });
});

describe("normalizeFtsQuery", () => {
  it("quotes tokens and joins them with OR", () => {
    expect(normalizeFtsQuery("falcon bird")).toBe('"falcon" OR "bird"');
  });

  it("strips FTS5 syntax characters", () => {
    expect(normalizeFtsQuery("foo* bar:1 -baz ^qux")).toBe('"foo" OR "bar" OR "1" OR "baz" OR "qux"');
  });

  it("keeps non-ASCII tokens intact", () => {
    expect(normalizeFtsQuery("سلام دنیا")).toBe('"سلام" OR "دنیا"');
  });

  it("returns an empty string when there is nothing to search", () => {
    expect(normalizeFtsQuery("   ")).toBe("");
    expect(normalizeFtsQuery("*** ::: ---")).toBe("");
  });
});

describe("mergeRetrievalHits", () => {
  it("keeps the best-scoring occurrence of a duplicate document", () => {
    const merged = mergeRetrievalHits([
      hit({ documentId: "a", score: 0.2 }),
      hit({ documentId: "a", score: 0.9 }),
      hit({ documentId: "b", score: 0.5 }),
    ]);

    expect(merged.map((h) => [h.documentId, h.score])).toEqual([
      ["a", 0.9],
      ["b", 0.5],
    ]);
  });

  it("breaks score ties by timestamp, newest first", () => {
    const merged = mergeRetrievalHits([
      hit({ documentId: "old", score: 0.5, timestamp: 1 }),
      hit({ documentId: "new", score: 0.5, timestamp: 2 }),
    ]);

    expect(merged.map((h) => h.documentId)).toEqual(["new", "old"]);
  });

  it("applies the limit after merging", () => {
    const merged = mergeRetrievalHits(
      [hit({ documentId: "a", score: 0.9 }), hit({ documentId: "b", score: 0.5 })],
      1
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].documentId).toBe("a");
  });
});
describe("chunked retrieval", () => {
  let retrieval: ReturnType<typeof createFts5Retrieval>;

  beforeEach(() => {
    retrieval = fresh().retrieval;
  });

  it("splits a long document and returns passage-level hits with chunkId", async () => {
    // The needle sits past the first chunk boundary, so a hit must carry the chunk it
    // came from — the passage, not the whole document.
    const filler = "falcon ".repeat(200);
    const text = filler + "the peregrine falcon is the fastest bird" + filler;
    await retrieval.index({ id: "long", namespace: "ns", text, title: "Birds" });

    const hits = await retrieval.search({ namespace: "ns", text: "peregrine" });
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    expect(hit.documentId).toBe("long");
    expect(hit.chunkId).toBeGreaterThan(0);
    expect(hit.text).toContain("peregrine");
    // A search hit is the passage, not the document: it is far shorter than the input.
    expect(hit.text.length).toBeLessThan(text.length);
  });

  it("get reassembles the whole document from its chunks", async () => {
    const filler = "falcon ".repeat(200);
    const text = filler + "the peregrine falcon is the fastest bird" + filler;
    await retrieval.index({ id: "long", namespace: "ns", text });

    const doc = await retrieval.get("ns", "long");
    expect(doc).not.toBeNull();
    expect(doc!.text).toBe(text);
    // A whole-document get has no passage coordinate.
    expect(doc!.chunkId).toBeUndefined();
  });

  it("re-indexing replaces the document's chunks instead of appending", async () => {
    await retrieval.index({ id: "doc", namespace: "ns", text: "the old falcon text" });
    await retrieval.index({ id: "doc", namespace: "ns", text: "the new eagle text" });

    const old = await retrieval.search({ namespace: "ns", text: "falcon" });
    expect(old).toHaveLength(0);
    const fresh = await retrieval.search({ namespace: "ns", text: "eagle" });
    expect(fresh.map((h) => h.text)).toEqual(["the new eagle text"]);
    const doc = await retrieval.get("ns", "doc");
    expect(doc!.text).toBe("the new eagle text");
  });

  it("delete removes every chunk of the document", async () => {
    const filler = "falcon ".repeat(200);
    const text = filler + "needle" + filler;
    await retrieval.index({ id: "doc", namespace: "ns", text });

    await retrieval.delete("ns", "doc");
    expect(await retrieval.get("ns", "doc")).toBeNull();
    expect(await retrieval.search({ namespace: "ns", text: "needle" })).toHaveLength(0);
  });
});
