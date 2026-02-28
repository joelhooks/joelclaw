import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { parseMinimalToml, resolveCapabilitiesConfig } from "../capabilities/config"
import type { CapabilityPort, JoelclawCapabilitiesConfig } from "../capabilities/contract"
import { createCapabilityRegistry } from "../capabilities/registry"

describe("capability config resolution", () => {
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
})

describe("capability registry", () => {
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
