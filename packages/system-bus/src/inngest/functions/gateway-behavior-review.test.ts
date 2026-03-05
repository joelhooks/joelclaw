import { describe, expect, test } from "bun:test"
import { __gatewayBehaviorReviewTestUtils } from "./gateway-behavior-review"

const { normalizeCandidateText, buildCandidates, clipSnippet } = __gatewayBehaviorReviewTestUtils

describe("gateway behavior review candidate generation", () => {
  test("builds good-pattern KEEP candidates from status + delegation signals", () => {
    const messages = [
      {
        role: "assistant" as const,
        text: "Status: delegated implementation to codex and will check in again in 2 minutes.",
        timestamp: Date.now(),
      },
      {
        role: "assistant" as const,
        text: "Done: codex finished; handoff complete with verification output.",
        timestamp: Date.now(),
      },
      {
        role: "assistant" as const,
        text: "Status: background work still running, concise check-in before next step.",
        timestamp: Date.now(),
      },
      {
        role: "assistant" as const,
        text: "Delegated the implementation and stayed interruptible for inbound messages.",
        timestamp: Date.now(),
      },
    ]

    const otel = [
      { action: "events.dispatched.background_only", component: "redis-channel", timestamp: Date.now() },
      { action: "events.dispatched.background_only", component: "redis-channel", timestamp: Date.now() },
      { action: "outbound.console_forward.suppressed_policy", component: "daemon.outbound", timestamp: Date.now() },
    ]

    const candidates = buildCandidates(messages, otel)
    const keep = candidates.filter((candidate) => candidate.type === "keep")

    expect(keep.length).toBeGreaterThan(0)
    expect(keep.some((candidate) => /status handoffs/i.test(candidate.text))).toBe(true)
    expect(keep.every((candidate) => candidate.confidence >= 0.55)).toBe(true)
    expect(keep.every((candidate) => candidate.evidence.length > 0)).toBe(true)
  })

  test("builds bad-pattern LESS/STOP candidates for monologue + heartbeat verbosity", () => {
    const longMessage = "A".repeat(1305)
    const heartbeatVerbose = "Heartbeat " + "detail ".repeat(70)

    const messages = [
      { role: "assistant" as const, text: longMessage, timestamp: Date.now() },
      { role: "assistant" as const, text: longMessage + " extra", timestamp: Date.now() },
      { role: "assistant" as const, text: heartbeatVerbose, timestamp: Date.now() },
      { role: "assistant" as const, text: heartbeatVerbose + " more", timestamp: Date.now() },
    ]

    const candidates = buildCandidates(messages, [])
    const types = candidates.map((candidate) => candidate.type)

    expect(types).toContain("less")
    expect(types).toContain("stop")
  })
})

describe("gateway behavior review helpers", () => {
  test("normalizes candidate text deterministically", () => {
    expect(normalizeCandidateText("  Frequent  STATUS Handoffs...  ")).toBe("frequent status handoffs")
  })

  test("clips long evidence snippets", () => {
    const clipped = clipSnippet("x".repeat(400), 50)
    expect(clipped.length).toBe(50)
    expect(clipped.endsWith("…")).toBe(true)
  })
})
