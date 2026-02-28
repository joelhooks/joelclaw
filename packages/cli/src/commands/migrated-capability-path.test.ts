import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { validateJoelclawEnvelope } from "../response"

const CLI_ENTRY = resolve(process.cwd(), "packages/cli/src/cli.ts")

function runCli(commandArgs: string[], env: Record<string, string>): unknown {
  const proc = spawnSync("bun", ["run", CLI_ENTRY, ...commandArgs], {
    cwd: resolve(process.cwd()),
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  })

  expect(proc.status).toBe(0)
  expect(proc.stderr.trim()).toBe("")

  const output = proc.stdout.trim()
  expect(output.length).toBeGreaterThan(0)

  return JSON.parse(output)
}

describe("phase-4 command capability routing", () => {
  test("mail status routes through capability disable gate and keeps envelope", () => {
    const envelope = runCli(["mail", "status"], {
      JOELCLAW_CAPABILITY_MAIL_ENABLED: "0",
    }) as Record<string, any>

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe("CAPABILITY_DISABLED")
    expect(String(envelope.command)).toBe("joelclaw mail status")
  })

  test("otel list routes through capability disable gate and keeps envelope", () => {
    const envelope = runCli(["otel", "list"], {
      JOELCLAW_CAPABILITY_OTEL_ENABLED: "false",
    }) as Record<string, any>

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe("CAPABILITY_DISABLED")
    expect(String(envelope.command)).toBe("joelclaw otel list")
  })

  test("recall routes through capability disable gate and keeps envelope", () => {
    const envelope = runCli(["recall", "capability route check"], {
      JOELCLAW_CAPABILITY_RECALL_ENABLED: "off",
    }) as Record<string, any>

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe("CAPABILITY_DISABLED")
    expect(String(envelope.command)).toBe("joelclaw recall")
  })

  test("subscribe list routes through capability disable gate and keeps envelope", () => {
    const envelope = runCli(["subscribe", "list"], {
      JOELCLAW_CAPABILITY_SUBSCRIBE_ENABLED: "no",
    }) as Record<string, any>

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe("CAPABILITY_DISABLED")
    expect(String(envelope.command)).toBe("joelclaw subscribe list")
  })
})
