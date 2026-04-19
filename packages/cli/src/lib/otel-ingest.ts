import { randomUUID } from "node:crypto"
import { hostname } from "node:os"

export const OTEL_INGEST_URL =
  process.env.JOELCLAW_OTEL_INGEST_URL || "http://localhost:3111/observability/emit"

const OTEL_INGEST_TOKEN = process.env.OTEL_EMIT_TOKEN?.trim()
const DEFAULT_OTEL_TIMEOUT_MS = parsePositiveInt(process.env.JOELCLAW_OTEL_INGEST_TIMEOUT_MS, 1500)

type OtelEventLevel = "debug" | "info" | "warn" | "error" | "fatal"

export type OtelEventPayloadInput = {
  level: OtelEventLevel
  source: string
  component: string
  action: string
  success: boolean
  sessionId?: string
  systemId?: string
  durationMs?: number
  error?: string
  metadata?: Record<string, unknown>
  id?: string
  timestamp?: number
}

export type OtelIngestResult =
  | {
      ok: true
      endpoint: string
      status: number
      response: unknown
    }
  | {
      ok: false
      endpoint: string
      status?: number
      error: string
      response?: unknown
    }

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}

function readNonEmptyEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function normalizeHostnameSystemId(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase().replace(/\.localdomain$|\.local$/u, "")
  return normalized || undefined
}

export function resolveDefaultOtelSessionId(): string {
  return readNonEmptyEnv(
    "SLOG_SESSION_ID",
    "JOELCLAW_SESSION_ID",
    "JOELCLAW_SESSION_HANDLE",
    "PI_SESSION_HANDLE",
  ) ?? (process.env.GATEWAY_ROLE?.trim() === "central"
    ? "gateway"
    : readNonEmptyEnv("JOELCLAW_ROLE") ?? "interactive")
}

export function resolveDefaultOtelSystemId(): string {
  return readNonEmptyEnv("SLOG_SYSTEM_ID", "JOELCLAW_SYSTEM_ID")
    ?? normalizeHostnameSystemId(hostname())
    ?? "unknown"
}

export function createOtelEventPayload(input: OtelEventPayloadInput): Record<string, unknown> {
  return {
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? Date.now(),
    sessionId: input.sessionId || resolveDefaultOtelSessionId(),
    systemId: input.systemId || resolveDefaultOtelSystemId(),
    level: input.level,
    source: input.source,
    component: input.component,
    action: input.action,
    success: input.success,
    duration_ms: input.durationMs,
    error: input.error,
    metadata: input.metadata ?? {},
  }
}

export async function ingestOtelPayload(
  payload: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<OtelIngestResult> {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_OTEL_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (OTEL_INGEST_TOKEN) headers["x-otel-emit-token"] = OTEL_INGEST_TOKEN

  try {
    const response = await fetch(OTEL_INGEST_URL, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(payload),
    })

    const raw = await response.text()
    const parsed = tryParseJson(raw)

    if (!response.ok) {
      return {
        ok: false,
        endpoint: OTEL_INGEST_URL,
        status: response.status,
        error: `OTEL emit request failed (${response.status}): ${raw || response.statusText}`,
        response: parsed,
      }
    }

    return {
      ok: true,
      endpoint: OTEL_INGEST_URL,
      status: response.status,
      response: parsed,
    }
  } catch (error) {
    return {
      ok: false,
      endpoint: OTEL_INGEST_URL,
      error: `OTEL emit request failed: ${String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
