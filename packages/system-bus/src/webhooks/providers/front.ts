/**
 * Front webhook provider adapter.
 * HMAC-SHA256 signature verification (timestamp:body) + payload normalization.
 *
 * Front docs: https://dev.frontapp.com/docs/application-webhooks
 * Signature: HMAC-SHA256(token, `${timestamp}:${rawBody}`) → base64
 * Challenge: POST with x-front-challenge header → respond with challenge value
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

/** Monitored teammate ID — only process events relevant to this inbox.
 *  Set via FRONT_MONITORED_TEAMMATE env var (e.g. tea_hjx3).
 *  Convert Front URL numeric ID to API ID: base36(818967) = hjx3 → tea_hjx3
 *  Future: read from ~/.joelclaw/config.json email-front section */
const MONITORED_TEAMMATE = process.env.FRONT_MONITORED_TEAMMATE;

function getWebhookSecret(): string {
  const secret = process.env.FRONT_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("FRONT_WEBHOOK_SECRET env var required for webhook verification");
  }
  return secret;
}

/** Check if this event is relevant to the monitored teammate's inbox.
 *  If no FRONT_MONITORED_TEAMMATE is set, all events pass through. */
function isRelevantToMonitored(body: Record<string, unknown>): boolean {
  if (!MONITORED_TEAMMATE) return true; // no filter configured

  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const conversation = (payload.conversation ?? {}) as Record<string, unknown>;
  const assignee = conversation.assignee as Record<string, unknown> | null | undefined;

  // No assignee = unassigned/new inbound — let it through
  if (!assignee) return true;

  // Assigned to monitored teammate — relevant
  if (assignee.id === MONITORED_TEAMMATE) return true;

  // Assigned to someone else — skip
  console.log(`[webhooks:front] filtered: assigned to ${assignee.id} (${assignee.email ?? "?"}), want ${MONITORED_TEAMMATE}`);
  return false;
}

export const frontProvider: WebhookProvider = {
  id: "front",
  eventPrefix: "front",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-front-signature"];
    const timestamp = headers["x-front-request-timestamp"];

    if (!signature || !timestamp) return false;

    const secret = getWebhookSecret();
    // Front: HMAC-SHA256(token, `${timestamp}:${rawBody}`) → base64
    const baseString = Buffer.concat([
      Buffer.from(`${timestamp}:`, "utf8"),
      Buffer.from(rawBody, "utf8"),
    ]).toString();
    const computed = createHmac("sha256", secret)
      .update(baseString)
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
    headers: Record<string, string>,
  ): NormalizedEvent[] {
    // Front challenge validation — not a real event
    const challenge = headers["x-front-challenge"];
    if (challenge) {
      return [{
        name: "_challenge",
        data: { challenge },
        idempotencyKey: `front-challenge-${Date.now()}`,
      }];
    }

    const type = body.type as string | undefined;
    if (!type) return [];

    const mappedName = EVENT_MAP[type];
    if (!mappedName) return [];

    // Inbox filter — drop events for other teammates
    if (!isRelevantToMonitored(body)) return [];

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
