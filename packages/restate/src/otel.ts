/**
 * OTEL emission for Restate DAG workloads.
 *
 * Direct HTTP POST to system-bus worker observability endpoint.
 * Fire-and-forget with short timeout — OTEL failure never blocks workflow execution.
 */

import { randomUUID } from "node:crypto";

const OTEL_ENDPOINT =
  process.env.OTEL_EMIT_URL ??
  "http://localhost:3111/observability/emit";

const OTEL_TIMEOUT_MS = 3_000;
const OUTPUT_PREVIEW_CHARS = 500;

export interface OtelEvent {
  level?: "info" | "warn" | "error";
  source?: string;
  component?: string;
  action: string;
  success?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export async function emitOtel(event: OtelEvent): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OTEL_TIMEOUT_MS);

    const response = await fetch(OTEL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        timestamp: Date.now(),
        level: event.level ?? "info",
        source: event.source ?? "restate",
        component: event.component ?? "dag-orchestrator",
        action: event.action,
        success: event.success ?? true,
        ...(event.error ? { error: event.error } : {}),
        metadata: event.metadata ?? {},
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

export function previewOutput(output: string): string {
  if (output.length <= OUTPUT_PREVIEW_CHARS) return output;
  return `${output.slice(0, OUTPUT_PREVIEW_CHARS)}…[${output.length} chars]`;
}

// --- Gateway notification ---

const GATEWAY_NOTIFY_TIMEOUT_MS = 5_000;
const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT ?? "6379", 10);
const GATEWAY_CHANNEL = "gateway";

export interface GatewayNotification {
  message: string;
  priority?: "low" | "normal" | "high" | "urgent";
  source?: string;
  context?: Record<string, unknown>;
}

/**
 * Push a notification to the gateway via Redis.
 * Same protocol as `joelclaw notify send` — LPUSH event to
 * `joelclaw:events:{channel}`, PUBLISH on `joelclaw:notify:{channel}`.
 *
 * Fire-and-forget: returns false on failure, never throws.
 */
export async function notifyGateway(notification: GatewayNotification): Promise<boolean> {
  let redis: InstanceType<typeof import("ioredis").default> | null = null;
  try {
    const Redis = (await import("ioredis")).default;
    const host = REDIS_HOST === "localhost" ? "127.0.0.1" : REDIS_HOST;
    redis = new Redis({
      host,
      port: REDIS_PORT,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3_000,
      commandTimeout: GATEWAY_NOTIFY_TIMEOUT_MS,
      retryStrategy: () => null, // no retries — fire and forget
    });
    redis.on("error", () => {}); // suppress unhandled

    await redis.connect();

    const priority = notification.priority ?? "normal";
    const event = {
      id: randomUUID(),
      type: "notify.message",
      source: notification.source ?? "restate/dag",
      payload: {
        prompt: notification.message,
        message: notification.message,
        priority,
        level: priority === "urgent" ? "fatal" : priority === "high" ? "warn" : "info",
        context: notification.context ?? {},
        immediateTelegram: priority === "high" || priority === "urgent",
      },
      ts: Date.now(),
    };

    const queueKey = `joelclaw:events:${GATEWAY_CHANNEL}`;
    const notifyKey = `joelclaw:notify:${GATEWAY_CHANNEL}`;
    const serialized = JSON.stringify(event);

    await redis.lpush(queueKey, serialized);
    await redis.publish(
      notifyKey,
      JSON.stringify({ eventId: event.id, type: event.type, priority }),
    );

    await redis.quit().catch(() => {});
    return true;
  } catch {
    if (redis) redis.disconnect(false);
    return false;
  }
}
