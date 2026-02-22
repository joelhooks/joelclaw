import { describe, expect, test } from "bun:test"
import { aggregateLangfuseTraces, parseProjectIdFromUrl } from "./langfuse"

describe("langfuse command helpers", () => {
  test("parseProjectIdFromUrl handles direct id and project URL", () => {
    expect(parseProjectIdFromUrl("cmlx4cd4901lyad07ih16f95i")).toBe("cmlx4cd4901lyad07ih16f95i")
    expect(
      parseProjectIdFromUrl("https://us.cloud.langfuse.com/project/cmlx4cd4901lyad07ih16f95i/")
    ).toBe("cmlx4cd4901lyad07ih16f95i")
    expect(parseProjectIdFromUrl("https://us.cloud.langfuse.com/project/notvalid"))
      .toBeUndefined()
  })

  test("aggregateLangfuseTraces computes rollups and trends", () => {
    const traces = [
      {
        id: "t1",
        projectId: "cmlx4cd4901lyad07ih16f95i",
        name: "joelclaw.recall",
        timestamp: "2026-02-22T03:00:00.000Z",
        totalCost: 0.01,
        metadata: {
          component: "recall-cli",
          action: "memory.recall.rewrite",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          durationMs: 120,
        },
      },
      {
        id: "t2",
        projectId: "cmlx4cd4901lyad07ih16f95i",
        name: "joelclaw.recall",
        timestamp: "2026-02-22T03:30:00.000Z",
        totalCost: 0.02,
        metadata: {
          component: "recall-cli",
          action: "memory.recall.rewrite",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          durationMs: 240,
        },
      },
      {
        id: "t3",
        projectId: "cmlx4cd4901lyad07ih16f95i",
        name: "joelclaw.content-sync",
        timestamp: "2026-02-22T04:00:00.000Z",
        totalCost: 0.03,
        metadata: {
          component: "content-sync",
          action: "content-sync.safety.review",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          durationMs: 520,
          error: "timeout",
        },
      },
    ]

    const aggregate = aggregateLangfuseTraces(traces, 60)

    expect(aggregate.traceCount).toBe(3)
    expect(aggregate.totalCost).toBeCloseTo(0.06, 6)
    expect(aggregate.breakdowns.names[0]?.name).toBe("joelclaw.recall")
    expect(aggregate.breakdowns.signatures[0]?.signature).toBe("recall-cli.memory.recall.rewrite")
    expect(aggregate.breakdowns.providers[0]?.provider).toBe("anthropic")
    expect(aggregate.failureSignals).toBe(1)

    const recallTrend = aggregate.signatureTrends.find(
      (entry) => entry.signature === "recall-cli.memory.recall.rewrite"
    )

    expect(recallTrend).toBeTruthy()
    expect(recallTrend?.count).toBe(2)
    expect(recallTrend?.buckets.length).toBeGreaterThan(0)
  })
})
