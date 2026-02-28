import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  CapabilityAdapterSettings,
  CapabilityAdapterValue,
  CapabilityConfigSource,
  JoelclawCapabilitiesConfig,
  ResolvedCapabilityConfig,
} from "./contract"

type PartialCapabilityConfig = {
  enabled?: boolean
  adapter?: string
  adapters?: Record<string, CapabilityAdapterSettings>
}

export interface CapabilityFlagsOverride {
  readonly enabled?: boolean
  readonly adapter?: string
}

export interface CapabilityConfigResolveOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly flags?: Record<string, CapabilityFlagsOverride | undefined>
  readonly projectConfigPath?: string
  readonly userConfigPath?: string
}

export const DEFAULT_CAPABILITY_CONFIG: Record<string, Omit<ResolvedCapabilityConfig, "source">> = {
  otel: { enabled: true, adapter: "typesense-otel", adapters: {} },
  recall: { enabled: true, adapter: "typesense-recall", adapters: {} },
  secrets: { enabled: true, adapter: "agent-secrets-cli", adapters: {} },
  mail: { enabled: false, adapter: "mcp-agent-mail", adapters: {} },
  deploy: { enabled: true, adapter: "scripted-deploy", adapters: {} },
  notify: { enabled: true, adapter: "gateway-redis", adapters: {} },
  heal: { enabled: true, adapter: "runbook-heal", adapters: {} },
  log: { enabled: true, adapter: "slog-cli", adapters: {} },
  subscribe: { enabled: true, adapter: "redis-subscriptions", adapters: {} },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeCapabilityName(value: string): string {
  return value.trim().toLowerCase()
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return undefined
}

function parseTomlScalar(raw: string): CapabilityAdapterValue | null {
  const value = raw.trim()
  if (!value) return null

  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  if (value === "true") return true
  if (value === "false") return false

  const asNumber = Number.parseFloat(value)
  if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) return asNumber

  return value
}

function stripComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (char === "\"" && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, i)
    }
  }
  return line
}

function setNestedValue(target: Record<string, unknown>, path: string[], key: string, value: CapabilityAdapterValue): void {
  let cursor: Record<string, unknown> = target
  for (const segment of path) {
    const current = cursor[segment]
    if (!isRecord(current)) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[key] = value
}

/**
 * Minimal TOML parser for phase 0.
 * TODO(ADR-0169): replace with full TOML parser once capability config grows.
 */
export function parseMinimalToml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let currentSection: string[] = []

  for (const rawLine of input.split("\n")) {
    const cleaned = stripComment(rawLine).trim()
    if (!cleaned) continue

    if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
      const section = cleaned.slice(1, -1).trim()
      if (!section) continue
      currentSection = section.split(".").map((segment) => segment.trim()).filter(Boolean)
      continue
    }

    const separator = cleaned.indexOf("=")
    if (separator <= 0) continue

    const key = cleaned.slice(0, separator).trim()
    const rawValue = cleaned.slice(separator + 1).trim()
    if (!key || !rawValue) continue

    const parsed = parseTomlScalar(rawValue)
    if (parsed === null) continue

    setNestedValue(root, currentSection, key, parsed)
  }

  return root
}

function safeReadToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return parseMinimalToml(readFileSync(path, "utf-8"))
  } catch {
    return {}
  }
}

function asAdapterSettingsRecord(value: unknown): Record<string, CapabilityAdapterSettings> {
  if (!isRecord(value)) return {}
  const result: Record<string, CapabilityAdapterSettings> = {}

  for (const [adapterName, adapterConfig] of Object.entries(value)) {
    if (!isRecord(adapterConfig)) continue
    const settings: Record<string, CapabilityAdapterValue> = {}

    for (const [key, raw] of Object.entries(adapterConfig)) {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        settings[key] = raw
      }
    }

    result[adapterName] = settings
  }

  return result
}

function extractCapabilitiesConfig(document: Record<string, unknown>): Record<string, PartialCapabilityConfig> {
  const capabilities = isRecord(document.capabilities) ? document.capabilities : {}
  const parsed: Record<string, PartialCapabilityConfig> = {}

  for (const [nameRaw, payload] of Object.entries(capabilities)) {
    if (!isRecord(payload)) continue
    const name = normalizeCapabilityName(nameRaw)
    parsed[name] = {
      ...(typeof payload.enabled === "boolean" ? { enabled: payload.enabled } : {}),
      ...(typeof payload.adapter === "string" && payload.adapter.trim().length > 0
        ? { adapter: payload.adapter.trim() }
        : {}),
      adapters: asAdapterSettingsRecord(payload.adapters),
    }
  }

  return parsed
}

function cloneAdapters(adapters: Record<string, CapabilityAdapterSettings>): Record<string, CapabilityAdapterSettings> {
  return Object.fromEntries(
    Object.entries(adapters).map(([name, settings]) => [name, { ...settings }])
  )
}

function mergeAdapterSettings(
  base: Record<string, CapabilityAdapterSettings>,
  incoming: Record<string, CapabilityAdapterSettings> | undefined,
): Record<string, CapabilityAdapterSettings> {
  const merged = cloneAdapters(base)
  if (!incoming) return merged

  for (const [adapter, config] of Object.entries(incoming)) {
    merged[adapter] = {
      ...(merged[adapter] ?? {}),
      ...config,
    }
  }

  return merged
}

function listCapabilityNames(
  defaults: Record<string, Omit<ResolvedCapabilityConfig, "source">>,
  user: Record<string, PartialCapabilityConfig>,
  project: Record<string, PartialCapabilityConfig>,
  env: Record<string, string | undefined>,
  flags: Record<string, CapabilityFlagsOverride | undefined>,
): string[] {
  const names = new Set<string>([
    ...Object.keys(defaults),
    ...Object.keys(user),
    ...Object.keys(project),
    ...Object.keys(flags).map(normalizeCapabilityName),
  ])

  for (const key of Object.keys(env)) {
    const adapterMatch = key.match(/^JOELCLAW_CAPABILITY_([A-Z0-9_]+)_ADAPTER$/u)
    if (adapterMatch?.[1]) {
      names.add(normalizeCapabilityName(adapterMatch[1].replaceAll("_", "-")))
      continue
    }

    const enabledMatch = key.match(/^JOELCLAW_CAPABILITY_([A-Z0-9_]+)_ENABLED$/u)
    if (enabledMatch?.[1]) {
      names.add(normalizeCapabilityName(enabledMatch[1].replaceAll("_", "-")))
    }
  }

  return [...names].sort()
}

function envCapabilityKey(capability: string, suffix: "ENABLED" | "ADAPTER"): string {
  const normalized = capability.replaceAll("-", "_").toUpperCase()
  return `JOELCLAW_CAPABILITY_${normalized}_${suffix}`
}

function resolveEnabled(
  capability: string,
  defaults: boolean,
  user: PartialCapabilityConfig | undefined,
  project: PartialCapabilityConfig | undefined,
  env: Record<string, string | undefined>,
  flags: CapabilityFlagsOverride | undefined,
): { value: boolean; source: CapabilityConfigSource } {
  let value = defaults
  let source: CapabilityConfigSource = "default"

  if (typeof user?.enabled === "boolean") {
    value = user.enabled
    source = "user"
  }

  if (typeof project?.enabled === "boolean") {
    value = project.enabled
    source = "project"
  }

  const envValue = parseBoolean(env[envCapabilityKey(capability, "ENABLED")])
  if (typeof envValue === "boolean") {
    value = envValue
    source = "env"
  }

  if (typeof flags?.enabled === "boolean") {
    value = flags.enabled
    source = "flag"
  }

  return { value, source }
}

function resolveAdapter(
  capability: string,
  defaults: string,
  user: PartialCapabilityConfig | undefined,
  project: PartialCapabilityConfig | undefined,
  env: Record<string, string | undefined>,
  flags: CapabilityFlagsOverride | undefined,
): { value: string; source: CapabilityConfigSource } {
  let value = defaults
  let source: CapabilityConfigSource = "default"

  if (typeof user?.adapter === "string" && user.adapter.trim().length > 0) {
    value = user.adapter.trim()
    source = "user"
  }

  if (typeof project?.adapter === "string" && project.adapter.trim().length > 0) {
    value = project.adapter.trim()
    source = "project"
  }

  const envValue = env[envCapabilityKey(capability, "ADAPTER")]?.trim()
  if (envValue) {
    value = envValue
    source = "env"
  }

  if (typeof flags?.adapter === "string" && flags.adapter.trim().length > 0) {
    value = flags.adapter.trim()
    source = "flag"
  }

  return { value, source }
}

export function resolveCapabilitiesConfig(options: CapabilityConfigResolveOptions = {}): JoelclawCapabilitiesConfig {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const projectConfigPath = options.projectConfigPath ?? join(cwd, ".joelclaw", "config.toml")
  const userConfigPath = options.userConfigPath ?? join(homedir(), ".joelclaw", "config.toml")
  const flags = Object.fromEntries(
    Object.entries(options.flags ?? {}).map(([name, value]) => [normalizeCapabilityName(name), value])
  )

  const userConfig = extractCapabilitiesConfig(safeReadToml(userConfigPath))
  const projectConfig = extractCapabilitiesConfig(safeReadToml(projectConfigPath))

  const capabilities: Record<string, ResolvedCapabilityConfig> = {}
  const names = listCapabilityNames(DEFAULT_CAPABILITY_CONFIG, userConfig, projectConfig, env, flags)

  for (const capability of names) {
    const normalizedName = normalizeCapabilityName(capability)
    const defaults = DEFAULT_CAPABILITY_CONFIG[normalizedName] ?? {
      enabled: true,
      adapter: "unconfigured",
      adapters: {},
    }

    const enabled = resolveEnabled(
      normalizedName,
      defaults.enabled,
      userConfig[normalizedName],
      projectConfig[normalizedName],
      env,
      flags[normalizedName],
    )

    const adapter = resolveAdapter(
      normalizedName,
      defaults.adapter,
      userConfig[normalizedName],
      projectConfig[normalizedName],
      env,
      flags[normalizedName],
    )

    const adapters = mergeAdapterSettings(
      mergeAdapterSettings(defaults.adapters, userConfig[normalizedName]?.adapters),
      projectConfig[normalizedName]?.adapters,
    )

    capabilities[normalizedName] = {
      enabled: enabled.value,
      adapter: adapter.value,
      adapters,
      source: {
        enabled: enabled.source,
        adapter: adapter.source,
      },
    }
  }

  return {
    capabilities,
    paths: {
      projectConfig: projectConfigPath,
      userConfig: userConfigPath,
    },
  }
}
