/**
 * Front webhook → gateway notification functions.
 *
 * Push contextual notifications to the gateway pi session when
 * Front events fire (new emails, replies, assignments, etc.)
 *
 * ADR-0048: Webhook Gateway for External Service Integration
 * ADR-0052: Email Port / Hexagonal Architecture
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

// ── Inbound message received ────────────────────────────────────────

export const frontMessageReceived = inngest.createFunction(
  { id: "front-message-received-notify", name: "Front → Gateway: Inbound Email" },
  { event: "front/message.received" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { from, fromName, subject, preview, conversationId, attachmentCount } = event.data;

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      const sender = fromName ? `${fromName} (${from})` : from;
      const attachTag = attachmentCount > 0 ? ` 📎${attachmentCount}` : "";
      return await gateway.notify("front.message.received", {
        message: `📧 New email from ${sender}: "${subject}"${attachTag}\n${preview}`,
        conversationId,
        from,
        fromName,
        subject,
        preview,
        attachmentCount,
      });
    });

    return { status: result.pushed ? "notified" : "skipped", conversationId, from, subject, result };
  }
);

// ── Outbound message sent ───────────────────────────────────────────

export const frontMessageSent = inngest.createFunction(
  { id: "front-message-sent-notify", name: "Front → Gateway: Outbound Email" },
  { event: "front/message.sent" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { to, subject, conversationId } = event.data;

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      const recipients = Array.isArray(to) ? to.join(", ") : to;
      return await gateway.notify("front.message.sent", {
        message: `📤 Email sent to ${recipients}: "${subject}"`,
        conversationId,
        to,
        subject,
      });
    });

    return { status: result.pushed ? "notified" : "skipped", conversationId, result };
  }
);

// ── Assignee changed ────────────────────────────────────────────────

export const frontAssigneeChanged = inngest.createFunction(
  { id: "front-assignee-changed-notify", name: "Front → Gateway: Assignee Changed" },
  { event: "front/assignee.changed" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { conversationId, assigneeEmail, assigneeName } = event.data;

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      const who = assigneeName || assigneeEmail || "unassigned";
      return await gateway.notify("front.assignee.changed", {
        message: `👤 Conversation assigned to ${who}`,
        conversationId,
        assigneeEmail,
        assigneeName,
      });
    });

    return { status: result.pushed ? "notified" : "skipped", conversationId, result };
  }
);
