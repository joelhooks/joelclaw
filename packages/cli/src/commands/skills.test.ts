import { describe, expect, test } from "bun:test"
import { __skillsTestUtils } from "./skills"

describe("skills command helpers", () => {
  test("parseRunOutput decodes valid JSON object output", () => {
    const parsed = __skillsTestUtils.parseRunOutput(
      JSON.stringify({
        timestamp: "2026-02-28T21:05:04.410Z",
        isDeepReview: false,
        findings: { total: 2, stalePatterns: 2 },
        details: [{ type: "stale-pattern", skill: "skill-review", detail: "outdated reference" }],
      }),
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.findings?.total).toBe(2)
    expect(parsed?.details?.[0]?.skill).toBe("skill-review")
  })

  test("parseRunOutput returns null for non-JSON output", () => {
    expect(__skillsTestUtils.parseRunOutput("not json")).toBeNull()
    expect(__skillsTestUtils.parseRunOutput(42 as unknown as string)).toBeNull()
  })
})
