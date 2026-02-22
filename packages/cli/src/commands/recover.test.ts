import { describe, expect, test } from "bun:test"
import { __recoverTestUtils } from "./recover"

const { normalizePhase, parseContext, truncateOutput, hasUnresolvedPlaceholder } = __recoverTestUtils

describe("recover command helpers", () => {
  test("normalizes supported phases", () => {
    expect(normalizePhase("FIX")).toBe("fix")
    expect(normalizePhase(" diagnose ")).toBe("diagnose")
    expect(normalizePhase("all")).toBe("all")
    expect(normalizePhase("invalid")).toBeNull()
  })

  test("parses context JSON object", () => {
    const parsed = parseContext('{"run-id":"01ABC","count":2}')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.context["run-id"]).toBe("01ABC")
      expect(parsed.context.count).toBe(2)
    }
  })

  test("rejects invalid context JSON", () => {
    const parsed = parseContext("{not-json}")
    expect(parsed.ok).toBe(false)
  })

  test("detects unresolved placeholders", () => {
    expect(hasUnresolvedPlaceholder("joelclaw run <run-id>")).toBe(true)
    expect(hasUnresolvedPlaceholder("joelclaw status")).toBe(false)
  })

  test("truncates long command output by line count", () => {
    const value = Array.from({ length: 6 }, (_, i) => `line-${i + 1}`).join("\n")
    const truncated = truncateOutput(value, 3)
    expect(truncated).toContain("line-6")
    expect(truncated).toContain("truncated")
  })
})
