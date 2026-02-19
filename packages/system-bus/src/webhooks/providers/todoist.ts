/**
 * Todoist webhook provider adapter.
 * HMAC-SHA256 signature verification + payload normalization.
 * ADR-0047: Todoist as Async Conversation Channel
 * ADR-0048: Webhook Gateway for External Service Integration
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookProvider, NormalizedEvent } from "../types";

/** Todoist webhook event_name → normalized event name */
const EVENT_MAP: Record<string, string> = {
  "note:added": "comment.added",
  "item:completed": "task.completed",
  "item:added": "task.created",
};

function getClientSecret(): string {
  // Todoist docs: "SHA256 Hmac generated using your client_secret as the encryption key"
  // NOT the "Verification token" from the App Console — that's a different thing.
  const secret = process.env.TODOIST_CLIENT_SECRET;
  if (!secret) {
    throw new Error("TODOIST_WEBHOOK_SECRET (or TODOIST_CLIENT_SECRET) env var is required for webhook verification");
  }
  return secret;
}

export const todoistProvider: WebhookProvider = {
  id: "todoist",
  eventPrefix: "todoist",

  verifySignature(rawBody: string, headers: Record<string, string>): boolean {
    const signature = headers["x-todoist-hmac-sha256"];
    if (!signature) return false;

    const secret = getClientSecret();
    const computed = createHmac("sha256", secret).update(rawBody).digest("base64");

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
    const eventName = body.event_name as string | undefined;
    if (!eventName) return [];

    const mappedName = EVENT_MAP[eventName];
    if (!mappedName) return [];

    const eventData = (body.event_data ?? {}) as Record<string, unknown>;
    const eventDataExtra = (body.event_data_extra ?? {}) as Record<string, unknown>;
    const entityId = String(eventData.id ?? "unknown");
    const idempotencyKey = `todoist-${eventName}-${entityId}`;

    if (mappedName === "comment.added") {
      return [
        {
          name: mappedName,
          data: {
            taskId: String(eventData.item_id ?? eventData.task_id ?? ""),
            commentId: entityId,
            commentContent: String(eventData.content ?? ""),
            taskContent: String(eventDataExtra.name ?? eventDataExtra.content ?? ""),
            projectId: String(eventData.project_id ?? ""),
            initiatorId: String((body.initiator as Record<string, unknown>)?.id ?? body.user_id ?? ""),
          },
          idempotencyKey,
        },
      ];
    }

    if (mappedName === "task.completed") {
      const labels = Array.isArray(eventData.labels) ? eventData.labels : [];
      return [
        {
          name: mappedName,
          data: {
            taskId: entityId,
            taskContent: String(eventData.content ?? ""),
            projectId: String(eventData.project_id ?? ""),
            labels,
          },
          idempotencyKey,
        },
      ];
    }

    if (mappedName === "task.created") {
      const labels = Array.isArray(eventData.labels) ? eventData.labels : [];
      return [
        {
          name: mappedName,
          data: {
            taskId: entityId,
            taskContent: String(eventData.content ?? ""),
            projectId: String(eventData.project_id ?? ""),
            labels,
          },
          idempotencyKey,
        },
      ];
    }

    return [];
  },
};
