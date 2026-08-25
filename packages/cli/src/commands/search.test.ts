import { describe, expect, test } from "bun:test";
import { __searchTestUtils } from "./search";

const {
  COLLECTIONS,
  resolveRequestedCollections,
  buildSearchRequest,
  buildSearchBatches,
  unwrapSearchBatchResults,
  assertCompleteSearchResponses,
  formatSearchVectorQuery,
  CollectionSelectionError,
} = __searchTestUtils;

describe("search collection selection", () => {
  test("supports docs_chunks_v2 as an explicit collection", () => {
    const selected = resolveRequestedCollections("docs_chunks_v2");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.name).toBe("docs_chunks_v2");
  });

  test("supports prefix selection for collection names", () => {
    const selected = resolveRequestedCollections("docs_chunks");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.name).toBe("docs_chunks_v2");
  });

  test("throws deterministic error for unsupported collection", () => {
    try {
      resolveRequestedCollections("not_a_collection");
      throw new Error("expected selection to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionSelectionError);
      expect((error as Error).message).toContain("Unsupported collection");
      expect((error as Error).message).toContain("Allowed:");
    }
  });
});

describe("search endpoint routing", () => {
  test("routes book collections to the docs node", () => {
    const selected = resolveRequestedCollections("docs");
    const batches = buildSearchBatches(selected, {
      main: "http://main:8108",
      docs: "http://books:8110",
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.url).toBe("http://books:8110");
    expect(batches[0]?.collections.map((collection) => collection.name)).toEqual([
      "docs",
      "docs_chunks_v2",
    ]);
  });

  test("splits unified search across main and docs nodes", () => {
    const batches = buildSearchBatches(COLLECTIONS, {
      main: "http://main:8108",
      docs: "http://books:8110",
    });

    expect(batches).toHaveLength(2);
    expect(
      batches
        .find((batch) => batch.url === "http://books:8110")
        ?.collections.map((collection) => collection.name),
    ).toEqual(["docs", "docs_chunks_v2"]);
    expect(batches.find((batch) => batch.url === "http://main:8108")?.collections).toHaveLength(
      COLLECTIONS.length - 2,
    );
  });

  test("keeps one request when both collection groups share an endpoint", () => {
    const batches = buildSearchBatches(COLLECTIONS, {
      main: "http://same:8108",
      docs: "http://same:8108",
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.collections).toHaveLength(COLLECTIONS.length);
  });
});

describe("search node failures", () => {
  test("fails unified search when any node fails", () => {
    expect(() =>
      unwrapSearchBatchResults([
        { status: "fulfilled", value: { results: [] } },
        { status: "rejected", reason: new Error("book node unavailable") },
      ]),
    ).toThrow("book node unavailable");
  });

  test("returns every node response when all nodes succeed", () => {
    expect(
      unwrapSearchBatchResults([
        { status: "fulfilled", value: { node: "main" } },
        { status: "fulfilled", value: { node: "books" } },
      ]),
    ).toEqual([{ node: "main" }, { node: "books" }]);
  });

  test("fails when Typesense reports a per-collection error", () => {
    expect(() =>
      assertCompleteSearchResponses([
        { results: [{ found: 1 }, { code: 404, error: "collection not found" }] },
      ]),
    ).toThrow("Typesense search result failed (404): collection not found");
  });

  test("accepts complete per-collection responses", () => {
    expect(assertCompleteSearchResponses([{ results: [{ found: 1 }, { found: 2 }] }])).toEqual([
      { results: [{ found: 1 }, { found: 2 }] },
    ]);
  });
});

describe("search request building", () => {
  test("docs_chunks_v2 stays keyword-only without a configured query vector field", () => {
    const docsCollection = COLLECTIONS.find((collection) => collection.name === "docs_chunks_v2");
    expect(docsCollection).toBeDefined();

    const request = buildSearchRequest(docsCollection!, "callback", {
      perPage: 5,
      semantic: true,
    });

    expect(request.query_by).toBe(docsCollection!.queryBy);
    expect(request.vector_query).toBeUndefined();
  });

  test("generic search does not invent a vector field for curated collections", () => {
    const vaultCollection = COLLECTIONS.find((collection) => collection.name === "vault_notes");
    expect(vaultCollection).toBeDefined();

    const request = buildSearchRequest(vaultCollection!, "redis dedupe", {
      perPage: 5,
      semantic: true,
      queryEmbedding: [0.1, -0.2, Number.NaN],
    });

    expect(request.query_by).toBe(vaultCollection!.queryBy);
    expect(request.query_by).not.toContain("embedding");
    expect(request.vector_query).toBeUndefined();
  });

  test("semantic search falls back to keyword-only without a query vector", () => {
    const vaultCollection = COLLECTIONS.find((collection) => collection.name === "vault_notes");
    expect(vaultCollection).toBeDefined();

    const request = buildSearchRequest(vaultCollection!, "redis dedupe", {
      perPage: 5,
      semantic: true,
    });

    expect(request.query_by).toBe(vaultCollection!.queryBy);
    expect(request.vector_query).toBeUndefined();
  });

  test("omits retired memory and system-log collections", () => {
    expect(COLLECTIONS.map((collection) => collection.name)).not.toContain(
      "memory_observations",
    );
    expect(COLLECTIONS.map((collection) => collection.name)).not.toContain("system_log");
  });

  test("formats finite search vectors and zeroes invalid values", () => {
    expect(formatSearchVectorQuery("embedding", [0.1, -0.2, Number.NaN], 7)).toBe(
      "embedding:([0.1,-0.2,0], k:7, alpha:0.7)",
    );
  });
});
