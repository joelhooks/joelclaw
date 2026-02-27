/**
 * Mux webhook provider adapter.
 * HMAC-SHA256 signature verification + event normalization.
 * ADR-0048: Webhook Gateway for External Service Integration
 *
 * Mux webhook docs:
 * - Header: mux-signature
 * - Value: t=<unix_timestamp>,v1=<hmac_hex_signature>
 * - Signature: HMAC-SHA256(secret, timestamp + "." + rawBody) -> hex
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedEvent, WebhookProvider } from "../types";

/** Mux webhook type → normalized event name */
const EVENT_MAP: Record<string, string> = {
  "video.asset.ready": "asset.ready",
  "video.asset.errored": "asset.errored",
  "video.asset.created": "asset.created",
  "video.upload.created": "upload.created",
  "video.upload.asset_created": "upload.asset_created",
};

let warnedMissingSecret = false;

function getWebhookSecret(): string | null {
  const secret = process.env.MUX_WEBHOOK_SECRET;
  if (!secret || secret.trim().length === 0) {
    return null;
  }
  return secret;
}

function parseSignature(rawSignature: string): { timestamp: string; signature: string } | null {
  const parts = rawSignature.split(",").map((part) => part.trim());
  const timestamp = parts
    .find((part) => part.startsWith("t="))
    ?.slice(2);
  const signature = parts
    .find((part) => part.startsWith("v1="))
    ?.slice(3);

  if (!timestamp || !signature) return null;
  return { timestamp, signature };
}

function normalizeEventType(rawType: string): string | undefined {
  if (!rawType.startsWith("video.")) return undefined;
  return EVENT_MAP[rawType] ?? rawType.slice("video.".length);
}

export const muxProvider: WebhookProvider = {
  id: "mux",
  eventPrefix: "mux",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signatureHeader = headers["mux-signature"];
    if (!signatureHeader) return false;

    const parsedSignature = parseSignature(signatureHeader);
    if (!parsedSignature) return false;

    const secret = getWebhookSecret();
    if (!secret) {
      if (!warnedMissingSecret) {
        console.warn("[mux-webhook] MUX_WEBHOOK_SECRET not set — rejecting all inbound webhooks");
        warnedMissingSecret = true;
      }
      return false;
    }

    const { timestamp, signature } = parsedSignature;
    const payload = `${timestamp}.${rawBody}`;
    const computed = createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    try {
      return timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(computed, "hex"),
      );
    } catch {
      return false;
    }
  },

  normalizePayload(
    body: Record<string, unknown>,
    _headers: Record<string, string>,
  ): NormalizedEvent[] {
    const type = body.type as string | undefined;
    if (!type) return [];

    const mappedName = normalizeEventType(type);
    if (!mappedName) return [];

    const data = (body.data ?? {}) as Record<string, unknown>;
    const eventId = String(data.id ?? "");
    const timestamp = String(
      (body.timestamp ??
        body.createdAt ??
        body.created_at ??
        (data.timestamp as string | number | undefined) ??
        Date.now()),
    );

    return [
      {
        name: mappedName,
        data: {
          ...data,
          eventType: type,
        },
        idempotencyKey: `mux-${mappedName}-${eventId}-${timestamp}`,
      },
    ];
  },
};
