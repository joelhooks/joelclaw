import { describe, expect, test } from "bun:test"
import { __jobMonitorTestUtils } from "./index"

describe("job monitor runtime change detection", () => {
  test("queueDepthBand buckets queue pressure for report-back without per-item spam", () => {
    expect(__jobMonitorTestUtils.queueDepthBand(0)).toBe("idle")
    expect(__jobMonitorTestUtils.queueDepthBand(3)).toBe("active")
    expect(__jobMonitorTestUtils.queueDepthBand(12)).toBe("elevated")
    expect(__jobMonitorTestUtils.queueDepthBand(30)).toBe("backlogged")
  })

  test("runtimeReportFingerprint ignores checkedAt noise but catches meaningful backlog state changes", () => {
    const idle = __jobMonitorTestUtils.runtimeReportFingerprint({
      checkedAt: "2026-03-08T04:00:00.000Z",
      overall: { status: "healthy", summary: "Runtime healthy" },
      queue: { status: "healthy", depth: 0, activePauses: [] },
      restate: { status: "healthy" },
      dkron: { status: "healthy" },
      inngest: { status: "healthy" },
    }, "healthy", null)

    const idleLater = __jobMonitorTestUtils.runtimeReportFingerprint({
      checkedAt: "2026-03-08T04:00:05.000Z",
      overall: { status: "healthy", summary: "Runtime healthy" },
      queue: { status: "healthy", depth: 0, activePauses: [] },
      restate: { status: "healthy" },
      dkron: { status: "healthy" },
      inngest: { status: "healthy" },
    }, "healthy", null)

    const held = __jobMonitorTestUtils.runtimeReportFingerprint({
      checkedAt: "2026-03-08T04:00:10.000Z",
      overall: { status: "healthy", summary: "Runtime healthy" },
      queue: { status: "healthy", depth: 2, activePauses: [{ family: "content/updated" }] },
      restate: { status: "healthy" },
      dkron: { status: "healthy" },
      inngest: { status: "healthy" },
    }, "healthy", null)

    expect(idle).toBe(idleLater)
    expect(held).not.toBe(idle)
  })
})
