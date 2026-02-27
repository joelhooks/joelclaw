/**
 * Gmail adapter — implements EmailPort using gog CLI.
 *
 * Shells out to `gog gmail` with JSON output mode.
 * Requires: `gog auth add <account> --services gmail` first.
 *
 * Credit: steipete/gogcli — ADR-0040
 * Hexagonal Architecture: ADR-0052
 */

import { execSync } from "node:child_process";
import type {
  ConversationFilter,
  EmailAddress,
  EmailConversation,
  EmailDraft,
  EmailInbox,
  EmailMessage,
  EmailPort,
} from "../port/types";

// ── Helpers ─────────────────────────────────────────────────────────

function gog(args: string, account: string, timeoutMs = 15_000): unknown {
  const cmd = `gog gmail ${args} -j -a ${account} --no-input`;
  const out = execSync(cmd, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function parseAddress(raw: string): EmailAddress {
  // "Joel Hooks <joel@joelhooks.com>" → { name, email }
  const match = raw.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1]!.trim(), email: match[2]! };
  return { email: raw.trim() };
}

function parseAddresses(raw: string | string[] | undefined): EmailAddress[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.split(",");
  return list.map((s) => parseAddress(s.trim())).filter((a) => a.email);
}

// ── Adapter ─────────────────────────────────────────────────────────

export function createGmailAdapter(config: {
  account: string; // e.g. "joel@joelhooks.com"
}): EmailPort {
  const { account } = config;

  return {
    provider: "gmail",

    async listInboxes(): Promise<EmailInbox[]> {
      // Gmail doesn't have "inboxes" — return labels as a proxy
      const labels = gog("labels list", account) as any[];
      return (labels ?? [])
        .filter((l: any) => l.type === "system" || l.type === "user")
        .slice(0, 20)
        .map((l: any) => ({
          id: l.id ?? l.name,
          name: l.name,
        }));
    },

    async listConversations(
      _inboxId: string,
      filter?: ConversationFilter,
    ): Promise<EmailConversation[]> {
      const parts: string[] = [];
      if (filter?.unread) parts.push("is:unread");
      if (filter?.status === "archived") parts.push("-in:inbox");
      if (filter?.status === "snoozed") parts.push("in:snoozed");
      if (filter?.tag) parts.push(`label:${filter.tag}`);
      if (filter?.query) parts.push(filter.query);

      const query = parts.length > 0 ? parts.join(" ") : "in:inbox";
      const max = filter?.limit ?? 25;

      const threads = gog(
        `search "${query}" --max ${max}`,
        account,
      ) as any[];

      return (threads ?? []).map((t: any) => ({
        id: t.id ?? t.threadId,
        subject: t.subject ?? t.snippet ?? "",
        status: "open" as const,
        lastMessageAt: new Date(t.date ?? t.internalDate ?? 0),
        messageCount: t.messageCount ?? t.messages?.length ?? 0,
        isUnread: t.unread ?? true,
        from: parseAddress(t.from ?? "unknown"),
        to: parseAddresses(t.to),
        tags: t.labels ?? t.labelIds ?? [],
        preview: t.snippet,
        raw: t,
      }));
    },

    async getConversation(threadId: string) {
      const thread = gog(`thread get ${threadId}`, account) as any;
      const messages: any[] = thread?.messages ?? [];

      return {
        conversation: {
          id: threadId,
          subject: messages[0]?.subject ?? "",
          status: "open" as const,
          lastMessageAt: new Date(
            messages[messages.length - 1]?.date ??
              messages[messages.length - 1]?.internalDate ??
              0,
          ),
          messageCount: messages.length,
          isUnread: messages.some((m: any) => m.labelIds?.includes("UNREAD")),
          from: parseAddress(messages[0]?.from ?? "unknown"),
          to: parseAddresses(messages[0]?.to),
          tags: messages[0]?.labelIds ?? [],
        },
        messages: messages.map(
          (m: any): EmailMessage => ({
            id: m.id,
            conversationId: threadId,
            from: parseAddress(m.from ?? "unknown"),
            to: parseAddresses(m.to),
            cc: parseAddresses(m.cc),
            subject: m.subject ?? "",
            body: m.body ?? m.snippet ?? "",
            bodyPlain: m.text ?? m.snippet,
            date: new Date(m.date ?? m.internalDate ?? 0),
            isInbound: !m.labelIds?.includes("SENT"),
            attachments: (m.attachments ?? []).map((a: any) => ({
              id: a.attachmentId ?? a.id,
              filename: a.filename,
              contentType: a.mimeType,
              size: a.size ?? 0,
            })),
            raw: m,
          }),
        ),
      };
    },

    async archive(threadId: string) {
      gog(`thread modify ${threadId} --remove-labels INBOX`, account);
    },

    async tag(threadId: string, label: string) {
      gog(`thread modify ${threadId} --add-labels ${label}`, account);
    },

    async untag(threadId: string, label: string) {
      gog(`thread modify ${threadId} --remove-labels ${label}`, account);
    },

    async assign(_threadId: string, _assigneeId: string) {
      // Gmail doesn't have assignment — no-op
      console.warn("[gmail] assign not supported — Gmail has no assignment concept");
    },

    async markRead(threadId: string) {
      gog(`thread modify ${threadId} --remove-labels UNREAD`, account);
    },

    async createDraft(_conversationId, body, options) {
      // gog gmail doesn't have draft creation yet — use Gmail API directly
      // For now, throw with guidance
      throw new Error(
        "Gmail draft creation via gog not yet implemented. " +
          "Use Front adapter for draft workflows.",
      );
    },

    async listDrafts(_conversationId) {
      return []; // Not yet implemented
    },

    async deleteDraft(_draftId) {
      throw new Error("Gmail draft deletion via gog not yet implemented");
    },
  };
}
