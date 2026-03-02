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
          stack: "\"Unable to reach SDK URL\"",
        },
      },
    }

    expect(__runsTestUtils.hasSdkReachabilityError(errors)).toBe(true)
    expect(__runsTestUtils.hasSdkReachabilityError({})).toBe(false)
    expect(__runsTestUtils.hasSdkReachabilityError(undefined)).toBe(false)
  })
})
