/**
 * X webhook provider adapter.
 *
 * X webhook docs:
 * - GET CRC: respond with { response_token: "sha256=<base64 hmac>" }
 * - POST signature: x-twitter-webhooks-signature = sha256=<base64 hmac(raw body)>
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedEvent, WebhookChallengeResponse, WebhookProvider } from "../types";

const X_EVENT_KEYS = [
  "tweet_create_events",
  "tweet_delete_events",
  "favorite_events",
  "follow_events",
  "unfollow_events",
  "block_events",
  "unblock_events",
  "mute_events",
  "unmute_events",
  "user_event",
  "direct_message_events",
  "direct_message_indicate_typing_events",
  "direct_message_mark_read_events",
  "replay_event",
] as const;

function getConsumerSecret(): string | null {
  const secret = process.env.X_CONSUMER_SECRET ?? process.env.TWITTER_CONSUMER_SECRET;
  if (!secret || secret.trim().length === 0) return null;
  return secret;
}

function buildSha256Base64(secret: string, message: string): string {
  return `sha256=${createHmac("sha256", secret).update(message).digest("base64")}`;
}

function safeEqualSignature(expected: string, received: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}

function detectEventTypes(body: Record<string, unknown>): string[] {
  const eventTypes = X_EVENT_KEYS.filter((key) => key in body);
  return eventTypes.length > 0 ? eventTypes : ["account_activity"];
}

function collectEventIds(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectEventIds(item));
  }
  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const ids: string[] = [];
  for (const key of ["id", "id_str", "event_id", "tweet_id", "status_id", "job_id"]) {
    const id = record[key];
    if (typeof id === "string" && id.trim()) ids.push(`${key}:${id}`);
    if (typeof id === "number" && Number.isFinite(id)) ids.push(`${key}:${id}`);
  }
  for (const nested of Object.values(record)) {
    if (Array.isArray(nested)) ids.push(...collectEventIds(nested));
  }
  return ids;
}

function stablePayloadHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24);
}

export const __xProviderTestUtils = {
  buildSha256Base64,
  detectEventTypes,
};

export const xProvider: WebhookProvider = {
  id: "x",
  eventPrefix: "x",

  buildChallengeResponse(query: Record<string, string>): WebhookChallengeResponse {
    const crcToken = query.crc_token;
    if (!crcToken) {
      return { status: 400, body: { ok: false, error: "Missing crc_token" } };
    }

    const secret = getConsumerSecret();
    if (!secret) {
      return { status: 503, body: { ok: false, error: "X consumer secret unavailable" } };
    }

    return {
      status: 200,
      body: {
        response_token: buildSha256Base64(secret, crcToken),
      },
    };
  },

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-twitter-webhooks-signature"];
    if (!signature) return false;

    const secret = getConsumerSecret();
    if (!secret) return false;

    const computed = buildSha256Base64(secret, rawBody);
    return safeEqualSignature(computed, signature);
  },

  normalizePayload(body: Record<string, unknown>, headers: Record<string, string>): NormalizedEvent[] {
    const eventTypes = detectEventTypes(body);
    const forUserId = typeof body.for_user_id === "string" ? body.for_user_id : undefined;
    const eventIds = collectEventIds(body);
    const payloadHash = stablePayloadHash(body);
    const webhookId = headers["x-twitter-webhooks-webhook-id"] ?? headers["x-webhook-id"];

    return [{
      name: "account_activity.received",
      idempotencyKey: [
        "x-account-activity",
        forUserId ?? "unknown-user",
        eventTypes.join("+"),
        eventIds.slice(0, 10).join("+") || payloadHash,
      ].join("-"),
      data: {
        source: "x-webhook",
        forUserId,
        eventTypes,
        webhookId,
        payloadHash,
        payload: body,
      },
    }];
  },
};
