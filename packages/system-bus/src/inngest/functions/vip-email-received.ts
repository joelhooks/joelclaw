/**
 * VIP email workflow.
 *
 * Uses Opus for deep analysis and follow-through for high-signal senders.
 */

import { spawnSync } from "node:child_process";
import { infer } from "../../lib/inference";
import { type LlmUsage } from "../../lib/langfuse";
import {
  sendTelegramDirect,
  stripOperatorRelayRules,
  toTelegramHtml,
} from "../../lib/telegram";
import * as typesense from "../../lib/typesense";
import { TodoistTaskAdapter } from "../../tasks";
import { inngest } from "../client";
import { parseClaudeOutput, pushGatewayEvent } from "./agent-loop/utils";
import { isVipSender } from "./vip-utils";

const FRONT_API = "https://api2.frontapp.com";
const FRONT_CONVERSATION_URL = "https://app.frontapp.com/open";
// ADR-0078: Opus 4.1 was $15/$75 per MTok. Opus 4.6 is $5/$15. Never use dated snapshots.
const VIP_MODEL = process.env.JOELCLAW_VIP_EMAIL_MODEL ?? "anthropic/claude-opus-4-6";
const BRIEF_MODEL = process.env.JOELCLAW_VIP_TRIAGE_MODEL ?? "anthropic/claude-sonnet-4-6";
const ENABLE_GITHUB_SEARCH = (process.env.JOELCLAW_VIP_ENABLE_GITHUB_SEARCH ?? "0") === "1";
const ENABLE_OPUS_ESCALATION = (process.env.JOELCLAW_VIP_ENABLE_OPUS_ESCALATION ?? "1") === "1";
const TOTAL_BUDGET_MS = Number(process.env.JOELCLAW_VIP_TOTAL_BUDGET_MS ?? "60000");
const FRONT_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_FRONT_TIMEOUT_MS ?? "2000");
const GRANOLA_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_GRANOLA_TIMEOUT_MS ?? "2500");
const MEMORY_RECALL_TIMEOUT_MS = Number(
  process.env.JOELCLAW_VIP_MEMORY_RECALL_TIMEOUT_MS
  ?? "15000"
);
const GITHUB_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_GITHUB_TIMEOUT_MS ?? "1500");
const BRIEF_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_TRIAGE_TIMEOUT_MS ?? "15000");
const OPUS_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_OPUS_TIMEOUT_MS ?? "20000");
const MIN_OPUS_TIME_REMAINING_MS = Number(process.env.JOELCLAW_VIP_MIN_OPUS_REMAINING_MS ?? "15000");
const GRANOLA_RANGES = (process.env.JOELCLAW_VIP_GRANOLA_RANGES ?? "year")
  .split(",")
  .map((range) => range.trim())
  .filter(Boolean);
const MAX_FRONT_MESSAGES = 50;
const FRONT_MESSAGES_PAGE_SIZE = 25;
const MAX_LINKS_TO_FOLLOW = 5;
const MAX_FOLLOWED_LINK_CONTENT_CHARS = 2000;
const URL_EXTRACT_RE = /https?:\/\/[^\s<>"'`)\]]+/giu;
const HREF_EXTRACT_RE = /href=["']([^"'#]+)["']/giu;
const TRACKING_HOST_FRAGMENTS = [
  "mailchi.mp",
  "mailchimp.com",
  "mandrillapp.com",
  "hubspotlinks.com",
  "hs-sites.com",
  "click.",
  "trk.",
  "track.",
  "lnk.",
  "list-manage.com",
];
const UNSUBSCRIBE_HINTS = [
  "unsubscribe",
  "email-preferences",
  "email_preferences",
  "notification-settings",
  "notification_settings",
  "optout",
];
const NON_CONTENT_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".ics",
];
const JOEL_EMAILS = new Set([
  "joelhooks@gmail.com",
  "joel@egghead.io",
  "joel@joelhooks.com",
]);
// WARNING: Think twice before adding real collaborators here. This auto-archives without review.
const AUTO_ARCHIVE_NEWSLETTER_SENDERS = new Set([]);

const VIP_ANALYSIS_SYSTEM_PROMPT = `You are a relationship intelligence analyst for Joel Hooks.

Goal: produce the highest-value action plan for a VIP email.

Rules:
- Reason deeply from provided context.
- Prioritize concrete next actions with clear owners and timing.
- Generate comprehensive todos.
- Explicitly list information the agent cannot access or verify.
- Never fabricate facts.
- If a source lookup failed, treat it as an access gap.

Respond ONLY with valid JSON:
{
  "executive_summary": "string",
  "interaction_signals": ["string"],
  "entity_investigation": [{ "entity": "string", "type": "person|company|project|property|other", "notes": "string", "confidence": "high|medium|low" }],
  "todos": [{ "title": "string", "description": "string", "priority": 1, "due": "optional natural language due" }],
  "missing_information": [{ "item": "string", "why_missing": "string", "how_to_get_it": "string" }],
  "questions_for_human": ["string"]
}`;

const VIP_BRIEF_SYSTEM_PROMPT = `You are Joel Hooks' VIP email analyst.

Produce a concise operator brief in markdown for Telegram delivery.

Rules:
- Use the exact section order shown below.
- The executive summary must be 2-3 sentences that you derive from the raw thread/context in this prompt.
- Mention why the thread matters now.
- Write your own judgment from the full context; do not parrot any prior triage summary or default "no action required" phrasing when the thread clearly needs action.
- If any prior suggestion conflicts with the raw thread/context, override it.
- "Needs your attention" must start with yes or no, then a short why.
- "Key links" should be "none" when there are no useful links.
- Never invent facts. If context is missing, say so briefly.
- Do not output JSON, XML, code fences, or extra sections.

Output format:
## VIP: {sender} — {subject}

{2-3 sentence executive summary of what's happening and why it matters}

**Thread**: {message count} messages, last activity {relative time}
**Your last reply**: {relative time or "none"}
**Key links**: {1-line summary, or "none"}

**Needs your attention**: {yes/no + why}

[View in Front](https://app.frontapp.com/open/{conversationId})`;

type GranolaMeeting = {
  id: string;
  title: string;
  date?: string;
  participants?: string[];
};

type GitHubRepo = {
  name?: string;
  description?: string;
  url?: string;
  updatedAt?: string;
  stargazersCount?: number;
};

type MissingInfo = {
  item: string;
  why_missing: string;
  how_to_get_it: string;
};

type VipTodo = {
  title: string;
  description: string;
  priority?: number;
  due?: string;
};

type VipAnalysis = {
  executive_summary: string;
  interaction_signals: string[];
  entity_investigation: Array<{ entity: string; type: string; notes: string; confidence: string }>;
  todos: VipTodo[];
  missing_information: MissingInfo[];
  questions_for_human: string[];
};

type FrontThreadMessage = {
  id: string;
  senderName: string;
  senderEmail: string;
  senderDisplay: string;
  createdAt: number;
  createdAtIso: string;
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

type FollowedLink = {
  url: string;
  content: string;
};

type RecallCliHit = {
  id?: unknown;
  observation?: unknown;
};

type RecallCliEnvelope = {
  ok?: unknown;
  result?: {
    hits?: RecallCliHit[];
  };
  error?: {
    message?: unknown;
  };
};

function emptyVipAnalysis(summary = "No actionable follow-up required."): VipAnalysis {
  return {
    executive_summary: summary,
    interaction_signals: [],
    entity_investigation: [],
    todos: [],
    missing_information: [],
    questions_for_human: [],
  };
}

function extractEmailAddress(input: string): string {
  const lowered = input.trim().toLowerCase();
  if (!lowered) return "";
  const match = lowered.match(/<([^>]+)>/);
  const value = (match?.[1] ?? lowered).trim();
  if (!value.includes("@")) return "";
  return value;
}

function extractModelText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  try {
    const envelope = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof envelope.result === "string") return envelope.result.trim();
  } catch {
    // non-JSON or partial JSON output
  }

  return trimmed;
}

function isLikelyNewsletter(input: {
  senderEmail: string;
  subject: string;
  preview: string;
  bodyPlain: string;
}): boolean {
  if (AUTO_ARCHIVE_NEWSLETTER_SENDERS.has(input.senderEmail)) return true;

  const haystack = [input.subject, input.preview, input.bodyPlain].join(" ").toLowerCase();
  const hasUnsubscribe = haystack.includes("unsubscribe");
  const hasNewsletterLanguage = ["newsletter", "weekly", "upcoming", "events", "view in browser"].some((token) =>
    haystack.includes(token)
  );

  return hasUnsubscribe && hasNewsletterLanguage;
}

function parseJsonOutput<T>(command: string, args: string[], timeoutMs = 30_000): { ok: boolean; data?: T; error?: string } {
  const proc = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TERM: "dumb" },
  });

  const stdout = (proc.stdout ?? "").trim();
  const stderr = (proc.stderr ?? "").trim();

  if (proc.status !== 0) {
    return { ok: false, error: stderr || stdout || `exit ${proc.status ?? "unknown"}` };
  }

  if (!stdout) {
    return { ok: false, error: "no output" };
  }

  try {
    return { ok: true, data: JSON.parse(stdout) as T };
  } catch {
    return { ok: false, error: `invalid JSON output: ${stdout.slice(0, 200)}` };
  }
}

function throwIfGranolaRateLimited(rawText: string, context: string): void {
  if (!rawText.toLowerCase().includes("rate limit")) return;
  throw new Error(
    `Granola rate limited (~1 hour window) during ${context}; retrying: ${rawText.slice(0, 500)}`
  );
}

function normalizePriority(priority?: number): 1 | 2 | 3 | 4 {
  if (priority === 4 || priority === 3 || priority === 2 || priority === 1) return priority;
  return 2;
}

function readFrontToken(): string {
  return process.env.FRONT_API_TOKEN ?? "";
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

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
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

function frontConversationUrl(conversationId: string): string {
  return `${FRONT_CONVERSATION_URL}/${conversationId}`;
}

function isJoelEmail(value: string): boolean {
  return JOEL_EMAILS.has(extractEmailAddress(value));
}

function extractPageToken(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return new URL(value).searchParams.get("page_token");
  } catch {
    return null;
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
    createdAtIso: new Date(timestamp).toISOString(),
    text: normalizeFrontMessageText(message),
    isInbound: Boolean(message.is_inbound ?? message.isInbound),
  };
}

function buildFallbackFrontThreadContext(input: {
  conversationId: string;
  messageId: string;
  senderName: string;
  senderEmail: string;
  senderDisplay: string;
  subject: string;
  bodyPlain: string;
  body: string;
  preview: string;
}): FrontThreadContext {
  const timestamp = Date.now();
  const latestMessage: FrontThreadMessage = {
    id: input.messageId || `${input.conversationId}:latest`,
    senderName: input.senderName || input.senderEmail || "unknown",
    senderEmail: input.senderEmail,
    senderDisplay: input.senderDisplay,
    createdAt: timestamp,
    createdAtIso: new Date(timestamp).toISOString(),
    text: normalizeWhitespace(input.bodyPlain || stripHtmlToText(input.body) || input.preview),
    isInbound: true,
  };

  return {
    summary: {
      subject: input.subject,
      status: "unknown",
      tags: [],
      messageCount: 1,
    },
    messages: [latestMessage],
    latestMessage,
    joelReplied: false,
  };
}

function extractUrlCandidates(rawBody: string, htmlBody: string): string[] {
  const values: string[] = [];
  for (const match of rawBody.matchAll(URL_EXTRACT_RE)) {
    values.push(match[0]);
  }
  for (const match of htmlBody.matchAll(HREF_EXTRACT_RE)) {
    values.push(match[1] ?? "");
  }
  return values;
}

function normalizeUrlCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/[),.;]+$/u, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isInterestingEmailUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const combined = `${hostname}${path}${url.search}`.toLowerCase();

    if (TRACKING_HOST_FRAGMENTS.some((fragment) => hostname.includes(fragment))) return false;
    if (UNSUBSCRIBE_HINTS.some((hint) => combined.includes(hint))) return false;
    if (NON_CONTENT_EXTENSIONS.some((extension) => path.endsWith(extension))) return false;

    const isKnownDocSurface = hostname.includes("docs.google.com")
      || hostname.includes("notion.so")
      || hostname.includes("notion.site")
      || hostname.includes("figma.com");
    const isContentPage = !combined.includes("utm_")
      && !combined.includes("signature")
      && !combined.includes("open.pixel")
      && !combined.includes("/u/")
      && path.length > 1;

    return isKnownDocSurface || isContentPage;
  } catch {
    return false;
  }
}

function extractInterestingUrlsFromEmail(rawBody: string, htmlBody: string): string[] {
  const candidates = extractUrlCandidates(rawBody, htmlBody)
    .map(normalizeUrlCandidate)
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(candidates)).filter(isInterestingEmailUrl).slice(0, MAX_LINKS_TO_FOLLOW);
}

function summarizeFollowedLinkContent(link: FollowedLink): string {
  const trimmed = normalizeWhitespace(link.content);
  if (!trimmed) return "content unavailable";
  const sentence = trimmed.split(/(?<=[.!?])\s+/u)[0] ?? trimmed;
  return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence;
}

async function fetchFrontThread(conversationId: string): Promise<FrontThreadContext | null> {
  const token = readFrontToken();
  if (!token || !conversationId) return null;

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  try {
    const convoRes = await fetchJsonWithTimeout(
      `${FRONT_API}/conversations/${conversationId}`,
      { headers },
      FRONT_TIMEOUT_MS
    );
    if (!convoRes.ok) {
      const detail = (await convoRes.text().catch(() => "")).slice(0, 180);
      throw new Error(`conversation ${convoRes.status}${detail ? `: ${detail}` : ""}`);
    }
    const convo = (await convoRes.json()) as Record<string, unknown>;

    const messages: FrontThreadMessage[] = [];
    let pageToken: string | null = null;

    while (messages.length < MAX_FRONT_MESSAGES) {
      const limit = Math.min(FRONT_MESSAGES_PAGE_SIZE, MAX_FRONT_MESSAGES - messages.length);
      const url = new URL(`${FRONT_API}/conversations/${conversationId}/messages`);
      url.searchParams.set("limit", String(limit));
      if (pageToken) url.searchParams.set("page_token", pageToken);

      const msgRes = await fetchJsonWithTimeout(url.toString(), { headers }, FRONT_TIMEOUT_MS);
      if (!msgRes.ok) {
        const detail = (await msgRes.text().catch(() => "")).slice(0, 180);
        throw new Error(`messages ${msgRes.status}${detail ? `: ${detail}` : ""}`);
      }

      const msgBody = (await msgRes.json()) as Record<string, unknown>;
      const results = Array.isArray(msgBody._results) ? msgBody._results : [];
      if (results.length === 0) break;

      for (const item of results) {
        if (!item || typeof item !== "object") continue;
        const normalized = normalizeFrontThreadMessage(item as Record<string, unknown>);
        if (normalized) messages.push(normalized);
        if (messages.length >= MAX_FRONT_MESSAGES) break;
      }

      pageToken = extractPageToken((msgBody._pagination as Record<string, unknown> | undefined)?.next);
      if (!pageToken) break;
    }

    messages.sort((left, right) => left.createdAt - right.createdAt);
    const latestMessage = messages.at(-1) ?? null;
    const lastJoelReplyAt = messages
      .filter((message) => isJoelEmail(message.senderEmail))
      .map((message) => message.createdAt)
      .sort((left, right) => right - left)[0];
    const tags = Array.isArray(convo.tags)
      ? uniqueStrings(
          convo.tags
            .filter((tag): tag is Record<string, unknown> => Boolean(tag) && typeof tag === "object")
            .map((tag) => String(tag.name ?? ""))
        )
      : [];

    return {
      summary: {
        subject: String(convo.subject ?? ""),
        status: String(convo.status ?? ""),
        tags,
        messageCount: messages.length,
      },
      messages,
      latestMessage,
      joelReplied: lastJoelReplyAt != null,
      ...(lastJoelReplyAt != null ? { lastJoelReplyAt } : {}),
    };
  } catch {
    return null;
  }
}

async function archiveFrontConversation(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const token = readFrontToken();
  if (!token) return { ok: false, error: "FRONT_API_TOKEN missing" };
  if (!conversationId) return { ok: false, error: "conversationId missing" };

  try {
    const res = await fetchJsonWithTimeout(
      `${FRONT_API}/conversations/${conversationId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ status: "archived" }),
      },
      FRONT_TIMEOUT_MS
    );

    if (res.ok || res.status === 204) return { ok: true };
    const body = (await res.text()).slice(0, 180);
    return { ok: false, error: `Front API ${res.status}${body ? `: ${body}` : ""}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
    };
  }
}

function parseGranolaMeetingsResponse(data: unknown): GranolaMeeting[] {
  if (!data || typeof data !== "object") return [];
  const body = data as Record<string, unknown>;
  const result = (body.result ?? {}) as Record<string, unknown>;
  const meetings = Array.isArray(result.meetings)
    ? result.meetings
    : Array.isArray(body.result)
      ? body.result
      : [];

  return meetings
    .filter((meeting): meeting is Record<string, unknown> => Boolean(meeting) && typeof meeting === "object")
    .map((meeting) => ({
      id: String(meeting.id ?? ""),
      title: String(meeting.title ?? "Untitled"),
      date: typeof meeting.date === "string" ? meeting.date : undefined,
      participants: Array.isArray(meeting.participants)
        ? meeting.participants.filter((p): p is string => typeof p === "string")
        : undefined,
    }))
    .filter((meeting) => Boolean(meeting.id));
}

function tokenizeSubject(subject: string): string[] {
  return subject
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .slice(0, 8);
}

function findRelatedMeetings(meetings: GranolaMeeting[], senderName: string, subject: string): GranolaMeeting[] {
  const senderTokens = senderName.toLowerCase().split(/\s+/g).filter((token) => token.length >= 3);
  const subjectTokens = tokenizeSubject(subject);

  return meetings.filter((meeting) => {
    const haystack = `${meeting.title} ${(meeting.participants ?? []).join(" ")}`.toLowerCase();
    const senderMatch = senderTokens.some((token) => haystack.includes(token));
    const subjectMatch = subjectTokens.some((token) => haystack.includes(token));
    return senderMatch || subjectMatch;
  });
}

function parseVipAnalysis(raw: string): VipAnalysis {
  const parsed = parseClaudeOutput(raw);
  if (!parsed || typeof parsed !== "object") {
    const text = extractModelText(raw).replace(/\s+/g, " ").trim();
    if (!text) return emptyVipAnalysis();
    const summary = text.length > 220 ? `${text.slice(0, 217)}...` : text;
    return emptyVipAnalysis(`No structured VIP analysis returned. ${summary}`);
  }

  const data = parsed as Record<string, unknown>;

  const todos = Array.isArray(data.todos)
    ? data.todos
        .filter((todo): todo is Record<string, unknown> => Boolean(todo) && typeof todo === "object")
        .map((todo) => ({
          title: String(todo.title ?? "").trim(),
          description: String(todo.description ?? "").trim(),
          priority: Number(todo.priority ?? 2),
          due: typeof todo.due === "string" ? todo.due : undefined,
        }))
        .filter((todo) => Boolean(todo.title))
    : [];

  const missing = Array.isArray(data.missing_information)
    ? data.missing_information
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          item: String(item.item ?? "").trim(),
          why_missing: String(item.why_missing ?? "").trim(),
          how_to_get_it: String(item.how_to_get_it ?? "").trim(),
        }))
        .filter((item) => Boolean(item.item))
    : [];

  const entities = Array.isArray(data.entity_investigation)
    ? data.entity_investigation
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          entity: String(item.entity ?? "").trim(),
          type: String(item.type ?? "other").trim(),
          notes: String(item.notes ?? "").trim(),
          confidence: String(item.confidence ?? "medium").trim(),
        }))
        .filter((item) => Boolean(item.entity))
    : [];

  const signals = Array.isArray(data.interaction_signals)
    ? data.interaction_signals.map((item) => String(item)).filter(Boolean)
    : [];

  const questions = Array.isArray(data.questions_for_human)
    ? data.questions_for_human.map((item) => String(item)).filter(Boolean)
    : [];

  return {
    executive_summary: String(data.executive_summary ?? "").trim() || (todos.length > 0 ? "VIP analysis generated." : "No actionable follow-up required."),
    interaction_signals: signals,
    entity_investigation: entities,
    todos,
    missing_information: missing,
    questions_for_human: questions,
  };
}

async function runModelAnalysis(
  model: string,
  systemPrompt: string,
  prompt: string,
  timeoutMs: number
): Promise<{ analysis: VipAnalysis; error?: string; provider?: string; model?: string; usage?: LlmUsage }> {
  try {
    const result = await infer(prompt, {
      task: "json",
      model,
      system: systemPrompt,
      component: "vip-email-received",
      action: "vip-email.analysis",
      json: true,
      print: true,
      noTools: true,
      timeout: timeoutMs,
      env: { ...process.env, TERM: "dumb" },
    });

    const payload = result.data != null
      ? (typeof result.data === "string" ? result.data : JSON.stringify(result.data))
      : "";
    return {
      analysis: parseVipAnalysis(payload || result.text),
      provider: result.provider,
      model: result.model ?? model,
      usage: result.usage,
      error: payload.length === 0 && result.text.length === 0 ? "empty model output" : undefined,
    };
  } catch (error) {
    return {
      analysis: parseVipAnalysis(""),
      error: error instanceof Error ? error.message : String(error),
      provider: model,
      model,
    };
  }
}

async function runOperatorBrief(prompt: string, timeoutMs: number): Promise<{
  brief: string;
  error?: string;
  provider?: string;
  model?: string;
  usage?: LlmUsage;
}> {
  try {
    const result = await infer(prompt, {
      task: "summary",
      model: BRIEF_MODEL,
      system: VIP_BRIEF_SYSTEM_PROMPT,
      component: "vip-email-received",
      action: "vip-email.brief",
      print: true,
      noTools: true,
      requireTextOutput: true,
      timeout: timeoutMs,
      env: { ...process.env, TERM: "dumb" },
    });

    const brief = extractModelText(result.text);
    return {
      brief,
      provider: result.provider,
      model: result.model ?? BRIEF_MODEL,
      usage: result.usage,
      error: brief.length === 0 ? "empty model output" : undefined,
    };
  } catch (error) {
    return {
      brief: "",
      error: error instanceof Error ? error.message : String(error),
      provider: BRIEF_MODEL,
      model: BRIEF_MODEL,
    };
  }
}

function formatRelativeTime(timestampMs?: number | null, now = Date.now()): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return "none";
  const diffMs = now - timestampMs;
  const absMs = Math.abs(diffMs);
  if (absMs < 60_000) return diffMs >= 0 ? "just now" : "in <1m";

  const units = [
    { label: "d", ms: 24 * 60 * 60_000 },
    { label: "h", ms: 60 * 60_000 },
    { label: "m", ms: 60_000 },
  ];
  for (const unit of units) {
    if (absMs >= unit.ms) {
      const value = Math.round(absMs / unit.ms);
      return diffMs >= 0 ? `${value}${unit.label} ago` : `in ${value}${unit.label}`;
    }
  }
  return "just now";
}

function shouldEscalateToOpus(input: {
  subject: string;
  preview: string;
  threadMessageCount: number;
  followedLinks: number;
  relatedMeetings: number;
  memoryHits: number;
}): { useOpus: boolean; reason: string } {
  const subjectSignals = `${input.subject} ${input.preview}`.toLowerCase();
  const hasExecutiveKeywords = [
    "proposal",
    "partnership",
    "contract",
    "launch",
    "invest",
    "pricing",
    "terms",
    "urgent",
  ].some((token) => subjectSignals.includes(token));

  if (input.threadMessageCount >= 12) {
    return { useOpus: true, reason: "thread has 12+ messages" };
  }
  if (input.followedLinks > 0) {
    return { useOpus: true, reason: "email references external links that need synthesis" };
  }
  if (input.relatedMeetings > 0 || input.memoryHits >= 3) {
    return { useOpus: true, reason: "email has meeting/history context that benefits from deeper synthesis" };
  }
  if (hasExecutiveKeywords) {
    return { useOpus: true, reason: "subject contains executive-sensitive keywords" };
  }
  return { useOpus: false, reason: "standard VIP context; sonnet analysis is sufficient" };
}

function buildAnalysisPrompt(input: {
  senderDisplay: string;
  subject: string;
  conversationId: string;
  preview: string;
  frontContext: FrontThreadContext;
  followedLinks: FollowedLink[];
  granolaMeetings: GranolaMeeting[];
  memoryContext: string[];
  githubRepos: GitHubRepo[];
  accessGaps: MissingInfo[];
}): string {
  const messageLines = input.frontContext.messages.map((message) =>
    `- [${message.createdAtIso}] ${message.senderDisplay}: ${message.text || "(no text available)"}`
  );
  const relatedMeetingLines = input.granolaMeetings.map((meeting) => {
    const when = meeting.date ? ` (${meeting.date})` : "";
    return `- ${meeting.title}${when} [${meeting.id}]`;
  });
  const followedLinkLines = input.followedLinks.flatMap((link) => [
    `- URL: ${link.url}`,
    `  Content: ${link.content}`,
  ]);

  const repoLines = input.githubRepos.map((repo) => {
    const name = repo.name ?? "unknown";
    const description = repo.description ?? "";
    const url = repo.url ?? "";
    return `- ${name}: ${description} ${url}`.trim();
  });

  return [
    `VIP sender: ${input.senderDisplay}`,
    `Subject: ${input.subject}`,
    `Conversation ID: ${input.conversationId}`,
    `Preview: ${input.preview}`,
    "",
    "Front conversation metadata:",
    JSON.stringify(input.frontContext.summary, null, 2),
    "",
    "Full Front thread messages:",
    ...(messageLines.length > 0 ? messageLines : ["- none available"]),
    "",
    "Followed email link content:",
    ...(followedLinkLines.length > 0 ? followedLinkLines : ["- none"]),
    "",
    "Related Granola meetings:",
    ...(relatedMeetingLines.length > 0 ? relatedMeetingLines : ["- none found"]),
    "",
    "Memory recall excerpts:",
    ...(input.memoryContext.length > 0 ? input.memoryContext : ["- none found"]),
    "",
    "GitHub repositories:",
    ...(repoLines.length > 0 ? repoLines : ["- none found"]),
    "",
    "Access gaps detected before analysis:",
    ...(input.accessGaps.length > 0
      ? input.accessGaps.map((gap) => `- ${gap.item}: ${gap.why_missing}. How to get: ${gap.how_to_get_it}`)
      : ["- none"]),
  ].join("\n");
}

function deriveNeedsAttention(input: {
  analysis: VipAnalysis;
  frontContext: FrontThreadContext;
  accessGaps: MissingInfo[];
}): { value: "yes" | "no"; reason: string } {
  if (input.analysis.todos.length > 0) {
    return { value: "yes", reason: input.analysis.todos[0]?.title ?? "there are concrete follow-ups" };
  }
  if (input.analysis.questions_for_human.length > 0) {
    return { value: "yes", reason: input.analysis.questions_for_human[0] ?? "there are unresolved questions" };
  }
  if (!input.frontContext.joelReplied) {
    return { value: "yes", reason: "Joel has not replied in the cached thread yet" };
  }
  if (input.accessGaps.length > 0) {
    return { value: "yes", reason: input.accessGaps[0]?.why_missing ?? "some context could not be retrieved" };
  }
  return { value: "no", reason: "the thread appears informational and already covered" };
}

function buildFallbackExecutiveSummary(input: {
  preview: string;
  analysis: VipAnalysis;
  frontContext: FrontThreadContext;
  followedLinks: FollowedLink[];
  needsAttention: { value: "yes" | "no"; reason: string };
  accessGaps: MissingInfo[];
}): string {
  const latestSnippetSource = normalizeWhitespace(
    input.frontContext.latestMessage?.text
    ?? input.preview
    ?? ""
  );
  const latestSnippet = latestSnippetSource
    ? latestSnippetSource.length > 180
      ? `${latestSnippetSource.slice(0, 177)}...`
      : latestSnippetSource
    : "Latest message content was unavailable in the cached thread.";

  const threadSentence = `${input.frontContext.messages.length} messages are in the cached thread, and Joel last replied ${formatRelativeTime(input.frontContext.lastJoelReplyAt)}.`;
  const attentionLead = input.needsAttention.value === "yes"
    ? "This needs attention now"
    : "This does not appear urgent right now";

  const supportReason = input.analysis.todos[0]?.title
    ?? input.analysis.questions_for_human[0]
    ?? input.needsAttention.reason;

  const contextTail = input.followedLinks.length > 0
    ? ` ${input.followedLinks.length} linked resource${input.followedLinks.length === 1 ? " was" : "s were"} pulled for extra context.`
    : input.accessGaps.length > 0
      ? ` Context gaps remain: ${input.accessGaps[0]?.item ?? "additional context"} could not be verified yet.`
      : "";

  return `${latestSnippet} ${threadSentence} ${attentionLead} because ${supportReason}.${contextTail}`.trim();
}

function buildFallbackOperatorBrief(input: {
  senderDisplay: string;
  subject: string;
  preview: string;
  conversationId: string;
  analysis: VipAnalysis;
  frontContext: FrontThreadContext;
  followedLinks: FollowedLink[];
  accessGaps: MissingInfo[];
}): string {
  const keyLinks = input.followedLinks.length > 0
    ? input.followedLinks
        .map((link) => `${link.url} — ${summarizeFollowedLinkContent(link)}`)
        .join("; ")
    : "none";
  const needsAttention = deriveNeedsAttention({
    analysis: input.analysis,
    frontContext: input.frontContext,
    accessGaps: input.accessGaps,
  });
  const executiveSummary = buildFallbackExecutiveSummary({
    preview: input.preview,
    analysis: input.analysis,
    frontContext: input.frontContext,
    followedLinks: input.followedLinks,
    needsAttention,
    accessGaps: input.accessGaps,
  });

  return [
    `## VIP: ${input.senderDisplay} — ${input.subject}`,
    "",
    executiveSummary,
    "",
    `**Thread**: ${input.frontContext.messages.length} messages, last activity ${formatRelativeTime(input.frontContext.latestMessage?.createdAt)}`,
    `**Your last reply**: ${formatRelativeTime(input.frontContext.lastJoelReplyAt)}`,
    `**Key links**: ${keyLinks}`,
    "",
    `**Needs your attention**: ${needsAttention.value} — ${needsAttention.reason}`,
    "",
    `[View in Front](${frontConversationUrl(input.conversationId)})`,
  ].join("\n");
}

function isWellFormedOperatorBrief(value: string): boolean {
  return value.startsWith("## VIP:")
    && value.includes("**Thread**:")
    && value.includes("**Your last reply**:")
    && value.includes("**Needs your attention**:")
    && value.includes("[View in Front]");
}

function buildEmailThreadCacheDocument(input: {
  conversationId: string;
  subject: string;
  vipSender: string;
  frontContext: FrontThreadContext;
  followedLinks: FollowedLink[];
  summary?: string;
}): Record<string, unknown> {
  const participants = uniqueStrings([
    input.vipSender,
    ...input.frontContext.messages.flatMap((message) => [message.senderEmail, message.senderName]),
  ]);
  const messages = input.frontContext.messages.map((message) => ({
    id: message.id,
    sender: message.senderDisplay,
    sender_email: message.senderEmail,
    timestamp: message.createdAt,
    text: message.text,
    is_inbound: message.isInbound,
  }));

  return {
    id: input.conversationId,
    conversation_id: input.conversationId,
    subject: input.subject,
    participants,
    vip_sender: input.vipSender,
    status: input.frontContext.summary.status || "unknown",
    last_message_at: input.frontContext.latestMessage?.createdAt ?? Date.now(),
    ...(input.frontContext.lastJoelReplyAt != null ? { last_joel_reply_at: input.frontContext.lastJoelReplyAt } : {}),
    message_count: input.frontContext.messages.length,
    messages_json: JSON.stringify(messages),
    ...(input.followedLinks.length > 0 ? { followed_links_json: JSON.stringify(input.followedLinks) } : {}),
    ...(input.frontContext.summary.tags.length > 0 ? { tags: input.frontContext.summary.tags } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    updated_at: Date.now(),
  };
}

/**
 * Granola MCP transcript/list endpoints are aggressively rate-limited (~1 hour window).
 * Keep this function account-scoped at concurrency 1 and throw on "rate limit" so Inngest retries.
 */
export const vipEmailReceived = inngest.createFunction(
  {
    id: "vip/email-received",
    name: "VIP Email Intelligence Pipeline",
    concurrency: { scope: "account", key: "granola-mcp", limit: 1 },
    retries: 1,
  },
  { event: "vip/email.received" },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const from = String(event.data.from ?? "");
    const fromName = String(event.data.fromName ?? "");
    const senderDisplay = fromName ? `${fromName} <${from}>` : from;

    if (!isVipSender(from, fromName)) {
      return {
        status: "noop",
        reason: "not-vip-sender",
        from: senderDisplay,
        telegramDelivered: false,
      };
    }

    const subject = String(event.data.subject ?? "");
    const conversationId = String(event.data.conversationId ?? "");
    const bodyPlain = String(event.data.bodyPlain ?? "");
    const body = String(event.data.body ?? "");
    const preview = String(event.data.preview ?? "");
    const senderEmail = extractEmailAddress(from);

    if (
      isLikelyNewsletter({
        senderEmail,
        subject,
        preview,
        bodyPlain: bodyPlain || body,
      })
    ) {
      const archived = await step.run("archive-newsletter-conversation", async () => {
        return await archiveFrontConversation(conversationId);
      });

      await step.run("notify-newsletter-archive", async () => {
        const archiveLine = archived.ok
          ? "Archived in Front."
          : `Archive attempt failed: ${archived.error ?? "unknown error"}`;

        await pushGatewayEvent({
          type: "vip.email.received",
          source: "inngest/vip-email-received",
          payload: {
            prompt: [
              "## VIP Newsletter Auto-Archive",
              "",
              `From: ${senderDisplay}`,
              `Subject: ${subject}`,
              archiveLine,
              "",
              "No todo extraction was attempted.",
            ].join("\n"),
            from,
            fromName,
            subject,
            conversationId,
            newsletter: true,
            archived: archived.ok,
            archiveError: archived.error,
          },
        });
      });

      return {
        status: "archived-newsletter",
        from: senderDisplay,
        subject,
        conversationId,
        archived: archived.ok,
        archiveError: archived.error,
        todosCreated: 0,
        telegramDelivered: false,
      };
    }

    const timings: Record<string, number> = {};
    const accessGaps: MissingInfo[] = [];

    const [frontResult, linkResult, granolaResult, memoryResult, githubResult] = await Promise.all([
      step.run("fetch-front-context", async () => {
        const t0 = Date.now();
        const context = await fetchFrontThread(conversationId);
        const gap = !context
          ? {
              item: "Front thread context",
              why_missing: "Front API token unavailable, timed out, or API call failed",
              how_to_get_it: "Ensure FRONT_API_TOKEN is valid and Front API is reachable",
            }
          : null;

        return { context, gap, durationMs: Date.now() - t0 };
      }),
      step.run("follow-email-links", async () => {
        const t0 = Date.now();
        const rawBody = bodyPlain || stripHtmlToText(body) || preview;
        const urls = extractInterestingUrlsFromEmail(rawBody, body);
        const links: FollowedLink[] = [];
        const errors: string[] = [];

        for (const url of urls) {
          try {
            const proc = spawnSync("defuddle", [url], {
              encoding: "utf-8",
              timeout: 10_000,
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, TERM: "dumb" },
            });
            const stdout = normalizeWhitespace((proc.stdout ?? "").trim());
            const stderr = normalizeWhitespace((proc.stderr ?? "").trim());
            if (proc.status !== 0 || !stdout) {
              errors.push(`${url}: ${(stderr || stdout || `exit ${proc.status ?? "unknown"}`).slice(0, 180)}`);
              continue;
            }
            links.push({
              url,
              content: stdout.slice(0, MAX_FOLLOWED_LINK_CONTENT_CHARS),
            });
          } catch (error) {
            errors.push(
              `${url}: ${error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)}`
            );
          }
        }

        return {
          urls,
          links,
          errors,
          durationMs: Date.now() - t0,
          gap: urls.length > 0 && links.length === 0
            ? {
                item: "Followed email links",
                why_missing: errors[0] ?? "defuddle could not extract content from email links",
                how_to_get_it: "Verify defuddle CLI availability and network access for linked pages",
              }
            : null,
        };
      }),
      step.run("search-granola-related", async () => {
        const t0 = Date.now();
        const rangeDurations: Record<string, number> = {};
        const allMeetings: GranolaMeeting[] = [];

        for (const range of GRANOLA_RANGES) {
          const rangeStart = Date.now();
          const response = parseJsonOutput<Record<string, unknown>>(
            "granola",
            ["meetings", "--range", range],
            GRANOLA_TIMEOUT_MS
          );
          rangeDurations[range] = Date.now() - rangeStart;
          if (!response.ok) {
            throwIfGranolaRateLimited(response.error ?? "", `vip/search-granola-related:${range}`);
            continue;
          }
          if (!response.data) continue;
          throwIfGranolaRateLimited(
            JSON.stringify(response.data),
            `vip/search-granola-related:${range}`
          );
          allMeetings.push(...parseGranolaMeetingsResponse(response.data));
        }

        const related = findRelatedMeetings(allMeetings, fromName || from, subject).slice(0, 8);
        const gap = allMeetings.length === 0
          ? {
              item: "Related Granola meetings",
              why_missing: "Granola CLI returned no usable meeting data",
              how_to_get_it: "Verify granola CLI auth and local MCP availability",
            }
          : null;

        return {
          meetings: related,
          gap,
          durationMs: Date.now() - t0,
          rangeDurations,
        };
      }),
      step.run("search-memory-recall", async () => {
        const t0 = Date.now();
        const query = `${fromName || from} ${subject}`.trim();
        const proc = spawnSync("joelclaw", ["recall", query, "--limit", "8", "--json"], {
          encoding: "utf-8",
          timeout: MEMORY_RECALL_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TERM: "dumb" },
        });

        const durationMs = Date.now() - t0;

        if (proc.status !== 0) {
          return {
            lines: [] as string[],
            recalledMemories: [] as Array<{ id: string; observation: string }>,
            durationMs,
            gap: {
              item: "Memory recall",
              why_missing: (proc.stderr ?? proc.stdout ?? "recall command failed").slice(0, 180),
              how_to_get_it: "Ensure Typesense is reachable and `joelclaw recall` works in this environment",
            },
          };
        }

        const parsed = (() => {
          try {
            return JSON.parse(proc.stdout ?? "{}") as RecallCliEnvelope;
          } catch {
            return null;
          }
        })();

        if (!parsed || parsed.ok !== true) {
          const envelopeError = parsed?.error?.message;
          const detail =
            typeof envelopeError === "string" && envelopeError.trim().length > 0
              ? envelopeError.trim()
              : "recall returned invalid JSON envelope";
          return {
            lines: [] as string[],
            recalledMemories: [] as Array<{ id: string; observation: string }>,
            durationMs,
            gap: {
              item: "Memory recall",
              why_missing: detail.slice(0, 180),
              how_to_get_it: "Ensure `joelclaw recall --json` returns ok=true with hit IDs",
            },
          };
        }

        const hits = Array.isArray(parsed.result?.hits) ? parsed.result.hits : [];
        const recalledMemories = hits
          .map((hit) => ({
            id: typeof hit.id === "string" ? hit.id.trim() : "",
            observation: typeof hit.observation === "string" ? hit.observation.trim() : "",
          }))
          .filter((hit) => hit.id.length > 0 && hit.observation.length > 0)
          .slice(0, 8);

        return {
          lines: recalledMemories.map((hit) => hit.observation),
          recalledMemories,
          durationMs,
          gap: recalledMemories.length > 0
            ? null
            : {
                item: "Memory recall",
                why_missing: "Recall returned zero usable memory hits",
                how_to_get_it: "Check memory corpus population and recall query quality",
              },
        };
      }),
      step.run("search-github-projects", async () => {
        const t0 = Date.now();
        if (!ENABLE_GITHUB_SEARCH) {
          return {
            repos: [] as GitHubRepo[],
            durationMs: Date.now() - t0,
            skipped: true,
            gap: null,
          };
        }

        const query = `${fromName || from} ${subject}`.trim();
        const response = parseJsonOutput<GitHubRepo[]>(
          "gh",
          ["search", "repos", query, "--limit", "5", "--json", "name,description,url,updatedAt,stargazersCount"],
          GITHUB_TIMEOUT_MS
        );

        return {
          repos: response.ok && response.data ? response.data : [],
          durationMs: Date.now() - t0,
          skipped: false,
          gap: response.ok || !response.error
            ? null
            : {
                item: "GitHub project search",
                why_missing: response.error,
                how_to_get_it: "Authenticate gh CLI and verify network/API access",
              },
        };
      }),
    ]);

    timings["fetch-front-context"] = frontResult.durationMs;
    timings["follow-email-links"] = linkResult.durationMs;
    timings["search-granola-related"] = granolaResult.durationMs;
    timings["search-memory-recall"] = memoryResult.durationMs;
    timings["search-github-projects"] = githubResult.durationMs;

    if (frontResult.gap?.item) accessGaps.push(frontResult.gap as MissingInfo);
    if (linkResult.gap?.item) accessGaps.push(linkResult.gap as MissingInfo);
    if (granolaResult.gap?.item) accessGaps.push(granolaResult.gap as MissingInfo);
    if (memoryResult.gap?.item) accessGaps.push(memoryResult.gap as MissingInfo);
    if (githubResult.gap?.item) accessGaps.push(githubResult.gap as MissingInfo);

    const frontContext = (frontResult.context ?? buildFallbackFrontThreadContext({
      conversationId,
      messageId: String(event.data.messageId ?? ""),
      senderName: fromName,
      senderEmail,
      senderDisplay,
      subject,
      bodyPlain,
      body,
      preview,
    })) as FrontThreadContext;
    const followedLinks = (linkResult.links ?? []) as FollowedLink[];
    const granolaMeetings = (granolaResult.meetings ?? []) as GranolaMeeting[];
    const memoryContext = (memoryResult.lines ?? []) as string[];
    const recalledMemories = (memoryResult.recalledMemories ?? []) as Array<{ id: string; observation: string }>;
    const githubRepos = (githubResult.repos ?? []) as GitHubRepo[];

    const analysisPrompt = buildAnalysisPrompt({
      senderDisplay,
      subject,
      conversationId,
      preview,
      frontContext,
      followedLinks,
      granolaMeetings,
      memoryContext,
      githubRepos,
      accessGaps,
    });

    const briefResult = await step.run("generate-operator-brief", async () => {
      const t0 = Date.now();
      const result = await runOperatorBrief(analysisPrompt, BRIEF_TIMEOUT_MS);
      return {
        ...result,
        durationMs: Date.now() - t0,
      };
    });

    timings["generate-operator-brief"] = briefResult.durationMs;
    if (briefResult.error) {
      accessGaps.push({
        item: "Operator brief",
        why_missing: briefResult.error,
        how_to_get_it: "Check pi model access and VIP brief prompt output",
      });
    }

    const opusDecision = shouldEscalateToOpus({
      subject,
      preview,
      threadMessageCount: frontContext.messages.length,
      followedLinks: followedLinks.length,
      relatedMeetings: granolaMeetings.length,
      memoryHits: memoryContext.length,
    });
    const elapsedBeforeAnalysis = Date.now() - startedAt;
    const remainingBudgetMs = TOTAL_BUDGET_MS - elapsedBeforeAnalysis;
    const shouldRunOpus = ENABLE_OPUS_ESCALATION
      && opusDecision.useOpus
      && remainingBudgetMs >= MIN_OPUS_TIME_REMAINING_MS;

    if (ENABLE_OPUS_ESCALATION && opusDecision.useOpus && !shouldRunOpus) {
      accessGaps.push({
        item: "Deep Opus analysis",
        why_missing: `Skipped to keep within ${TOTAL_BUDGET_MS}ms budget`,
        how_to_get_it: "Increase JOELCLAW_VIP_TOTAL_BUDGET_MS or reduce upstream context latency",
      });
    }

    const finalAnalysis = await step.run("analyze-vip-context", async () => {
      const t0 = Date.now();
      const model = shouldRunOpus ? VIP_MODEL : BRIEF_MODEL;
      const timeoutMs = shouldRunOpus
        ? Math.min(OPUS_TIMEOUT_MS, Math.max(2_000, remainingBudgetMs - 1_000))
        : BRIEF_TIMEOUT_MS;
      const result = await runModelAnalysis(
        model,
        VIP_ANALYSIS_SYSTEM_PROMPT,
        analysisPrompt,
        timeoutMs
      );

      return {
        ...result,
        durationMs: Date.now() - t0,
      };
    });

    timings["analyze-vip-context"] = finalAnalysis.durationMs;
    if (finalAnalysis.error) {
      accessGaps.push({
        item: "Deep model analysis",
        why_missing: finalAnalysis.error,
        how_to_get_it: "Check pi model access and CLI auth",
      });
    }

    const analysis = finalAnalysis.analysis;

    const cacheResult = await step.run("cache-email-thread", async () => {
      const t0 = Date.now();
      try {
        await typesense.ensureEmailThreadsCollection();
        const document = buildEmailThreadCacheDocument({
          conversationId,
          subject,
          vipSender: senderEmail || from,
          frontContext,
          followedLinks,
          summary: analysis.executive_summary,
        });
        await typesense.upsert(typesense.EMAIL_THREADS_COLLECTION, document);
        return { cached: true, durationMs: Date.now() - t0 };
      } catch (error) {
        return {
          cached: false,
          durationMs: Date.now() - t0,
          error: error instanceof Error ? error.message.slice(0, 220) : String(error).slice(0, 220),
        };
      }
    });

    timings["cache-email-thread"] = cacheResult.durationMs;
    if (cacheResult.error) {
      accessGaps.push({
        item: "Email thread cache",
        why_missing: cacheResult.error,
        how_to_get_it: "Check Typesense availability and email_threads collection schema",
      });
    }

    const createdTodos = await step.run("create-comprehensive-todos", async () => {
      const t0 = Date.now();
      const taskAdapter = new TodoistTaskAdapter();
      const created: Array<{ id: string; content: string }> = [];
      const todos = analysis.todos.slice(0, 10);

      for (const todo of todos) {
        try {
          const description = [
            `VIP email source: ${senderDisplay}`,
            `Subject: ${subject}`,
            `Conversation: ${conversationId}`,
            "",
            todo.description,
          ].filter(Boolean).join("\n");

          const task = await taskAdapter.createTask({
            content: `[VIP] ${todo.title}`,
            description,
            priority: normalizePriority(todo.priority),
            dueString: todo.due,
          });

          created.push({ id: task.id, content: task.content });
        } catch (error) {
          accessGaps.push({
            item: `Todo creation failed for: ${todo.title}`,
            why_missing: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
            how_to_get_it: "Check TODOIST_API_TOKEN and todoist-cli availability",
          });
        }
      }

      return { created, durationMs: Date.now() - t0 };
    });

    timings["create-comprehensive-todos"] = createdTodos.durationMs;

    const allMissingInfo = [
      ...analysis.missing_information,
      ...accessGaps,
    ];

    const operatorBrief = isWellFormedOperatorBrief(briefResult.brief)
      ? briefResult.brief
      : buildFallbackOperatorBrief({
          senderDisplay,
          subject,
          preview,
          conversationId,
          analysis,
          frontContext,
          followedLinks,
          accessGaps: allMissingInfo,
        });
    const telegramBriefHtml = toTelegramHtml(
      stripOperatorRelayRules(operatorBrief),
    );

    const notifyResult = await step.run("notify-vip-summary", async () => {
      const t0 = Date.now();
      const gatewayResultPromise = pushGatewayEvent({
        type: "vip.email.received",
        source: "inngest/vip-email-received",
        payload: {
          prompt: operatorBrief,
          from,
          fromName,
          subject,
          conversationId,
          todosCreated: createdTodos.created.length,
          missingInfoCount: allMissingInfo.length,
          relatedMeetingCount: granolaMeetings.length,
          memoryContextCount: memoryContext.length,
          githubRepoCount: githubRepos.length,
          followedLinkCount: followedLinks.length,
          threadMessageCount: frontContext.messages.length,
          lastJoelReplyAt: frontContext.lastJoelReplyAt ?? null,
          cacheStored: cacheResult.cached,
          cacheError: cacheResult.error,
          analysisModel: finalAnalysis.model ?? (shouldRunOpus ? VIP_MODEL : BRIEF_MODEL),
          briefModel: briefResult.model ?? BRIEF_MODEL,
          ranOpus: shouldRunOpus,
        },
      })
        .then(() => ({ ok: true as const }))
        .catch((error) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }));
      const telegramResult = await sendTelegramDirect(telegramBriefHtml, {
        disablePreview: false,
      });
      const gatewayResult = await gatewayResultPromise;

      if (!telegramResult.ok) {
        console.error("[vip-email-received] failed to send direct telegram brief", {
          from: senderDisplay,
          subject,
          conversationId,
          error: telegramResult.error,
        });
      }

      if (!gatewayResult.ok) {
        console.error("[vip-email-received] failed to enqueue gateway brief", {
          from: senderDisplay,
          subject,
          conversationId,
          error: gatewayResult.error,
        });
      }

      if (!telegramResult.ok && !gatewayResult.ok) {
        throw new Error(
          `VIP brief delivery failed: telegram=${telegramResult.error ?? "unknown"} gateway=${gatewayResult.error ?? "unknown"}`,
        );
      }

      return {
        durationMs: Date.now() - t0,
        telegramDelivered: telegramResult.ok,
        telegramError: telegramResult.error,
      };
    });

    timings["notify-vip-summary"] = notifyResult.durationMs;

    const echoFizzleResponseText = [
      `Summary: ${analysis.executive_summary}`,
      ...analysis.interaction_signals.slice(0, 6).map((signal) => `Signal: ${signal}`),
      ...createdTodos.created.slice(0, 6).map((todo) => `Todo: ${todo.content}`),
      ...analysis.questions_for_human.slice(0, 3).map((question) => `Question: ${question}`),
    ].join("\n").trim();

    const echoFizzleDispatch =
      recalledMemories.length > 0 && echoFizzleResponseText.length > 0
        ? await step.sendEvent("emit-memory-echo-fizzle", {
            name: "memory/echo-fizzle.requested",
            data: {
              recalledMemories: recalledMemories.slice(0, 8).map((memory) => ({
                id: memory.id,
                observation: memory.observation,
              })),
              agentResponse: echoFizzleResponseText,
            },
          })
            .then(() => ({
              emitted: true,
              recalledMemories: recalledMemories.length,
            }))
            .catch((error) => ({
              emitted: false,
              recalledMemories: recalledMemories.length,
              error: error instanceof Error ? error.message.slice(0, 220) : String(error).slice(0, 220),
            }))
        : {
            emitted: false,
            recalledMemories: recalledMemories.length,
            reason: "missing-memory-context-or-response",
          };

    const totalDurationMs = Date.now() - startedAt;

    return {
      status: "processed",
      model: finalAnalysis.model ?? (shouldRunOpus ? VIP_MODEL : BRIEF_MODEL),
      briefModel: briefResult.model ?? BRIEF_MODEL,
      from: senderDisplay,
      subject,
      threadMessages: frontContext.messages.length,
      followedLinks: followedLinks.length,
      relatedMeetings: granolaMeetings.length,
      memoryMatches: memoryContext.length,
      githubRepos: githubRepos.length,
      todosCreated: createdTodos.created.length,
      missingInfoCount: allMissingInfo.length,
      ranOpus: shouldRunOpus,
      opusReason: opusDecision.reason,
      cacheStored: cacheResult.cached,
      cacheError: cacheResult.error,
      telegramDelivered: notifyResult.telegramDelivered,
      telegramError: notifyResult.telegramError,
      timings,
      granolaRangeDurations: granolaResult.rangeDurations,
      echoFizzleDispatch,
      totalDurationMs,
      budgetMs: TOTAL_BUDGET_MS,
      budgetExceeded: totalDurationMs > TOTAL_BUDGET_MS,
    };
  }
);
