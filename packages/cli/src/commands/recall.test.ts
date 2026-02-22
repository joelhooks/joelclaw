import { describe, expect, test } from "bun:test"
import { __recallTestUtils } from "./recall"

const { runRewriteQueryWith, trustPassFilter } = __recallTestUtils

type RankedHit = Parameters<typeof trustPassFilter>[0][number]

function rankedHit(overrides: Partial<RankedHit> = {}): RankedHit {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    document: {
      id: "hit-1",
      observation: "Redis SETNX dedupe pattern for Inngest jobs",
      timestamp: nowSeconds,
      stale: false,
      recall_count: 1,
      retrieval_priority: 0,
    },
    score: 0.8,
    decayedScore: 0.8,
    usageBoost: 1,
    ...(overrides as RankedHit),
  }
}

describe("recall rewrite", () => {
  test("disables rewrite deterministically when rewrite is disabled", async () => {
    const result = await runRewriteQueryWith("   redis   dedupe   ", { rewriteEnabled: false })
    expect(result).toMatchObject({
      inputQuery: "redis dedupe",
      rewrittenQuery: "redis dedupe",
      rewritten: false,
      strategy: "disabled",
    })
  })

  test("falls back cleanly when rewrite subprocess fails", async () => {
    const result = await runRewriteQueryWith("redis setnx pattern", {
      rewriteEnabled: true,
      spawn: () => ({ exitCode: 1, stdout: "", stderr: "mock rewrite failure" }),
    })

    expect(result.strategy).toBe("fallback")
    expect(result.rewritten).toBe(false)
    expect(result.rewrittenQuery).toBe("redis setnx pattern")
    expect(result.error).toContain("mock rewrite failure")
  })

  test("accepts successful rewrite output and sanitizes quotes", async () => {
    const result = await runRewriteQueryWith("redis setnx pattern", {
      rewriteEnabled: true,
      spawn: () => ({ exitCode: 0, stdout: "\"Redis SETNX idempotency strategy\"", stderr: "" }),
    })

    expect(result.strategy).toBe("haiku")
    expect(result.rewritten).toBe(true)
    expect(result.rewrittenQuery).toBe("Redis SETNX idempotency strategy")
  })
})

describe("recall trust pass", () => {
  test("drops low-trust hits but falls back to first result when everything is dropped", () => {
    const staleOld = rankedHit({
      document: {
        id: "stale-old",
        observation: "old stale memory",
        timestamp: Math.floor(Date.now() / 1000) - 120 * 24 * 60 * 60,
        stale: true,
        recall_count: 0,
      },
      decayedScore: 0,
      score: 0,
    })

    const result = trustPassFilter([staleOld], 0.1)
    expect(result.dropped).toHaveLength(1)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.document.id).toBe("stale-old")
    expect(result.filtersApplied).toContain("trust-pass")
    expect(result.filtersApplied).toContain("trust-pass-fallback")
    expect(result.dropped[0]?.reasons).toContain("stale_tagged")
  })

  test("keeps valid hits and reports dropped diagnostics", () => {
    const good = rankedHit({
      document: {
        id: "good",
        observation: "Use a shared lease parser for Typesense API key retrieval",
        timestamp: Math.floor(Date.now() / 1000),
        stale: false,
        recall_count: 3,
      },
      decayedScore: 0.7,
      score: 0.7,
    })
    const tooShort = rankedHit({
      document: {
        id: "short",
        observation: "tiny",
        timestamp: Math.floor(Date.now() / 1000),
        stale: false,
        recall_count: 0,
      },
      decayedScore: 0.6,
      score: 0.6,
    })

    const result = trustPassFilter([good, tooShort], 0.1)
    expect(result.kept.map((hit) => hit.document.id)).toEqual(["good"])
    expect(result.filtersApplied).toContain("trust-pass")
    expect(result.filtersApplied).not.toContain("trust-pass-fallback")
    expect(result.dropped.find((hit) => hit.id === "short")?.reasons).toContain("too_short")
  })
})
