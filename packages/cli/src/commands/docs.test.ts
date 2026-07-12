import { describe, expect, test } from "bun:test"
import { __docsTestUtils } from "./docs"

const { buildDocsSearchParams, formatDocsVectorQuery } = __docsTestUtils

describe("docs semantic search", () => {
  test("uses vector_query without putting raw embedding in query_by", () => {
    const params = buildDocsSearchParams("distributed systems", 10, [0.1, -0.2, Number.NaN])

    expect(params.get("query_by")).toBe("retrieval_text,content")
    expect(params.get("query_by")).not.toContain("embedding")
    expect(params.get("vector_query")).toBe(
      "embedding:([0.1,-0.2,0], k:30, alpha:0.75)"
    )
  })

  test("falls back to lexical search when no query embedding is available", () => {
    const params = buildDocsSearchParams("distributed systems", 5)

    expect(params.get("query_by")).toBe("retrieval_text,content")
    expect(params.has("vector_query")).toBe(false)
  })

  test("enforces the minimum semantic fetch size", () => {
    expect(formatDocsVectorQuery([0.25], 20)).toBe(
      "embedding:([0.25], k:20, alpha:0.75)"
    )
  })
})
