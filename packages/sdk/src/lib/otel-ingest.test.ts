import { afterEach, describe, expect, test } from "bun:test"
import { createOtelEventPayload } from "./otel-ingest"

const ORIGINAL_ENV = { ...process.env }

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

afterEach(() => {
  resetEnv()
})

describe("createOtelEventPayload", () => {
  test("falls back to role-aware session and hostname-derived system provenance", () => {
    delete process.env.SLOG_SESSION_ID
    delete process.env.SLOG_SYSTEM_ID
    delete process.env.JOELCLAW_SESSION_ID
    delete process.env.JOELCLAW_SESSION_HANDLE
    delete process.env.PI_SESSION_HANDLE
    delete process.env.JOELCLAW_SYSTEM_ID
    process.env.JOELCLAW_ROLE = "system"

    const payload = createOtelEventPayload({
      action: "test.emit",
      source: "cli",
      component: "otel-cli",
      level: "info",
      success: true,
    })

    expect(payload.sessionId).toBe("system")
    expect(payload.systemId).toBe("panda")
  })

  test("prefers explicit slog provenance when present", () => {
    process.env.SLOG_SESSION_ID = "LuckyWombat"
    process.env.SLOG_SYSTEM_ID = "panda"
    process.env.JOELCLAW_ROLE = "system"

    const payload = createOtelEventPayload({
      action: "test.emit",
      source: "cli",
      component: "otel-cli",
      level: "info",
      success: true,
    })

    expect(payload.sessionId).toBe("LuckyWombat")
    expect(payload.systemId).toBe("panda")
  })
})
