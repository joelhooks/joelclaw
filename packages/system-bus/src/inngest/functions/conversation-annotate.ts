import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";
import { infer } from "../../lib/inference";
import { getRedisPort } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const COMPONENT = "conversation-annotate";
const OTEL_SOURCE = "system-bus";
const GATEWAY_SOURCE = "inngest/conversation/annotate";
const DEDUP_TTL_SECONDS = 4 * 60 * 60;
const VAULT_CONVERSATIONS_DIR = join(homedir(), "Vault", "Resources", "conversations");
const FRONT_CONVERSATION_URL = "https://app.frontapp.com/open";
const JOEL_OWNER_RE = /\b(joel|panda)\b/i;

type ConversationSource = "webhook" | "pattern" | "explicit";

type ReadAttachment = {
  id: string;
  name: string;
  content_type: string | null;
  size: number | null;
  source_url: string | null;
};

type ReadMessage = {
  id: string;
  from: {
    name: string;
    email: string;
  };
  date: string;
  is_inbound: boolean;
  body: string;
  attachments: ReadAttachment[];
};

type ReadConversationPayload = {
  conversation: {
    id: string;
    subject: string;
    status: string;
    from: {
      name: string;
      email: string;
    };
    date: string;
    tags: string[];
  };
  messages: ReadMessage[];
  attachment_summary?: {
    total: number;
    cached: number;
    metadata_only: number;
    cache_errors: number;
  };
  fetched_at: string;
  cache?: {
    hit?: boolean;
    source?: string;
    cache_path?: string | null;
    age_seconds?: number;
    ttl_seconds?: number;
    refresh_requested?: boolean;
  };
};

type ConversationParticipant = {
  name: string;
  email?: string;
  role?: string;
};

type ConversationLink = {
  url: string;
  label?: string;
  context?: string;
};

type ConversationActionItem = {
  owner: string;
  task: string;
  dueDate?: string;
  status?: string;
  reason?: string;
};

type ConversationJoelInput = {
  required: boolean;
  reason: string;
  questions: string[];
};

type ConversationAnnotationSummary = {
  participants: ConversationParticipant[];
  topic: string;
  summary: string;
  keyDecisions: string[];
  actionItems: ConversationActionItem[];
  links: ConversationLink[];
  urgency: "low" | "medium" | "high" | "critical";
  needsJoelsInput: ConversationJoelInput;
  joelActionItems: ConversationActionItem[];
  datesMentioned: string[];
};

type FetchConversationResult = {
  payload: ReadConversationPayload;
  subject: string;
  messageCount: number;
  participants: ConversationParticipant[];
  extractedLinks: ConversationLink[];
};

type ConversationAnnotateEvent = {
  data: {
    conversationId: string;
    source: ConversationSource;
    sourceContext?: string;
    threadId?: string;
  };
};

let redisClient: Redis | null = null;

function extractConversationEventData(value: unknown): ConversationAnnotateEvent["data"] | null {
  if (!isRecord(value)) return null;

  const conversationId = asOptionalString(value.conversationId);
  const source = asOptionalString(value.source) as ConversationSource | undefined;
  if (conversationId && source) {
    return {
      conversationId,
      source,
      ...(asOptionalString(value.sourceContext) ? { sourceContext: asOptionalString(value.sourceContext) } : {}),
      ...(asOptionalString(value.threadId) ? { threadId: asOptionalString(value.threadId) } : {}),
    };
  }

  if (isRecord(value.event)) {
    return extractConversationEventData(value.event.data);
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asOptionalString(value: unknown): string | undefined {
  const normalized = asString(value);
  return normalized.length > 0 ? normalized : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter(Boolean);
}

function normalizeUrgency(value: unknown): ConversationAnnotationSummary["urgency"] {
  const normalized = asString(value).toLowerCase();
  if (normalized === "critical") return "critical";
  if (normalized === "high") return "high";
  if (normalized === "low") return "low";
  return "medium";
}

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: getRedisPort(),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

function getDedupKey(conversationId: string): string {
  return `conversation:annotate:${conversationId}:last_count`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);

  return slug || "conversation";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clip(value: string, max = 240): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeParticipants(participants: ConversationParticipant[]): ConversationParticipant[] {
  const seen = new Set<string>();
  const normalized: ConversationParticipant[] = [];

  for (const participant of participants) {
    const name = participant.name.trim();
    const email = participant.email?.trim();
    const role = participant.role?.trim();
    if (!name && !email) continue;

    const key = `${(email ?? "").toLowerCase()}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      ...(name ? { name } : { name: email ?? "Unknown" }),
      ...(email ? { email } : {}),
      ...(role ? { role } : {}),
    });
  }

  return normalized;
}

function dedupeLinks(links: ConversationLink[]): ConversationLink[] {
  const seen = new Set<string>();
  const normalized: ConversationLink[] = [];

  for (const link of links) {
    const url = asString(link.url);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    normalized.push({
      url,
      ...(link.label ? { label: clip(link.label, 120) } : {}),
      ...(link.context ? { context: clip(link.context, 180) } : {}),
    });
  }

  return normalized;
}

function dedupeActionItems(items: ConversationActionItem[]): ConversationActionItem[] {
  const seen = new Set<string>();
  const normalized: ConversationActionItem[] = [];

  for (const item of items) {
    const owner = clip(asString(item.owner) || "Unknown", 120);
    const task = clip(asString(item.task), 400);
    if (!task) continue;

    const dueDate = asOptionalString(item.dueDate);
    const status = asOptionalString(item.status);
    const reason = asOptionalString(item.reason);
    const key = `${owner.toLowerCase()}::${task.toLowerCase()}::${(dueDate ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      owner,
      task,
      ...(dueDate ? { dueDate } : {}),
      ...(status ? { status } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  return normalized;
}

function extractLinks(messages: ReadMessage[]): ConversationLink[] {
  const urlPattern = /https?:\/\/[^\s)]+/giu;
  const links: ConversationLink[] = [];

  for (const message of messages) {
    const body = message.body ?? "";
    for (const match of body.matchAll(urlPattern)) {
      const rawUrl = match[0]?.replace(/[.,;!?]+$/u, "").trim();
      if (!rawUrl) continue;
      try {
        const parsed = new URL(rawUrl);
        links.push({
          url: parsed.toString(),
          label: parsed.hostname,
          context: clip(body.replace(/\s+/g, " "), 180),
        });
      } catch {
        continue;
      }
    }
  }

  return dedupeLinks(links);
}

function collectParticipants(payload: ReadConversationPayload): ConversationParticipant[] {
  const participants: ConversationParticipant[] = [];
  const starterName = payload.conversation.from?.name?.trim();
  const starterEmail = payload.conversation.from?.email?.trim();

  if (starterName || starterEmail) {
    participants.push({
      name: starterName || starterEmail || "Unknown",
      ...(starterEmail ? { email: starterEmail } : {}),
      role: "thread-starter",
    });
  }

  for (const message of payload.messages) {
    const name = message.from?.name?.trim();
    const email = message.from?.email?.trim();
    if (!name && !email) continue;
    participants.push({
      name: name || email || "Unknown",
      ...(email ? { email } : {}),
      role: message.is_inbound ? "sender" : "teammate",
    });
  }

  return dedupeParticipants(participants);
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const commandError = error as Error & {
      status?: number | null;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const stderr = typeof commandError.stderr === "string"
      ? commandError.stderr.trim()
      : commandError.stderr instanceof Buffer
        ? commandError.stderr.toString("utf8").trim()
        : "";
    const stdout = typeof commandError.stdout === "string"
      ? commandError.stdout.trim()
      : commandError.stdout instanceof Buffer
        ? commandError.stdout.toString("utf8").trim()
        : "";
    const status = typeof commandError.status === "number" ? ` (exit ${commandError.status})` : "";
    return clip(`${commandError.message}${status}${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`.trim(), 500);
  }

  return clip(String(error), 500);
}

function parseJsonEnvelope(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("email read returned empty output");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("email read returned invalid JSON");
  }
}

function parseReadConversationPayload(raw: string): ReadConversationPayload {
  const envelope = parseJsonEnvelope(raw);
  if (!isRecord(envelope)) {
    throw new Error("email read response was not an object");
  }

  if (envelope.ok !== true) {
    const errorMessage = isRecord(envelope.error) ? asString(envelope.error.message) : "";
    throw new Error(errorMessage || "joelclaw email read returned ok=false");
  }

  if (!isRecord(envelope.result)) {
    throw new Error("email read result missing");
  }

  const result = envelope.result;
  const conversation = isRecord(result.conversation) ? result.conversation : null;
  const messages = Array.isArray(result.messages) ? result.messages : [];

  if (!conversation) {
    throw new Error("email read response missing conversation payload");
  }

  return {
    conversation: {
      id: asString(conversation.id),
      subject: asString(conversation.subject),
      status: asString(conversation.status),
      from: isRecord(conversation.from)
        ? {
            name: asString(conversation.from.name),
            email: asString(conversation.from.email),
          }
        : { name: "", email: "" },
      date: asString(conversation.date),
      tags: asStringArray(conversation.tags),
    },
    messages: messages
      .map((message): ReadMessage | null => {
        if (!isRecord(message)) return null;
        const from = isRecord(message.from) ? message.from : {};
        return {
          id: asString(message.id),
          from: {
            name: asString(from.name),
            email: asString(from.email),
          },
          date: asString(message.date),
          is_inbound: Boolean(message.is_inbound),
          body: asString(message.body),
          attachments: Array.isArray(message.attachments)
            ? message.attachments
              .filter(isRecord)
              .map((attachment) => ({
                id: asString(attachment.id),
                name: asString(attachment.name),
                content_type: asOptionalString(attachment.content_type) ?? null,
                size: typeof attachment.size === "number" ? attachment.size : null,
                source_url: asOptionalString(attachment.source_url) ?? null,
              }))
            : [],
        };
      })
      .filter((message): message is ReadMessage => Boolean(message)),
    attachment_summary: isRecord(result.attachment_summary)
      ? {
          total: Number(result.attachment_summary.total ?? 0),
          cached: Number(result.attachment_summary.cached ?? 0),
          metadata_only: Number(result.attachment_summary.metadata_only ?? 0),
          cache_errors: Number(result.attachment_summary.cache_errors ?? 0),
        }
      : undefined,
    fetched_at: asString(result.fetched_at),
    cache: isRecord(result.cache)
      ? {
          hit: typeof result.cache.hit === "boolean" ? result.cache.hit : undefined,
          source: asOptionalString(result.cache.source),
          cache_path: asOptionalString(result.cache.cache_path) ?? null,
          age_seconds: typeof result.cache.age_seconds === "number" ? result.cache.age_seconds : undefined,
          ttl_seconds: typeof result.cache.ttl_seconds === "number" ? result.cache.ttl_seconds : undefined,
          refresh_requested:
            typeof result.cache.refresh_requested === "boolean" ? result.cache.refresh_requested : undefined,
        }
      : undefined,
  };
}

function buildSummarySystemPrompt(): string {
  return [
    "You annotate Front email conversations for Joel Hooks.",
    "Extract operational context with conservative judgment.",
    "Respond ONLY with valid JSON using this exact shape:",
    "{",
    '  "participants": [{ "name": "string", "email": "string optional", "role": "string optional" }],',
    '  "topic": "short topic string",',
    '  "summary": "2-4 sentence summary",',
    '  "keyDecisions": ["decision"],',
    '  "actionItems": [{ "owner": "string", "task": "string", "dueDate": "ISO date or natural language optional", "status": "open|blocked|done optional", "reason": "optional why this matters" }],',
    '  "links": [{ "url": "https://...", "label": "optional label", "context": "optional why it matters" }],',
    '  "urgency": "low|medium|high|critical",',
    '  "needsJoelsInput": { "required": true, "reason": "string", "questions": ["string"] },',
    '  "joelActionItems": [{ "owner": "Joel", "task": "string", "dueDate": "optional", "status": "optional", "reason": "optional" }],',
    '  "datesMentioned": ["date or time reference"]',
    "}",
    "If a field has no data, return an empty array or an empty string. Never omit keys.",
    "Be faithful to the thread. Do not invent people, decisions, deadlines, or urgency.",
    "Only mark needsJoelsInput.required true when Joel explicitly needs to reply, decide, approve, or unblock something.",
  ].join("\n");
}

function buildSummaryPrompt(input: {
  conversationId: string;
  source: ConversationSource;
  sourceContext?: string;
  subject: string;
  participants: ConversationParticipant[];
  messages: ReadMessage[];
  extractedLinks: ConversationLink[];
}): string {
  const participantLines = input.participants.length > 0
    ? input.participants.map((participant) => {
        const identity = participant.email ? `${participant.name} <${participant.email}>` : participant.name;
        return `- ${identity}${participant.role ? ` (${participant.role})` : ""}`;
      })
    : ["- none identified"];

  const linkLines = input.extractedLinks.length > 0
    ? input.extractedLinks.map((link) => `- ${link.url}${link.context ? ` — ${link.context}` : ""}`)
    : ["- none detected in message text"];

  const messageLines = input.messages
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((message, index) => {
      const author = message.from.email
        ? `${message.from.name || message.from.email} <${message.from.email}>`
        : message.from.name || "Unknown";
      const direction = message.is_inbound ? "inbound" : "outbound";
      const attachments = message.attachments.length > 0
        ? ` | attachments: ${message.attachments.map((attachment) => attachment.name || attachment.id).filter(Boolean).join(", ")}`
        : "";
      const body = clip(message.body.replace(/\s+/g, " "), 450);
      return `${index + 1}. [${message.date || "unknown-date"}] ${direction} — ${author}${attachments}\n${body}`;
    });

  return [
    `Conversation ID: ${input.conversationId}`,
    `Source: ${input.source}${input.sourceContext ? ` (${input.sourceContext})` : ""}`,
    `Subject: ${input.subject || "(no subject)"}`,
    "",
    "Participants:",
    ...participantLines,
    "",
    "Links already detected:",
    ...linkLines,
    "",
    "Messages:",
    ...messageLines,
  ].join("\n");
}

function normalizeParticipantsFromSummary(value: unknown, fallback: ConversationParticipant[]): ConversationParticipant[] {
  if (!Array.isArray(value)) return fallback;

  const participants = value
    .filter(isRecord)
    .map((participant) => ({
      name: asString(participant.name),
      ...(asOptionalString(participant.email) ? { email: asOptionalString(participant.email) } : {}),
      ...(asOptionalString(participant.role) ? { role: asOptionalString(participant.role) } : {}),
    }));

  const deduped = dedupeParticipants(participants);
  return deduped.length > 0 ? deduped : fallback;
}

function normalizeActionItems(value: unknown): ConversationActionItem[] {
  if (!Array.isArray(value)) return [];
  return dedupeActionItems(
    value
      .filter(isRecord)
      .map((item) => ({
        owner: asString(item.owner) || "Unknown",
        task: asString(item.task),
        ...(asOptionalString(item.dueDate) ? { dueDate: asOptionalString(item.dueDate) } : {}),
        ...(asOptionalString(item.status) ? { status: asOptionalString(item.status) } : {}),
        ...(asOptionalString(item.reason) ? { reason: asOptionalString(item.reason) } : {}),
      }))
  );
}

function normalizeLinks(value: unknown): ConversationLink[] {
  if (!Array.isArray(value)) return [];
  return dedupeLinks(
    value
      .filter(isRecord)
      .map((link) => ({
        url: asString(link.url),
        ...(asOptionalString(link.label) ? { label: asOptionalString(link.label) } : {}),
        ...(asOptionalString(link.context) ? { context: asOptionalString(link.context) } : {}),
      }))
  );
}

function normalizeNeedsJoelsInput(value: unknown): ConversationJoelInput {
  if (!isRecord(value)) {
    return { required: false, reason: "", questions: [] };
  }

  return {
    required: Boolean(value.required),
    reason: clip(asString(value.reason), 400),
    questions: uniqueStrings(asStringArray(value.questions).map((question) => clip(question, 300))),
  };
}

function normalizeAnnotationSummary(input: {
  raw: unknown;
  subject: string;
  participants: ConversationParticipant[];
  extractedLinks: ConversationLink[];
}): ConversationAnnotationSummary {
  const record = isRecord(input.raw) ? input.raw : {};
  const actionItems = normalizeActionItems(record.actionItems);
  const joelActionItems = normalizeActionItems(record.joelActionItems);
  const summaryLinks = dedupeLinks([...normalizeLinks(record.links), ...input.extractedLinks]);
  const needsJoelsInput = normalizeNeedsJoelsInput(record.needsJoelsInput);

  return {
    participants: normalizeParticipantsFromSummary(record.participants, input.participants),
    topic: clip(asString(record.topic) || input.subject || "Conversation", 160),
    summary: clip(asString(record.summary), 1200),
    keyDecisions: uniqueStrings(asStringArray(record.keyDecisions).map((decision) => clip(decision, 300))),
    actionItems,
    links: summaryLinks,
    urgency: normalizeUrgency(record.urgency),
    needsJoelsInput,
    joelActionItems: joelActionItems.length > 0
      ? joelActionItems
      : actionItems.filter((item) => JOEL_OWNER_RE.test(item.owner)),
    datesMentioned: uniqueStrings(asStringArray(record.datesMentioned).map((date) => clip(date, 120))),
  };
}

function formatParticipantPlain(participant: ConversationParticipant): string {
  const identity = participant.email ? `${participant.name} <${participant.email}>` : participant.name;
  return participant.role ? `${identity} (${participant.role})` : identity;
}

function formatParticipantHtml(participant: ConversationParticipant): string {
  const identity = participant.email
    ? `${escapeHtml(participant.name)} &lt;${escapeHtml(participant.email)}&gt;`
    : escapeHtml(participant.name);
  return participant.role ? `${identity} (${escapeHtml(participant.role)})` : identity;
}

function formatActionPlain(item: ConversationActionItem): string {
  const due = item.dueDate ? ` — due ${item.dueDate}` : "";
  const status = item.status ? ` [${item.status}]` : "";
  return `${item.owner}: ${item.task}${status}${due}`;
}

function formatActionHtml(item: ConversationActionItem): string {
  const due = item.dueDate ? ` — due ${escapeHtml(item.dueDate)}` : "";
  const status = item.status ? ` [${escapeHtml(item.status)}]` : "";
  return `${escapeHtml(item.owner)}: ${escapeHtml(item.task)}${status}${due}`;
}

function frontConversationUrl(conversationId: string): string {
  return `${FRONT_CONVERSATION_URL}/${conversationId}`;
}

function buildGatewayStartPrompt(input: {
  conversationId: string;
  source: ConversationSource;
  sourceContext?: string;
  threadId?: string;
}): string {
  return [
    "## 📧 Conversation annotation started",
    "",
    `Conversation: ${input.conversationId}`,
    `Source: ${input.source}${input.sourceContext ? ` (${input.sourceContext})` : ""}`,
    ...(input.threadId ? [`Telegram thread: ${input.threadId}`] : []),
  ].join("\n");
}

function buildGatewaySummaryPrompt(input: {
  conversationId: string;
  subject: string;
  source: ConversationSource;
  sourceContext?: string;
  threadId?: string;
  summary: ConversationAnnotationSummary;
}): string {
  const lines: string[] = [
    "## 📧 Conversation annotated",
    "",
    `Subject: ${input.subject || "(no subject)"}`,
    `Conversation: ${input.conversationId}`,
    `Source: ${input.source}${input.sourceContext ? ` (${input.sourceContext})` : ""}`,
    ...(input.threadId ? [`Telegram thread: ${input.threadId}`] : []),
    `Urgency: ${input.summary.urgency}`,
    "",
    input.summary.summary || "No summary available.",
  ];

  if (input.summary.participants.length > 0) {
    lines.push("", "Participants:");
    for (const participant of input.summary.participants.slice(0, 8)) {
      lines.push(`- ${formatParticipantPlain(participant)}`);
    }
  }

  if (input.summary.keyDecisions.length > 0) {
    lines.push("", "Key decisions:");
    for (const decision of input.summary.keyDecisions.slice(0, 6)) {
      lines.push(`- ${decision}`);
    }
  }

  if (input.summary.actionItems.length > 0) {
    lines.push("", "Action items:");
    for (const item of input.summary.actionItems.slice(0, 8)) {
      lines.push(`- ${formatActionPlain(item)}`);
    }
  }

  if (input.summary.links.length > 0) {
    lines.push("", "Links:");
    for (const link of input.summary.links.slice(0, 6)) {
      lines.push(`- ${link.label ? `${link.label}: ` : ""}${link.url}`);
    }
  }

  if (input.summary.needsJoelsInput.required || input.summary.joelActionItems.length > 0) {
    lines.push(
      "",
      `Needs Joel's input: ${input.summary.needsJoelsInput.required ? "yes" : "not explicitly"}`,
    );
    if (input.summary.needsJoelsInput.reason) {
      lines.push(`Reason: ${input.summary.needsJoelsInput.reason}`);
    }
    for (const question of input.summary.needsJoelsInput.questions.slice(0, 4)) {
      lines.push(`- ${question}`);
    }
  }

  lines.push("", `Front: ${frontConversationUrl(input.conversationId)}`);
  return lines.join("\n");
}

function buildTelegramSummaryHtml(input: {
  conversationId: string;
  subject: string;
  source: ConversationSource;
  sourceContext?: string;
  summary: ConversationAnnotationSummary;
}): string {
  const lines: string[] = [
    "<b>📧 Conversation annotated</b>",
    "",
    `<b>Subject:</b> ${escapeHtml(input.subject || "(no subject)")}`,
    `<b>Conversation:</b> <code>${escapeHtml(input.conversationId)}</code>`,
    `<b>Source:</b> ${escapeHtml(input.source)}${input.sourceContext ? ` (${escapeHtml(input.sourceContext)})` : ""}`,
    `<b>Urgency:</b> ${escapeHtml(input.summary.urgency)}`,
    "",
    escapeHtml(input.summary.summary || "No summary available."),
  ];

  if (input.summary.participants.length > 0) {
    lines.push("", "<b>Participants</b>");
    for (const participant of input.summary.participants.slice(0, 8)) {
      lines.push(`• ${formatParticipantHtml(participant)}`);
    }
  }

  if (input.summary.actionItems.length > 0) {
    lines.push("", "<b>Action items</b>");
    for (const item of input.summary.actionItems.slice(0, 6)) {
      lines.push(`• ${formatActionHtml(item)}`);
    }
  }

  if (input.summary.links.length > 0) {
    lines.push("", "<b>Links</b>");
    for (const link of input.summary.links.slice(0, 6)) {
      const href = escapeHtml(link.url);
      const label = escapeHtml(link.label || link.url);
      lines.push(`• <a href="${href}">${label}</a>`);
    }
  }

  if (input.summary.needsJoelsInput.required) {
    lines.push("", `<b>Joel input needed:</b> ${escapeHtml(input.summary.needsJoelsInput.reason || "Yes")}`);
  }

  lines.push("", `<a href="${escapeHtml(frontConversationUrl(input.conversationId))}">Open in Front</a>`);
  return lines.join("\n");
}

function buildActionsPrompt(input: {
  conversationId: string;
  subject: string;
  joelActionItems: ConversationActionItem[];
  needsJoelsInput: ConversationJoelInput;
}): string {
  const lines: string[] = [
    "## ⚠️ Conversation needs Joel",
    "",
    `Subject: ${input.subject || "(no subject)"}`,
    `Conversation: ${input.conversationId}`,
  ];

  if (input.joelActionItems.length > 0) {
    lines.push("", "Joel action items:");
    for (const item of input.joelActionItems.slice(0, 8)) {
      lines.push(`- ${formatActionPlain(item)}`);
    }
  }

  if (input.needsJoelsInput.reason) {
    lines.push("", `Why Joel is needed: ${input.needsJoelsInput.reason}`);
  }

  if (input.needsJoelsInput.questions.length > 0) {
    lines.push("", "Questions:");
    for (const question of input.needsJoelsInput.questions.slice(0, 6)) {
      lines.push(`- ${question}`);
    }
  }

  return lines.join("\n");
}

function buildActionsHtml(input: {
  conversationId: string;
  subject: string;
  joelActionItems: ConversationActionItem[];
  needsJoelsInput: ConversationJoelInput;
}): string {
  const lines: string[] = [
    "<b>⚠️ Conversation needs Joel</b>",
    "",
    `<b>Subject:</b> ${escapeHtml(input.subject || "(no subject)")}`,
    `<b>Conversation:</b> <code>${escapeHtml(input.conversationId)}</code>`,
  ];

  if (input.joelActionItems.length > 0) {
    lines.push("", "<b>Joel action items</b>");
    for (const item of input.joelActionItems.slice(0, 8)) {
      lines.push(`• ${formatActionHtml(item)}`);
    }
  }

  if (input.needsJoelsInput.reason) {
    lines.push("", `<b>Why Joel is needed:</b> ${escapeHtml(input.needsJoelsInput.reason)}`);
  }

  if (input.needsJoelsInput.questions.length > 0) {
    lines.push("", "<b>Questions</b>");
    for (const question of input.needsJoelsInput.questions.slice(0, 6)) {
      lines.push(`• ${escapeHtml(question)}`);
    }
  }

  lines.push("", `<a href="${escapeHtml(frontConversationUrl(input.conversationId))}">Open in Front</a>`);
  return lines.join("\n");
}

function buildVaultMarkdown(input: {
  conversationId: string;
  subject: string;
  source: ConversationSource;
  sourceContext?: string;
  threadId?: string;
  fetchedAt: string;
  annotatedAt: string;
  messageCount: number;
  summary: ConversationAnnotationSummary;
  messages: ReadMessage[];
  notePath: string;
}): string {
  const lines: string[] = [
    "---",
    `conversation_id: ${JSON.stringify(input.conversationId)}`,
    `subject: ${JSON.stringify(input.subject || "(no subject)")}`,
    `source: ${JSON.stringify(input.source)}`,
    ...(input.sourceContext ? [`source_context: ${JSON.stringify(input.sourceContext)}`] : []),
    ...(input.threadId ? [`thread_id: ${JSON.stringify(input.threadId)}`] : []),
    `message_count: ${input.messageCount}`,
    `fetched_at: ${JSON.stringify(input.fetchedAt)}`,
    `annotated_at: ${JSON.stringify(input.annotatedAt)}`,
    `topic: ${JSON.stringify(input.summary.topic)}`,
    `urgency: ${JSON.stringify(input.summary.urgency)}`,
    `needs_joels_input: ${input.summary.needsJoelsInput.required}`,
    `front_url: ${JSON.stringify(frontConversationUrl(input.conversationId))}`,
    `vault_path: ${JSON.stringify(input.notePath)}`,
    "---",
    "",
    `# ${input.subject || "Conversation"}`,
    "",
    `- Conversation ID: \`${input.conversationId}\``,
    `- Source: ${input.source}${input.sourceContext ? ` (${input.sourceContext})` : ""}`,
    `- Messages: ${input.messageCount}`,
    `- Topic: ${input.summary.topic}`,
    `- Fetched: ${input.fetchedAt}`,
    `- Annotated: ${input.annotatedAt}`,
    `- Front: ${frontConversationUrl(input.conversationId)}`,
    "",
    "## Summary",
    "",
    input.summary.summary || "No summary available.",
  ];

  if (input.summary.participants.length > 0) {
    lines.push("", "## Participants", "");
    for (const participant of input.summary.participants) {
      lines.push(`- ${formatParticipantPlain(participant)}`);
    }
  }

  if (input.summary.keyDecisions.length > 0) {
    lines.push("", "## Key Decisions", "");
    for (const decision of input.summary.keyDecisions) {
      lines.push(`- ${decision}`);
    }
  }

  if (input.summary.actionItems.length > 0) {
    lines.push("", "## Action Items", "");
    for (const item of input.summary.actionItems) {
      lines.push(`- ${formatActionPlain(item)}`);
    }
  }

  lines.push("", "## Joel Input", "");
  lines.push(`- Required: ${input.summary.needsJoelsInput.required ? "Yes" : "No"}`);
  if (input.summary.needsJoelsInput.reason) {
    lines.push(`- Reason: ${input.summary.needsJoelsInput.reason}`);
  }
  for (const question of input.summary.needsJoelsInput.questions) {
    lines.push(`- Question: ${question}`);
  }

  if (input.summary.joelActionItems.length > 0) {
    lines.push("", "## Joel Action Items", "");
    for (const item of input.summary.joelActionItems) {
      lines.push(`- ${formatActionPlain(item)}`);
    }
  }

  if (input.summary.links.length > 0) {
    lines.push("", "## Links", "");
    for (const link of input.summary.links) {
      const label = link.label ? `${link.label}: ` : "";
      const context = link.context ? ` — ${link.context}` : "";
      lines.push(`- ${label}${link.url}${context}`);
    }
  }

  if (input.summary.datesMentioned.length > 0) {
    lines.push("", "## Dates Mentioned", "");
    for (const date of input.summary.datesMentioned) {
      lines.push(`- ${date}`);
    }
  }

  if (input.messages.length > 0) {
    lines.push("", "## Message Timeline", "");
    for (const message of input.messages.slice().sort((left, right) => left.date.localeCompare(right.date))) {
      const author = message.from.email
        ? `${message.from.name || message.from.email} <${message.from.email}>`
        : message.from.name || "Unknown";
      const direction = message.is_inbound ? "inbound" : "outbound";
      const attachments = message.attachments.length > 0
        ? ` | attachments: ${message.attachments.map((attachment) => attachment.name || attachment.id).filter(Boolean).join(", ")}`
        : "";
      lines.push(`- ${message.date || "unknown-date"} — ${direction} — ${author}${attachments}`);
      lines.push(`  ${clip(message.body.replace(/\s+/g, " "), 300)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function getSummaryUsageMetadata(usage: unknown): Record<string, unknown> {
  if (!isRecord(usage)) return {};
  const metadata: Record<string, unknown> = {};
  if (typeof usage.inputTokens === "number") metadata.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") metadata.outputTokens = usage.outputTokens;
  if (typeof usage.totalTokens === "number") metadata.totalTokens = usage.totalTokens;
  if (typeof usage.costTotal === "number") metadata.costTotal = usage.costTotal;
  return metadata;
}

export const conversationAnnotate = inngest.createFunction(
  {
    id: "conversation/annotate",
    name: "Conversation Annotation Pipeline",
    concurrency: { limit: 2 },
    retries: 2,
    idempotency: "event.data.conversationId",
    onFailure: async ({ event, error, step }) => {
      const failureData = extractConversationEventData((event as ConversationAnnotateEvent | { data?: unknown }).data);
      const conversationId = failureData?.conversationId ?? "unknown";
      const source = failureData?.source ?? "unknown";
      const sourceContext = failureData?.sourceContext;
      const threadId = failureData?.threadId;
      const errorMessage = commandErrorMessage(error);

      await step.run("reset-dedup-on-failure", async () => {
        if (conversationId === "unknown") return;
        await getRedis().del(getDedupKey(conversationId));
      });

      await step.run("log-failure", async () => {
        await emitOtelEvent({
          level: "error",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.failed",
          success: false,
          error: errorMessage,
          metadata: {
            conversationId,
            source,
            sourceContext: sourceContext ?? null,
            threadId: threadId ?? null,
          },
        });
      });

      await step.run("notify-gateway-failure", async () => {
        const prompt = [
          "## ❌ Conversation annotation failed",
          "",
          `Conversation: ${conversationId}`,
          `Source: ${source}${sourceContext ? ` (${sourceContext})` : ""}`,
          ...(threadId ? [`Telegram thread: ${threadId}`] : []),
          `Error: ${errorMessage}`,
        ].join("\n");

        const message = [
          "<b>❌ Conversation annotation failed</b>",
          "",
          `<b>Conversation:</b> <code>${escapeHtml(conversationId)}</code>`,
          `<b>Source:</b> ${escapeHtml(source)}${sourceContext ? ` (${escapeHtml(sourceContext)})` : ""}`,
          ...(threadId ? [`<b>Telegram thread:</b> ${escapeHtml(threadId)}`] : []),
          `<b>Error:</b> ${escapeHtml(errorMessage)}`,
        ].join("\n");

        await pushGatewayEvent({
          type: "notification",
          source: GATEWAY_SOURCE,
          payload: {
            prompt,
            message,
            channel: "telegram",
            format: "html",
            parseMode: "HTML",
            conversationId,
            sourceContext: sourceContext ?? null,
            threadId: threadId ?? null,
            kind: "failure",
          },
        });
      });
    },
  },
  { event: "conversation/annotate.requested" },
  async ({ event, step }) => {
    const conversationId = asString(event.data.conversationId);
    const source = event.data.source;
    const sourceContext = asOptionalString(event.data.sourceContext);
    const threadId = asOptionalString(event.data.threadId);

    const fetched = await step.run("fetch-conversation", async (): Promise<FetchConversationResult> => {
      try {
        await emitOtelEvent({
          level: "info",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.triggered",
          success: true,
          metadata: {
            conversationId,
            source,
            sourceContext: sourceContext ?? null,
            threadId: threadId ?? null,
          },
        });

        const startPrompt = buildGatewayStartPrompt({
          conversationId,
          source,
          sourceContext,
          threadId,
        });
        const startHtml = [
          "<b>📧 Conversation annotation started</b>",
          "",
          `<b>Conversation:</b> <code>${escapeHtml(conversationId)}</code>`,
          `<b>Source:</b> ${escapeHtml(source)}${sourceContext ? ` (${escapeHtml(sourceContext)})` : ""}`,
          ...(threadId ? [`<b>Telegram thread:</b> ${escapeHtml(threadId)}`] : []),
        ].join("\n");

        try {
          await pushGatewayEvent({
            type: "notification",
            source: GATEWAY_SOURCE,
            payload: {
              prompt: startPrompt,
              message: startHtml,
              channel: "telegram",
              format: "html",
              parseMode: "HTML",
              conversationId,
              sourceContext: sourceContext ?? null,
              threadId: threadId ?? null,
              kind: "started",
            },
          });
        } catch (gatewayError) {
          await emitOtelEvent({
            level: "warn",
            source: OTEL_SOURCE,
            component: COMPONENT,
            action: "conversation.annotate.gateway_start_failed",
            success: false,
            error: commandErrorMessage(gatewayError),
            metadata: {
              conversationId,
              source,
              sourceContext: sourceContext ?? null,
              threadId: threadId ?? null,
            },
          });
        }

        if (!conversationId) {
          throw new Error("conversationId missing");
        }

        const quotedConversationId = conversationId.replace(/'/g, `'"'"'`);
        const output = execSync(`joelclaw email read --id '${quotedConversationId}'`, {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            TERM: "dumb",
            NO_COLOR: "1",
          },
        });
        const payload = parseReadConversationPayload(output);
        const participants = collectParticipants(payload);
        const messageCount = payload.messages.length;
        const subject = payload.conversation.subject || "(no subject)";
        const extractedLinks = extractLinks(payload.messages);

        await emitOtelEvent({
          level: "info",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.fetched",
          success: true,
          metadata: {
            conversationId,
            source,
            sourceContext: sourceContext ?? null,
            threadId: threadId ?? null,
            subject,
            messageCount,
            participants: participants.map((participant) => formatParticipantPlain(participant)),
            fetchedAt: payload.fetched_at,
            cacheSource: payload.cache?.source ?? null,
            cacheHit: payload.cache?.hit ?? null,
            linksDetected: extractedLinks.length,
          },
        });

        return {
          payload,
          subject,
          messageCount,
          participants,
          extractedLinks,
        };
      } catch (error) {
        const errorMessage = commandErrorMessage(error);
        await emitOtelEvent({
          level: "error",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.fetched",
          success: false,
          error: errorMessage,
          metadata: {
            conversationId,
            source,
            sourceContext: sourceContext ?? null,
            threadId: threadId ?? null,
          },
        });
        throw error;
      }
    });

    const dedup = await step.run("check-dedup", async () => {
      try {
        const redis = getRedis();
        const key = getDedupKey(conversationId);
        const previousCountRaw = await redis.get(key);
        const previousCount = previousCountRaw ? Number.parseInt(previousCountRaw, 10) : null;
        const unchanged = previousCount !== null && previousCount === fetched.messageCount;

        if (unchanged) {
          await emitOtelEvent({
            level: "info",
            source: OTEL_SOURCE,
            component: COMPONENT,
            action: "conversation.annotate.dedup_skip",
            success: true,
            metadata: {
              conversationId,
              subject: fetched.subject,
              previousCount,
              messageCount: fetched.messageCount,
              dedupKey: key,
              ttlSeconds: DEDUP_TTL_SECONDS,
            },
          });

          return {
            skipped: true as const,
            dedupKey: key,
            previousCount,
          };
        }

        await redis.set(key, String(fetched.messageCount), "EX", DEDUP_TTL_SECONDS);
        await emitOtelEvent({
          level: "info",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.dedup_checked",
          success: true,
          metadata: {
            conversationId,
            subject: fetched.subject,
            previousCount,
            messageCount: fetched.messageCount,
            dedupKey: key,
            ttlSeconds: DEDUP_TTL_SECONDS,
          },
        });

        return {
          skipped: false as const,
          dedupKey: key,
          previousCount,
        };
      } catch (error) {
        const errorMessage = commandErrorMessage(error);
        await emitOtelEvent({
          level: "error",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.dedup_checked",
          success: false,
          error: errorMessage,
          metadata: {
            conversationId,
            subject: fetched.subject,
            messageCount: fetched.messageCount,
          },
        });
        throw error;
      }
    });

    if (dedup.skipped) {
      return {
        status: "skipped",
        reason: "message-count-unchanged",
        conversationId,
        subject: fetched.subject,
        messageCount: fetched.messageCount,
      };
    }

    const summarized = await step.run("summarize", async () => {
      try {
        const result = await infer(
          buildSummaryPrompt({
            conversationId,
            source,
            sourceContext,
            subject: fetched.subject,
            participants: fetched.participants,
            messages: fetched.payload.messages,
            extractedLinks: fetched.extractedLinks,
          }),
          {
            agent: "triage",
            task: "json",
            system: buildSummarySystemPrompt(),
            component: COMPONENT,
            action: "conversation.annotate.summarize",
            json: true,
            requireJson: true,
            requireTextOutput: true,
            noTools: true,
            timeout: 120_000,
            metadata: {
              conversationId,
              subject: fetched.subject,
              messageCount: fetched.messageCount,
              source,
              sourceContext: sourceContext ?? null,
            },
          }
        );

        const summary = normalizeAnnotationSummary({
          raw: result.data ?? result.text,
          subject: fetched.subject,
          participants: fetched.participants,
          extractedLinks: fetched.extractedLinks,
        });

        await emitOtelEvent({
          level: "info",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.summarized",
          success: true,
          metadata: {
            conversationId,
            subject: fetched.subject,
            messageCount: fetched.messageCount,
            model: result.model ?? null,
            provider: result.provider ?? null,
            summaryLength: summary.summary.length,
            participantCount: summary.participants.length,
            actionItemCount: summary.actionItems.length,
            joelActionCount: summary.joelActionItems.length,
            linksCount: summary.links.length,
            urgency: summary.urgency,
            needsJoelsInput: summary.needsJoelsInput.required,
            ...getSummaryUsageMetadata(result.usage),
          },
        });

        return {
          summary,
          model: result.model ?? null,
          provider: result.provider ?? null,
        };
      } catch (error) {
        const errorMessage = commandErrorMessage(error);
        await emitOtelEvent({
          level: "error",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.summarized",
          success: false,
          error: errorMessage,
          metadata: {
            conversationId,
            subject: fetched.subject,
            messageCount: fetched.messageCount,
          },
        });
        throw error;
      }
    });

    const gatewaySummary = await step.run("notify-gateway", async () => {
      try {
        const prompt = buildGatewaySummaryPrompt({
          conversationId,
          subject: fetched.subject,
          source,
          sourceContext,
          threadId,
          summary: summarized.summary,
        });
        const message = buildTelegramSummaryHtml({
          conversationId,
          subject: fetched.subject,
          source,
          sourceContext,
          summary: summarized.summary,
        });

        const gatewayEvent = await pushGatewayEvent({
          type: "notification",
          source: GATEWAY_SOURCE,
          payload: {
            prompt,
            message,
            channel: "telegram",
            format: "html",
            parseMode: "HTML",
            conversationId,
            threadId: threadId ?? null,
            sourceContext: sourceContext ?? null,
            kind: "summary",
            summaryModel: summarized.model,
          },
        });

        await emitOtelEvent({
          level: "info",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.gateway_notified",
          success: true,
          metadata: {
            conversationId,
            subject: fetched.subject,
            threadId: threadId ?? null,
            gatewayEventId: gatewayEvent.id,
            messageLength: message.length,
            promptLength: prompt.length,
            linksCount: summarized.summary.links.length,
            actionItemCount: summarized.summary.actionItems.length,
          },
        });

        return {
          prompt,
          message,
          gatewayEventId: gatewayEvent.id,
        };
      } catch (error) {
        const errorMessage = commandErrorMessage(error);
        await emitOtelEvent({
          level: "error",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.gateway_notified",
          success: false,
          error: errorMessage,
          metadata: {
            conversationId,
            subject: fetched.subject,
            threadId: threadId ?? null,
          },
        });
        throw error;
      }
    });

    const persisted = await step.run("persist-vault", async () => {
      try {
        await mkdir(VAULT_CONVERSATIONS_DIR, { recursive: true });
        const noteSlug = slugify(fetched.subject || conversationId);
        const notePath = join(VAULT_CONVERSATIONS_DIR, `${noteSlug}.md`);
        const annotatedAt = new Date().toISOString();
        const markdown = buildVaultMarkdown({
          conversationId,
          subject: fetched.subject,
          source,
          sourceContext,
          threadId,
          fetchedAt: fetched.payload.fetched_at || annotatedAt,
          annotatedAt,
          messageCount: fetched.messageCount,
          summary: summarized.summary,
          messages: fetched.payload.messages,
          notePath,
        });

        await writeFile(notePath, markdown, "utf-8");
        await emitOtelEvent({
          level: "info",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.vault_persisted",
          success: true,
          metadata: {
            conversationId,
            subject: fetched.subject,
            notePath,
            noteSlug,
            messageCount: fetched.messageCount,
          },
        });

        return {
          notePath,
          noteSlug,
        };
      } catch (error) {
        const errorMessage = commandErrorMessage(error);
        await emitOtelEvent({
          level: "error",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.vault_persisted",
          success: false,
          error: errorMessage,
          metadata: {
            conversationId,
            subject: fetched.subject,
          },
        });
        throw error;
      }
    });

    const actionExtraction = await step.run("extract-actions", async () => {
      try {
        const joelActionItems = dedupeActionItems([
          ...summarized.summary.joelActionItems,
          ...summarized.summary.actionItems.filter((item) => JOEL_OWNER_RE.test(item.owner)),
        ]);

        if (joelActionItems.length === 0 && !summarized.summary.needsJoelsInput.required) {
          await emitOtelEvent({
            level: "info",
            source: OTEL_SOURCE,
            component: COMPONENT,
            action: "conversation.annotate.actions_extracted",
            success: true,
            metadata: {
              conversationId,
              subject: fetched.subject,
              actionCount: 0,
              notified: false,
            },
          });

          return {
            notified: false,
            actionCount: 0,
          };
        }

        const prompt = buildActionsPrompt({
          conversationId,
          subject: fetched.subject,
          joelActionItems,
          needsJoelsInput: summarized.summary.needsJoelsInput,
        });
        const message = buildActionsHtml({
          conversationId,
          subject: fetched.subject,
          joelActionItems,
          needsJoelsInput: summarized.summary.needsJoelsInput,
        });

        const gatewayEvent = await pushGatewayEvent({
          type: "notification",
          source: GATEWAY_SOURCE,
          payload: {
            prompt,
            message,
            channel: "telegram",
            format: "html",
            parseMode: "HTML",
            conversationId,
            threadId: threadId ?? null,
            sourceContext: sourceContext ?? null,
            kind: "actions",
            actionCount: joelActionItems.length,
          },
        });

        await emitOtelEvent({
          level: "info",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.actions_extracted",
          success: true,
          metadata: {
            conversationId,
            subject: fetched.subject,
            actionCount: joelActionItems.length,
            questionCount: summarized.summary.needsJoelsInput.questions.length,
            notified: true,
            gatewayEventId: gatewayEvent.id,
          },
        });

        return {
          notified: true,
          actionCount: joelActionItems.length,
          gatewayEventId: gatewayEvent.id,
        };
      } catch (error) {
        const errorMessage = commandErrorMessage(error);
        await emitOtelEvent({
          level: "error",
          source: OTEL_SOURCE,
          component: COMPONENT,
          action: "conversation.annotate.actions_extracted",
          success: false,
          error: errorMessage,
          metadata: {
            conversationId,
            subject: fetched.subject,
          },
        });
        throw error;
      }
    });

    return {
      status: "annotated",
      conversationId,
      subject: fetched.subject,
      messageCount: fetched.messageCount,
      notePath: persisted.notePath,
      summaryNotification: gatewaySummary.gatewayEventId,
      actionItemsNotified: actionExtraction.actionCount,
      actionsNotificationSent: actionExtraction.notified,
      urgency: summarized.summary.urgency,
      needsJoelsInput: summarized.summary.needsJoelsInput.required,
    };
  }
);
