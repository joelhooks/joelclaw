import { describe, expect, test } from "bun:test"
import { __healAdapterTestUtils } from "../capabilities/adapters/heal-runbook"
import { __healTestUtils } from "./heal"

const {
  parseContextJson,
  normalizeTimeoutMs,
  normalizeMaxOutputLines,
} = __healTestUtils

const {
  phasesFor,
  hasUnresolvedPlaceholder,
  truncateOutput,
} = __healAdapterTestUtils

describe("heal command helpers", () => {
  test("parses context JSON object", () => {
    const parsed = parseContextJson('{"run-id":"01ABC","attempt":2}')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value["run-id"]).toBe("01ABC")
      expect(parsed.value.attempt).toBe(2)
    }
  })

  test("rejects invalid context payloads", () => {
    expect(parseContextJson("[]").ok).toBe(false)
    expect(parseContextJson("{not-json}").ok).toBe(false)
  })

  test("normalizes timeout and output constraints", () => {
    expect(normalizeTimeoutMs(50)).toBe(1000)
    expect(normalizeMaxOutputLines(0)).toBe(5)
  })
})

describe("heal adapter helpers", () => {
  test("expands phase all into diagnose/fix/verify sequence", () => {
    expect(phasesFor("all")).toEqual(["diagnose", "fix", "verify"])
    expect(phasesFor("rollback")).toEqual(["rollback"])
  })

  test("detects unresolved placeholders and truncates output safely", () => {
    expect(hasUnresolvedPlaceholder("joelclaw run <run-id>")).toBe(true)
    expect(hasUnresolvedPlaceholder("joelclaw status")).toBe(false)

    const input = Array.from({ length: 7 }, (_, index) => `line-${index + 1}`).join("\n")
    const truncated = truncateOutput(input, 3)
    expect(truncated).toContain("line-7")
    expect(truncated).toContain("truncated")
  })
})
