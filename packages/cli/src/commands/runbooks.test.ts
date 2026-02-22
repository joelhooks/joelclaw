import { describe, expect, test } from "bun:test"
import { getRunbook, listRunbookCodes, resolveRunbookCommand, resolveRunbookPhase } from "../runbooks"

describe("runbook registry", () => {
  test("lists deterministic runbook codes", () => {
    const codes = listRunbookCodes()
    expect(codes.length).toBeGreaterThan(0)
    expect(codes).toContain("TYPESENSE_UNREACHABLE")
    expect(codes).toContain("INVALID_JSON")
  })

  test("resolves placeholders from context", () => {
    const resolved = resolveRunbookCommand("joelclaw run <run-id>", { "run-id": "01TEST" })
    expect(resolved).toBe("joelclaw run 01TEST")
  })

  test("keeps missing placeholders unresolved for dry-run visibility", () => {
    const resolved = resolveRunbookCommand("joelclaw run <run-id>", {})
    expect(resolved).toBe("joelclaw run <run-id>")
  })

  test("returns runbook phase command entries", () => {
    const runbook = getRunbook("RUN_FAILED")
    expect(runbook).toBeTruthy()
    if (!runbook) return

    const steps = resolveRunbookPhase(runbook, "diagnose", { "run-id": "01ABC" })
    expect(steps.length).toBeGreaterThan(0)
    expect(steps[0]?.resolvedCommand.length).toBeGreaterThan(0)
  })
})
