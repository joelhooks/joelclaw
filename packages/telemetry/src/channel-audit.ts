import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

export const CHANNEL_AUDIT_SCHEMA_VERSION = 1 as const;

export type ChannelContentFingerprint = {
  contentHash: string;
  contentChars: number;
  contentBytes: number;
};

export type ChannelAuditSeed = {
  flowId?: string;
  producer?: string;
  originSystemId?: string;
  eventId?: string;
  requestedAtMs?: number;
  queuedAtMs?: number;
  route?: string;
  inReplyToMessageId?: number;
};

export type ChannelDeliveryAudit = ChannelContentFingerprint & {
  schemaVersion: typeof CHANNEL_AUDIT_SCHEMA_VERSION;
  flowId: string;
  producer: string;
  originSystemId: string;
  requestedAtMs: number;
  eventId?: string;
  queuedAtMs?: number;
  route?: string;
  inReplyToMessageId?: number;
};

export function resolveSystemId(value?: string): string {
  const explicit = value?.trim();
  if (explicit) return explicit;

  const configured = process.env.SLOG_SYSTEM_ID?.trim();
  if (configured) return configured;

  const host = hostname().trim().toLowerCase().replace(/\.localdomain$|\.local$/u, "");
  return host || "unknown";
}

export function summarizeChannelError(error: unknown): string {
  if (!error || typeof error !== "object") return "channel_delivery_error";
  const value = error as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name : "ChannelDeliveryError";
  const code = typeof value.error_code === "number" || typeof value.error_code === "string"
    ? String(value.error_code)
    : typeof value.code === "number" || typeof value.code === "string"
      ? String(value.code)
      : undefined;
  const description = typeof value.description === "string"
    ? value.description.replace(/\s+/gu, " ").slice(0, 240)
    : undefined;
  return [name, code, description].filter(Boolean).join(":") || "channel_delivery_error";
}

export function fingerprintChannelContent(content: string): ChannelContentFingerprint {
  return {
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    contentChars: Array.from(content).length,
    contentBytes: Buffer.byteLength(content, "utf8"),
  };
}

export function createChannelDeliveryAudit(
  content: string,
  seed: ChannelAuditSeed = {},
  nowMs = Date.now(),
): ChannelDeliveryAudit {
  return {
    schemaVersion: CHANNEL_AUDIT_SCHEMA_VERSION,
    flowId: seed.flowId?.trim() || randomUUID(),
    producer: seed.producer?.trim() || "unknown",
    originSystemId: resolveSystemId(seed.originSystemId),
    requestedAtMs: seed.requestedAtMs ?? nowMs,
    ...(seed.eventId ? { eventId: seed.eventId } : {}),
    ...(seed.queuedAtMs !== undefined ? { queuedAtMs: seed.queuedAtMs } : {}),
    ...(seed.route ? { route: seed.route } : {}),
    ...(seed.inReplyToMessageId !== undefined
      ? { inReplyToMessageId: seed.inReplyToMessageId }
      : {}),
    ...fingerprintChannelContent(content),
  };
}
