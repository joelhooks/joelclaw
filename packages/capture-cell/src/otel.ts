import { hostname } from "node:os";
import { OtelRejectedError } from "./failure";
import type { CellOtelEvent } from "./types";

/*
 * The otel step posts the same JSON shape system-bus's emitter stores
 * (`OtelEvent`) to the same ingest endpoint, `/observability/emit`. The
 * system-bus emitter itself imports its stores, and the telemetry
 * package's emitter mints random ids; the cell needs a deterministic id per
 * `(run_id, step)`, so it posts directly.
 */

export interface OtelShipperConfig {
  url: string | undefined;
  token: string | undefined;
  timeoutMs: number;
  systemId: string;
}

export class OtelEndpointMissingError extends Error {
  constructor() {
    super("no OTEL endpoint: set OTEL_EMIT_URL or JOELCLAW_CENTRAL_URL");
    this.name = "OtelEndpointMissingError";
  }
}

export function resolveOtelEmitUrl(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.OTEL_EMIT_URL?.trim() || env.JOELCLAW_OTEL_INGEST_URL?.trim();
  if (explicit) return explicit;
  const central = env.JOELCLAW_CENTRAL_URL?.trim();
  return central ? `${central.replace(/\/+$/u, "")}/observability/emit` : undefined;
}

export function resolveSystemId(env: Record<string, string | undefined>): string {
  const explicit = env.SLOG_SYSTEM_ID?.trim();
  if (explicit) return explicit;
  const host = hostname()
    .trim()
    .toLowerCase()
    .replace(/\.localdomain$|\.local$/u, "");
  return host || "unknown";
}

export type ShipOtel = (event: Record<string, unknown>) => Promise<void>;

/** Post one stored event. Throws on any failure; 4xx other than 408/429 is deterministic. */
export function createOtelShipper(config: OtelShipperConfig): ShipOtel {
  return async (stored) => {
    if (!config.url) throw new OtelEndpointMissingError();
    const event: CellOtelEvent = {
      ...(stored as Omit<CellOtelEvent, "sessionId" | "systemId">),
      sessionId: "capture-cell",
      systemId: config.systemId,
    };
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.token ? { "x-otel-emit-token": config.token } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.ok) return;
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429
    ) {
      throw new OtelRejectedError(response.status, detail);
    }
    throw new Error(`otel emit failed: HTTP ${response.status} ${detail}`.trim());
  };
}
