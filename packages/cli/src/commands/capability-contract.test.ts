import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { DEFAULT_CAPABILITY_CONFIG, parseMinimalToml, resolveCapabilitiesConfig } from "../capabilities/config"
import type { CapabilityPort, JoelclawCapabilitiesConfig } from "../capabilities/contract"
import { createCapabilityRegistry } from "../capabilities/registry"
import { capabilityRegistry } from "../capabilities/setup"

describe("capability config resolution", () => {
  test("defaults include phase-4 capability roots", () => {
    expect(DEFAULT_CAPABILITY_CONFIG.mail).toMatchObject({
      enabled: true,
      adapter: "mcp-agent-mail",
    })
    expect(DEFAULT_CAPABILITY_CONFIG.otel).toMatchObject({
      enabled: true,
      adapter: "typesense-otel",
    })
    expect(DEFAULT_CAPABILITY_CONFIG.recall).toMatchObject({
      enabled: true,
      adapter: "typesense-recall",
    })
    expect(DEFAULT_CAPABILITY_CONFIG.subscribe).toMatchObject({
      enabled: true,
      adapter: "redis-subscriptions",
    })
    expect(DEFAULT_CAPABILITY_CONFIG.deploy).toMatchObject({
      enabled: true,
      adapter: "scripted-deploy",
    })
    expect(DEFAULT_CAPABILITY_CONFIG.heal).toMatchObject({
      enabled: true,
      adapter: "runbook-heal",
    })
  })

  test("minimal TOML parser reads capability sections", () => {
    const parsed = parseMinimalToml(`
[capabilities.secrets]
enabled = true
adapter = "agent-secrets-cli"

[capabilities.secrets.adapters.agent-secrets-cli]
timeout_ms = 5000
`)

    expect(parsed).toEqual({
      capabilities: {
        secrets: {
          enabled: true,
          adapter: "agent-secrets-cli",
          adapters: {
            "agent-secrets-cli": {
              timeout_ms: 5000,
            },
          },
        },
      },
    })
  })

  test("config precedence is flags > env > project > user > defaults", () => {
    const root = mkdtempSync("/tmp/joelclaw-cap-config-")
    const projectDir = join(root, "project")
    const homeDir = join(root, "home")
    mkdirSync(join(projectDir, ".joelclaw"), { recursive: true })
    mkdirSync(join(homeDir, ".joelclaw"), { recursive: true })

    const projectPath = join(projectDir, ".joelclaw", "config.toml")
    const userPath = join(homeDir, ".joelclaw", "config.toml")

    writeFileSync(userPath, `
[capabilities.notify]
enabled = false
adapter = "user-adapter"
`)

    writeFileSync(projectPath, `
[capabilities.notify]
enabled = true
adapter = "project-adapter"
`)

    const config = resolveCapabilitiesConfig({
      cwd: projectDir,
      env: {
        JOELCLAW_CAPABILITY_NOTIFY_ENABLED: "false",
        JOELCLAW_CAPABILITY_NOTIFY_ADAPTER: "env-adapter",
      },
      flags: {
        notify: { adapter: "flag-adapter", enabled: true },
      },
      projectConfigPath: projectPath,
      userConfigPath: userPath,
    })

    const notify = config.capabilities.notify
    expect(notify?.adapter).toBe("flag-adapter")
    expect(notify?.enabled).toBe(true)
    expect(notify?.source.adapter).toBe("flag")
    expect(notify?.source.enabled).toBe("flag")

    rmSync(root, { recursive: true, force: true })
  })

  test("new capability adapters honor precedence and adapter settings merge", () => {
    const config = resolveCapabilitiesConfig({
      cwd: "/tmp",
      env: {
        JOELCLAW_CAPABILITY_MAIL_ADAPTER: "env-mail",
      },
      flags: {
        mail: { adapter: "flag-mail" },
      },
      projectConfigPath: "/tmp/does-not-exist-project.toml",
      userConfigPath: "/tmp/does-not-exist-user.toml",
    })

    expect(config.capabilities.mail?.adapter).toBe("flag-mail")
    expect(config.capabilities.mail?.source.adapter).toBe("flag")
  })
})

describe("capability registry", () => {
  test("runtime registry includes phase-4 adapters", () => {
    const entries = capabilityRegistry.list()
    expect(entries.some((entry) => entry.capability === "mail" && entry.adapter === "mcp-agent-mail")).toBe(true)
    expect(entries.some((entry) => entry.capability === "otel" && entry.adapter === "typesense-otel")).toBe(true)
    expect(entries.some((entry) => entry.capability === "recall" && entry.adapter === "typesense-recall")).toBe(true)
    expect(entries.some((entry) => entry.capability === "subscribe" && entry.adapter === "redis-subscriptions")).toBe(true)
    expect(entries.some((entry) => entry.capability === "deploy" && entry.adapter === "scripted-deploy")).toBe(true)
    expect(entries.some((entry) => entry.capability === "heal" && entry.adapter === "runbook-heal")).toBe(true)
  })

  test("resolves configured adapter and returns descriptive errors", () => {
    const registry = createCapabilityRegistry()

    const dummyPort: CapabilityPort<{
      ping: {
        summary: string
        argsSchema: typeof Schema.Struct<{}>
        resultSchema: typeof Schema.String
      }
    }> = {
      capability: "notify",
      adapter: "dummy",
      commands: {
        ping: {
          summary: "Ping",
          argsSchema: Schema.Struct({}),
          resultSchema: Schema.String,
        },
      },
      execute: () => Effect.succeed("ok"),
    }

    registry.register(dummyPort as any)

    const config: JoelclawCapabilitiesConfig = {
      capabilities: {
        notify: {
          enabled: true,
          adapter: "dummy",
          adapters: {},
          source: { adapter: "default", enabled: "default" },
        },
      },
      paths: {
        projectConfig: "/tmp/project.toml",
        userConfig: "/tmp/user.toml",
      },
    }

    const resolved = registry.resolve("notify", config)
    expect(resolved.port?.adapter).toBe("dummy")

    const disabled = registry.resolve("notify", {
      ...config,
      capabilities: {
        notify: {
          ...config.capabilities.notify,
          enabled: false,
          source: { adapter: "default", enabled: "env" },
        },
      },
    })

    expect(disabled.error?.code).toBe("CAPABILITY_DISABLED")
  })
})
