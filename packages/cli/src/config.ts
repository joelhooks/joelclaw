import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ENV_PATH = join(process.env.HOME ?? "", ".config", "system-bus.env")

export interface Config {
  readonly eventKey: string
  readonly signingKey: string
  readonly inngestUrl: string
  readonly workerUrl: string
}

let _cached: Config | null = null

export function loadConfig(): Config {
  if (_cached) return _cached

  const env: Record<string, string> = {}

  // load from ~/.config/system-bus.env
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
  }

  // env vars override file (so docker/launchd overrides work too)
  _cached = {
    eventKey: process.env.INNGEST_EVENT_KEY ?? env.INNGEST_EVENT_KEY ?? "",
    signingKey: process.env.INNGEST_SIGNING_KEY ?? env.INNGEST_SIGNING_KEY ?? "",
    inngestUrl: process.env.INNGEST_URL ?? env.INNGEST_URL ?? "http://localhost:8288",
    workerUrl: process.env.INNGEST_WORKER_URL ?? env.INNGEST_WORKER_URL ?? "http://localhost:3111",
  }

  if (!_cached.eventKey) {
    throw new Error(`No INNGEST_EVENT_KEY — create ${ENV_PATH} or set env var`)
  }

  return _cached
}
