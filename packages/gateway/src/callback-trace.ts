import crypto from "node:crypto";
import { emitGatewayOtel } from "@joelclaw/telemetry";

export const DEFAULT_CALLBACK_TRACE_TIMEOUT_MS = 15_000;
const MAX_RECENT_TRACES = 20;

export type CallbackTraceStatus =
  | "started"
  | "acknowledged"
  | "dispatched"
  | "completed"
  | "failed"
  | "timed_out";

export type CallbackTraceSummary = {
  traceId: string;
  handler: string;
  route: string;
  rawData: string;
  chatId: number | null;
  messageId: number | null;
  status: CallbackTraceStatus;
  startedAt: string;
  ack: {
    state: "pending" | "succeeded" | "failed";
    text: string | null;
    at: string | null;
    error: string | null;
  };
  dispatchedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  timedOutAt: string | null;
  timeoutMs: number;
  detail: string | null;
  error: string | null;
};

export type CallbackTraceSnapshot = {
  timeoutMs: number;
  activeCount: number;
  activeRoutes: string[];
  lastCompleted: CallbackTraceSummary | null;
  lastFailed: CallbackTraceSummary | null;
  lastTimedOut: CallbackTraceSummary | null;
  recent: CallbackTraceSummary[];
};

type CallbackTraceInternal = CallbackTraceSummary & {
  timeoutTimer: NodeJS.Timeout | null;
  onTimeout?: (trace: CallbackTraceSummary) => void | Promise<void>;
};

const traces: CallbackTraceInternal[] = [];
const activeTraces = new Map<string, CallbackTraceInternal>();

function nowIso(): string {
  return new Date().toISOString();
}

function buildTraceId(): string {
  return `cb_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function publicTrace(trace: CallbackTraceInternal): CallbackTraceSummary {
  const { timeoutTimer: _timeoutTimer, onTimeout: _onTimeout, ...rest } = trace;
  return rest;
}

function emitTraceOtel(
  action: string,
  trace: CallbackTraceInternal,
  success: boolean,
  extra?: { error?: string; metadata?: Record<string, unknown>; level?: "info" | "warn" | "error" },
): void {
  void emitGatewayOtel({
    level: extra?.level ?? (success ? "info" : "warn"),
    component: "callback-trace",
    action,
    success,
    ...(extra?.error ? { error: extra.error } : {}),
    metadata: {
      traceId: trace.traceId,
      handler: trace.handler,
      route: trace.route,
      chatId: trace.chatId,
      messageId: trace.messageId,
      status: trace.status,
      ackState: trace.ack.state,
      ...(extra?.metadata ?? {}),
    },
  });
}

function finalizeTrace(trace: CallbackTraceInternal): void {
  if (trace.timeoutTimer) {
    clearTimeout(trace.timeoutTimer);
    trace.timeoutTimer = null;
  }
  activeTraces.delete(trace.traceId);
}

function rememberTrace(trace: CallbackTraceInternal): void {
  traces.push(trace);
  if (traces.length > MAX_RECENT_TRACES) {
    traces.splice(0, traces.length - MAX_RECENT_TRACES);
  }
}

function findTrace(traceId: string): CallbackTraceInternal | undefined {
  return activeTraces.get(traceId) ?? traces.find((trace) => trace.traceId === traceId);
}

export function startCallbackTrace(
  input: {
    handler: string;
    route: string;
    rawData: string;
    chatId?: number | null;
    messageId?: number | null;
  },
  options?: {
    timeoutMs?: number;
    onTimeout?: (trace: CallbackTraceSummary) => void | Promise<void>;
  },
): string {
  const traceId = buildTraceId();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CALLBACK_TRACE_TIMEOUT_MS;

  const trace: CallbackTraceInternal = {
    traceId,
    handler: input.handler,
    route: input.route,
    rawData: input.rawData,
    chatId: input.chatId ?? null,
    messageId: input.messageId ?? null,
    status: "started",
    startedAt: nowIso(),
    ack: {
      state: "pending",
      text: null,
      at: null,
      error: null,
    },
    dispatchedAt: null,
    completedAt: null,
    failedAt: null,
    timedOutAt: null,
    timeoutMs,
    detail: null,
    error: null,
    timeoutTimer: null,
    onTimeout: options?.onTimeout,
  };

  const timeoutTimer = setTimeout(() => {
    const active = activeTraces.get(traceId);
    if (!active || active.status === "completed" || active.status === "failed") return;

    active.status = "timed_out";
    active.timedOutAt = nowIso();
    active.error = active.error ?? `callback timed out after ${active.timeoutMs}ms`;
    finalizeTrace(active);
    emitTraceOtel("callback.trace.timed_out", active, false, {
      error: active.error,
      level: "error",
      metadata: { timeoutMs: active.timeoutMs },
    });

    void active.onTimeout?.(publicTrace(active));
  }, timeoutMs);
  if (timeoutTimer && typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
    timeoutTimer.unref();
  }

  trace.timeoutTimer = timeoutTimer;
  activeTraces.set(traceId, trace);
  rememberTrace(trace);
  emitTraceOtel("callback.trace.started", trace, true, {
    metadata: { timeoutMs },
  });
  return traceId;
}

export function acknowledgeCallbackTrace(
  traceId: string,
  result: { text?: string; error?: string },
): void {
  const trace = findTrace(traceId);
  if (!trace) return;

  trace.ack.text = result.text ?? trace.ack.text;
  trace.ack.at = nowIso();

  if (result.error) {
    trace.ack.state = "failed";
    trace.ack.error = result.error;
    emitTraceOtel("callback.trace.ack_failed", trace, false, {
      error: result.error,
      level: "warn",
      metadata: { ackText: trace.ack.text },
    });
    return;
  }

  trace.ack.state = "succeeded";
  trace.status = trace.status === "started" ? "acknowledged" : trace.status;
  emitTraceOtel("callback.trace.acknowledged", trace, true, {
    metadata: { ackText: trace.ack.text },
  });
}

export function markCallbackTraceDispatched(traceId: string, detail?: string): void {
  const trace = findTrace(traceId);
  if (!trace) return;

  trace.status = "dispatched";
  trace.dispatchedAt = nowIso();
  trace.detail = detail ?? trace.detail;
  emitTraceOtel("callback.trace.dispatched", trace, true, {
    metadata: { detail: trace.detail },
  });
}

export function completeCallbackTrace(traceId: string, detail?: string): void {
  const trace = findTrace(traceId);
  if (!trace) return;

  trace.status = "completed";
  trace.completedAt = nowIso();
  trace.detail = detail ?? trace.detail;
  finalizeTrace(trace);
  emitTraceOtel("callback.trace.completed", trace, true, {
    metadata: { detail: trace.detail },
  });
}

export function failCallbackTrace(traceId: string, error: string, detail?: string): void {
  const trace = findTrace(traceId);
  if (!trace) return;

  trace.status = "failed";
  trace.failedAt = nowIso();
  trace.error = error;
  trace.detail = detail ?? trace.detail;
  finalizeTrace(trace);
  emitTraceOtel("callback.trace.failed", trace, false, {
    error,
    level: "error",
    metadata: { detail: trace.detail },
  });
}

export function getCallbackTraceSnapshot(): CallbackTraceSnapshot {
  const lastCompleted = [...traces].reverse().find((trace) => trace.status === "completed") ?? null;
  const lastFailed = [...traces].reverse().find((trace) => trace.status === "failed") ?? null;
  const lastTimedOut = [...traces].reverse().find((trace) => trace.status === "timed_out") ?? null;

  return {
    timeoutMs: DEFAULT_CALLBACK_TRACE_TIMEOUT_MS,
    activeCount: activeTraces.size,
    activeRoutes: Array.from(new Set(Array.from(activeTraces.values()).map((trace) => trace.route))).sort(),
    lastCompleted: lastCompleted ? publicTrace(lastCompleted) : null,
    lastFailed: lastFailed ? publicTrace(lastFailed) : null,
    lastTimedOut: lastTimedOut ? publicTrace(lastTimedOut) : null,
    recent: traces.slice(-5).map(publicTrace),
  };
}

export const __callbackTraceTestUtils = {
  reset(): void {
    for (const trace of activeTraces.values()) {
      if (trace.timeoutTimer) {
        clearTimeout(trace.timeoutTimer);
      }
    }
    activeTraces.clear();
    traces.length = 0;
  },
};
