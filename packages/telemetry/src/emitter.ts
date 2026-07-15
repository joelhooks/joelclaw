import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSystemId } from "./channel-audit";
import type { GatewayOtelInput, TelemetryEmitter } from "./types";

const SYSTEM_BUS_ENV_PATH = join(homedir(), ".config", "system-bus.env");

function readSystemBusEnv(): Record<string, string> {
  if (!existsSync(SYSTEM_BUS_ENV_PATH)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(SYSTEM_BUS_ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    env[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).replace(/^["']|["']$/g, "");
  }
  return env;
}

function readConfigValue(config: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim() || config[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function appendObservabilityEmit(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/observability/emit`;
}

function resolveOtelEmitUrl(): string {
  const config = readSystemBusEnv();
  const explicit = readConfigValue(config, "OTEL_EMIT_URL", "JOELCLAW_OTEL_INGEST_URL");
  if (explicit) return explicit;

  const centralUrl = readConfigValue(config, "JOELCLAW_CENTRAL_URL");
  if (centralUrl) return appendObservabilityEmit(centralUrl);

  const workerUrl = readConfigValue(config, "INNGEST_WORKER_URL");
  if (workerUrl) return appendObservabilityEmit(workerUrl);

  return "http://localhost:3111/observability/emit";
}

const OTEL_EMIT_URL = resolveOtelEmitUrl();
const OTEL_EMIT_TOKEN = process.env.OTEL_EMIT_TOKEN;
const DEBUG_WINDOW_MS = 60_000;
const DEBUG_MAX_PER_KEY = 10;
const MAX_IN_FLIGHT = 24;

type DebugBudgetState = { startedAt: number; count: number; dropped: number };
const debugBudget = new Map<string, DebugBudgetState>();
let inFlight = 0;

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function otelEnabled(): boolean {
  return parseBooleanFlag(process.env.OTEL_EVENTS_ENABLED, true);
}

function shouldDropDebug(input: GatewayOtelInput): boolean {
  if (input.level !== "debug") return false;
  const now = Date.now();
  const key = `${input.component}:${input.action}`;
  const previous = debugBudget.get(key);
  if (!previous || now - previous.startedAt >= DEBUG_WINDOW_MS) {
    debugBudget.set(key, { startedAt: now, count: 1, dropped: 0 });
    return false;
  }

  if (previous.count < DEBUG_MAX_PER_KEY) {
    previous.count += 1;
    return false;
  }

  previous.dropped += 1;
  if (previous.dropped === 1 || previous.dropped % 25 === 0) {
    console.warn("[gateway:otel] dropped debug event by backpressure guard", {
      component: input.component,
      action: input.action,
      droppedInWindow: previous.dropped,
    });
  }
  return true;
}

function shouldDropByInFlight(input: GatewayOtelInput): boolean {
  if (input.critical) return false;
  if (inFlight < MAX_IN_FLIGHT) return false;
  return input.level === "debug" || input.level === "info";
}

export async function emitGatewayOtel(input: GatewayOtelInput): Promise<void> {
  if (!otelEnabled()) return;
  if (shouldDropDebug(input)) return;
  if (shouldDropByInFlight(input)) return;

  const payload = {
    id: randomUUID(),
    timestamp: Date.now(),
    level: input.level,
    source: input.source ?? "gateway",
    sessionId: input.sessionId ?? process.env.SLOG_SESSION_ID?.trim() ?? "unknown",
    systemId: resolveSystemId(input.systemId),
    component: input.component,
    action: input.action,
    duration_ms: input.duration_ms,
    success: input.success,
    error: input.error,
    metadata: input.metadata ?? {},
  };

  inFlight += 1;
  try {
    const resp = await fetch(OTEL_EMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(OTEL_EMIT_TOKEN ? { "x-otel-emit-token": OTEL_EMIT_TOKEN } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2_000),
    });

    if (!resp.ok && input.level !== "debug") {
      const text = await resp.text().catch(() => "");
      console.warn("[gateway:otel] emit failed", {
        status: resp.status,
        component: input.component,
        action: input.action,
        detail: text.slice(0, 200),
      });
    }
  } catch (error) {
    if (input.level !== "debug") {
      console.warn("[gateway:otel] emit request failed", {
        component: input.component,
        action: input.action,
        error: String(error),
      });
    }
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

export function createGatewayEmitter(component: string): TelemetryEmitter {
  return {
    emit(action, detail, extra) {
      void emitGatewayOtel({
        level: "info",
        component,
        action,
        success: true,
        metadata: {
          detail,
          ...(extra ?? {}),
        },
      });
    },
  };
}
