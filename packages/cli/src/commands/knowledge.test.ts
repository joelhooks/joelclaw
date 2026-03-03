import { describe, expect, test } from "bun:test"
import { __knowledgeTestUtils } from "./knowledge"

describe("knowledge note helpers", () => {
  test("parseCsvList trims and deduplicates values", () => {
    const tags = __knowledgeTestUtils.parseCsvList("gateway, turn-note, gateway,  ,tool-use")
    expect(tags).toEqual(["gateway", "turn-note", "tool-use"])
  })

  test("buildTurnId includes source agent channel session and turn", () => {
    const turnId = __knowledgeTestUtils.buildTurnId({
      source: "gateway",
      agent: "gateway-daemon",
      channel: "telegram",
      session: "sess-123",
      turn: 8,
    })
    expect(turnId).toBe("gateway:gateway-daemon:telegram:sess-123:8")
  })

  test("validateKnowledgeNoteInput requires summary when skip reason missing", () => {
    const result = __knowledgeTestUtils.validateKnowledgeNoteInput({
      source: "gateway",
      agent: "gateway-daemon",
      session: "sess-123",
      turn: 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("--summary is required")
    }
  })

  test("validateKnowledgeNoteInput accepts explicit skip reason without summary", () => {
    const result = __knowledgeTestUtils.validateKnowledgeNoteInput({
      source: "gateway",
      agent: "gateway-daemon",
      session: "sess-123",
      turn: 2,
      skipReason: "no-new-information",
      usefulness: "gateway,turn",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.skipReason).toBe("no-new-information")
      expect(result.value.turnId).toContain("sess-123")
    }
  })
})
