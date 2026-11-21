// ── Retrieval: a zero-dependency FTS5 adapter over SqlPort ────────────────────
//
// Retrieval is the product's biggest gap (EPIC-C1), and the obvious fix is a search
// server or a vector database. Both are wrong here for the same reason `tasks.ts`
// rejected Temporal and `swarm.ts` rejected Mem0: Simorgh has to bundle into a
// Cloudflare Worker with no bindings and run on bare Node. A server is a second
// deployment; a native vector extension (`sqlite-vec`) is unavailable on Durable Object
// SQLite, which documents FTS5, JSON and math functions and nothing else.
//
// What *is* available on both hosts is **SQLite FTS5**:
//
//   * Cloudflare Durable Object SQLite lists FTS5 (including `fts5vocab`) in its
//     official SQL API docs.
//   * Node's built-in `node:sqlite` ships FTS5 — verified on Node 26.11.1 before this
//     module was written, with a `CREATE VIRTUAL TABLE … USING fts5` and a `MATCH`.
//
// So the baseline adapter is a virtual table, a `MATCH` query, and a handful of pure
// functions. No dependency, no service, no new scheduler. Hosts that have a hosted
// index bind their own `RetrievalPort`; the engine only ever sees this contract.
//
// The module is pure over `SqlPort`: no `node:` import, no `cloudflare:` import, no
// runtime global. `boundary.test.ts` stays green because the only thing this file
// touches is the port it was handed.

import type {
  RetrievalDocument,
  RetrievalHit,
  RetrievalPort,
  RetrievalQuery,
  SqlPort,
  SqlRow,
} from "./ports.ts";

/**
 * The FTS5 virtual table.
 *
 * `title` and `text` are indexed; everything else is `UNINDEXED` because it is
 * metadata we filter or return, never search terms. `document_id` is stored rather
 * than used as `rowid` because a caller-chosen id is a string, and a second
 * integer mapping is a second truth to keep in sync.
 */
export const RETRIEVAL_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_docs USING fts5(
  document_id UNINDEXED,
  namespace UNINDEXED,
  chunk_index UNINDEXED,
  title,
  text,
  metadata UNINDEXED,
  created_at UNINDEXED
);
`;

/**
 * Characters per indexed chunk.
 *
 * A document is split into fixed-size passages so a search hit points at the *passage*
 * that matched, not the whole document — the difference between a useful citation and
 * a file dump. 1,200 code points is roughly one screen of text: large enough that a
 * sentence is rarely split, small enough that a hit is a readable excerpt. No overlap:
 * a passage split mid-sentence is a quality tweak to add when retrieval shows boundary
 * misses, not before.
 */
export const RETRIEVAL_CHUNK_CHARS = 1_200;

/** Split text into code-point chunks (never splits a surrogate pair). */
function splitIntoChunks(text: string): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += RETRIEVAL_CHUNK_CHARS) {
    chunks.push(chars.slice(i, i + RETRIEVAL_CHUNK_CHARS).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

/** A row as it comes back from the FTS5 table. */
type RetrievalRow = {
  document_id: string;
  namespace: string;
  chunk_index: number;
  title: string;
  text: string;
  metadata: string;
  created_at: number;
  /** NULL for a plain `get` (no MATCH); a number for a search. */
  rank: number | null;
};

/**
 * A Unicode-aware token: letters, numbers and underscore, in any script.
 *
 * `\p{L}` is what keeps Persian, Arabic and CJK queries intact; an ASCII-only
 * `[a-z0-9]` would silently return nothing for a Persian document, which is the
 * quietest possible failure for this project's audience.
 */
const TOKEN = /[\p{L}\p{N}_]+/gu;

/**
 * Turn free user text into a safe FTS5 `MATCH` expression.
 *
 * Every token is quoted and joined with `OR`. That is deliberate:
 *
 *   * **Injection.** FTS5's query language has operators (`AND`, `OR`, `NOT`, `NEAR`,
 *     `*`, `:`, `^`, `-`). Passing user text straight through lets a query change the
 *     query's meaning, or error the whole search. Quoting every token makes the input
 *     data, never syntax.
 *   * **Recall.** A search box is not a boolean query. `OR` plus `ORDER BY rank`
 *     returns the documents that match any term, best first; `AND` would return an
 *     empty set the moment one term is absent, which reads as "nothing found" rather
 *     than "nothing matched all three words".
 *
 * A query with no tokens returns `""`; callers must treat that as "no search", not as
 * "match everything".
 */
export function normalizeFtsQuery(input: string): string {
  const tokens = input.match(TOKEN);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

/** Parse the metadata column back into an object, or `{}` when it is not one. */
function parseMetadata(value: string): Record<string, string | number | boolean | null> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string | number | boolean | null>;
    }
  } catch {
    // A malformed metadata column is a corrupt row, not a reason to fail the search.
  }
  return {};
}

/**
 * Map one FTS5 row to the port's hit shape.
 *
 * `rank` is NULL for a plain `get` (no MATCH), so it defaults to `0`; a search row
 * always carries the negated BM25 score.
 */
function rowToHit(row: RetrievalRow): RetrievalHit {
  return {
    documentId: row.document_id,
    chunkId: row.chunk_index,
    namespace: row.namespace,
    title: row.title === "" ? undefined : row.title,
    text: row.text,
    score: -(row.rank ?? 0),
    source: "fts5",
    timestamp: row.created_at,
    metadata: parseMetadata(row.metadata),
  };
}

/** Create the FTS5 table if it does not exist. Safe to call on every boot. */
export function ensureRetrievalSchema(sql: SqlPort): void {
  sql.exec(RETRIEVAL_SCHEMA);
}

/**
 * Build a `RetrievalPort` backed by SQLite FTS5.
 *
 * The schema is created on construction (`IF NOT EXISTS`), so a host can call this
 * once at boot and then treat the returned object as the port. `now` is injectable
 * because a hit's timestamp is part of the C2 provenance contract and a test must be
 * able to freeze it.
 */
export function createFts5Retrieval(
  sql: SqlPort,
  now: () => number = Date.now
): RetrievalPort {
  ensureRetrievalSchema(sql);

  return {
    async index(document: RetrievalDocument): Promise<void> {
      const metadata = JSON.stringify(document.metadata ?? {});
      const timestamp = document.timestamp ?? now();
      const chunks = splitIntoChunks(document.text);
      // Replace, not append: re-indexing a document (same namespace + id) must not
      // leave the old chunks behind, or a stale passage keeps answering searches.
      sql.exec(
        `DELETE FROM retrieval_docs WHERE namespace = ? AND document_id = ?`,
        document.namespace,
        document.id
      );
      for (let i = 0; i < chunks.length; i++) {
        sql.exec(
          `INSERT INTO retrieval_docs(document_id, namespace, chunk_index, title, text, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          document.id,
          document.namespace,
          i,
          document.title ?? "",
          chunks[i],
          metadata,
          timestamp
        );
      }
    },

    async search(query: RetrievalQuery): Promise<RetrievalHit[]> {
      const match = normalizeFtsQuery(query.text);
      if (match === "") return [];

      const limit = Math.max(1, Math.min(query.limit ?? 10, 100));
      const rows = sql.exec<RetrievalRow>(
        `SELECT document_id, namespace, chunk_index, title, text, metadata, created_at, rank
           FROM retrieval_docs
          WHERE retrieval_docs MATCH ? AND namespace = ?
          ORDER BY rank
          LIMIT ?`,
        match,
        query.namespace,
        limit
      ).toArray();

      return rows.map(rowToHit);
    },

    async get(namespace: string, documentId: string): Promise<RetrievalHit | null> {
      // The whole document, reassembled from its chunks in order. A get is not a
      // passage: it returns the document the caller asked for, not a fragment of it.
      const rows = sql.exec<RetrievalRow>(
        `SELECT document_id, namespace, chunk_index, title, text, metadata, created_at, rank
           FROM retrieval_docs
          WHERE namespace = ? AND document_id = ?
          ORDER BY chunk_index`,
        namespace,
        documentId
      ).toArray();
      if (rows.length === 0) return null;
      const first = rows[0];
      return {
        documentId: first.document_id,
        namespace: first.namespace,
        title: first.title === "" ? undefined : first.title,
        text: rows.map((row) => row.text).join(""),
        score: 0,
        source: "fts5",
        timestamp: first.created_at,
        metadata: parseMetadata(first.metadata),
      };
    },

    async delete(namespace: string, documentId: string): Promise<void> {
      sql.exec(
        `DELETE FROM retrieval_docs WHERE namespace = ? AND document_id = ?`,
        namespace,
        documentId
      );
    },
  };
}

/**
 * Deduplicate and order hits from one or more adapters.
 *
 * A document can appear in both a lexical and a vector adapter; a caller that merged
 * naively would show it twice. The **best-scoring** occurrence wins, so a vector
 * adapter's higher-confidence hit is not discarded because a lexical adapter returned
 * the same document first. The sort is score-desc then timestamp-desc so a stable merge
 * does not reshuffle equal-scoring rows on every call.
 */
export function mergeRetrievalHits(hits: RetrievalHit[], limit = 10): RetrievalHit[] {
  const byId = new Map<string, RetrievalHit>();

  for (const hit of hits) {
    const existing = byId.get(hit.documentId);
    if (!existing || hit.score > existing.score) byId.set(hit.documentId, hit);
  }

  const merged = [...byId.values()];

  merged.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.timestamp ?? 0) - (a.timestamp ?? 0);
  });

  return merged.slice(0, Math.max(1, limit));
}

/** Re-exported so a host can type an adapter without importing `ports.ts` directly. */
export type { RetrievalDocument, RetrievalHit, RetrievalPort, RetrievalQuery };