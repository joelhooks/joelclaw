import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_INNGEST_URL = "http://localhost:8288"
const DEFAULT_WORKER_URL = "http://localhost:3111"
const SYSTEM_BUS_ENV_PATH = join(homedir(), ".config", "system-bus.env")

export interface InngestEventConfig {
  readonly eventKey: string
  readonly inngestUrl: string
  readonly eventApi: string
  readonly workerUrl: string
}

let cachedConfig: InngestEventConfig | null = null

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/g, "")
}

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const separator = trimmed.indexOf("=")
  if (separator === -1) return null

  const key = trimmed.slice(0, separator).trim()
  const value = trimmed.slice(separator + 1).trim()
  if (!key) return null
  return [key, value]
}

function readSystemBusEnv(): Record<string, string> {
  if (!existsSync(SYSTEM_BUS_ENV_PATH)) return {}

  const values: Record<string, string> = {}
  for (const line of readFileSync(SYSTEM_BUS_ENV_PATH, "utf-8").split("\n")) {
    const parsed = parseLine(line)
    if (!parsed) continue
    const [key, value] = parsed
    values[key] = value
  }

  return values
}

function parseResponseBody(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function formatErrorDetail(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function loadInngestEventConfig(): InngestEventConfig {
  if (cachedConfig) return cachedConfig

  const fromFile = readSystemBusEnv()
  const eventKey = process.env.INNGEST_EVENT_KEY?.trim() || fromFile.INNGEST_EVENT_KEY?.trim() || ""
  const inngestUrl = normalizeBaseUrl(
    process.env.INNGEST_URL?.trim() || fromFile.INNGEST_URL?.trim() || DEFAULT_INNGEST_URL,
  )

  if (!eventKey) {
    throw new Error(`No INNGEST_EVENT_KEY configured (env or ${SYSTEM_BUS_ENV_PATH})`)
  }

  cachedConfig = {
    eventKey,
    inngestUrl,
    eventApi: `${inngestUrl}/e/${eventKey}`,
    workerUrl: normalizeBaseUrl(
      process.env.INNGEST_WORKER_URL?.trim() || fromFile.INNGEST_WORKER_URL?.trim() || DEFAULT_WORKER_URL,
    ),
  }

  return cachedConfig
}

export async function sendInngestEvent(name: string, data: Record<string, unknown>): Promise<unknown> {
  const eventName = name.trim()
  if (!eventName) {
    throw new Error("sendInngestEvent requires a non-empty event name")
  }

  const config = loadInngestEventConfig()
  const response = await fetch(config.eventApi, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: eventName,
      data,
    }),
  })

  const bodyText = await response.text()
  const body = parseResponseBody(bodyText)

  if (!response.ok) {
    throw new Error(
      `Inngest event send failed (${response.status}): ${formatErrorDetail(body)}`,
    )
  }

  return body
}
