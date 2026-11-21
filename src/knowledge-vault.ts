import { DurableObject } from "cloudflare:workers";
import {
  createFts5Retrieval,
  ensureRetrievalSchema,
  type RetrievalDocument,
  type RetrievalHit,
  type RetrievalQuery,
} from "@simorgh/phoenix-core";

// ── KnowledgeVault Durable Object ─────────────────────────────────────────────
//
// One SQLite-backed store for indexed documents, separate from DataTrustVault because
// the two have different lifecycles: the ledger is append-only and permanent, while
// knowledge is indexed, searched and deleted. Both classes are thin RPC surfaces over a
// phoenix-core port — the schema and the SQL live in `retrieval.ts`, once.
//
// The class exists because Durable Object RPC needs a named class with methods; the
// storage is `this.ctx.storage.sql`, which satisfies `SqlPort` structurally.

export class KnowledgeVault extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    // Must block, not `waitUntil`: a request arriving before the FTS5 table lands would
    // fail with "no such table: retrieval_docs".
    this.ctx.blockConcurrencyWhile(async () => {
      ensureRetrievalSchema(this.ctx.storage.sql);
    });
  }

  /**
   * A retrieval adapter bound to this object's storage.
   *
   * A getter rather than a field: `createFts5Retrieval` closes over the `SqlPort` and
   * holds no state, and a field would have to survive hibernation, which it cannot.
   */
  private get retrieval() {
    return createFts5Retrieval(this.ctx.storage.sql);
  }

  async indexDocument(document: RetrievalDocument): Promise<{ indexed: true }> {
    await this.retrieval.index(document);
    return { indexed: true };
  }

  async searchDocuments(query: RetrievalQuery): Promise<RetrievalHit[]> {
    return this.retrieval.search(query);
  }

  async getDocument(namespace: string, documentId: string): Promise<RetrievalHit | null> {
    return this.retrieval.get(namespace, documentId);
  }

  async deleteDocument(namespace: string, documentId: string): Promise<{ deleted: true }> {
    await this.retrieval.delete(namespace, documentId);
    return { deleted: true };
  }
}