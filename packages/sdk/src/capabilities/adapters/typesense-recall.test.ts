import { beforeEach, describe, expect, test } from "bun:test"
import { __recallTestUtils } from "./typesense-recall"

describe("typesense-recall rewrite skip heuristics", () => {
  beforeEach(() => {
    __recallTestUtils.resetCircuit()
    __recallTestUtils.circuitRecordSuccess()
  })

  test('Short query "hi" → "skip.short_query"', () => {
    expect(__recallTestUtils.detectRewriteSkipReason("hi")).toBe("skip.short_query")
  })

  test('Quoted literal "\"exact match\"" → "skip.literal_query"', () => {
    expect(__recallTestUtils.detectRewriteSkipReason('"exact match"')).toBe("skip.literal_query")
  })

  test('Path-like "packages/cli/src/foo.ts" → "skip.direct_identifier"', () => {
    expect(__recallTestUtils.detectRewriteSkipReason("packages/cli/src/foo.ts")).toBe("skip.direct_identifier")
  })

  test('Command-like "show me tasks" → "skip.command_like"', () => {
    expect(__recallTestUtils.detectRewriteSkipReason("show me tasks")).toBe("skip.command_like")
  })

  test("Normal long query → null", () => {
    expect(__recallTestUtils.detectRewriteSkipReason("How does the memory write gate decision flow work for long-running gateway sessions?")).toBeNull()
  })
})

describe("typesense-recall rewrite circuit breaker", () => {
  beforeEach(() => {
    __recallTestUtils.resetCircuit()
    __recallTestUtils.circuitRecordSuccess()
  })

  test("3x circuitRecordFailure → circuitShouldSkip returns skip=true", () => {
    __recallTestUtils.circuitRecordFailure()
    __recallTestUtils.circuitRecordFailure()
    __recallTestUtils.circuitRecordFailure()

    const result = __recallTestUtils.circuitShouldSkip()
    expect(result.skip).toBe(true)
  })

  test("circuitRecordSuccess → resets, circuitShouldSkip returns skip=false", () => {
    __recallTestUtils.circuitRecordFailure()
    __recallTestUtils.circuitRecordFailure()
    __recallTestUtils.circuitRecordFailure()

    expect(__recallTestUtils.circuitShouldSkip().skip).toBe(true)

    __recallTestUtils.circuitRecordSuccess()

    const result = __recallTestUtils.circuitShouldSkip()
    expect(result.skip).toBe(false)
  })
})

describe("typesense-recall rewrite cache", () => {
  beforeEach(() => {
    __recallTestUtils.resetCircuit()
    __recallTestUtils.circuitRecordSuccess()
  })

  test("cacheSet + cacheGet returns the entry", () => {
    __recallTestUtils.cacheSet("my-query", {
      rewrittenQuery: "my rewritten query",
      strategy: "haiku",
      model: "anthropic/claude-haiku-4-5",
      provider: "pi",
    })

    const entry = __recallTestUtils.cacheGet("my-query")

    expect(entry).not.toBeNull()
    expect(entry?.rewrittenQuery).toBe("my rewritten query")
    expect(entry?.strategy).toBe("haiku")
  })

  test("cacheGet on missing key returns null", () => {
    expect(__recallTestUtils.cacheGet("missing-key")).toBeNull()
  })
})
