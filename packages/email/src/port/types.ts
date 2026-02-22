/**
 * Email Port — application-owned interface for email operations.
 *
 * Hexagonal Architecture (ADR-0052): The application defines what it needs
 * from email. Adapters (Front, Gmail, etc.) implement this interface.
 * The hexagon never knows which adapter is plugged in.
 */

// ── Core Types ──────────────────────────────────────────────────────

export type EmailAddress = {
  email: string;
  name?: string;
};

export type EmailAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url?: string;
};

export type EmailMessage = {
  id: string;
  conversationId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  body: string;
  bodyPlain?: string;
  date: Date;
  isInbound: boolean;
  attachments: EmailAttachment[];
  /** Provider-specific metadata */
  raw?: Record<string, unknown>;
};

export type EmailConversation = {
  id: string;
  subject: string;
  status: "open" | "archived" | "snoozed" | "trashed";
  lastMessageAt: Date;
  messageCount: number;
  isUnread: boolean;
  from: EmailAddress;
  to: EmailAddress[];
  tags: string[];
  assignee?: string;
  /** Preview of the latest message body */
  preview?: string;
  /** Provider-specific metadata */
  raw?: Record<string, unknown>;
};

export type EmailInbox = {
  id: string;
  name: string;
  address?: string;
};

export type EmailDraft = {
  id: string;
  conversationId: string;
  body: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject?: string;
  createdAt: Date;
};

// ── Filter Types ────────────────────────────────────────────────────

export type ConversationFilter = {
  /** Only unread conversations */
  unread?: boolean;
  /** Filter by status */
  status?: "open" | "archived" | "snoozed";
  /** Filter by tag name */
  tag?: string;
  /** Search query (provider-specific syntax) */
  query?: string;
  /** Max results */
  limit?: number;
};

// ── Port Interface ──────────────────────────────────────────────────

export interface EmailPort {
  /** Provider identifier */
  readonly provider: string;

  // ── Inbox ───────────────────────────────────────────────────────

  /** List available inboxes/mailboxes */
  listInboxes(): Promise<EmailInbox[]>;

  // ── Conversations (threads) ─────────────────────────────────────

  /** List conversations with optional filtering */
  listConversations(
    inboxId: string,
    filter?: ConversationFilter,
  ): Promise<EmailConversation[]>;

  /** Get a single conversation with full message history */
  getConversation(conversationId: string): Promise<{
    conversation: EmailConversation;
    messages: EmailMessage[];
  }>;

  // ── Triage Actions ──────────────────────────────────────────────

  /** Archive a conversation (mark as done) */
  archive(conversationId: string): Promise<void>;

  /** Tag a conversation */
  tag(conversationId: string, tagName: string): Promise<void>;

  /** Remove a tag from a conversation */
  untag(conversationId: string, tagName: string): Promise<void>;

  /** Assign a conversation to a teammate/user */
  assign(conversationId: string, assigneeId: string): Promise<void>;

  /** Mark conversation as read */
  markRead(conversationId: string): Promise<void>;

  // ── Drafts (approval gate) ─────────────────────────────────────

  /** Create a draft reply on a conversation (does NOT send) */
  createDraft(
    conversationId: string,
    body: string,
    options?: { to?: EmailAddress[]; cc?: EmailAddress[]; subject?: string },
  ): Promise<EmailDraft>;

  /** List pending drafts on a conversation */
  listDrafts(conversationId: string): Promise<EmailDraft[]>;

  /** Delete a draft */
  deleteDraft(draftId: string): Promise<void>;
}
