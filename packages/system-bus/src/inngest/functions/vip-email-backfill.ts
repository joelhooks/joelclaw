import * as typesense from "../../lib/typesense";
import { inngest } from "../client";
import { buildEmailThreadCacheDocument } from "./vip-email-cache";
import { extractVipSenderEmail, getVipSenders } from "./vip-utils";

const FRONT_API = "https://api2.frontapp.com";
const FRONT_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_FRONT_TIMEOUT_MS ?? "4000");
const FRONT_PAGE_SIZE = 100;
const JOEL_EMAILS = new Set([
  "joelhooks@gmail.com",
  "joel@egghead.io",
  "joel@joelhooks.com",
]);
const RETRYABLE_FRONT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

type FrontConversationRecord = {
  id: string;
  subject: string;
  status: string;
  tags: string[];
  lastMessageAt: number | null;
};

type FrontThreadMessage = {
  id: string;
  senderName: string;
  senderEmail: string;
  senderDisplay: string;
  createdAt: number;
  text: string;
  isInbound: boolean;
};

type FrontThreadContext = {
  summary: {
    subject: string;
    status: string;
    tags: string[];
    messageCount: number;
  };
  messages: FrontThreadMessage[];
  latestMessage: FrontThreadMessage | null;
  joelReplied: boolean;
  lastJoelReplyAt?: number;
};

type VipEmailBackfillSenderResult = {
  senderEmail: string;
  contactFound: boolean;
  conversations: number;
  indexed: number;
  skipped: number;
  errors: Array<{ conversationId: string; error: string }>;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stripHtmlToText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/p>/giu, "\n")
      .replace(/<script[\s\S]*?<\/script>/giu, " ")
      .replace(/<style[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
  );
}

function extractEmailAddress(input: string): string {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return "";

  const match = normalized.match(/<([^>]+)>/u);
  const candidate = (match?.[1] ?? normalized).trim();
  return candidate.includes("@") ? candidate : "";
}

function toTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractPageToken(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  try {
    return new URL(value).searchParams.get("page_token");
  } catch {
    return null;
  }
}

function isJoelEmail(value: string): boolean {
  return JOEL_EMAILS.has(extractEmailAddress(value));
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFrontSender(message: Record<string, unknown>): {
  senderName: string;
  senderEmail: string;
  senderDisplay: string;
} {
  const author = (message.author ?? {}) as Record<string, unknown>;
  const recipients = Array.isArray(message.recipients)
    ? message.recipients.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const fromRecipient = recipients.find((recipient) => String(recipient.role ?? "") === "from");
  const senderEmail = extractEmailAddress(
    String(author.email ?? fromRecipient?.handle ?? author.username ?? fromRecipient?.name ?? "")
  );
  const senderName = normalizeWhitespace(
    String(
      [author.first_name, author.last_name].filter(Boolean).join(" ")
      || fromRecipient?.name
      || author.username
      || author.email
      || "unknown"
    )
  );
  const senderDisplay = senderEmail && senderName && senderName.toLowerCase() !== senderEmail.toLowerCase()
    ? `${senderName} <${senderEmail}>`
    : senderName || senderEmail || "unknown";

  return { senderName: senderName || senderEmail || "unknown", senderEmail, senderDisplay };
}

function normalizeFrontMessageText(message: Record<string, unknown>): string {
  const plain = typeof message.text === "string" ? normalizeWhitespace(message.text) : "";
  if (plain) return plain;

  const html = typeof message.body === "string" ? stripHtmlToText(message.body) : "";
  if (html) return html;

  return normalizeWhitespace(String(message.blurb ?? ""));
}

function normalizeFrontThreadMessage(message: Record<string, unknown>): FrontThreadMessage | null {
  const timestamp = toTimestampMs(message.created_at ?? message.createdAt ?? message.received_at);
  if (timestamp == null) return null;

  const sender = normalizeFrontSender(message);
  return {
    id: String(message.id ?? ""),
    senderName: sender.senderName,
    senderEmail: sender.senderEmail,
    senderDisplay: sender.senderDisplay,
    createdAt: timestamp,
    text: normalizeFrontMessageText(message),
    isInbound: Boolean(message.is_inbound ?? message.isInbound),
  };
}

function normalizeConversation(record: Record<string, unknown>): FrontConversationRecord | null {
  const id = String(record.id ?? "").trim();
  if (!id) return null;

  const tags = Array.isArray(record.tags)
    ? record.tags
        .filter((tag): tag is Record<string, unknown> => Boolean(tag) && typeof tag === "object")
        .map((tag) => String(tag.name ?? "").trim())
        .filter(Boolean)
    : [];

  return {
    id,
    subject: String(record.subject ?? "").trim() || "(no subject)",
    status: String(record.status ?? "").trim() || "unknown",
    tags,
    lastMessageAt: toTimestampMs(record.last_message_at ?? record.created_at),
  };
}

async function fetchFrontContactConversations(
  senderEmail: string,
  token: string
): Promise<{ conversations: FrontConversationRecord[]; contactFound: boolean }> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const conversations: FrontConversationRecord[] = [];
  let pageToken: string | null = null;

  while (true) {
    const url = new URL(`${FRONT_API}/contacts/alt:email:${encodeURIComponent(senderEmail)}/conversations`);
    url.searchParams.set("limit", String(FRONT_PAGE_SIZE));
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetchJsonWithTimeout(url.toString(), { headers }, FRONT_TIMEOUT_MS);
    if (response.status === 404) {
      return { conversations: [], contactFound: false };
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`contact conversations ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    const results = Array.isArray(body._results) ? body._results : [];
    for (const item of results) {
      if (!item || typeof item !== "object") continue;
      const normalized = normalizeConversation(item as Record<string, unknown>);
      if (normalized) conversations.push(normalized);
    }

    pageToken = extractPageToken((body._pagination as Record<string, unknown> | undefined)?.next);
    if (!pageToken) break;
  }

  return { conversations, contactFound: true };
}

async function fetchFrontConversationMessages(
  conversationId: string,
  token: string
): Promise<FrontThreadMessage[]> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const messages: FrontThreadMessage[] = [];
  let pageToken: string | null = null;

  while (true) {
    const url = new URL(`${FRONT_API}/conversations/${conversationId}/messages`);
    url.searchParams.set("limit", String(FRONT_PAGE_SIZE));
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetchJsonWithTimeout(url.toString(), { headers }, FRONT_TIMEOUT_MS);
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`conversation messages ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    const results = Array.isArray(body._results) ? body._results : [];
    if (results.length === 0) break;

    for (const item of results) {
      if (!item || typeof item !== "object") continue;
      const normalized = normalizeFrontThreadMessage(item as Record<string, unknown>);
      if (normalized) messages.push(normalized);
    }

    pageToken = extractPageToken((body._pagination as Record<string, unknown> | undefined)?.next);
    if (!pageToken) break;
  }

  messages.sort((left, right) => left.createdAt - right.createdAt);
  return messages;
}

function buildFrontThreadContext(
  conversation: FrontConversationRecord,
  messages: FrontThreadMessage[]
): FrontThreadContext {
  const latestMessage = messages.at(-1) ?? null;
  const lastJoelReplyAt = messages
    .filter((message) => isJoelEmail(message.senderEmail))
    .map((message) => message.createdAt)
    .sort((left, right) => right - left)[0];

  return {
    summary: {
      subject: conversation.subject,
      status: conversation.status,
      tags: conversation.tags,
      messageCount: messages.length,
    },
    messages,
    latestMessage,
    joelReplied: lastJoelReplyAt != null,
    ...(lastJoelReplyAt != null ? { lastJoelReplyAt } : {}),
  };
}

function buildBackfillSummary(input: {
  senderEmail: string;
  subject: string;
  frontContext: FrontThreadContext;
  fallbackLatestAt?: number | null;
}): string {
  const latestText = normalizeWhitespace(input.frontContext.latestMessage?.text ?? "");
  const latestSnippet = latestText
    ? latestText.length > 220
      ? `${latestText.slice(0, 217).trimEnd()}...`
      : latestText
    : "Latest message text unavailable.";
  const replyState = input.frontContext.lastJoelReplyAt != null
    ? `Joel last replied on ${new Date(input.frontContext.lastJoelReplyAt).toISOString()}.`
    : "Joel has not replied in the cached thread yet.";
  const latestAt = input.frontContext.latestMessage?.createdAt
    ?? input.fallbackLatestAt
    ?? conversationFallbackTimestamp(input.frontContext);

  return `${input.subject} with ${input.senderEmail}: ${input.frontContext.messages.length} messages. Latest activity ${new Date(latestAt).toISOString()}. ${replyState} ${latestSnippet}`.trim();
}

function conversationFallbackTimestamp(frontContext: FrontThreadContext): number {
  return frontContext.messages.at(-1)?.createdAt ?? Date.now();
}

function sanitizeStepIdFragment(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return sanitized || "vip-sender";
}

function resolveVipSenderEmails(input?: string[]): { emails: string[]; skipped: string[] } {
  const configured = input && input.length > 0 ? input : getVipSenders();
  const emails: string[] = [];
  const skipped: string[] = [];

  for (const sender of configured) {
    const email = extractVipSenderEmail(sender);
    if (email) emails.push(email);
    else skipped.push(sender);
  }

  return {
    emails: Array.from(new Set(emails)),
    skipped: Array.from(new Set(skipped)),
  };
}

async function backfillVipSender(senderEmail: string, token: string): Promise<VipEmailBackfillSenderResult> {
  const { conversations, contactFound } = await fetchFrontContactConversations(senderEmail, token);
  const errors: Array<{ conversationId: string; error: string }> = [];
  let indexed = 0;
  let skipped = 0;

  for (const conversation of conversations) {
    try {
      const messages = await fetchFrontConversationMessages(conversation.id, token);
      if (messages.length === 0) {
        skipped += 1;
        continue;
      }

      const frontContext = buildFrontThreadContext(conversation, messages);
      const document = buildEmailThreadCacheDocument({
        conversationId: conversation.id,
        subject: conversation.subject,
        vipSender: senderEmail,
        frontContext,
        summary: buildBackfillSummary({
          senderEmail,
          subject: conversation.subject,
          frontContext,
          fallbackLatestAt: conversation.lastMessageAt,
        }),
      });

      await typesense.upsert(typesense.EMAIL_THREADS_COLLECTION, document);
      indexed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("conversation messages")
        && RETRYABLE_FRONT_STATUSES.has(Number.parseInt(message.match(/\d{3}/u)?.[0] ?? "", 10))
      ) {
        throw error;
      }

      errors.push({
        conversationId: conversation.id,
        error: message.slice(0, 240),
      });
    }
  }

  return {
    senderEmail,
    contactFound,
    conversations: conversations.length,
    indexed,
    skipped,
    errors,
  };
}

export const vipEmailThreadsBackfill = inngest.createFunction(
  {
    id: "vip/email-threads.backfill",
    name: "VIP Email Threads Backfill",
    concurrency: { scope: "account", key: "front-api", limit: 1 },
    retries: 2,
  },
  { event: "vip/email-threads.backfill" },
  async ({ event, step }) => {
    const token = process.env.FRONT_API_TOKEN ?? "";
    if (!token) throw new Error("FRONT_API_TOKEN missing");

    await step.run("ensure-email-threads-collection", async () => {
      await typesense.ensureEmailThreadsCollection();
      return { ensured: true };
    });

    const { emails, skipped } = resolveVipSenderEmails(event.data?.senders);
    if (emails.length === 0) {
      return {
        status: "no-email-senders-configured",
        configuredSenders: event.data?.senders ?? getVipSenders(),
        skipped,
      };
    }

    const senderResults: VipEmailBackfillSenderResult[] = [];
    for (const senderEmail of emails) {
      const result = await step.run(`backfill-vip-sender-${sanitizeStepIdFragment(senderEmail)}`, async () =>
        backfillVipSender(senderEmail, token)
      );
      senderResults.push(result);
    }

    return {
      status: "completed",
      senders: emails,
      skippedConfiguredSenders: skipped,
      totals: {
        senders: emails.length,
        conversations: senderResults.reduce((sum, result) => sum + result.conversations, 0),
        indexed: senderResults.reduce((sum, result) => sum + result.indexed, 0),
        skipped: senderResults.reduce((sum, result) => sum + result.skipped, 0),
        errors: senderResults.reduce((sum, result) => sum + result.errors.length, 0),
      },
      senderResults,
    };
  }
);
