import { describe, expect, test } from "bun:test"
import { __jobsTestUtils } from "./jobs"

describe("jobs command helpers", () => {
  test("worstSeverity prefers down over degraded over healthy", () => {
    expect(__jobsTestUtils.worstSeverity("healthy", "degraded", "healthy")).toBe("degraded")
    expect(__jobsTestUtils.worstSeverity("healthy", "down", "degraded")).toBe("down")
    expect(__jobsTestUtils.worstSeverity("healthy", "healthy")).toBe("healthy")
  })

  test("summarizeRunStatuses groups by status", () => {
    expect(__jobsTestUtils.summarizeRunStatuses([
      { status: "COMPLETED" },
      { status: "FAILED" },
      { status: "COMPLETED" },
      { status: "QUEUED" },
    ])).toEqual({
      COMPLETED: 2,
      FAILED: 1,
      QUEUED: 1,
    })
  })

  test("buildOverallSummary reports healthy aggregate when all components are healthy", () => {
    const summary = __jobsTestUtils.buildOverallSummary({
      queue: { status: "healthy", depth: 0, activePauses: [], summary: "", byPriority: {}, oldestAgeMs: null, redisUrl: "redis://localhost:6379", error: null },
      restate: { status: "healthy", summary: "", namespace: "joelclaw", adminUrl: "http://localhost:9070", statefulset: { exists: true, desiredReplicas: 1, readyReplicas: 1, phase: "ready", error: null }, service: { exists: true, type: "ClusterIP", ports: [], error: null }, admin: { healthy: true, status: 200, response: "ok" } },
      dkron: { status: "healthy", summary: "", namespace: "joelclaw", serviceName: "dkron-svc", statefulset: { exists: true, desiredReplicas: 1, readyReplicas: 1, phase: "ready", error: null }, service: { exists: true, type: "ClusterIP", ports: [], error: null }, api: { accessible: true, status: 200, response: {}, accessMode: "tunnel", baseUrl: "http://127.0.0.1:18080", localPort: 18080, error: null }, jobs: { total: 5, restate: 5 } },
      inngest: { status: "healthy", summary: "", checks: {}, recentRuns: { hours: 1, count: 0, byStatus: {}, recent: [] } },
    })

    expect(summary).toContain("Runtime healthy")
    expect(summary).toContain("queue idle")
    expect(summary).toContain("restate healthy")
    expect(summary).toContain("dkron healthy")
    expect(summary).toContain("inngest healthy")
  })

  test("describeQueueOverall reports held backlog when work is paused intentionally", () => {
    expect(__jobsTestUtils.describeQueueOverall({
      status: "healthy",
      depth: 4,
      activePauses: [{ family: "content/updated", reason: "pause", source: "manual", mode: "manual", appliedAt: "", expiresAt: "", expiresInMs: 10_000 }],
      summary: "",
      byPriority: {},
      oldestAgeMs: 500,
      redisUrl: "redis://localhost:6379",
      error: null,
    })).toBe("queue held (depth 4, 1 pause)")
  })
})
