import { describe, expect, test } from "bun:test"
import { __webhookTestUtils } from "./webhook"

describe("webhook command helpers", () => {
  test("parses duration suffixes", () => {
    expect(__webhookTestUtils.parseDurationToSeconds("15m")).toBe(900)
    expect(__webhookTestUtils.parseDurationToSeconds("1h")).toBe(3600)
    expect(__webhookTestUtils.parseDurationToSeconds("2d")).toBe(172800)
    expect(__webhookTestUtils.parseDurationToSeconds("45")).toBe(45)
  })

  test("rejects invalid durations", () => {
    expect(__webhookTestUtils.parseDurationToSeconds("")).toBeNull()
    expect(__webhookTestUtils.parseDurationToSeconds("-1h")).toBeNull()
    expect(__webhookTestUtils.parseDurationToSeconds("abc")).toBeNull()
    expect(__webhookTestUtils.parseDurationToSeconds("10w")).toBeNull()
  })

  test("defaultSessionId prefers gateway in central role", () => {
    const prior = process.env.GATEWAY_ROLE
    process.env.GATEWAY_ROLE = "central"
    expect(__webhookTestUtils.defaultSessionId()).toBe("gateway")
    if (prior === undefined) {
      delete process.env.GATEWAY_ROLE
    } else {
      process.env.GATEWAY_ROLE = prior
    }
  })
})
