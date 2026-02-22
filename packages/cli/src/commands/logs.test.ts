import { describe, expect, test } from "bun:test"
import {
  aggregateLogSnapshots,
  classifyLogSeverity,
  normalizeSignature,
  normalizeSourceArg,
} from "./logs"

describe("logs helpers", () => {
  test("normalizeSourceArg supports aggregate aliases", () => {
    expect(normalizeSourceArg("worker")).toBe("worker")
    expect(normalizeSourceArg("err")).toBe("errors")
    expect(normalizeSourceArg("analysis")).toBe("analyze")
    expect(normalizeSourceArg("aggregate")).toBe("analyze")
    expect(normalizeSourceArg("wat")).toBeNull()
  })

  test("classifyLogSeverity uses stable heuristics", () => {
    expect(classifyLogSeverity("fatal: boom")).toBe("error")
    expect(classifyLogSeverity("WARN check this")).toBe("warn")
    expect(classifyLogSeverity("debug details")).toBe("debug")
    expect(classifyLogSeverity("all good")).toBe("info")
  })

  test("normalizeSignature collapses noisy ids", () => {
    const normalized = normalizeSignature(
      "2026-02-22T03:00:00.000Z run 01KJ1MCA07HSBX815DSEAABBZT failed for id 1234567"
    )

    expect(normalized).toContain("<ts>")
    expect(normalized).toContain("<ulid>")
    expect(normalized).toContain("<num>")
  })

  test("aggregateLogSnapshots computes severity/component/action rollups", () => {
    const result = aggregateLogSnapshots([
      {
        source: "worker",
        label: "worker stdout",
        available: true,
        lines: [
          '{"level":"error","component":"observe","action":"observe.failed","error":"timeout"}',
          "WARN component=reflect retrying",
        ],
      },
      {
        source: "errors",
        label: "worker stderr",
        available: true,
        lines: ["ERROR component=observe fatal crash"],
      },
      {
        source: "server",
        label: "inngest server (k8s)",
        available: false,
        lines: [],
        error: "kubectl not reachable",
      },
    ])

    expect(result.totals.lines).toBe(3)
    expect(result.totals.bySeverity.error).toBe(2)
    expect(result.totals.bySeverity.warn).toBe(1)
    expect(result.topComponents[0]?.component).toBe("observe")
    expect(result.topActions[0]?.action).toBe("observe.failed")
    expect(result.bySource.server.available).toBe(false)
    expect(result.samples.errors.length).toBeGreaterThan(0)
  })
})
