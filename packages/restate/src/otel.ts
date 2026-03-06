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
