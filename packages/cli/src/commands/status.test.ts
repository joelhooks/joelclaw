import { expect, test } from "bun:test"
import { existsSync } from "node:fs"

import { __statusTestables } from "./status"

test("status can resolve the agent-dispatch canary script path", () => {
  const scriptPath = __statusTestables.resolveAgentDispatchCanaryScriptPath()

  expect(scriptPath.endsWith("scripts/verify-agent-dispatch-timeout.ts")).toBe(true)
  expect(existsSync(scriptPath)).toBe(true)
})
