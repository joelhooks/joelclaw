import { randomUUID } from "node:crypto";

import type { ForwarderTelemetry } from "./forwarder.js";

export class OtelHttpTelemetry implements ForwarderTelemetry {
  constructor(
    private readonly url = "http://127.0.0.1:3111/observability/emit",
    private readonly token?: string,
  ) {}

  async emit(input: Parameters<ForwarderTelemetry["emit"]>[0]): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token === undefined ? {} : { "x-otel-emit-token": this.token }),
      },
      body: JSON.stringify({
        id: randomUUID(),
        timestamp: Date.now(),
        level: input.success ? "info" : "warn",
        source: "memory",
        component: "supermemory-forwarder",
        action: input.action,
        success: input.success,
        ...(input.errorCode === undefined ? {} : { error: input.errorCode }),
        metadata: input.metadata,
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`OTEL ingest returned ${response.status}`);
  }
}
