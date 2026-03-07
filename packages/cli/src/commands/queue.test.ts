import { describe, expect, test } from "bun:test"
import { Priority } from "@joelclaw/queue"
import { __queueCommandTestUtils, queueCmd, queueCommandNames } from "./queue"

const { buildQueueEnvelope, parseJsonObject, resolvePriority } = __queueCommandTestUtils

describe("queue command contract", () => {
  test("queue command exposes the expected subcommand set", () => {
    expect(queueCmd.descriptor._tag).toBe("Subcommands")
    expect(queueCommandNames).toEqual(["emit", "depth", "list", "inspect"])
    expect(queueCmd.descriptor.children).toHaveLength(queueCommandNames.length)
  })

  test("buildQueueEnvelope creates canonical CLI envelopes", () => {
    const envelope = buildQueueEnvelope({
      event: "discovery/noted",
      data: { url: "https://example.com" },
      priority: Priority.P2,
      dedupKey: "example.com",
    })

    expect(envelope.event).toBe("discovery/noted")
    expect(envelope.source).toBe("cli")
    expect(envelope.priority).toBe(Priority.P2)
    expect(envelope.data).toEqual({ url: "https://example.com" })
    expect(envelope.dedupKey).toBe("example.com")
    expect(typeof envelope.id).toBe("string")
    expect(typeof envelope.trace?.correlationId).toBe("string")
  })

  test("parseJsonObject accepts only JSON objects", () => {
    expect(parseJsonObject('{"url":"https://example.com"}')).toEqual({
      url: "https://example.com",
    })
    expect(() => parseJsonObject("[]")).toThrow("queue payload must be a JSON object")
  })

  test("resolvePriority honors explicit overrides", () => {
    expect(resolvePriority(undefined, Priority.P3)).toBe(Priority.P3)
    expect(resolvePriority("p1", Priority.P3)).toBe(Priority.P1)
    expect(() => resolvePriority("urgent", Priority.P3)).toThrow("Unknown priority")
  })
})
