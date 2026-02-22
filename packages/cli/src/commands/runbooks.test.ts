import { describe, expect, test } from "bun:test"
import { ERROR_CODES } from "../error-codes"
import { getRunbook, listRunbookCodes, resolveRunbookCommand, resolveRunbookPhase } from "../runbooks"

describe("runbook registry", () => {
  test("covers the canonical top 20 error codes", () => {
    const codes = listRunbookCodes()
    expect(codes.length).toBe(ERROR_CODES.length)
    expect(codes.length).toBe(20)

    for (const code of ERROR_CODES) {
      expect(codes).toContain(code)
      expect(getRunbook(code)).toBeTruthy()
    }
  })

  test("every runbook has diagnose/fix/verify/rollback commands", () => {
    for (const code of ERROR_CODES) {
      const runbook = getRunbook(code)
      expect(runbook).toBeTruthy()
      if (!runbook) continue

      expect(runbook.phases.diagnose.length).toBeGreaterThan(0)
      expect(runbook.phases.fix.length).toBeGreaterThan(0)
      expect(runbook.phases.verify.length).toBeGreaterThan(0)
      expect(runbook.phases.rollback.length).toBeGreaterThan(0)
    }
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
