import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_FLEET_CONFIG_PATH = join(homedir(), ".config", "joelclaw", "fleet.json")

export const fleetRoles = ["central", "central-shadow", "satellite"] as const
export type FleetRole = typeof fleetRoles[number]

export interface FleetHostExpectation {
  readonly alias: string
  /** Local-only SSH routing from ~/.config/joelclaw/fleet.json. */
  readonly sshTarget: string
  readonly expectedHostname: string
  readonly role: FleetRole
  readonly harness?: {
    readonly piVersion?: string
    readonly model?: string
    readonly thinking?: string
    readonly cliVersion?: string
  }
  readonly skills?: {
    readonly fingerprint?: string
  }
  readonly exemptions?: readonly {
    readonly field: string
    readonly reason: string
  }[]
}

export interface FleetManifest {
  readonly version: 1
  readonly hosts: readonly FleetHostExpectation[]
}

export class FleetManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FleetManifestError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FleetManifestError(`${path} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, path)
}

function parseHost(value: unknown, index: number): FleetHostExpectation {
  const path = `hosts[${index}]`
  if (!isRecord(value)) throw new FleetManifestError(`${path} must be an object`)

  const role = requiredString(value.role, `${path}.role`)
  if (!fleetRoles.includes(role as FleetRole)) {
    throw new FleetManifestError(`${path}.role must be one of: ${fleetRoles.join(", ")}`)
  }

  const harness = value.harness === undefined ? undefined : parseHarness(value.harness, `${path}.harness`)
  const skills = value.skills === undefined ? undefined : parseSkills(value.skills, `${path}.skills`)
  const exemptions = value.exemptions === undefined ? undefined : parseExemptions(value.exemptions, `${path}.exemptions`)

  return {
    alias: requiredString(value.alias, `${path}.alias`),
    sshTarget: requiredString(value.sshTarget, `${path}.sshTarget`),
    expectedHostname: requiredString(value.expectedHostname, `${path}.expectedHostname`),
    role: role as FleetRole,
    ...(harness ? { harness } : {}),
    ...(skills ? { skills } : {}),
    ...(exemptions ? { exemptions } : {}),
  }
}

function parseHarness(value: unknown, path: string): FleetHostExpectation["harness"] {
  if (!isRecord(value)) throw new FleetManifestError(`${path} must be an object`)
  return {
    ...(optionalString(value.piVersion, `${path}.piVersion`) ? { piVersion: optionalString(value.piVersion, `${path}.piVersion`) } : {}),
    ...(optionalString(value.model, `${path}.model`) ? { model: optionalString(value.model, `${path}.model`) } : {}),
    ...(optionalString(value.thinking, `${path}.thinking`) ? { thinking: optionalString(value.thinking, `${path}.thinking`) } : {}),
    ...(optionalString(value.cliVersion, `${path}.cliVersion`) ? { cliVersion: optionalString(value.cliVersion, `${path}.cliVersion`) } : {}),
  }
}

function parseSkills(value: unknown, path: string): FleetHostExpectation["skills"] {
  if (!isRecord(value)) throw new FleetManifestError(`${path} must be an object`)
  const fingerprint = optionalString(value.fingerprint, `${path}.fingerprint`)
  return fingerprint ? { fingerprint } : {}
}

function parseExemptions(value: unknown, path: string): FleetHostExpectation["exemptions"] {
  if (!Array.isArray(value)) throw new FleetManifestError(`${path} must be an array`)
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`
    if (!isRecord(item)) throw new FleetManifestError(`${itemPath} must be an object`)
    return {
      field: requiredString(item.field, `${itemPath}.field`),
      reason: requiredString(item.reason, `${itemPath}.reason`),
    }
  })
}

export function parseFleetManifest(value: unknown): FleetManifest {
  if (!isRecord(value)) throw new FleetManifestError("fleet manifest must be an object")
  if (value.version !== 1) throw new FleetManifestError("fleet manifest version must be 1")
  if (!Array.isArray(value.hosts) || value.hosts.length === 0) {
    throw new FleetManifestError("fleet manifest hosts must be a non-empty array")
  }

  const hosts = value.hosts.map(parseHost)
  const aliases = new Set<string>()
  for (const host of hosts) {
    if (aliases.has(host.alias)) throw new FleetManifestError(`fleet manifest has duplicate alias: ${host.alias}`)
    aliases.add(host.alias)
  }

  return { version: 1, hosts }
}

export function loadFleetManifest(path = DEFAULT_FLEET_CONFIG_PATH): FleetManifest {
  if (!existsSync(path)) {
    throw new FleetManifestError(`fleet manifest not found at ${path}; create local private config at ~/.config/joelclaw/fleet.json`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON"
    throw new FleetManifestError(`could not parse fleet manifest at ${path}: ${detail}`)
  }
  return parseFleetManifest(parsed)
}
