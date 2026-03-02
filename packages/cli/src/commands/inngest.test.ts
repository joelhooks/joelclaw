import { describe, expect, test } from "bun:test"
import { __inngestTestUtils } from "./inngest"

const {
  parseCsvList,
  buildSweepStalePredicate,
  parseSqliteJsonRows,
  runIdHexToUlid,
  mapSweepCandidates,
} = __inngestTestUtils

describe("inngest sweep-stale-runs helpers", () => {
  test("parseCsvList trims and drops empty items", () => {
    expect(parseCsvList("check/system-health, check/o11y-triage ,, ")).toEqual([
      "check/system-health",
      "check/o11y-triage",
    ])
  })

  test("runIdHexToUlid decodes 16-byte run_id hex", () => {
    expect(runIdHexToUlid("019cb031eca3471598a1731acd6b8945")).toBe("01KJR33V538WASH8BK3B6PQ2A5")
    expect(runIdHexToUlid("not-hex")).toBeNull()
  })

  test("buildSweepStalePredicate includes age threshold and escaped function names", () => {
    const where = buildSweepStalePredicate({
      namespace: "joelclaw",
      pod: "inngest-0",
      dbPath: "/data/main.db",
      functionNames: ["check/o11y-triage", "team/o'hara"],
      olderThanMinutes: 10,
      sampleLimit: 25,
      maxApplyCandidates: 200,
    })

    expect(where).toContain("tr.status = 200")
    expect(where).toContain("10 * 60 * 1000")
    expect(where).toContain("'check/o11y-triage'")
    expect(where).toContain("'team/o''hara'")
  })

  test("parseSqliteJsonRows parses multi-statement sqlite -json output", () => {
    const output = [
      '[{"metric":"candidates","value":2}]',
      '[{"metric":"trace_runs_terminalized","value":2}]',
    ].join("\n")

    expect(parseSqliteJsonRows(output)).toEqual([
      { metric: "candidates", value: 2 },
      { metric: "trace_runs_terminalized", value: 2 },
    ])
  })

  test("mapSweepCandidates normalizes preview rows", () => {
    const rows = [
      {
        run_id_hex: "019cb031eca3471598a1731acd6b8945",
        function_name: "check/system-health",
        trace_status: 200,
        started_at: 1772482587821,
        ended_at: 0,
        age_minutes: 17,
        has_finish: 0,
        has_terminal_history: 1,
      },
    ]

    const [candidate] = mapSweepCandidates(rows)
    expect(candidate?.runId).toBe("01KJR33V538WASH8BK3B6PQ2A5")
    expect(candidate?.runIdHex).toBe("019cb031eca3471598a1731acd6b8945")
    expect(candidate?.hasFinish).toBe(false)
    expect(candidate?.hasTerminalHistory).toBe(true)
    expect(candidate?.startedAtIso).toMatch(/^2026-03-02T/) // deterministic enough for fixture
  })
})
