import { describe, expect, test } from "bun:test"
import { __runsTestUtils } from "./runs"

describe("run command helpers", () => {
  test("terminal status detection is deterministic", () => {
    expect(__runsTestUtils.isTerminalRunStatus("COMPLETED")).toBe(true)
    expect(__runsTestUtils.isTerminalRunStatus("FAILED")).toBe(true)
    expect(__runsTestUtils.isTerminalRunStatus("CANCELLED")).toBe(true)
    expect(__runsTestUtils.isTerminalRunStatus("RUNNING")).toBe(false)
    expect(__runsTestUtils.isTerminalRunStatus(undefined)).toBe(false)
  })

  test("normalizeStatus uppercases and guards nulls", () => {
    expect(__runsTestUtils.normalizeStatus("running")).toBe("RUNNING")
    expect(__runsTestUtils.normalizeStatus(undefined)).toBe("UNKNOWN")
  })

  test("active run next actions include cancel shortcut", () => {
    const result = {
      run: { status: "RUNNING" },
      trigger: { IDs: ["evt_123"] },
      errors: undefined,
    }

    const next = __runsTestUtils.buildRunNextActions(result, "01RUNID")
    const commands = next.map((action) => action.command)

    expect(commands).toContain("joelclaw run <run-id> --cancel")
    expect(commands).toContain("joelclaw event <event-id>")
  })

  test("filterRunsByStatus enforces local status filtering", () => {
    const rows = [
      { id: "1", status: "RUNNING" },
      { id: "2", status: "COMPLETED" },
      { id: "3", status: "running" },
    ]

    const filtered = __runsTestUtils.filterRunsByStatus(rows, "RUNNING")
    expect(filtered.map((r) => r.id)).toEqual(["1", "3"])
  })

  test("hasSdkReachabilityError detects stale SDK failures", () => {
    const errors = {
      Finalization: {
        error: {
          stack: '"Unable to reach SDK URL"',
        },
      },
    }

    expect(__runsTestUtils.hasSdkReachabilityError(errors)).toBe(true)
    expect(__runsTestUtils.hasSdkReachabilityError({})).toBe(false)
    expect(__runsTestUtils.hasSdkReachabilityError(undefined)).toBe(false)
  })

  test("needsRunningGhostDetailCheck selects ended RUNNING rows", () => {
    expect(__runsTestUtils.needsRunningGhostDetailCheck({
      status: "RUNNING",
      endedAt: "2026-03-02T20:30:45.071Z",
      startedAt: "2026-03-02T20:30:45.070Z",
      functionName: "check/o11y-triage",
    })).toBe(true)
  })

  test("detectLikelyStaleRunningGhost flags finalization-only SDK unreachable runs", () => {
    const signal = __runsTestUtils.detectLikelyStaleRunningGhost(
      {
        id: "01RUN",
        status: "RUNNING",
        functionName: "check/o11y-triage",
        startedAt: "2026-03-02T20:30:45.070Z",
        endedAt: "2026-03-02T20:30:45.071Z",
      },
      {
        detail: {
          run: { status: "RUNNING" },
          errors: {
            Finalization: { error: { stack: '"Unable to reach SDK URL"' } },
          },
          trace: {
            name: "Run",
            status: "RUNNING",
            childrenSpans: [
              { name: "Finalization", status: "FAILED", childrenSpans: [] },
            ],
          },
        },
      },
    )

    expect(signal?.likely).toBe(true)
    expect(signal?.reasons).toContain("finalization_failed_without_execution")
  })

  test("detectLikelyStaleRunningGhost flags list/detail status mismatch", () => {
    const signal = __runsTestUtils.detectLikelyStaleRunningGhost(
      {
        status: "RUNNING",
        functionName: "check/system-health",
        startedAt: "2026-03-02T20:00:00.000Z",
      },
      {
        detail: {
          run: { status: "CANCELLED" },
          errors: undefined,
          trace: { name: "Run", status: "COMPLETED", childrenSpans: [] },
        },
      },
    )

    expect(signal?.likely).toBe(true)
    expect(signal?.confidence).toBe("high")
    expect(signal?.reasons).toContain("list_detail_status_mismatch:CANCELLED")
  })

  test("detectLikelyStaleRunningGhost ignores healthy active execution", () => {
    const signal = __runsTestUtils.detectLikelyStaleRunningGhost(
      {
        status: "RUNNING",
        functionName: "tasks/triage",
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      {
        detail: {
          run: { status: "RUNNING" },
          errors: undefined,
          trace: {
            name: "Run",
            status: "RUNNING",
            childrenSpans: [
              {
                name: "Execution",
                status: "RUNNING",
                childrenSpans: [{ name: "Attempt 0", status: "RUNNING" }],
              },
            ],
          },
        },
      },
    )

    expect(signal).toBeNull()
  })
})
