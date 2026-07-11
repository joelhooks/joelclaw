import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

import { validateJoelclawEnvelope } from "../../response"
import { fleetStatusResponse, type FleetStatusDependencies } from "./index"
import type { FleetManifest } from "./manifest"

const manifest: FleetManifest = {
  version: 1,
  hosts: [
    { alias: "central", sshTarget: "central.invalid", expectedHostname: "central-host", role: "central" },
    { alias: "satellite", sshTarget: "satellite.invalid", expectedHostname: "satellite-host", role: "satellite" },
  ],
}

const successfulProbe: FleetStatusDependencies["probeHost"] = (host) => ({
  alias: host.alias,
  expectedHostname: host.expectedHostname,
  role: host.role,
  facts: { hostname: host.expectedHostname },
  failures: [],
  ok: true,
})

function dependencies(probeHost = successfulProbe): FleetStatusDependencies {
  return { loadManifest: () => manifest, probeHost }
}

function parseEnvelope(output: string): Record<string, any> {
  const envelope = JSON.parse(output)
  const validation = validateJoelclawEnvelope(envelope)
  expect(validation.valid).toBe(true)
  return envelope
}

test("fleet status returns every declared host through injected dependencies", () => {
  const envelope = parseEnvelope(fleetStatusResponse({ config: "/private/fleet.json" }, dependencies()))

  expect(envelope.ok).toBe(true)
  expect(envelope.command).toBe("joelclaw fleet status")
  expect(envelope.result.hostCount).toBe(2)
  expect(envelope.result.hosts.map((host: { alias: string }) => host.alias)).toEqual(["central", "satellite"])
})

test("fleet status does not expose a supplied private config path", () => {
  const privateConfigPath = "/private/joelclaw/fleet-private-routing.json"
  const envelope = parseEnvelope(fleetStatusResponse(
    { config: privateConfigPath },
    {
      loadManifest: () => {
        throw new Error(`could not load ${privateConfigPath}`)
      },
      probeHost: successfulProbe,
    },
  ))

  expect(envelope.ok).toBe(false)
  expect(envelope.error.code).toBe("FLEET_MANIFEST_INVALID")
  expect(JSON.stringify(envelope)).not.toContain(privateConfigPath)
})

test("fleet status rejects an unknown host before probing", () => {
  let probeCount = 0
  const envelope = parseEnvelope(fleetStatusResponse(
    { config: "/private/fleet.json", host: "missing" },
    dependencies(() => {
      probeCount += 1
      throw new Error("must not probe unknown host")
    }),
  ))

  expect(envelope.ok).toBe(false)
  expect(envelope.error.code).toBe("FLEET_HOST_UNKNOWN")
  expect(probeCount).toBe(0)
})

test("fleet status keeps partial remote failure in its envelope", () => {
  const envelope = parseEnvelope(fleetStatusResponse(
    { config: "/private/fleet.json" },
    dependencies((host) => host.alias === "satellite"
      ? {
          alias: host.alias,
          expectedHostname: host.expectedHostname,
          role: host.role,
          facts: {},
          failures: [{ probe: "ssh", code: "ssh_failed", detail: "connection refused" }],
          ok: false,
        }
      : successfulProbe(host)),
  ))

  expect(envelope.ok).toBe(false)
  expect(envelope.result.failedCount).toBe(1)
  expect(envelope.result.hosts[1].failures[0].code).toBe("ssh_failed")
})

test("CLI registers fleet status and rejects an unknown host without probing a real machine", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-cli-"))
  const configPath = join(dir, "fleet.json")
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    hosts: [{
      alias: "fixture",
      sshTarget: "fixture.invalid",
      expectedHostname: "fixture-host",
      role: "central",
    }],
  }))

  try {
    const proc = spawnSync("bun", ["run", resolve(process.cwd(), "packages/cli/src/cli.ts"), "fleet", "status", "--config", configPath, "--host", "missing"], {
      cwd: resolve(process.cwd()),
      encoding: "utf8",
    })

    expect(proc.status).toBe(0)
    expect(proc.stderr.trim()).toBe("")
    const envelope = parseEnvelope(proc.stdout.trim())
    expect(envelope.command).toBe("joelclaw fleet status")
    expect(envelope.error.code).toBe("FLEET_HOST_UNKNOWN")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("CLI normalizes an omitted optional host before probing the declared manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-cli-omitted-host-"))
  const configPath = join(dir, "fleet.json")
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    hosts: [{
      alias: "fixture",
      sshTarget: "fixture.invalid",
      expectedHostname: "fixture-host",
      role: "central",
    }],
  }))

  try {
    for (const command of ["status", "diff"]) {
      const proc = spawnSync("bun", ["run", resolve(process.cwd(), "packages/cli/src/cli.ts"), "fleet", command, "--config", configPath], {
        cwd: resolve(process.cwd()),
        encoding: "utf8",
        timeout: 10_000,
      })

      expect(proc.status).toBe(0)
      expect(proc.stderr.trim()).toBe("")
      const envelope = parseEnvelope(proc.stdout.trim())
      expect(envelope.command).toBe(`joelclaw fleet ${command}`)
      expect(envelope.error?.code).not.toBe("FLEET_HOST_UNKNOWN")
      expect(envelope.result.hostCount).toBe(1)
      expect(envelope.result.hosts[0].alias).toBe("fixture")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
