import { respond, respondError } from "../../response"
import type { FleetHostExpectation, FleetManifest } from "./manifest"
import type { FleetHostProbeResult } from "./probe"
import type { FleetStatusDependencies } from "./index"

export type FleetDiffClassification = "in_sync" | "expected_difference" | "drift" | "unavailable"

export type FleetFieldDiff = {
  readonly field: string
  readonly expected: string
  readonly observed?: string
  readonly classification: FleetDiffClassification
  readonly exemptionReason?: string
}

export type FleetHostDiff = {
  readonly alias: string
  readonly role: FleetHostExpectation["role"]
  readonly fields: readonly FleetFieldDiff[]
  readonly failures: FleetHostProbeResult["failures"]
  readonly ok: boolean
}

type ExpectedField = {
  readonly field: string
  readonly expected: string
  readonly observed?: string
}

function expectedFields(host: FleetHostExpectation, probe: FleetHostProbeResult): readonly ExpectedField[] {
  return [
    { field: "hostname", expected: host.expectedHostname, observed: probe.facts.hostname },
    ...(host.harness?.piVersion ? [{ field: "harness.piVersion", expected: host.harness.piVersion, observed: probe.facts.piVersion }] : []),
    ...(host.harness?.model ? [{ field: "harness.model", expected: host.harness.model, observed: probe.facts.model }] : []),
    ...(host.harness?.thinking ? [{ field: "harness.thinking", expected: host.harness.thinking, observed: probe.facts.thinking }] : []),
    ...(host.harness?.cliVersion ? [{ field: "harness.cliVersion", expected: host.harness.cliVersion, observed: probe.facts.cliVersion }] : []),
    ...(host.skills?.fingerprint ? [{ field: "skills.fingerprint", expected: host.skills.fingerprint, observed: probe.facts.skillsFingerprint }] : []),
    ...(host.role === "satellite" ? [{ field: "satelliteHealth", expected: "ok", observed: probe.facts.satelliteHealth }] : []),
  ]
}

function diffField(host: FleetHostExpectation, field: ExpectedField): FleetFieldDiff {
  const exemptionReason = host.exemptions?.find((exemption) => exemption.field === field.field)?.reason
  if (field.observed === field.expected) {
    return { ...field, classification: "in_sync" }
  }
  if (exemptionReason) {
    return { ...field, classification: "expected_difference", exemptionReason }
  }
  if (field.observed === undefined) {
    return { ...field, classification: "unavailable" }
  }
  return { ...field, classification: "drift" }
}

export function diffFleetHost(host: FleetHostExpectation, probe: FleetHostProbeResult): FleetHostDiff {
  const fields = expectedFields(host, probe).map((field) => diffField(host, field))
  const identityMismatch = probe.failures.some((failure) => failure.code === "identity_mismatch")
  const actionable = identityMismatch || fields.some((field) => field.classification === "drift" || field.classification === "unavailable")

  return {
    alias: host.alias,
    role: host.role,
    fields,
    failures: probe.failures,
    ok: !actionable,
  }
}

function selectHosts(manifest: FleetManifest, host: string | undefined): readonly FleetHostExpectation[] {
  return host ? manifest.hosts.filter((candidate) => candidate.alias === host) : manifest.hosts
}

export function fleetDiffResponse(
  input: { readonly config: string; readonly host?: string },
  dependencies: FleetStatusDependencies,
): string {
  let manifest: FleetManifest
  try {
    manifest = dependencies.loadManifest(input.config)
  } catch {
    return respondError(
      "fleet diff",
      "Could not load the local fleet manifest",
      "FLEET_MANIFEST_INVALID",
      "Create or repair the private local fleet manifest; do not commit it.",
      [{ command: "fleet status", description: "Inspect the local fleet manifest and read-only host inventory" }],
    )
  }

  const hosts = selectHosts(manifest, input.host)
  if (input.host && hosts.length === 0) {
    return respondError(
      "fleet diff",
      `Unknown fleet host alias: ${input.host}`,
      "FLEET_HOST_UNKNOWN",
      "Choose an alias declared in the private local fleet manifest.",
      [{ command: "fleet status", description: "Inspect all declared fleet hosts" }],
    )
  }

  const results = hosts.map((host) => diffFleetHost(host, dependencies.probeHost(host)))
  const failed = results.filter((result) => !result.ok)

  return respond(
    "fleet diff",
    { hosts: results, hostCount: results.length, failedCount: failed.length },
    [{ command: "fleet status", description: "Refresh the read-only fleet inventory" }],
    failed.length === 0,
  )
}
