import { randomUUID } from "node:crypto";
import type { GatewayOtelInput, TelemetryEmitter } from "./types";

const OTEL_EMIT_URL = process.env.OTEL_EMIT_URL ?? "http://localhost:3111/observability/emit";
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
