/**
 * joelclaw webhook provider adapter.
 * Proxies trusted remote Inngest events into local self-hosted Inngest.
 *
 * Signature: HMAC-SHA256(secret, rawBody) -> hex
 * Header: x-joelclaw-signature
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedEvent, WebhookProvider } from "../types";

export type JoelclawInngestEvent = {
  name: string;
  data: Record<string, unknown>;
};

let warnedMissingSecret = false;

function getWebhookSecret(): string | null {
  const secret = process.env.JOELCLAW_WEBHOOK_SECRET;
  if (!secret || secret.trim().length === 0) {
    return null;
  }
  return secret;
}

function toJoelclawInngestEvent(body: Record<string, unknown>): JoelclawInngestEvent | null {
  const name = body.name;
  const data = body.data;

  if (typeof name !== "string" || name.trim().length === 0) {
    return null;
  }

  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data)
  ) {
    return null;
  }

  return {
    name,
    data: data as Record<string, unknown>,
  };
}

function buildIdempotencyKey(event: JoelclawInngestEvent): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(event))
    .digest("hex")
    .slice(0, 16);
  return `joelclaw-${event.name}-${fingerprint}`;
}

export async function forwardJoelclawEvent(event: JoelclawInngestEvent): Promise<Response> {
  const eventKey = process.env.INNGEST_EVENT_KEY?.trim();
  if (!eventKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "Inngest event key not configured" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const targetUrl = `http://127.0.0.1:8288/e/${eventKey}`;
  return fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

export const joelclawProvider: WebhookProvider = {
  id: "joelclaw",
  eventPrefix: "joelclaw",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-joelclaw-signature"];
    if (!signature) return false;

    const secret = getWebhookSecret();
    if (!secret) {
      if (!warnedMissingSecret) {
        console.warn("[joelclaw-webhook] JOELCLAW_WEBHOOK_SECRET not set — rejecting all inbound webhooks");
        warnedMissingSecret = true;
      }
      return false;
    }

    const computed = createHmac("sha256", secret)
      .update(rawBody)
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
    const event = toJoelclawInngestEvent(body);
    if (!event) return [];

    return [
      {
        name: event.name,
        data: event.data,
        idempotencyKey: buildIdempotencyKey(event),
      },
    ];
  },
};
