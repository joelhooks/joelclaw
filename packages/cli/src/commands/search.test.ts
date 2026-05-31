import { describe, expect, test } from "bun:test"
import { __searchTestUtils } from "./search"

const {
  COLLECTIONS,
  resolveRequestedCollections,
  buildSearchRequest,
  formatSearchVectorQuery,
  CollectionSelectionError,
} = __searchTestUtils

describe("search collection selection", () => {
  test("supports otel_events as an explicit collection", () => {
    const selected = resolveRequestedCollections("otel_events")
    expect(selected).toHaveLength(1)
    expect(selected[0]?.name).toBe("otel_events")
  })

  test("supports prefix selection for collection names", () => {
    const selected = resolveRequestedCollections("otel")
    expect(selected).toHaveLength(1)
    expect(selected[0]?.name).toBe("otel_events")
  })

  test("throws deterministic error for unsupported collection", () => {
    try {
      resolveRequestedCollections("not_a_collection")
      throw new Error("expected selection to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionSelectionError)
      expect((error as Error).message).toContain("Unsupported collection")
      expect((error as Error).message).toContain("Allowed:")
    }
  })
})

describe("search request building", () => {
  test("semantic search is disabled for otel_events", () => {
    const otelCollection = COLLECTIONS.find((collection) => collection.name === "otel_events")
    expect(otelCollection).toBeDefined()

    const request = buildSearchRequest(otelCollection!, "callback", {
      perPage: 5,
      semantic: true,
    })

    expect(request.query_by).toBe(otelCollection!.queryBy)
    expect(request.vector_query).toBeUndefined()
  })

  test("semantic search uses vector_query without adding embedding to query_by", () => {
    const memoryCollection = COLLECTIONS.find((collection) => collection.name === "memory_observations")
    expect(memoryCollection).toBeDefined()

    const request = buildSearchRequest(memoryCollection!, "redis dedupe", {
      perPage: 5,
      semantic: true,
      queryEmbedding: [0.1, -0.2, Number.NaN],
    })

    expect(request.query_by).toBe(memoryCollection!.queryBy)
    expect(request.query_by).not.toContain("embedding")
    expect(request.vector_query).toBe("embedding:([0.1,-0.2,0], k:10, alpha:0.7)")
  })

  test("semantic search falls back to keyword-only without a query vector", () => {
    const memoryCollection = COLLECTIONS.find((collection) => collection.name === "memory_observations")
    expect(memoryCollection).toBeDefined()

    const request = buildSearchRequest(memoryCollection!, "redis dedupe", {
      perPage: 5,
      semantic: true,
    })

    expect(request.query_by).toBe(memoryCollection!.queryBy)
    expect(request.vector_query).toBeUndefined()
  })

  test("formats finite search vectors and zeroes invalid values", () => {
    expect(formatSearchVectorQuery("embedding", [0.1, -0.2, Number.NaN], 7)).toBe(
      "embedding:([0.1,-0.2,0], k:7, alpha:0.7)",
    )
  })
})
