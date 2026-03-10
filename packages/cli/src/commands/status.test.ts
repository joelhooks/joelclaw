import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { __statusTestables } from "./status"

test("status can resolve the agent-dispatch canary script path", () => {
  const scriptPath = __statusTestables.resolveAgentDispatchCanaryScriptPath()

  expect(scriptPath.endsWith("scripts/verify-agent-dispatch-timeout.ts")).toBe(true)
  expect(existsSync(scriptPath)).toBe(true)
})

test("status can read the latest persisted agent-dispatch canary summary", () => {
  const inboxDir = mkdtempSync(join(tmpdir(), "status-canary-inbox-"))

  try {
    writeFileSync(
      join(inboxDir, "agent-dispatch-timeout-old.json"),
      JSON.stringify({
        requestId: "agent-dispatch-timeout-old",
        status: "failed",
        updatedAt: "2026-03-10T04:00:00.000Z",
        error: "old timeout",
        localSandbox: { sandboxId: "old-sandbox" },
      }),
    )
    writeFileSync(
      join(inboxDir, "health-agent-dispatch-timeout-new.json"),
      JSON.stringify({
        requestId: "health-agent-dispatch-timeout-new",
        status: "failed",
        updatedAt: "2026-03-10T05:00:00.000Z",
        error: "scheduled timeout",
        localSandbox: { sandboxId: "new-sandbox" },
      }),
    )

    const latest = __statusTestables.readLatestAgentDispatchCanarySummary(inboxDir)

    expect(latest).toEqual({
      requestId: "health-agent-dispatch-timeout-new",
      mode: "scheduled",
      status: "failed",
      updatedAt: "2026-03-10T05:00:00.000Z",
      error: "scheduled timeout",
      sandboxId: "new-sandbox",
    })
  } finally {
    rmSync(inboxDir, { recursive: true, force: true })
  }
})
