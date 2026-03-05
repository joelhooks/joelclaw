import { describe, expect, test } from "bun:test"
import { __gatewayBehaviorTestUtils } from "./gateway-behavior"

const {
  normalizeDirectiveText,
  addDirectiveToContract,
  governContractDirectives,
  parseContract,
  CONTRACT_CAP,
} = __gatewayBehaviorTestUtils

describe("gateway behavior normalization", () => {
  test("normalizes whitespace and trailing punctuation", () => {
    const normalized = normalizeDirectiveText("  frequent   status handoffs during delegation...  ")
    expect(normalized).toMatchObject({
      text: "frequent status handoffs during delegation...",
      normalizedText: "frequent status handoffs during delegation",
    })
  })

  test("rejects tiny directives", () => {
    expect(() => normalizeDirectiveText("ok")).toThrow("too short")
  })
})

describe("gateway behavior add governance", () => {
  const baseContract = parseContract(JSON.stringify({
    version: 3,
    generatedAt: new Date("2026-03-04T20:00:00.000Z").toISOString(),
    directives: [
      {
        id: "d-keep-1",
        type: "keep",
        text: "frequent status handoffs during delegated work",
        normalizedText: "frequent status handoffs during delegated work",
        source: "operator",
        createdAt: "2026-03-04T20:00:00.000Z",
      },
    ],
  }))

  test("dedupes same type + normalized text", () => {
    const decision = addDirectiveToContract(baseContract, {
      type: "keep",
      text: "frequent status handoffs during delegated work",
      normalizedText: "frequent status handoffs during delegated work",
      source: "operator",
    })

    expect(decision.kind).toBe("deduped")
  })

  test("rejects conflicting equivalent directive", () => {
    const decision = addDirectiveToContract(baseContract, {
      type: "stop",
      text: "frequent status handoffs during delegated work",
      normalizedText: "frequent status handoffs during delegated work",
      source: "operator",
    })

    expect(decision.kind).toBe("conflict")
    if (decision.kind === "conflict") {
      expect(decision.conflictWith.id).toBe("d-keep-1")
    }
  })

  test("enforces contract cap", () => {
    const directives = Array.from({ length: CONTRACT_CAP }, (_, index) => ({
      id: `d-${index}`,
      type: "keep",
      text: `directive ${index}`,
      normalizedText: `directive ${index}`,
      source: "operator",
      createdAt: `2026-03-04T20:${String(index).padStart(2, "0")}:00.000Z`,
    }))

    const cappedContract = parseContract(JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      directives,
    }))

    const decision = addDirectiveToContract(cappedContract, {
      type: "more",
      text: "more explicit handoff updates",
      normalizedText: "more explicit handoff updates",
      source: "operator",
    })

    expect(decision.kind).toBe("cap")
  })
})

describe("gateway behavior apply governance", () => {
  test("drops duplicate + conflicting + overflow directives deterministically", () => {
    const contract = parseContract(JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      directives: [
        {
          id: "keep-a",
          type: "keep",
          text: "status handoffs",
          normalizedText: "status handoffs",
          source: "operator",
          createdAt: "2026-03-04T20:00:00.000Z",
        },
        {
          id: "keep-a-dup",
          type: "keep",
          text: "status handoffs",
          normalizedText: "status handoffs",
          source: "operator",
          createdAt: "2026-03-04T20:01:00.000Z",
        },
        {
          id: "stop-conflict",
          type: "stop",
          text: "status handoffs",
          normalizedText: "status handoffs",
          source: "operator",
          createdAt: "2026-03-04T20:02:00.000Z",
        },
        ...Array.from({ length: CONTRACT_CAP + 2 }, (_, index) => ({
          id: `bulk-${index}`,
          type: "more",
          text: `bulk ${index}`,
          normalizedText: `bulk ${index}`,
          source: "operator",
          createdAt: `2026-03-04T21:${String(index % 60).padStart(2, "0")}:00.000Z`,
        })),
      ],
    }))

    const result = governContractDirectives(contract.directives)

    expect(result.directives.length).toBeLessThanOrEqual(CONTRACT_CAP)
    expect(result.dropped.some((drop) => drop.reason === "dedupe")).toBe(true)
    expect(result.dropped.some((drop) => drop.reason === "conflict")).toBe(true)
    expect(result.dropped.some((drop) => drop.reason === "cap")).toBe(true)
  })
})
