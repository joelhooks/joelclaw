import { randomUUID } from "node:crypto";

export const OTEL_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;

export type OtelLevel = (typeof OTEL_LEVELS)[number];

export type OtelMetadata = Record<string, unknown>;

export type OtelEvent = {
  id: string;
  timestamp: number;
  level: OtelLevel;
  source: string;
  component: string;
  action: string;
  duration_ms?: number;
  success: boolean;
  error?: string;
  metadata: OtelMetadata;
};

export type OtelEventInput = Omit<OtelEvent, "id" | "timestamp" | "metadata"> & {
  id?: string;
  timestamp?: number;
  metadata?: OtelMetadata;
};

function isLevel(value: unknown): value is OtelLevel {
  return typeof value === "string" && (OTEL_LEVELS as readonly string[]).includes(value);
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`otel_event.${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`otel_event.${field} cannot be empty`);
  }
  return trimmed;
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return Date.now();
}

function normalizeDuration(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  throw new Error("otel_event.duration_ms must be a non-negative number");
}

function normalizeError(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("otel_event.error must be a string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isHighSeverity(level: OtelLevel): boolean {
  return level === "warn" || level === "error" || level === "fatal";
}

export function createOtelEvent(input: OtelEventInput): OtelEvent {
  const level = isLevel(input.level)
    ? input.level
    : (() => {
        throw new Error(`otel_event.level must be one of: ${OTEL_LEVELS.join(", ")}`);
      })();

  const event: OtelEvent = {
    id: typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : randomUUID(),
    timestamp: normalizeTimestamp(input.timestamp),
    level,
    source: assertNonEmptyString(input.source, "source"),
    component: assertNonEmptyString(input.component, "component"),
    action: assertNonEmptyString(input.action, "action"),
    success: Boolean(input.success),
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };

  const duration = normalizeDuration(input.duration_ms);
  if (duration != null) event.duration_ms = duration;

  const error = normalizeError(input.error);
  if (error) event.error = error;

  if (!event.success && !event.error) {
    event.error = "operation_failed";
  }

  return event;
}

export function assertOtelEvent(value: unknown): asserts value is OtelEvent {
  if (!value || typeof value !== "object") {
    throw new Error("otel_event payload must be an object");
  }

  const event = value as Record<string, unknown>;

  if (typeof event.id !== "string" || event.id.trim().length === 0) {
    throw new Error("otel_event.id must be a non-empty string");
  }
  if (typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp)) {
    throw new Error("otel_event.timestamp must be a finite number");
  }
  if (!isLevel(event.level)) {
    throw new Error(`otel_event.level must be one of: ${OTEL_LEVELS.join(", ")}`);
  }

  assertNonEmptyString(event.source, "source");
  assertNonEmptyString(event.component, "component");
  assertNonEmptyString(event.action, "action");

  if (typeof event.success !== "boolean") {
    throw new Error("otel_event.success must be a boolean");
  }

  if (event.duration_ms != null) {
    normalizeDuration(event.duration_ms);
  }
  if (event.error != null) {
    normalizeError(event.error);
  }

  if (event.metadata != null && typeof event.metadata !== "object") {
    throw new Error("otel_event.metadata must be an object");
  }
}

