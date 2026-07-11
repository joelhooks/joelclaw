import { describe, expect, test } from "bun:test"

import type { FleetHostExpectation } from "./manifest"
import { probeFleetHost, SSH_COMMAND_TIMEOUT_MS } from "./probe"

const host = (overrides: Partial<FleetHostExpectation> = {}): FleetHostExpectation => ({
  alias: "central",
  sshTarget: "central-fixture.invalid",
  expectedHostname: "central-example",
  role: "central",
  ...overrides,
})

const successfulOutput = [
  "hostname=central-example",
  "piVersion=0.80.6",
  "modelThinking=gpt-5.6-sol|high",
  "skillsFingerprint=12345",
  "cliVersion=1.2.3",
].join("\n")

describe("probeFleetHost", () => {
  test("collects one host through fixed SSH argv", () => {
    let call: { command: string; args: readonly string[]; timeoutMs: number } | undefined
    const result = probeFleetHost(host(), (command, args, timeoutMs) => {
      call = { command, args, timeoutMs }
      return { ok: true, stdout: successfulOutput, stderr: "" }
    })

    expect(result).toEqual({
      alias: "central",
      expectedHostname: "central-example",
      role: "central",
      facts: {
        hostname: "central-example",
        piVersion: "0.80.6",
        model: "gpt-5.6-sol",
        thinking: "high",
        skillsFingerprint: "12345",
        cliVersion: "1.2.3",
      },
      failures: [],
      ok: true,
    })
    expect(call).toMatchObject({ command: "ssh", timeoutMs: SSH_COMMAND_TIMEOUT_MS })
    expect(call?.args).toContain("--")
    expect(call?.args).toContain("central-fixture.invalid")
    expect(call?.args.join(" ")).not.toContain("central-example")
  })

  test("returns a generic SSH failure without exposing the target or credentials", () => {
    const privateTarget = "private-fleet-host.tailnet.example"
    const secretLikeStderr = `Could not resolve hostname ${privateTarget}: token=super-secret password=hunter2`
    const result = probeFleetHost(host({ sshTarget: privateTarget }), () => ({ ok: false, stdout: "", stderr: secretLikeStderr }))

    expect(result.ok).toBe(false)
    expect(result.facts).toEqual({})
    expect(result.failures[0]).toEqual({ probe: "ssh", code: "ssh_failed", detail: "SSH command failed" })
    expect(JSON.stringify(result)).not.toContain(privateTarget)
    expect(JSON.stringify(result)).not.toContain("super-secret")
    expect(JSON.stringify(result)).not.toContain("hunter2")
  })

  test("returns timeout without attempting a fallback transport", () => {
    const result = probeFleetHost(host(), () => ({ ok: false, stdout: "", stderr: "timed out", timedOut: true }))

    expect(result.failures).toEqual([{ probe: "ssh", code: "timeout", detail: "SSH command timed out" }])
  })

  test("makes identity mismatch actionable drift data", () => {
    const result = probeFleetHost(host(), () => ({
      ok: true,
      stdout: successfulOutput.replace("hostname=central-example", "hostname=wrong-example"),
      stderr: "",
    }))

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({
      probe: "hostname",
      code: "identity_mismatch",
      detail: "expected central-example, observed wrong-example",
    })
  })

  test("returns partial facts and satellite health without failing closed", () => {
    const result = probeFleetHost(host({ role: "satellite" }), () => ({
      ok: true,
      stdout: ["hostname=central-example", "skillsFingerprint=123", "cliVersion=1.2.3", "satelliteHealth=ok"].join("\n"),
      stderr: "",
    }))

    expect(result.facts).toEqual({
      hostname: "central-example",
      skillsFingerprint: "123",
      cliVersion: "1.2.3",
      satelliteHealth: "ok",
    })
    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({
      probe: "piVersion",
      code: "unavailable",
      detail: "piVersion was unavailable from the remote host",
    })
  })
})
