/**
 * @joelclaw/email — Email port + adapters.
 *
 * Hexagonal Architecture (ADR-0052):
 *   Port: EmailPort interface (application-owned)
 *   Adapters: Front (primary), Gmail via gog CLI (secondary)
 *
 * Usage:
 *   import { createFrontAdapter } from "@joelclaw/email"
 *   const email = createFrontAdapter({ apiToken: "..." })
 *   const convos = await email.listConversations("inb_xxx", { unread: true })
 */


// Adapters
export { createFrontAdapter } from "./adapters/front";
export { createGmailAdapter } from "./adapters/gmail";
// Port
export type {
  ConversationFilter,
  EmailAddress,
  EmailAttachment,
  EmailConversation,
  EmailDraft,
  EmailInbox,
  EmailMessage,
  EmailPort,
} from "./port/types";
