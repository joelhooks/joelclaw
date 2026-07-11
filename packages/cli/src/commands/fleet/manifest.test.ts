import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FleetManifestError, loadFleetManifest, parseFleetManifest } from "./manifest"

const fixtures = join(import.meta.dir, "fixtures")

test("loads a redacted role-aware manifest from an explicit local path", () => {
  const manifest = loadFleetManifest(join(fixtures, "valid-fleet.json"))

  expect(manifest.hosts.map((host) => host.role)).toEqual(["central", "central-shadow", "satellite"])
  expect(manifest.hosts[2]?.exemptions).toEqual([
    { field: "skills.fingerprint", reason: "thin satellite fixture" },
  ])
})

test("rejects invalid roles before a probe can run", () => {
  expect(() => loadFleetManifest(join(fixtures, "invalid-fleet.json"))).toThrow(FleetManifestError)
  expect(() => loadFleetManifest(join(fixtures, "invalid-fleet.json"))).toThrow("hosts[1].role")
})

test("rejects duplicate aliases", () => {
  expect(() => parseFleetManifest({
    version: 1,
    hosts: [
      { alias: "same", sshTarget: "one-fixture.invalid", expectedHostname: "one-example", role: "central" },
      { alias: "same", sshTarget: "two-fixture.invalid", expectedHostname: "two-example", role: "satellite" },
    ],
  })).toThrow("duplicate alias")
})

test("reports the private local config path when no manifest exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-manifest-"))
  const path = join(dir, "fleet.json")

  try {
    expect(() => loadFleetManifest(path)).toThrow("create local private config at ~/.config/joelclaw/fleet.json")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("reports malformed local JSON without exposing its content", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-manifest-"))
  const path = join(dir, "fleet.json")
  writeFileSync(path, "{not-json", "utf8")

  try {
    expect(() => loadFleetManifest(path)).toThrow("could not parse fleet manifest")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
