/**
 * Front adapter — implements EmailPort using @skillrecordings/front-sdk.
 *
 * Credit: Joel Hooks / Skill Recordings (@skillrecordings/front-sdk)
 * Hexagonal Architecture: ADR-0052
 */

import {
  createFrontClient,
  paginate,
  type FrontClient,
  type Conversation,
  type Message,
  type Draft,
  type Inbox,
  type Recipient,
} from "@skillrecordings/front-sdk";

import type {
  EmailPort,
  EmailAddress,
  EmailAttachment,
  EmailConversation,
  EmailDraft,
  EmailInbox,
  EmailMessage,
  ConversationFilter,
} from "../port/types";

// ── Mappers ─────────────────────────────────────────────────────────

function toEmailAddress(r: Recipient): EmailAddress {
  return { email: r.handle, name: r.name ?? undefined };
}

function mapStatus(
  s: string,
): "open" | "archived" | "snoozed" | "trashed" {
  switch (s) {
    case "archived":
      return "archived";
    case "snoozed":
      return "snoozed";
    case "deleted":
      return "trashed";
    default:
      return "open"; // unassigned, assigned, invisible → open
  }
}

function toConversation(c: Conversation): EmailConversation {
  const from = c.recipient
    ? toEmailAddress(c.recipient as Recipient)
    : { email: "unknown" };

  return {
    id: c.id,
    subject: c.subject,
    status: mapStatus(c.status),
    lastMessageAt: new Date(c.created_at * 1000),
    messageCount: 0, // Front doesn't include this on list — filled on getConversation
    isUnread: c.status === "unassigned" || c.status === "assigned",
    from,
    to: [],
    tags: c.tags.map((t) => t.name),
    assignee: c.assignee?.email,
    raw: c as unknown as Record<string, unknown>,
  };
}

function toMessage(m: Message): EmailMessage {
  const from: EmailAddress = m.is_inbound
    ? toEmailAddress(
        m.recipients.find((r) => r.role === "from") ?? {
          handle: "unknown",
          role: "from",
        },
      )
    : {
        email: m.author?.email ?? "unknown",
        name: m.author?.first_name
          ? `${m.author.first_name} ${m.author.last_name ?? ""}`.trim()
          : undefined,
      };

  const to = m.recipients
    .filter((r) => r.role === "to")
    .map(toEmailAddress);

  const cc = m.recipients
    .filter((r) => r.role === "cc")
    .map(toEmailAddress);

  const attachments: EmailAttachment[] = m.attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.content_type,
    size: a.size,
    url: a.url,
  }));

  return {
    id: m.id,
    conversationId: m._links.related.conversation,
    from,
    to,
    cc: cc.length > 0 ? cc : undefined,
    subject: m.subject ?? "",
    body: m.body,
    bodyPlain: m.text ?? undefined,
    date: new Date(m.created_at * 1000),
    isInbound: m.is_inbound,
    attachments,
    raw: m as unknown as Record<string, unknown>,
  };
}

function toDraft(d: Draft): EmailDraft {
  return {
    id: d.id,
    conversationId: d._links.related.conversation,
    body: d.body,
    to: d.recipients
      .filter((r) => r.role === "to")
      .map(toEmailAddress),
    cc: d.recipients
      .filter((r) => r.role === "cc")
      .map(toEmailAddress),
    subject: d.subject ?? undefined,
    createdAt: new Date(d.created_at * 1000),
  };
}

// ── Adapter ─────────────────────────────────────────────────────────

export function createFrontAdapter(config: {
  apiToken: string;
  /** Default channel ID for creating drafts (cha_xxx) */
  defaultChannelId?: string;
}): EmailPort {
  const front = createFrontClient({ apiToken: config.apiToken });

  return {
    provider: "front",

    async listInboxes(): Promise<EmailInbox[]> {
      const result = await front.inboxes.list();
      return result._results.map((inbox: Inbox) => ({
        id: inbox.id,
        name: inbox.name,
        address: inbox.address ?? undefined,
      }));
    },

    async listConversations(
      inboxId: string,
      filter?: ConversationFilter,
    ): Promise<EmailConversation[]> {
      // Build Front search query
      const parts: string[] = [];
      if (filter?.unread) parts.push("is:unread");
      if (filter?.status === "archived") parts.push("is:archived");
      if (filter?.status === "snoozed") parts.push("is:snoozed");
      if (filter?.tag) parts.push(`tag:"${filter.tag}"`);
      if (filter?.query) parts.push(filter.query);

      const query = parts.length > 0 ? parts.join(" ") : undefined;
      const limit = filter?.limit ?? 25;

      let conversations: Conversation[];

      if (query) {
        // Use conversations.search for filtered queries
        const result = await front.conversations.search(query);
        conversations = result._results;
      } else {
        // Unfiltered — list inbox conversations
        const result = await front.inboxes.listConversations(inboxId);
        conversations = ((result as any)?._results ?? []) as Conversation[];
      }

      if (limit && conversations.length > limit) {
        conversations = conversations.slice(0, limit);
      }

      return conversations.map(toConversation);
    },

    async getConversation(conversationId: string) {
      const conv = await front.conversations.get(conversationId);
      const messagesResult = await front.conversations.listMessages(
        conversationId,
      );

      const messages: Message[] =
        (messagesResult as any)?._results ?? [];

      return {
        conversation: {
          ...toConversation(conv),
          messageCount: messages.length,
        },
        messages: messages.map(toMessage),
      };
    },

    async archive(conversationId: string) {
      await front.conversations.update(conversationId, {
        status: "archived",
      });
    },

    async tag(conversationId: string, tagName: string) {
      // Front needs tag ID, not name — look it up
      const tags = await front.tags.list();
      const tag = tags._results.find((t: any) => t.name === tagName);
      if (!tag) throw new Error(`Tag "${tagName}" not found`);
      await front.conversations.addTag(conversationId, tag.id);
    },

    async untag(conversationId: string, tagName: string) {
      const tags = await front.tags.list();
      const tag = tags._results.find((t: any) => t.name === tagName);
      if (!tag) throw new Error(`Tag "${tagName}" not found`);
      await front.conversations.removeTag(conversationId, tag.id);
    },

    async assign(conversationId: string, assigneeId: string) {
      await front.conversations.updateAssignee(conversationId, assigneeId);
    },

    async markRead(conversationId: string) {
      // Front doesn't have a direct "mark read" — listing messages
      // with markSeen on the latest message is the closest equivalent
      const messagesResult = await front.conversations.listMessages(
        conversationId,
      );
      const messages = (messagesResult as any)?._results ?? [];
      const latest = messages[0];
      if (latest?.id) {
        await front.messages.markSeen(latest.id);
      }
    },

    async createDraft(conversationId, body, options) {
      const channelId = config.defaultChannelId;
      if (!channelId) {
        throw new Error(
          "defaultChannelId required for creating drafts. " +
            "Set it when creating the Front adapter.",
        );
      }

      const draft = await front.drafts.createReply(conversationId, {
        body,
        channel_id: channelId,
        to: options?.to?.map((a) => a.email),
        cc: options?.cc?.map((a) => a.email),
        subject: options?.subject,
      });

      return toDraft(draft);
    },

    async listDrafts(conversationId: string) {
      const result = await front.drafts.list(conversationId);
      return result._results.map(toDraft);
    },

    async deleteDraft(draftId: string) {
      await front.drafts.delete(draftId);
    },
  };
}
