// C2 route-level tests: the four knowledge routes over the real KnowledgeVault DO.
//
// The unit suites pin the parsers (`phoenix-core/test/knowledge.test.ts`) and the FTS5
// adapter (`phoenix-core/test/retrieval.test.ts`). What they cannot pin is the seam this
// file exists for: the *routes* — auth, principal-scoped namespaces, the delete
// semantics, and the provenance envelope a real caller receives over HTTP.
//
// Bindings are real: the KnowledgeVault Durable Object really stores into DO SQLite and
// searches through FTS5. Only the flock is absent, because no route here touches it.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";

const ALICE = "c2-token-alice";
const BOB = "c2-token-bob";
const SERVICE = "c2-service-token";

function testEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    AI: env.AI,
    CONTEXT_STORE: env.CONTEXT_STORE,
    DATA_TRUST_VAULT: env.DATA_TRUST_VAULT,
    KNOWLEDGE_VAULT: env.KNOWLEDGE_VAULT,
    FLOCK_COORDINATOR: env.FLOCK_COORDINATOR,
    ENVIRONMENT: env.ENVIRONMENT,
    SIMORGH_API_KEY: SERVICE,
    SIMORGH_API_KEYS: JSON.stringify({ [ALICE]: "alice", [BOB]: "bob" }),
    ...overrides,
  } as unknown as Env;
}

const auth = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  ...extra,
});

const post = (path: string, body: unknown, token: string, e: Env) =>
  app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json", ...auth(token) }, body: JSON.stringify(body) },
    e
  );

const get = (path: string, token: string, e: Env) =>
  app.request(path, { headers: auth(token) }, e);

const del = (path: string, token: string, e: Env) =>
  app.request(path, { method: "DELETE", headers: auth(token) }, e);

describe("knowledge routes (C2)", () => {
  it("indexes, returns, searches and deletes a document with the provenance envelope", async () => {
    const e = testEnv();
    const indexed = await post(
      "/api/v1/knowledge",
      {
        namespace: "notes",
        title: "Falcon",
        text: "the peregrine falcon is the fastest bird",
        metadata: { source: "manual", year: 2026 },
      },
      ALICE,
      e
    );
    expect(indexed.status).toBe(201);
    const { documentId } = (await indexed.json()) as { documentId: string };
    expect(documentId).toBeTruthy();

    const fetched = await get(`/api/v1/knowledge/${documentId}?namespace=notes`, ALICE, e);
    expect(fetched.status).toBe(200);
    const hit = (await fetched.json()) as Record<string, unknown>;
    expect(hit.documentId).toBe(documentId);
    // The namespace the caller sent is the namespace they see — never the stored
    // `<subject>::<label>` prefix.
    expect(hit.namespace).toBe("notes");
    expect(hit.title).toBe("Falcon");
    expect(hit.text).toBe("the peregrine falcon is the fastest bird");
    expect(hit.source).toBe("fts5");
    expect(typeof hit.score).toBe("number");
    expect(hit.metadata).toEqual({ source: "manual", year: 2026 });

    const searched = await post(
      "/api/v1/knowledge/search",
      { namespace: "notes", text: "peregrine" },
      ALICE,
      e
    );
    expect(searched.status).toBe(200);
    const results = (await searched.json()) as { results: Array<Record<string, unknown>> };
    expect(results.results).toHaveLength(1);
    expect(results.results[0].documentId).toBe(documentId);

    const removed = await del(`/api/v1/knowledge/${documentId}?namespace=notes`, ALICE, e);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });

    // Deleted material stops appearing: the get is a 404 and the search is empty.
    const afterGet = await get(`/api/v1/knowledge/${documentId}?namespace=notes`, ALICE, e);
    expect(afterGet.status).toBe(404);
    const afterSearch = await post(
      "/api/v1/knowledge/search",
      { namespace: "notes", text: "peregrine" },
      ALICE,
      e
    );
    expect(((await afterSearch.json()) as { results: unknown[] }).results).toHaveLength(0);
  });

  it("isolates principals: bob cannot fetch, search or delete alice's knowledge", async () => {
    const e = testEnv();
    const indexed = await post(
      "/api/v1/knowledge",
      { namespace: "shared-label", text: "alice private falcon notes" },
      ALICE,
      e
    );
    const { documentId } = (await indexed.json()) as { documentId: string };

    // Same label, different principal: the stored namespace is `bob::shared-label`,
    // so alice's document is not there.
    const bobGet = await get(`/api/v1/knowledge/${documentId}?namespace=shared-label`, BOB, e);
    expect(bobGet.status).toBe(404);

    const bobSearch = await post(
      "/api/v1/knowledge/search",
      { namespace: "shared-label", text: "falcon" },
      BOB,
      e
    );
    expect(((await bobSearch.json()) as { results: unknown[] }).results).toHaveLength(0);

    const bobDelete = await del(`/api/v1/knowledge/${documentId}?namespace=shared-label`, BOB, e);
    expect(bobDelete.status).toBe(404);

    // Alice's document is untouched by bob's attempts.
    const aliceGet = await get(`/api/v1/knowledge/${documentId}?namespace=shared-label`, ALICE, e);
    expect(aliceGet.status).toBe(200);
  });

  it("refuses unauthenticated and unattributable callers", async () => {
    const e = testEnv();

    const noToken = await app.request("/api/v1/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "notes", text: "x" }),
    }, e);
    expect(noToken.status).toBe(401);

    // The service token is a valid credential but carries no identity.
    const serviceToken = await post(
      "/api/v1/knowledge",
      { namespace: "notes", text: "x" },
      SERVICE,
      e
    );
    expect(serviceToken.status).toBe(503);
    expect(((await serviceToken.json()) as { error: { code: string } }).error.code).toBe(
      "IDENTITY_UNRESOLVED"
    );

    // A deployment with no auth configured at all answers 503, like every other route.
    const unconfigured = testEnv({ SIMORGH_API_KEY: undefined, SIMORGH_API_KEYS: undefined });
    const noConfig = await post(
      "/api/v1/knowledge",
      { namespace: "notes", text: "x" },
      ALICE,
      unconfigured
    );
    expect(noConfig.status).toBe(503);
    expect(((await noConfig.json()) as { error: { code: string } }).error.code).toBe(
      "AUTH_NOT_CONFIGURED"
    );
  });

  it("validates namespace, text and id with honest errors", async () => {
    const e = testEnv();

    const badNs = await post("/api/v1/knowledge", { namespace: "bad ns!", text: "x" }, ALICE, e);
    expect(badNs.status).toBe(400);
    expect(((await badNs.json()) as { error: { code: string } }).error.code).toBe("INVALID_NAMESPACE");

    const emptyText = await post("/api/v1/knowledge", { namespace: "notes", text: "   " }, ALICE, e);
    expect(emptyText.status).toBe(400);
    expect(((await emptyText.json()) as { error: { code: string } }).error.code).toBe("EMPTY_TEXT");

    const tooBig = await post(
      "/api/v1/knowledge",
      { namespace: "notes", text: "x".repeat(50_001) },
      ALICE,
      e
    );
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: { code: string } }).error.code).toBe("text_too_large");

    const badId = await get("/api/v1/knowledge/not!a!valid!id?namespace=notes", ALICE, e);
    expect(badId.status).toBe(400);
    expect(((await badId.json()) as { error: { code: string } }).error.code).toBe("INVALID_ID");
  });

  it("404s a get and delete for a document that was never indexed", async () => {
    const e = testEnv();
    const missing = await get("/api/v1/knowledge/nope?namespace=notes", ALICE, e);
    expect(missing.status).toBe(404);
    const missingDelete = await del("/api/v1/knowledge/nope?namespace=notes", ALICE, e);
    expect(missingDelete.status).toBe(404);
  });
});