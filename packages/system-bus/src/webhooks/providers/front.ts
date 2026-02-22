/**
 * Front webhook provider adapter — RULES-BASED webhooks.
 *
 * Rules webhooks send Front Event objects (not app-level webhook format).
 * Different type names and payload structure than application webhooks.
 *
 * Event format: { type, id, emitted_at, conversation, source, target, _links }
 * Types: inbound, outbound, move, archive, reopen, assign, unassign, tag, untag, comment, etc.
 *
 * HMAC: SHA1(apiSecret, JSON.stringify(body)) → base64
 * Header: x-front-signature
 *
 * Docs: https://dev.frontapp.com/docs/rule-webhooks
 *       https://dev.frontapp.com/reference/events
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookProvider, NormalizedEvent } from "../types";

/** Front Event type → normalized Inngest event name.
 *  Rules webhooks use short Event types, not app-level "inbound_received" style. */
const EVENT_MAP: Record<string, string> = {
  inbound: "message.received",
  outbound: "message.sent",
  move: "conversation.moved",
  archive: "conversation.archived",
  reopen: "conversation.reopened",
  trash: "conversation.deleted",
  restore: "conversation.restored",
  assign: "assignee.changed",
  unassign: "assignee.changed",
  tag: "tag.added",
  untag: "tag.removed",
  comment: "comment.added",
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

    // Rules webhook Event object: top-level conversation, source, target
    const conversation = (body.conversation ?? {}) as Record<string, unknown>;
    const source = (body.source ?? {}) as Record<string, unknown>;
    const target = (body.target ?? {}) as Record<string, unknown>;
    const targetData = (target.data ?? {}) as Record<string, unknown>;
    const sourceData = (source.data ?? {}) as Record<string, unknown>;

    const conversationId = String(conversation.id ?? "");
    const eventId = String(body.id ?? "");
    const idempotencyKey = `front-${type}-${eventId || conversationId}-${body.emitted_at ?? Date.now()}`;

    // Inbound/outbound message events
    if (type === "inbound" || type === "outbound") {
      // target.data is the message object
      const recipients = Array.isArray(targetData.recipients)
        ? (targetData.recipients as Array<Record<string, unknown>>)
        : [];
      const fromRecipient = recipients.find((r) => r.role === "from");
      const toRecipients = recipients.filter((r) => r.role === "to");
      const author = (targetData.author ?? {}) as Record<string, unknown>;

      return [{
        name: mappedName,
        data: {
          conversationId,
          messageId: String(targetData.id ?? ""),
          from: String(fromRecipient?.handle ?? author.email ?? ""),
          fromName: String(fromRecipient?.name ?? ""),
          to: toRecipients.map((r) => String(r.handle ?? "")),
          subject: String(targetData.subject ?? conversation.subject ?? ""),
          body: String(targetData.body ?? ""),
          bodyPlain: String(targetData.text ?? ""),
          preview: String(targetData.blurb ?? ""),
          isInbound: type === "inbound",
          attachmentCount: Array.isArray(targetData.attachments) ? targetData.attachments.length : 0,
        },
        idempotencyKey,
      }];
    }

    // Conversation state changes (archive, reopen, move, trash, restore)
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

    // Assignee changed (assign/unassign)
    if (type === "assign" || type === "unassign") {
      return [{
        name: mappedName,
        data: {
          conversationId,
          assigneeEmail: String(targetData.email ?? ""),
          assigneeName: [targetData.first_name, targetData.last_name].filter(Boolean).join(" "),
          isUnassign: type === "unassign",
        },
        idempotencyKey,
      }];
    }

    // Comment added
    if (type === "comment") {
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

    // Tag added/removed
    if (type === "tag" || type === "untag") {
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
      data: { conversationId, raw: body },
      idempotencyKey,
    }];
  },
};
