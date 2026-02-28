import { describe, expect, test } from "bun:test"
import { __contentTestUtils } from "./content"

describe("content command helpers", () => {
  test("exposes prune command in content command map", () => {
    expect(__contentTestUtils.CONTENT_COMMANDS.prune).toContain("Dry-run")
  })

  test("prune dry-run suggests apply action", () => {
    const actions = __contentTestUtils.buildPruneNextActions(false)
    expect(actions.map((action) => action.command)).toContain("joelclaw content prune --apply")
  })

  test("prune apply suggests verify follow-up", () => {
    const actions = __contentTestUtils.buildPruneNextActions(true)
    expect(actions.map((action) => action.command)).toContain("joelclaw content verify")
  })
})
