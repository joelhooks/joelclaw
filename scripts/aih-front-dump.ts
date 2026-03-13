#!/usr/bin/env bun

import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FRONT_API = "https://api2.frontapp.com";
const FRONT_QUERY = "aih";
const REQUEST_DELAY_MS = 1_000;
const OUTPUT_ROOT = path.join(os.homedir(), "Vault", "Areas", "ai-hero", "runbook", "front");
const THREADS_DIR = path.join(OUTPUT_ROOT, "threads");
const FRONT_APP_CONVERSATION_URL = "https://app.frontapp.com/open";

const FRONT_TOKEN = process.env.FRONT_API_TOKEN?.trim();

if (!FRONT_TOKEN) {
  throw new Error("FRONT_API_TOKEN is required");
}

type FrontPage<T> = {
  _results?: T[];
  _pagination?: {
    next?: string | null;
  } | null;
};

type FrontConversation = {
  id?: string;
  subject?: string | null;
};

type FrontMessage = Record<string, unknown>;

type NormalizedMessage = {
  id: string;
  createdAt: number;
  date: string;
  fromName: string;
  fromEmail: string;
  fromDisplay: string;
  body: string;
  rawSources: string[];
  googleDocUrls: string[];
};

type ConversationThread = {
  id: string;
  rawSubject: string;
  cleanSubject: string;
  messages: NormalizedMessage[];
  lastMessageAt: number;
  googleDocUrls: string[];
  isGitHubPr: boolean;
};

type ThreadGroup = {
  subject: string;
  conversations: ConversationThread[];
  totalMessages: number;
  lastMessageAt: number;
};

const htmlEntityMap: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

let lastRequestCompletedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeInlineWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeMultilineText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, entity) => {
    const normalized = String(entity).toLowerCase();

    if (normalized in htmlEntityMap) {
      return htmlEntityMap[normalized];
    }

    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return match;
  });
}

function htmlToText(value: string): string {
  const text = decodeHtmlEntities(
    value
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<li\b[^>]*>/giu, "- ")
      .replace(/<\/(p|div|section|article|header|footer|tr|table|ul|ol|li|blockquote|h[1-6])>/giu, "\n")
      .replace(/<[^>]+>/giu, " "),
  );

  return normalizeMultilineText(text);
}

function toTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1_000;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Date.now();
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function cleanSubject(subject: string): string {
  let cleaned = normalizeInlineWhitespace(subject || "(no subject)");

  while (true) {
    const next = cleaned
      .replace(/^\s*re:\s*/iu, "")
      .replace(/^\s*\[aih\]\s*/iu, "")
      .trim();

    if (next === cleaned) break;
    cleaned = next;
  }

  return cleaned || "untitled-thread";
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return slug || "untitled-thread";
}

function sanitizeDocsUrlCandidate(value: string): string | null {
  const cleaned = decodeHtmlEntities(value).replace(/[)>.,;!?]+$/gu, "").trim();

  try {
    const url = new URL(cleaned);
    if (url.hostname.toLowerCase() !== "docs.google.com") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function extractGoogleDocUrls(sources: string[]): string[] {
  const found = new Set<string>();
  const regex = /https?:\/\/docs\.google\.com\/[^\s<>")\]]+/giu;

  for (const source of sources) {
    for (const match of source.matchAll(regex)) {
      const normalized = sanitizeDocsUrlCandidate(match[0]);
      if (normalized) {
        found.add(normalized);
      }
    }
  }

  return [...found].sort((left, right) => left.localeCompare(right));
}

function formatSender(message: FrontMessage): { name: string; email: string; display: string } {
  const author = isRecord(message.author) ? message.author : {};
  const recipients = Array.isArray(message.recipients)
    ? message.recipients.filter(isRecord)
    : [];
  const fromRecipient = recipients.find((recipient) => stringValue(recipient.role).toLowerCase() === "from");

  const firstName = stringValue(author.first_name);
  const lastName = stringValue(author.last_name);
  const combinedName = normalizeInlineWhitespace([firstName, lastName].filter(Boolean).join(" "));
  const email = normalizeInlineWhitespace(
    stringValue(author.email)
      || stringValue(author.handle)
      || stringValue(fromRecipient?.handle)
      || stringValue(fromRecipient?.email)
      || stringValue(author.username),
  );
  const name = normalizeInlineWhitespace(
    combinedName
      || stringValue(author.name)
      || stringValue(fromRecipient?.name)
      || email,
  ) || "unknown";

  const display = email && name.toLowerCase() !== email.toLowerCase()
    ? `${name} <${email}>`
    : name || email || "unknown";

  return {
    name,
    email: email || "unknown",
    display,
  };
}

function collectRawMessageSources(message: FrontMessage): string[] {
  const candidates = [
    stringValue(message.text),
    stringValue(message.body_text),
    stringValue(message.body),
    stringValue(message.body_html),
    stringValue(message.blurb),
  ].map((value) => value.trim()).filter(Boolean);

  return candidates;
}

function extractMessageBody(message: FrontMessage): string {
  const plain = normalizeMultilineText(
    stringValue(message.text)
      || stringValue(message.body_text),
  );
  if (plain) return plain;

  const html = stringValue(message.body) || stringValue(message.body_html);
  if (html) {
    const stripped = htmlToText(html);
    if (stripped) return stripped;
  }

  return normalizeMultilineText(stringValue(message.blurb)) || "(no body text)";
}

function normalizeMessage(message: FrontMessage): NormalizedMessage {
  const createdAt = toTimestampMs(message.created_at ?? message.createdAt ?? message.received_at);
  const sender = formatSender(message);
  const rawSources = collectRawMessageSources(message);

  return {
    id: stringValue(message.id) || `message-${createdAt}`,
    createdAt,
    date: formatTimestamp(createdAt),
    fromName: sender.name,
    fromEmail: sender.email,
    fromDisplay: sender.display,
    body: extractMessageBody(message),
    rawSources,
    googleDocUrls: extractGoogleDocUrls(rawSources),
  };
}

function extractNextUrl(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function fetchFrontJson<T>(pathOrUrl: string): Promise<T> {
  if (lastRequestCompletedAt > 0) {
    const waitMs = REQUEST_DELAY_MS - (Date.now() - lastRequestCompletedAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `${FRONT_API}${pathOrUrl}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${FRONT_TOKEN}`,
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Front API ${response.status} ${response.statusText} for ${url}: ${text.slice(0, 500)}`);
    }

    return text ? JSON.parse(text) as T : {} as T;
  } finally {
    lastRequestCompletedAt = Date.now();
  }
}

async function fetchAllConversations(): Promise<FrontConversation[]> {
  const conversations: FrontConversation[] = [];
  const seenIds = new Set<string>();
  let nextUrl: string | null = `${FRONT_API}/conversations/search/${encodeURIComponent(FRONT_QUERY)}?limit=100`;

  while (nextUrl) {
    const page = await fetchFrontJson<FrontPage<FrontConversation>>(nextUrl);
    for (const conversation of page._results ?? []) {
      const id = stringValue(conversation.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      conversations.push(conversation);
    }
    nextUrl = extractNextUrl(page._pagination?.next);
  }

  return conversations;
}

async function fetchConversationMessages(conversationId: string): Promise<NormalizedMessage[]> {
  const messages: NormalizedMessage[] = [];
  const seenIds = new Set<string>();
  let nextUrl: string | null = `${FRONT_API}/conversations/${encodeURIComponent(conversationId)}/messages?limit=100`;

  while (nextUrl) {
    const page = await fetchFrontJson<FrontPage<FrontMessage>>(nextUrl);
    for (const rawMessage of page._results ?? []) {
      const message = normalizeMessage(rawMessage);
      if (seenIds.has(message.id)) continue;
      seenIds.add(message.id);
      messages.push(message);
    }
    nextUrl = extractNextUrl(page._pagination?.next);
  }

  messages.sort((left, right) => left.createdAt - right.createdAt);
  return messages;
}

function looksLikeGitHubPr(conversation: ConversationThread): boolean {
  const subject = conversation.rawSubject.toLowerCase();
  const bodyBlob = conversation.messages.map((message) => message.body).join("\n\n").toLowerCase();
  const hasGithubSender = conversation.messages.some((message) => (
    message.fromEmail.toLowerCase().includes("github.com")
      || message.fromName.toLowerCase().includes("github")
  ));
  const hasPullRequestLanguage = subject.includes("pull request") || /\bpr\s*#\d+/iu.test(subject);
  const hasPullRequestUrl = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/iu.test(bodyBlob);
  const repoTagSubject = /^\[[^\]]+\/[^\]]+\]/u.test(conversation.rawSubject);

  return hasPullRequestLanguage || hasPullRequestUrl || (hasGithubSender && repoTagSubject);
}

function buildConversationThread(conversation: FrontConversation, messages: NormalizedMessage[]): ConversationThread {
  const rawSubject = normalizeInlineWhitespace(stringValue(conversation.subject) || "(no subject)");
  const clean = cleanSubject(rawSubject);
  const googleDocUrls = new Set<string>();

  for (const message of messages) {
    for (const url of message.googleDocUrls) {
      googleDocUrls.add(url);
    }
  }

  const lastMessageAt = messages.length > 0
    ? Math.max(...messages.map((message) => message.createdAt))
    : Date.now();

  const thread: ConversationThread = {
    id: stringValue(conversation.id),
    rawSubject,
    cleanSubject: clean,
    messages,
    lastMessageAt,
    googleDocUrls: [...googleDocUrls].sort((left, right) => left.localeCompare(right)),
    isGitHubPr: false,
  };

  thread.isGitHubPr = looksLikeGitHubPr(thread);
  return thread;
}

function groupThreads(threads: ConversationThread[]): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();

  for (const thread of threads) {
    const existing = groups.get(thread.cleanSubject);
    if (existing) {
      existing.conversations.push(thread);
      existing.totalMessages += thread.messages.length;
      existing.lastMessageAt = Math.max(existing.lastMessageAt, thread.lastMessageAt);
      continue;
    }

    groups.set(thread.cleanSubject, {
      subject: thread.cleanSubject,
      conversations: [thread],
      totalMessages: thread.messages.length,
      lastMessageAt: thread.lastMessageAt,
    });
  }

  return [...groups.values()].sort((left, right) => right.lastMessageAt - left.lastMessageAt);
}

function assignThreadFiles(groups: ThreadGroup[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const slugCounts = new Map<string, number>();

  for (const group of [...groups].sort((left, right) => left.subject.localeCompare(right.subject))) {
    const base = slugify(group.subject);
    const currentCount = slugCounts.get(base) ?? 0;
    slugCounts.set(base, currentCount + 1);
    const filename = currentCount === 0 ? `${base}.md` : `${base}-${currentCount + 1}.md`;
    assigned.set(group.subject, filename);
  }

  return assigned;
}

function renderBodyFence(body: string): string {
  return body.replace(/~~~/gu, "~\u200b~~");
}

function renderConversationSection(conversation: ConversationThread): string {
  const lines = [
    `## Conversation ${conversation.id}`,
    "",
    `- Original subject: ${conversation.rawSubject}`,
    `- Front link: ${FRONT_APP_CONVERSATION_URL}/${conversation.id}`,
    `- Messages: ${conversation.messages.length}`,
    `- Last activity: ${formatTimestamp(conversation.lastMessageAt)}`,
    "",
  ];

  for (const message of conversation.messages) {
    lines.push(`### ${message.date}`);
    lines.push("");
    lines.push(`**From:** ${message.fromDisplay}`);
    lines.push("");
    lines.push("~~~text");
    lines.push(renderBodyFence(message.body || "(no body text)"));
    lines.push("~~~");
    lines.push("");
  }

  return lines.join("\n");
}

function renderThreadFile(group: ThreadGroup): string {
  const conversationIds = group.conversations.map((conversation) => conversation.id).join(", ");
  const sections = group.conversations
    .slice()
    .sort((left, right) => {
      const leftStart = left.messages[0]?.createdAt ?? left.lastMessageAt;
      const rightStart = right.messages[0]?.createdAt ?? right.lastMessageAt;
      return leftStart - rightStart;
    })
    .map(renderConversationSection);

  return [
    `# ${group.subject}`,
    "",
    `- Conversations: ${group.conversations.length}`,
    `- Total messages: ${group.totalMessages}`,
    `- Conversation IDs: ${conversationIds}`,
    `- Last activity: ${formatTimestamp(group.lastMessageAt)}`,
    "",
    sections.join("\n---\n\n"),
    "",
  ].join("\n");
}

function escapeLinkLabel(value: string): string {
  return value.replace(/([\\\[\]])/gu, "\\$1");
}

function renderIndex(
  regularGroups: ThreadGroup[],
  githubGroups: ThreadGroup[],
  fileNames: Map<string, string>,
  googleDocUrlCount: number,
  totalConversationCount: number,
  totalMessageCount: number,
): string {
  const lines = [
    "# AIH Front conversation dump",
    "",
    `- Query: \`${FRONT_QUERY}\``,
    `- Total conversations: ${totalConversationCount}`,
    `- Total messages: ${totalMessageCount}`,
    `- Subject files: ${regularGroups.length}`,
    `- GitHub PR conversations: ${githubGroups.reduce((sum, group) => sum + group.conversations.length, 0)}`,
    `- Unique Google Docs URLs: ${googleDocUrlCount}`,
    `- Generated at: ${new Date().toISOString()}`,
    "",
    "## Thread files",
    "",
  ];

  if (regularGroups.length === 0) {
    lines.push("- No non-GitHub threads found.");
  } else {
    for (const group of regularGroups) {
      const fileName = fileNames.get(group.subject);
      if (!fileName) continue;
      lines.push(
        `- [${escapeLinkLabel(group.subject)}](./threads/${fileName}) — ${group.conversations.length} conversation(s), ${group.totalMessages} message(s), latest ${formatTimestamp(group.lastMessageAt)}`,
      );
    }
  }

  lines.push("");
  lines.push("## Other outputs");
  lines.push("");
  lines.push(`- [GitHub PR notifications](./github-prs.md) — ${githubGroups.length} subject group(s)`);
  lines.push(`- [Google Docs URLs](./google-doc-urls.md) — ${googleDocUrlCount} unique URL(s)`);
  lines.push("");

  return lines.join("\n");
}

function renderGitHubPrFile(groups: ThreadGroup[]): string {
  const totalConversations = groups.reduce((sum, group) => sum + group.conversations.length, 0);
  const totalMessages = groups.reduce((sum, group) => sum + group.totalMessages, 0);
  const sections = groups.map((group) => [
    `## ${group.subject}`,
    "",
    `- Conversations: ${group.conversations.length}`,
    `- Total messages: ${group.totalMessages}`,
    `- Last activity: ${formatTimestamp(group.lastMessageAt)}`,
    "",
    group.conversations
      .slice()
      .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
      .map(renderConversationSection)
      .join("\n---\n\n"),
  ].join("\n"));

  return [
    "# GitHub PR notifications",
    "",
    `- Conversations: ${totalConversations}`,
    `- Messages: ${totalMessages}`,
    `- Subject groups: ${groups.length}`,
    "",
    sections.length > 0 ? sections.join("\n\n---\n\n") : "No GitHub PR notifications found.",
    "",
  ].join("\n");
}

function renderGoogleDocUrlsFile(threads: ConversationThread[]): string {
  const urlsBySubject = new Map<string, Set<string>>();
  const allUrls = new Set<string>();

  for (const thread of threads) {
    if (!urlsBySubject.has(thread.cleanSubject)) {
      urlsBySubject.set(thread.cleanSubject, new Set<string>());
    }
    const bucket = urlsBySubject.get(thread.cleanSubject)!;
    for (const url of thread.googleDocUrls) {
      bucket.add(url);
      allUrls.add(url);
    }
  }

  const subjects = [...urlsBySubject.entries()]
    .filter(([, urls]) => urls.size > 0)
    .sort((left, right) => left[0].localeCompare(right[0]));

  const lines = [
    "# Google Docs URLs",
    "",
    `- Unique URLs: ${allUrls.size}`,
    `- Generated at: ${new Date().toISOString()}`,
    "",
  ];

  if (subjects.length === 0) {
    lines.push("No docs.google.com URLs found.");
    lines.push("");
    return lines.join("\n");
  }

  for (const [subject, urls] of subjects) {
    lines.push(`## ${subject}`);
    lines.push("");
    for (const url of [...urls].sort((left, right) => left.localeCompare(right))) {
      lines.push(`- ${url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function writeOutputs(threads: ConversationThread[]): Promise<void> {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await rm(THREADS_DIR, { recursive: true, force: true });
  await mkdir(THREADS_DIR, { recursive: true });

  const regularGroups = groupThreads(threads.filter((thread) => !thread.isGitHubPr));
  const githubGroups = groupThreads(threads.filter((thread) => thread.isGitHubPr));
  const fileNames = assignThreadFiles(regularGroups);

  for (const group of regularGroups) {
    const fileName = fileNames.get(group.subject);
    if (!fileName) continue;
    await writeFile(path.join(THREADS_DIR, fileName), renderThreadFile(group), "utf8");
  }

  const totalMessageCount = threads.reduce((sum, thread) => sum + thread.messages.length, 0);
  const googleDocUrlCount = new Set(threads.flatMap((thread) => thread.googleDocUrls)).size;

  await writeFile(
    path.join(OUTPUT_ROOT, "index.md"),
    renderIndex(regularGroups, githubGroups, fileNames, googleDocUrlCount, threads.length, totalMessageCount),
    "utf8",
  );
  await writeFile(path.join(OUTPUT_ROOT, "github-prs.md"), renderGitHubPrFile(githubGroups), "utf8");
  await writeFile(path.join(OUTPUT_ROOT, "google-doc-urls.md"), renderGoogleDocUrlsFile(threads), "utf8");
}

async function main(): Promise<void> {
  console.log(`Searching Front conversations for ${JSON.stringify(FRONT_QUERY)}...`);
  const conversations = await fetchAllConversations();
  console.log(`Found ${conversations.length} conversation(s).`);

  const threads: ConversationThread[] = [];

  for (const [index, conversation] of conversations.entries()) {
    const id = stringValue(conversation.id);
    if (!id) continue;

    console.log(`[${index + 1}/${conversations.length}] Fetching messages for ${id}...`);
    const messages = await fetchConversationMessages(id);
    threads.push(buildConversationThread(conversation, messages));
  }

  await writeOutputs(threads);
  console.log(`Wrote ${threads.length} conversation thread(s) into ${OUTPUT_ROOT}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
