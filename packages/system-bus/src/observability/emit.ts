import { assertOtelEvent, createOtelEvent, type OtelEvent, type OtelEventInput } from "./otel-event";
import { storeOtelEvent, type OtelStoreResult } from "./store";

export type EmitOtelResult = OtelStoreResult & {
  event?: OtelEvent;
  skipped?: boolean;
  error?: string;
};

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function isOtelEnabled(): boolean {
  return parseBooleanFlag(process.env.OTEL_EVENTS_ENABLED, true);
}

export async function emitOtelEvent(input: OtelEventInput): Promise<EmitOtelResult> {
  if (!isOtelEnabled()) {
    return {
      stored: false,
      skipped: true,
      eventId: input.id ?? "disabled",
      dropped: true,
      dropReason: "otel_events_disabled",
      typesense: { written: false },
      convex: { written: false, pruned: 0, skipped: true },
      sentry: { written: false, skipped: true },
    };
  }

  try {
    const event = createOtelEvent(input);
    const stored = await storeOtelEvent(event);
    return { ...stored, event };
  } catch (error) {
    return {
      stored: false,
      eventId: input.id ?? "invalid",
      error: String(error),
      typesense: { written: false, error: String(error) },
      convex: { written: false, pruned: 0, skipped: true },
      sentry: { written: false, skipped: true },
    };
  }
}

export async function emitValidatedOtelEvent(payload: unknown): Promise<EmitOtelResult> {
  try {
    assertOtelEvent(payload);
    const stored = await storeOtelEvent(payload);
    return { ...stored, event: payload };
  } catch (error) {
    return {
      stored: false,
      eventId: "invalid",
      error: String(error),
      typesense: { written: false, error: String(error) },
      convex: { written: false, pruned: 0, skipped: true },
      sentry: { written: false, skipped: true },
    };
  }
}

export async function emitMeasuredOtelEvent<T>(
  input: Omit<OtelEventInput, "duration_ms" | "success" | "error"> & {
    metadata?: Record<string, unknown>;
  },
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    await emitOtelEvent({
      ...input,
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: {
        ...input.metadata,
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitOtelEvent({
      ...input,
      level: input.level === "fatal" ? "fatal" : "error",
      success: false,
      error: message,
      duration_ms: Date.now() - startedAt,
      metadata: {
        ...input.metadata,
      },
    });
    throw error;
  }
}
