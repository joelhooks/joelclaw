/**
 * Front webhook → gateway notification functions.
 *
 * Pattern: enrich-context → build-prompt → notify-gateway
 * (Matches todoist-notify.ts structure — see cli-design skill)
 *
 * ADR-0048: Webhook Gateway for External Service Integration
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { isVipSender } from "./vip-utils";

// ── Front API helpers ───────────────────────────────────────────────

const FRONT_API = "https://api2.frontapp.com";

function getApiToken(): string | undefined {
  return process.env.FRONT_API_TOKEN;
}

async function fetchConversation(conversationId: string): Promise<{
  subject: string;
  status: string;
  assigneeEmail: string;
  assigneeName: string;
  tags: string[];
  messagesCount: number;
} | null> {
  const token = getApiToken();
  if (!token || !conversationId) return null;

  try {
    const res = await fetch(`${FRONT_API}/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const convo = (await res.json()) as Record<string, unknown>;
    const assignee = (convo.assignee ?? {}) as Record<string, unknown>;
    const tags = Array.isArray(convo.tags)
      ? (convo.tags as Array<Record<string, unknown>>).map((t) => String(t.name ?? ""))
      : [];
    return {
      subject: String(convo.subject ?? ""),
      status: String(convo.status ?? ""),
      assigneeEmail: String(assignee.email ?? ""),
      assigneeName: [assignee.first_name, assignee.last_name].filter(Boolean).join(" "),
      tags,
      messagesCount: Number(convo.last_message ? 1 : 0), // approximate
    };
  } catch {
    return null;
  }
}

// ── Inbound message received ────────────────────────────────────────

export const frontMessageReceived = inngest.createFunction(
  { id: "front-message-received-notify", name: "Front → Gateway: Inbound Email" },
  { event: "front/message.received" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const {
      from,
      fromName,
      to,
      subject,
      body,
      bodyPlain,
      preview,
      conversationId,
      messageId,
      isInbound,
      attachmentCount,
    } = event.data;

    // Enrich: fetch conversation context (tags, assignee, status, thread depth)
    const context = await step.run("enrich-context", async () => {
      const convo = await fetchConversation(conversationId);
      return {
        subject: convo?.subject || subject || "",
        status: convo?.status || "unknown",
        assignee: convo?.assigneeName || convo?.assigneeEmail || "unassigned",
        tags: convo?.tags ?? [],
        messagesCount: convo?.messagesCount ?? 0,
        sender: fromName ? `${fromName} (${from})` : from,
      };
    });

    const agentPrompt = await step.run("build-prompt", () => {
      const attachTag = attachmentCount > 0 ? `\n**Attachments**: ${attachmentCount}` : "";
      const tagLine = context.tags.length ? `\n**Tags**: ${context.tags.join(", ")}` : "";
      const previewText = (bodyPlain || preview || "").slice(0, 500);

      return [
        `## 📧 Inbound Email`,
        "",
        `**From**: ${context.sender}`,
        `**Subject**: "${context.subject}"`,
        `**Status**: ${context.status} · **Assigned**: ${context.assignee}${tagLine}${attachTag}`,
        "",
        `> ${previewText}`,
        "",
        `Triage: needs reply? Needs scheduling? Forward to someone? Tag for follow-up?`,
        `If it's noise (newsletter, notification), acknowledge briefly.`,
        `Conversation \`${conversationId}\``,
      ].join("\n");
    });

    // ADR-0236: Index to Typesense for gateway context gathering
    await step.run("index-channel-message", async () => {
      await inngest.send({
        name: "channel/message.received",
        data: {
          channelType: "email",
          channelId: conversationId || "front-unknown",
          channelName: context.subject || "email",
          userId: from || "unknown",
          userName: context.sender || from || "unknown",
          text: (bodyPlain || preview || "").slice(0, 2000),
          timestamp: Date.now(),
        },
      });
    });

    const result = await step.run("notify-gateway", async () => {
      // VIP senders get a dedicated intelligence pipeline (vip-email-received.ts)
      // that delivers a richer brief — skip the generic notification to avoid stutter.
      if (isVipSender(from, fromName)) {
        return { pushed: false, reason: "vip-sender-deferred-to-vip-pipeline" };
      }
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return await gateway.notify("front.message.received", {
        prompt: agentPrompt,
        conversationId,
        from,
        fromName,
        subject: context.subject,
        preview,
        attachmentCount,
        status: context.status,
        tags: context.tags,
      });
    });

    let vipTriggered = false;
    if (isVipSender(from, fromName)) {
      await step.sendEvent("emit-vip-email-received", {
        name: "vip/email.received",
        data: {
          conversationId,
          messageId,
          from,
          fromName,
          to,
          subject: context.subject,
          body,
          bodyPlain,
          preview,
          isInbound,
          attachmentCount,
          source: "front-webhook" as const,
        },
      });
      vipTriggered = true;
    }

    return {
      status: result.pushed ? "notified" : "skipped",
      conversationId,
      from,
      subject: context.subject,
      tags: context.tags,
      vipTriggered,
      result,
    };
  }
);

// ── Outbound message sent ───────────────────────────────────────────

export const frontMessageSent = inngest.createFunction(
  { id: "front-message-sent-notify", name: "Front → Gateway: Outbound Email" },
  { event: "front/message.sent" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { to, subject, conversationId } = event.data;

    const context = await step.run("enrich-context", async () => {
      const convo = await fetchConversation(conversationId);
      const recipients = Array.isArray(to) ? to.join(", ") : to;
      return {
        subject: convo?.subject || subject || "",
        status: convo?.status || "unknown",
        tags: convo?.tags ?? [],
        recipients,
      };
    });

    const agentPrompt = await step.run("build-prompt", () => {
      const tagLine = context.tags.length ? ` [${context.tags.join(", ")}]` : "";
      return [
        `## 📤 Email Sent`,
        "",
        `**To**: ${context.recipients}`,
        `**Subject**: "${context.subject}"${tagLine}`,
        "",
        `Should this conversation be archived, tagged, or does it need follow-up tracking?`,
        `Conversation \`${conversationId}\``,
      ].join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return await gateway.notify("front.message.sent", {
        prompt: agentPrompt,
        conversationId,
        to,
        subject: context.subject,
        tags: context.tags,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      conversationId,
      subject: context.subject,
      result,
    };
  }
);

// ── Assignee changed ────────────────────────────────────────────────

export const frontAssigneeChanged = inngest.createFunction(
  { id: "front-assignee-changed-notify", name: "Front → Gateway: Assignee Changed" },
  { event: "front/assignee.changed" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const { conversationId, assigneeEmail, assigneeName } = event.data;

    const context = await step.run("enrich-context", async () => {
      const convo = await fetchConversation(conversationId);
      return {
        subject: convo?.subject || "",
        status: convo?.status || "unknown",
        tags: convo?.tags ?? [],
        who: assigneeName || assigneeEmail || convo?.assigneeName || "unassigned",
      };
    });

    const agentPrompt = await step.run("build-prompt", () => {
      const tagLine = context.tags.length ? ` [${context.tags.join(", ")}]` : "";
      return [
        `## 👤 Conversation Reassigned`,
        "",
        `**Subject**: "${context.subject}"${tagLine}`,
        `**Assigned to**: ${context.who}`,
        "",
        `Acknowledge briefly. If assigned to Joel, check if action is needed.`,
        `Conversation \`${conversationId}\``,
      ].join("\n");
    });

    const result = await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false, reason: "no gateway context" };

      return await gateway.notify("front.assignee.changed", {
        prompt: agentPrompt,
        conversationId,
        assigneeEmail,
        assigneeName: context.who,
        subject: context.subject,
        tags: context.tags,
      });
    });

    return {
      status: result.pushed ? "notified" : "skipped",
      conversationId,
      assignee: context.who,
      subject: context.subject,
      result,
    };
  }
);
