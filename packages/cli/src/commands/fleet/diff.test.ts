import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

import { validateJoelclawEnvelope } from "../../response"
import { fleetDiffResponse } from "./diff"
import type { FleetStatusDependencies } from "./index"
import type { FleetManifest } from "./manifest"

const manifest: FleetManifest = {
  version: 1,
  hosts: [{
    alias: "central",
    sshTarget: "central.invalid",
    expectedHostname: "central-host",
    role: "central",
    harness: { model: "gpt-5.6-sol", thinking: "high" },
    skills: { fingerprint: "expected-fingerprint" },
  }],
}

function dependencies(overrides: Partial<FleetStatusDependencies> = {}): FleetStatusDependencies {
  return {
    loadManifest: () => manifest,
    probeHost: (host) => ({
      alias: host.alias,
      expectedHostname: host.expectedHostname,
      role: host.role,
      facts: {
        hostname: "central-host",
        model: "gpt-5.6-sol",
        thinking: "high",
        skillsFingerprint: "expected-fingerprint",
      },
      failures: [],
      ok: true,
    }),
    ...overrides,
  }
}

function envelope(output: string): any {
  const parsed = JSON.parse(output)
  expect(validateJoelclawEnvelope(parsed).valid).toBe(true)
  return parsed
}

test("fleet diff marks matching declared fields in sync", () => {
  const result = envelope(fleetDiffResponse({ config: "/private/fleet.json" }, dependencies()))

  expect(result.ok).toBe(true)
  expect(result.result.hosts[0].fields).toEqual([
    { field: "hostname", expected: "central-host", observed: "central-host", classification: "in_sync" },
    { field: "harness.model", expected: "gpt-5.6-sol", observed: "gpt-5.6-sol", classification: "in_sync" },
    { field: "harness.thinking", expected: "high", observed: "high", classification: "in_sync" },
    { field: "skills.fingerprint", expected: "expected-fingerprint", observed: "expected-fingerprint", classification: "in_sync" },
  ])
})

test("fleet diff classifies exempted differences without failing the host", () => {
  const exemptManifest: FleetManifest = {
    ...manifest,
    hosts: [{
      ...manifest.hosts[0]!,
      role: "satellite",
      exemptions: [{ field: "skills.fingerprint", reason: "thin fixture policy" }],
    }],
  }
  const result = envelope(fleetDiffResponse({ config: "/private/fleet.json" }, dependencies({
    loadManifest: () => exemptManifest,
    probeHost: (host) => ({
      alias: host.alias,
      expectedHostname: host.expectedHostname,
      role: host.role,
      facts: { hostname: "central-host", model: "gpt-5.6-sol", thinking: "high", skillsFingerprint: "different", satelliteHealth: "ok" },
      failures: [],
      ok: true,
    }),
  })))

  expect(result.ok).toBe(true)
  expect(result.result.hosts[0].role).toBe("satellite")
  expect(result.result.hosts[0].fields).toContainEqual({
    field: "skills.fingerprint",
    expected: "expected-fingerprint",
    observed: "different",
    classification: "expected_difference",
    exemptionReason: "thin fixture policy",
  })
})

test("fleet diff makes failed satellite health actionable drift", () => {
  const satelliteManifest: FleetManifest = {
    ...manifest,
    hosts: [{ ...manifest.hosts[0]!, role: "satellite" }],
  }
  const result = envelope(fleetDiffResponse({ config: "/private/fleet.json" }, dependencies({
    loadManifest: () => satelliteManifest,
    probeHost: (host) => ({
      alias: host.alias,
      expectedHostname: host.expectedHostname,
      role: host.role,
      facts: { hostname: "central-host", model: "gpt-5.6-sol", thinking: "high", skillsFingerprint: "expected-fingerprint", satelliteHealth: "failed" },
      failures: [],
      ok: true,
    }),
  })))

  expect(result.ok).toBe(false)
  expect(result.result.hosts[0].fields).toContainEqual({
    field: "satelliteHealth",
    expected: "ok",
    observed: "failed",
    classification: "drift",
  })
})

test("fleet diff makes unavailable satellite health actionable", () => {
  const satelliteManifest: FleetManifest = {
    ...manifest,
    hosts: [{ ...manifest.hosts[0]!, role: "satellite" }],
  }
  const result = envelope(fleetDiffResponse({ config: "/private/fleet.json" }, dependencies({
    loadManifest: () => satelliteManifest,
    probeHost: (host) => ({
      alias: host.alias,
      expectedHostname: host.expectedHostname,
      role: host.role,
      facts: { hostname: "central-host", model: "gpt-5.6-sol", thinking: "high", skillsFingerprint: "expected-fingerprint" },
      failures: [{ probe: "satelliteHealth", code: "unavailable", detail: "satelliteHealth was unavailable from the remote host" }],
      ok: false,
    }),
  })))

  expect(result.ok).toBe(false)
  expect(result.result.hosts[0].fields).toContainEqual({
    field: "satelliteHealth",
    expected: "ok",
    classification: "unavailable",
  })
})

test("fleet diff treats hostname identity mismatch as actionable drift", () => {
  const result = envelope(fleetDiffResponse({ config: "/private/fleet.json" }, dependencies({
    probeHost: (host) => ({
      alias: host.alias,
      expectedHostname: host.expectedHostname,
      role: host.role,
      facts: { hostname: "wrong-host", model: "gpt-5.6-sol", thinking: "high", skillsFingerprint: "expected-fingerprint" },
      failures: [{ probe: "hostname", code: "identity_mismatch", detail: "expected central-host, observed wrong-host" }],
      ok: false,
    }),
  })))

  expect(result.ok).toBe(false)
  expect(result.result.hosts[0].ok).toBe(false)
  expect(result.result.hosts[0].fields).toContainEqual({
    field: "hostname",
    expected: "central-host",
    observed: "wrong-host",
    classification: "drift",
  })
})

test("fleet diff makes a missing required declared fact unavailable and actionable", () => {
  const result = envelope(fleetDiffResponse({ config: "/private/fleet.json" }, dependencies({
    probeHost: (host) => ({
      alias: host.alias,
      expectedHostname: host.expectedHostname,
      role: host.role,
      facts: { hostname: "central-host", thinking: "high", skillsFingerprint: "expected-fingerprint" },
      failures: [{ probe: "model", code: "unavailable", detail: "model was unavailable from the remote host" }],
      ok: false,
    }),
  })))

  expect(result.ok).toBe(false)
  expect(result.result.hosts[0].fields).toContainEqual({
    field: "harness.model",
    expected: "gpt-5.6-sol",
    classification: "unavailable",
  })
})

test("fleet diff rejects unknown aliases before probing", () => {
  let probes = 0
  const result = envelope(fleetDiffResponse({ config: "/private/fleet.json", host: "missing" }, dependencies({
    probeHost: () => {
      probes += 1
      throw new Error("must not probe")
    },
  })))

  expect(result.ok).toBe(false)
  expect(result.error.code).toBe("FLEET_HOST_UNKNOWN")
  expect(probes).toBe(0)
})

test("CLI registers fleet diff and rejects an unknown host without probing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-diff-cli-"))
  const configPath = join(dir, "fleet.json")
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    hosts: [{ alias: "fixture", sshTarget: "fixture.invalid", expectedHostname: "fixture-host", role: "central" }],
  }))

  try {
    const proc = spawnSync("bun", ["run", resolve(process.cwd(), "packages/cli/src/cli.ts"), "fleet", "diff", "--config", configPath, "--host", "missing"], {
      cwd: resolve(process.cwd()),
      encoding: "utf8",
    })
    expect(proc.status).toBe(0)
    expect(proc.stderr.trim()).toBe("")
    expect(envelope(proc.stdout.trim()).error.code).toBe("FLEET_HOST_UNKNOWN")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
