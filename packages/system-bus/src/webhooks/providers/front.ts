/**
 * Front webhook provider adapter — RULES-BASED webhooks.
 *
 * Rules webhooks send Front Event objects (not app-level webhook format).
 * Different type names and payload structure than application webhooks.
 *
 * Event format: { type, id, emitted_at, conversation, source, target, _links }
 * Types: inbound, outbound, move, archive, reopen, assign, unassign, tag, untag, comment, etc.
 *
 * Rule HMAC: SHA1(apiSecret, JSON.stringify(body)) → base64
 * Application HMAC: SHA256(applicationSecret, `${timestamp}:${rawBody}`) → base64
 * Headers: x-front-signature, plus x-front-request-timestamp for application webhooks
 *
 * Docs: https://dev.frontapp.com/docs/rule-webhooks
 *       https://dev.frontapp.com/reference/events
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedEvent, WebhookProvider } from "../types";

/** Front Event type → normalized Inngest event name.
 *  Rules webhooks use short Event types, not app-level "inbound_received" style. */
const RULES_EVENT_MAP: Record<string, string> = {
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

/** Application webhooks use long event names and wrap the resource in `payload`. */
const APPLICATION_EVENT_MAP: Record<string, string> = {
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

function signaturesMatch(signature: string, computed: string): boolean {
  try {
    return timingSafeEqual(
      Buffer.from(signature, "base64"),
      Buffer.from(computed, "base64"),
    );
  } catch {
    return false;
  }
}

function getRulesWebhookSecret(): string {
  const secret = process.env.FRONT_RULES_WEBHOOK_SECRET ?? process.env.FRONT_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("FRONT_RULES_WEBHOOK_SECRET env var required for rule webhook verification");
  }
  return secret;
}

function getApplicationWebhookSecret(): string {
  const secret = process.env.FRONT_APPLICATION_SECRET;
  if (!secret) {
    throw new Error("FRONT_APPLICATION_SECRET env var required for application webhook verification");
  }
  return secret;
}

export const frontProvider: WebhookProvider = {
  id: "front",
  eventPrefix: "front",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-front-signature"];
    if (!signature) return false;

    const timestamp = headers["x-front-request-timestamp"];
    if (timestamp) {
      const computed = createHmac("sha256", getApplicationWebhookSecret())
        .update(`${timestamp}:${rawBody}`)
        .digest("base64");
      return signaturesMatch(signature, computed);
    }

    // Rules webhook: HMAC-SHA1(secret, JSON.stringify(parsed body)) → base64
    let compactBody: string;
    try {
      compactBody = JSON.stringify(JSON.parse(rawBody));
    } catch {
      return false;
    }

    const computed = createHmac("sha1", getRulesWebhookSecret())
      .update(compactBody)
      .digest("base64");

    return signaturesMatch(signature, computed);
  },

  normalizePayload(
    body: Record<string, unknown>,
    _headers: Record<string, string>,
  ): NormalizedEvent[] {
    const type = body.type as string | undefined;
    if (!type) return [];

    const applicationPayload = (body.payload ?? {}) as Record<string, unknown>;
    const isApplicationWebhook = Object.hasOwn(APPLICATION_EVENT_MAP, type);
    const mappedName = isApplicationWebhook
      ? APPLICATION_EVENT_MAP[type]
      : RULES_EVENT_MAP[type];
    if (!mappedName) return [];

    // Rules events keep resources at the top level. Application events wrap them in payload.
    const eventPayload = isApplicationWebhook ? applicationPayload : body;
    const conversation = (
      eventPayload.conversation ?? (isApplicationWebhook ? eventPayload : {})
    ) as Record<string, unknown>;
    const source = (eventPayload.source ?? {}) as Record<string, unknown>;
    const target = (eventPayload.target ?? {}) as Record<string, unknown>;
    const targetData = (target.data ?? {}) as Record<string, unknown>;
    const messageData = isApplicationWebhook ? eventPayload : targetData;
    const sourceData = (source.data ?? {}) as Record<string, unknown>;

    const conversationId = String(conversation.id ?? "");
    const eventId = String(eventPayload.id ?? body.id ?? "");
    const emittedAt = body.emitted_at ?? body.ts ?? Date.now();
    const idempotencyKey = `front-${type}-${eventId || conversationId}-${emittedAt}`;

    // Inbound/outbound message events
    if (
      type === "inbound" ||
      type === "outbound" ||
      type === "inbound_received" ||
      type === "outbound_sent"
    ) {
      const recipients = Array.isArray(messageData.recipients)
        ? (messageData.recipients as Array<Record<string, unknown>>)
        : [];
      const fromRecipient = recipients.find((r) => r.role === "from");
      const toRecipients = recipients.filter((r) => r.role === "to");
      const author = (messageData.author ?? {}) as Record<string, unknown>;

      return [{
        name: mappedName,
        data: {
          conversationId,
          messageId: String(messageData.id ?? ""),
          from: String(fromRecipient?.handle ?? author.email ?? ""),
          fromName: String(fromRecipient?.name ?? ""),
          to: toRecipients.map((r) => String(r.handle ?? "")),
          subject: String(messageData.subject ?? conversation.subject ?? ""),
          body: String(messageData.body ?? ""),
          bodyPlain: String(messageData.text ?? ""),
          preview: String(messageData.blurb ?? ""),
          isInbound: type === "inbound" || type === "inbound_received",
          attachmentCount: Array.isArray(messageData.attachments) ? messageData.attachments.length : 0,
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
    if (type === "assign" || type === "unassign" || type === "assignee_changed") {
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
    if (type === "comment" || type === "new_comment_added") {
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
    if (type === "tag" || type === "untag" || type === "tag_added" || type === "tag_removed") {
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
      data: { conversationId, raw: eventPayload },
      idempotencyKey,
    }];
  },
};
