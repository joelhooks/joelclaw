import { type AnyCapabilityPort, capabilityError, type JoelclawCapabilitiesConfig } from "./contract"

type CapabilityKey = `${string}:${string}`

export type CapabilityDescriptor = {
  capability: string
  adapter: string
  commandCount: number
  commands: string[]
}

function registryKey(capability: string, adapter: string): CapabilityKey {
  return `${capability}:${adapter}`
}

export class CapabilityRegistry {
  private readonly ports = new Map<CapabilityKey, AnyCapabilityPort>()

  register(port: AnyCapabilityPort): this {
    this.ports.set(registryKey(port.capability, port.adapter), port)
    return this
  }

  get(capability: string, adapter: string): AnyCapabilityPort | undefined {
    return this.ports.get(registryKey(capability, adapter))
  }

  resolve(capability: string, config: JoelclawCapabilitiesConfig): {
    port?: AnyCapabilityPort
    error?: ReturnType<typeof capabilityError>
  } {
    const normalizedCapability = capability.trim().toLowerCase()
    const capabilityConfig = config.capabilities[normalizedCapability]

    if (!capabilityConfig) {
      return {
        error: capabilityError(
          "CAPABILITY_NOT_CONFIGURED",
          `Capability "${normalizedCapability}" is not configured`,
          `Set capabilities.${normalizedCapability} in ${config.paths.userConfig} or ${config.paths.projectConfig}.`
        ),
      }
    }

    if (!capabilityConfig.enabled) {
      return {
        error: capabilityError(
          "CAPABILITY_DISABLED",
          `Capability "${normalizedCapability}" is disabled`,
          `Enable it in config or override with JOELCLAW_CAPABILITY_${normalizedCapability.toUpperCase()}_ENABLED=true.`
        ),
      }
    }

    const port = this.get(normalizedCapability, capabilityConfig.adapter)
    if (!port) {
      return {
        error: capabilityError(
          "CAPABILITY_ADAPTER_UNAVAILABLE",
          `Capability "${normalizedCapability}" adapter "${capabilityConfig.adapter}" is not registered`,
          `Use --adapter with one of: ${this.adaptersFor(normalizedCapability).join(", ") || "no registered adapters"}.`
        ),
      }
    }

    return { port }
  }

  list(): CapabilityDescriptor[] {
    return [...this.ports.values()]
      .map((port) => ({
        capability: port.capability,
        adapter: port.adapter,
        commandCount: Object.keys(port.commands).length,
        commands: Object.keys(port.commands).sort(),
      }))
      .sort((a, b) => {
        const capability = a.capability.localeCompare(b.capability)
        if (capability !== 0) return capability
        return a.adapter.localeCompare(b.adapter)
      })
  }

  adaptersFor(capability: string): string[] {
    const normalizedCapability = capability.trim().toLowerCase()
    return this.list()
      .filter((entry) => entry.capability === normalizedCapability)
      .map((entry) => entry.adapter)
  }
}

export const createCapabilityRegistry = (): CapabilityRegistry => new CapabilityRegistry()
