/**
 * Front webhook provider adapter — RULES-BASED webhooks.
 *
 * Rules webhooks use HMAC-SHA1 (not SHA256) over JSON.stringify(body).
 * No timestamp in HMAC, no challenge mechanism.
 * Filtering happens at Front's Rules level (scoped to private inboxes).
 *
 * Docs: https://dev.frontapp.com/docs/rule-webhooks
 * Signature: HMAC-SHA1(apiSecret, JSON.stringify(body)) → base64
 * Header: x-front-signature
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookProvider, NormalizedEvent } from "../types";

/** Front webhook type → normalized event name */
const EVENT_MAP: Record<string, string> = {
  inbound_received: "message.received",
  outbound_sent: "message.sent",
  message_delivery_failed: "message.failed",
  conversation_archived: "conversation.archived",
  conversation_reopened: "conversation.reopened",
  conversation_deleted: "conversation.deleted",
  conversation_snoozed: "conversation.snoozed",
  conversation_snooze_expired: "conversation.unsnoozed",
  new_comment_added: "comment.added",
  assignee_changed: "assignee.changed",
  tag_added: "tag.added",
  tag_removed: "tag.removed",
};

function getWebhookSecret(): string {
  const secret = process.env.FRONT_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("FRONT_WEBHOOK_SECRET env var required for webhook verification");
  }
  return secret;
}

export const frontProvider: WebhookProvider = {
  id: "front",
  eventPrefix: "front",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-front-signature"];
    if (!signature) return false;

    const secret = getWebhookSecret();

    // Rules webhook: HMAC-SHA1(secret, JSON.stringify(parsed body)) → base64
    // Re-serialize to match Front's compact JSON format
    let compactBody: string;
    try {
      compactBody = JSON.stringify(JSON.parse(rawBody));
    } catch {
      return false;
    }

    const computed = createHmac("sha1", secret)
      .update(compactBody)
      .digest("base64");

    try {
      return timingSafeEqual(
        Buffer.from(signature, "base64"),
        Buffer.from(computed, "base64"),
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

    const mappedName = EVENT_MAP[type];
    if (!mappedName) return [];

    const payload = (body.payload ?? {}) as Record<string, unknown>;
    const conversation = (payload.conversation ?? payload) as Record<string, unknown>;
    const target = (payload.target ?? {}) as Record<string, unknown>;
    const targetData = ((target as any)?.data ?? {}) as Record<string, unknown>;

    const conversationId = String(conversation.id ?? "");
    const idempotencyKey = `front-${type}-${payload.id ?? conversationId}-${body.ts ?? Date.now()}`;

    // Inbound/outbound message events
    if (type === "inbound_received" || type === "outbound_sent") {
      const recipients = (payload.recipients ?? []) as Array<Record<string, unknown>>;
      const fromRecipient = recipients.find((r) => r.role === "from");
      const toRecipients = recipients.filter((r) => r.role === "to");
      const author = (payload.author ?? {}) as Record<string, unknown>;

      return [{
        name: mappedName,
        data: {
          conversationId,
          messageId: String(payload.id ?? ""),
          from: String(fromRecipient?.handle ?? author.email ?? ""),
          fromName: fromRecipient?.name ?? "",
          to: toRecipients.map((r) => String(r.handle ?? "")),
          subject: String(payload.subject ?? conversation.subject ?? ""),
          body: String(payload.body ?? ""),
          bodyPlain: String(payload.text ?? ""),
          preview: String(payload.blurb ?? ""),
          isInbound: type === "inbound_received",
          attachmentCount: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
        },
        idempotencyKey,
      }];
    }

    // Conversation state changes
    if (mappedName.startsWith("conversation.")) {
      return [{
        name: mappedName,
        data: {
          conversationId,
          subject: String(conversation.subject ?? ""),
        },
        idempotencyKey,
      }];
    }

    // Comment added
    if (type === "new_comment_added") {
      return [{
        name: mappedName,
        data: {
          conversationId,
          commentBody: String(targetData.body ?? ""),
          authorEmail: String((targetData.author as any)?.email ?? ""),
        },
        idempotencyKey,
      }];
    }

    // Assignee changed
    if (type === "assignee_changed") {
      return [{
        name: mappedName,
        data: {
          conversationId,
          assigneeEmail: String(targetData.email ?? ""),
          assigneeName: [targetData.first_name, targetData.last_name].filter(Boolean).join(" "),
        },
        idempotencyKey,
      }];
    }

    // Tag added/removed
    if (type === "tag_added" || type === "tag_removed") {
      return [{
        name: mappedName,
        data: {
          conversationId,
          tagName: String(targetData.name ?? ""),
          tagId: String(targetData.id ?? ""),
        },
        idempotencyKey,
      }];
    }

    // Fallback for mapped but unhandled types
    return [{
      name: mappedName,
      data: { conversationId, raw: payload },
      idempotencyKey,
    }];
  },
};
