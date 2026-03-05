import { describe, expect, test } from "bun:test"
import {
  injectGatewayBehaviorContract,
  parseBehaviorDirectivesFromPrompt,
  renderGatewayBehaviorContractBlock,
  stripGatewayBehaviorContract,
} from "./behavior-contract"

describe("gateway behavior directive parser", () => {
  test("extracts KEEP/MORE/LESS/STOP/START directives from operator prompt", () => {
    const prompt = [
      "---",
      "Channel: telegram",
      "Date: Wednesday",
      "---",
      "KEEP: frequent status handoffs during delegated work",
      "MORE: short check-ins while background work runs",
      "LESS: long strategy monologues",
      "STOP: redundant heartbeat verbosity",
      "START: explicit done handoff when delegation completes",
    ].join("\n")

    expect(parseBehaviorDirectivesFromPrompt(prompt)).toEqual([
      { type: "keep", text: "frequent status handoffs during delegated work" },
      { type: "more", text: "short check-ins while background work runs" },
      { type: "less", text: "long strategy monologues" },
      { type: "stop", text: "redundant heartbeat verbosity" },
      { type: "start", text: "explicit done handoff when delegation completes" },
    ])
  })

  test("ignores automated gateway events", () => {
    const prompt = [
      "> ⚡ **Automated gateway event** — not a human message",
      "",
      "KEEP: this should not be captured",
    ].join("\n")

    expect(parseBehaviorDirectivesFromPrompt(prompt)).toEqual([])
  })
})

describe("gateway behavior contract injection", () => {
  test("injects behavior block before Role section", () => {
    const systemPrompt = [
      "# Identity & Context",
      "identity",
      "",
      "# Role: Gateway",
      "role text",
    ].join("\n")

    const block = renderGatewayBehaviorContractBlock({
      version: 2,
      hash: "abc123",
      directives: [
        { type: "keep", text: "frequent status handoffs" },
      ],
    })

    const injected = injectGatewayBehaviorContract(systemPrompt, block)
    expect(injected.inserted).toBe(true)
    expect(injected.placement).toBe("before-role")
    expect(injected.systemPrompt).toContain("<GATEWAY_BEHAVIOR_CONTRACT")

    const behaviorIndex = injected.systemPrompt.indexOf("<GATEWAY_BEHAVIOR_CONTRACT")
    const roleIndex = injected.systemPrompt.indexOf("# Role: Gateway")
    expect(behaviorIndex).toBeGreaterThan(-1)
    expect(roleIndex).toBeGreaterThan(-1)
    expect(behaviorIndex).toBeLessThan(roleIndex)
  })

  test("replaces previous behavior block", () => {
    const first = [
      "<GATEWAY_BEHAVIOR_CONTRACT version=\"1\" hash=\"old\">",
      "- KEEP: old",
      "</GATEWAY_BEHAVIOR_CONTRACT>",
      "",
      "# Role: Gateway",
    ].join("\n")

    const block = renderGatewayBehaviorContractBlock({
      version: 3,
      hash: "newhash",
      directives: [{ type: "stop", text: "old pattern" }],
    })

    const injected = injectGatewayBehaviorContract(first, block)
    const stripped = stripGatewayBehaviorContract(injected.systemPrompt)

    expect(injected.systemPrompt.match(/<GATEWAY_BEHAVIOR_CONTRACT/g)?.length ?? 0).toBe(1)
    expect(stripped).not.toContain("<GATEWAY_BEHAVIOR_CONTRACT")
  })
})
