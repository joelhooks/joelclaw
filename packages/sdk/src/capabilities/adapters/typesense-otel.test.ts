import { describe, expect, test } from "bun:test"
import { __otelAdapterTestUtils } from "./typesense-otel"

describe("typesense otel adapter helpers", () => {
  test("buildFilter applies session/system provenance filters and respects timestamp units", () => {
    const msFilter = __otelAdapterTestUtils.buildFilter({
      session: "gateway",
      system: "panda",
      hours: 1,
    })
    const secondsFilter = __otelAdapterTestUtils.buildFilter({
      session: "gateway",
      system: "panda",
      hours: 1,
    }, { timestampUnit: "seconds" })

    expect(msFilter).toContain("sessionId:=`gateway`")
    expect(msFilter).toContain("systemId:=`panda`")
    expect(secondsFilter).toContain("sessionId:=`gateway`")
    expect(secondsFilter).toContain("systemId:=`panda`")

    const msCutoff = Number(msFilter?.match(/timestamp:>=(\d+)/)?.[1] ?? 0)
    const secondsCutoff = Number(secondsFilter?.match(/timestamp:>=(\d+)/)?.[1] ?? 0)

    expect(msCutoff).toBeGreaterThan(1_000_000_000_000)
    expect(secondsCutoff).toBeGreaterThan(1_000_000_000)
    expect(secondsCutoff).toBeLessThan(10_000_000_000)
  })

  test("timestampFromDocument normalizes second-based timestamps to milliseconds", () => {
    expect(__otelAdapterTestUtils.timestampFromDocument({ timestamp: 1_773_778_250 })).toBe(1_773_778_250_000)
    expect(__otelAdapterTestUtils.timestampFromDocument({ timestamp: 1_773_788_250_900 })).toBe(1_773_788_250_900)
    expect(__otelAdapterTestUtils.timestampFromDocument({ timestamp: "1773778250" })).toBe(1_773_778_250_000)
  })
})
