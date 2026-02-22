import { describe, expect, test } from "bun:test"
import {
  buildErrorEnvelope,
  buildSuccessEnvelope,
  validateJoelclawEnvelope,
} from "../response"

describe("CLI contract envelope", () => {
  test("success envelope is normalized and valid", () => {
    const envelope = buildSuccessEnvelope(
      "status",
      { server: { ok: true } },
      [
        { command: "runs", description: "Inspect recent runs" },
        {
          command: "run <run-id>",
          description: "Inspect one run",
          params: {
            "run-id": { description: "Run ID", value: "01ABC" },
          },
        },
      ]
    )

    expect(envelope.command).toBe("joelclaw status")
    expect(envelope.next_actions[0]?.command).toBe("joelclaw runs")
    expect(envelope.next_actions[1]?.command).toBe("joelclaw run <run-id>")

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
  })

  test("error envelope includes error metadata, fix, and recover action", () => {
    const envelope = buildErrorEnvelope(
      "search",
      "Typesense unavailable",
      "TYPESENSE_UNREACHABLE",
      "Check port-forward and retry",
      [{ command: "status", description: "Check all services" }]
    )

    expect(envelope.ok).toBe(false)
    expect(envelope.command).toBe("joelclaw search")
    expect(envelope.error?.code).toBe("TYPESENSE_UNREACHABLE")
    expect(envelope.fix).toBe("Check port-forward and retry")

    const recoverAction = envelope.next_actions.find((action) =>
      action.command.startsWith("joelclaw recover")
    )

    expect(recoverAction).toBeTruthy()
    expect(recoverAction?.params?.["error-code"]?.value).toBe("TYPESENSE_UNREACHABLE")

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
  })

  test("validator reports missing required fields", () => {
    const invalid = {
      ok: true,
      command: "",
      next_actions: [{ command: "", description: "" }],
    }

    const validation = validateJoelclawEnvelope(invalid)
    expect(validation.valid).toBe(false)
    expect(validation.errors).toContain("command must be non-empty string")
    expect(validation.errors).toContain("result field is required")
    expect(validation.errors).toContain("next_actions[0].command must be non-empty string")
    expect(validation.errors).toContain("next_actions[0].description must be non-empty string")
  })
})
