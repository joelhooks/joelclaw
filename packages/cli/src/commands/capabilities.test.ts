import { describe, expect, test } from "bun:test"
import { buildSuccessEnvelope, validateJoelclawEnvelope } from "../response"
import { buildCapabilitiesCatalog, CAPABILITY_FLOWS } from "./capabilities"

describe("capabilities catalog", () => {
  test("contains required navigation flows with unique IDs", () => {
    const ids = CAPABILITY_FLOWS.map((flow) => flow.id)
    const unique = new Set(ids)

    expect(unique.size).toBe(ids.length)
    expect(ids).toContain("system-health")
    expect(ids).toContain("operator-signals")
    expect(ids).toContain("run-failure-triage")
    expect(ids).toContain("gateway-operations")
    expect(ids).toContain("memory-health")
  })

  test("every flow includes commands and verification checks", () => {
    for (const flow of CAPABILITY_FLOWS) {
      expect(flow.goal.length).toBeGreaterThan(0)
      expect(flow.commands.length).toBeGreaterThan(0)
      expect(flow.verification.length).toBeGreaterThan(0)

      for (const command of flow.commands) {
        expect(command.command.length).toBeGreaterThan(0)
        expect(command.description.length).toBeGreaterThan(0)
      }
    }
  })

  test("catalog can be wrapped in valid HATEOAS envelope", () => {
    const catalog = buildCapabilitiesCatalog()
    const envelope = buildSuccessEnvelope(
      "capabilities",
      catalog,
      [{ command: "status", description: "Check health" }]
    )

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    expect(catalog.capabilityContract.configuredCount).toBeGreaterThan(0)
    expect(catalog.capabilityContract.registryEntries).toBeGreaterThanOrEqual(3)
  })
})
