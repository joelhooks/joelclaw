#!/usr/bin/env bun
/// <reference lib="es2021" />
/// <reference lib="dom" />

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

declare function require(name: string): any;

const { mkdir, readdir, rm, writeFile } = require("node:fs/promises") as {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readdir: (
    path: string,
    options: { withFileTypes: true },
  ) => Promise<Array<{ name: string; isFile(): boolean }>>;
  rm: (path: string) => Promise<void>;
  writeFile: (path: string, data: string, encoding: string) => Promise<void>;
};

const { homedir } = require("node:os") as {
  homedir: () => string;
};

const { join } = require("node:path") as {
  join: (...parts: string[]) => string;
};

const CHANNEL_ID = "C0211NSK3TP";
const CHANNEL_NAME = "cc-matt-p";
const OUTPUT_DIR = join(
  homedir(),
  "Vault",
  "Areas",
  "ai-hero",
  "runbook",
  "slack",
);
const HISTORY_PAGE_LIMIT = 200;
const REPLIES_PAGE_LIMIT = 200;
const DISPLAY_TIME_ZONE =
  process.env.TZ?.trim()
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || "UTC";

const ENDPOINT_MIN_INTERVAL_MS: Record<string, number> = {
  "conversations.history": 1_300,
  "conversations.replies": 800,
  "users.info": 400,
};

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
};

type SlackBotProfile = {
  name?: string;
};

type SlackMessage = {
  type?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  bot_profile?: SlackBotProfile;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: SlackFile[];
  attachments?: unknown[];
};

type SlackHistoryResponse = SlackApiResponse & {
  messages?: SlackMessage[];
};

type SlackRepliesResponse = SlackApiResponse & {
  messages?: SlackMessage[];
};

type SlackUserProfile = {
  display_name?: string;
  real_name?: string;
};

type SlackUser = {
  name?: string;
  real_name?: string;
  profile?: SlackUserProfile;
};

type SlackUserInfoResponse = SlackApiResponse & {
  user?: SlackUser;
};

type ExportMessage = {
  ts: string;
  epochMs: number;
  monthKey: string;
  author: string;
  text: string;
  replies: ExportMessage[];
};

type MonthSummary = {
  monthKey: string;
  filename: string;
  topLevelCount: number;
  totalCount: number;
  firstTs: number | null;
  lastTs: number | null;
};

const monthFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});

const timestampFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNonEmpty(value: string | undefined, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function parseSlackTimestamp(ts: string | undefined): number | null {
  if (!ts) return null;
  const parsed = Number.parseFloat(ts);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed * 1000);
}

function getMonthKey(epochMs: number): string {
  const parts = monthFormatter.formatToParts(new Date(epochMs));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  return `${year}-${month}`;
}

function formatTimestamp(epochMs: number): string {
  const parts = timestampFormatter.formatToParts(new Date(epochMs));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const second = parts.find((part) => part.type === "second")?.value ?? "00";
  const zone =
    parts.find((part) => part.type === "timeZoneName")?.value ?? DISPLAY_TIME_ZONE;

  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${zone}`;
}

function decodeSlackEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function extractMentionedUserIds(text: string): string[] {
  const ids = new Set<string>();
  const pattern = /<@([A-Z0-9]+)>/g;
  while (true) {
    const match = pattern.exec(text);
    if (!match) break;
    if (match[1]) ids.add(match[1]);
  }
  return Array.from(ids);
}

function shouldSkipMessage(message: SlackMessage): boolean {
  const subtype = message.subtype?.trim();
  const hasFiles = Array.isArray(message.files) && message.files.length > 0;
  const hasAttachments =
    Array.isArray(message.attachments) && message.attachments.length > 0;
  if (!subtype) return false;
  if (subtype === "channel_join") return true;
  if (subtype === "channel_leave") return true;
  if (subtype === "tombstone") return true;
  if (
    subtype === "bot_message"
    && !(message.text ?? "").trim()
    && !hasFiles
    && !hasAttachments
  ) {
    return true;
  }
  return false;
}

function isThreadReply(message: SlackMessage): boolean {
  const threadTs = message.thread_ts?.trim();
  const messageTs = message.ts?.trim();
  return Boolean(threadTs && messageTs && threadTs !== messageTs);
}

function summarizeFiles(files: SlackFile[] | undefined): string[] {
  if (!Array.isArray(files) || files.length === 0) return [];
  const labels = new Set<string>();
  for (const file of files) {
    const label = file.title?.trim() || file.name?.trim();
    if (label) labels.add(label);
  }
  return Array.from(labels);
}

function flattenExportMessages(messages: ExportMessage[]): ExportMessage[] {
  const flattened: ExportMessage[] = [];

  for (const message of messages) {
    flattened.push(message);
    if (message.replies.length > 0) {
      flattened.push(...flattenExportMessages(message.replies));
    }
  }

  return flattened;
}

function collectReferencedUserIds(messages: SlackMessage[]): string[] {
  const userIds = new Set<string>();

  for (const message of messages) {
    const authorId = message.user?.trim();
    if (authorId) userIds.add(authorId);

    const text = decodeSlackEntities(message.text ?? "");
    for (const mentionedId of extractMentionedUserIds(text)) {
      userIds.add(mentionedId);
    }
  }

  return Array.from(userIds);
}

function countReplies(messages: ExportMessage[]): number {
  return messages.reduce((total, message) => {
    return total + message.replies.length + countReplies(message.replies);
  }, 0);
}

function getDateRange(messages: ExportMessage[]): {
  first: number | null;
  last: number | null;
} {
  const flattened = flattenExportMessages(messages);
  let first: number | null = null;
  let last: number | null = null;

  for (const message of flattened) {
    if (first == null || message.epochMs < first) {
      first = message.epochMs;
    }
    if (last == null || message.epochMs > last) {
      last = message.epochMs;
    }
  }

  return { first, last };
}

function renderMessage(message: ExportMessage, depth = 0): string[] {
  const bulletIndent = "  ".repeat(depth);
  const contentIndent = "  ".repeat(depth + 1);
  const lines = [
    `${bulletIndent}- \`${formatTimestamp(message.epochMs)}\` **${escapeMarkdownInline(message.author)}**`,
    "",
  ];

  const messageBody = message.text.trim().length > 0 ? message.text : "_(no text)_";
  for (const line of messageBody.split("\n")) {
    lines.push(line.length > 0 ? `${contentIndent}> ${line}` : `${contentIndent}>`);
  }

  for (const reply of message.replies) {
    lines.push("");
    lines.push(...renderMessage(reply, depth + 1));
  }

  return lines;
}

function buildMonthMarkdown(monthKey: string, messages: ExportMessage[]): string {
  const flattened = flattenExportMessages(messages);
  const range = getDateRange(messages);
  const replyCount = countReplies(messages);
  const lines = [
    `# Slack export — #${CHANNEL_NAME} — ${monthKey}`,
    "",
    `- Channel ID: \`${CHANNEL_ID}\``,
    `- Top-level messages: ${messages.length}`,
    `- Thread replies: ${replyCount}`,
    `- Total exported entries: ${flattened.length}`,
    `- Date range: ${range.first != null ? formatTimestamp(range.first) : "n/a"} → ${range.last != null ? formatTimestamp(range.last) : "n/a"}`,
    "",
    "## Messages",
    "",
  ];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    lines.push(...renderMessage(message));
    if (index < messages.length - 1) {
      lines.push("");
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function buildIndexMarkdown(months: MonthSummary[], totalMessages: number): string {
  const first = months.find((month) => month.firstTs != null)?.firstTs ?? null;
  const reversed = [...months].reverse();
  const last = reversed.find((month) => month.lastTs != null)?.lastTs ?? null;

  const lines = [
    `# Slack dump — #${CHANNEL_NAME}`,
    "",
    `- Channel ID: \`${CHANNEL_ID}\``,
    `- Time zone: \`${DISPLAY_TIME_ZONE}\``,
    `- Total exported entries: ${totalMessages}`,
    `- Date range: ${first != null ? formatTimestamp(first) : "n/a"} → ${last != null ? formatTimestamp(last) : "n/a"}`,
    `- Generated: ${new Date().toISOString()}`,
    "",
    "## Months",
    "",
  ];

  for (const month of months) {
    const dateRange =
      month.firstTs != null && month.lastTs != null
        ? `${formatTimestamp(month.firstTs)} → ${formatTimestamp(month.lastTs)}`
        : "n/a";

    lines.push(
      `- [${month.monthKey}](./${month.filename}) — ${month.topLevelCount} top-level / ${month.totalCount} total entries — ${dateRange}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

class SlackClient {
  private readonly lastRequestStartedAt = new Map<string, number>();
  private readonly userNameCache = new Map<string, string>();

  constructor(private readonly token: string) {}

  getCachedUserName(userId: string): string | undefined {
    return this.userNameCache.get(userId);
  }

  async primeUserCache(userIds: Iterable<string>): Promise<void> {
    for (const userId of Array.from(userIds)) {
      const trimmed = userId.trim();
      if (!trimmed) continue;
      await this.resolveUserName(trimmed);
    }
  }

  async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    const response = await this.api<SlackUserInfoResponse>("users.info", {
      user: userId,
    });
    const label =
      response.user?.profile?.display_name?.trim()
      || response.user?.profile?.real_name?.trim()
      || response.user?.real_name?.trim()
      || response.user?.name?.trim()
      || userId;

    this.userNameCache.set(userId, label);
    return label;
  }

  async resolveAuthorLabel(message: SlackMessage): Promise<string> {
    const userId = message.user?.trim();
    if (userId) {
      return this.resolveUserName(userId);
    }

    const profileName = message.bot_profile?.name?.trim();
    if (profileName) return profileName;

    const username = message.username?.trim();
    if (username) return username;

    const botId = message.bot_id?.trim();
    if (botId) return `bot:${botId}`;

    return "unknown";
  }

  async fetchAllChannelHistory(channelId: string): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;

    while (true) {
      const page = await this.api<SlackHistoryResponse>("conversations.history", {
        channel: channelId,
        limit: String(HISTORY_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      });

      if (Array.isArray(page.messages)) {
        messages.push(...page.messages);
      }

      const nextCursor = page.response_metadata?.next_cursor?.trim();
      if (!page.has_more || !nextCursor) {
        break;
      }

      cursor = nextCursor;
    }

    return messages;
  }

  async fetchThreadReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    const replies: SlackMessage[] = [];
    let cursor: string | undefined;

    while (true) {
      const page = await this.api<SlackRepliesResponse>("conversations.replies", {
        channel: channelId,
        ts: threadTs,
        limit: String(REPLIES_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      });

      if (Array.isArray(page.messages)) {
        replies.push(...page.messages);
      }

      const nextCursor = page.response_metadata?.next_cursor?.trim();
      if (!page.has_more || !nextCursor) {
        break;
      }

      cursor = nextCursor;
    }

    return replies;
  }

  private async api<T extends SlackApiResponse>(
    endpoint: string,
    params: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`https://slack.com/api/${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }

    while (true) {
      await this.waitForTurn(endpoint);

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? "1", 10);
        const retryAfterMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : 1_000;
        await sleep(retryAfterMs);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Slack ${endpoint} failed with HTTP ${response.status}: ${body || "<empty body>"}`,
        );
      }

      const data = (await response.json()) as T;
      if (data.ok !== true) {
        throw new Error(`Slack ${endpoint} failed: ${data.error ?? "unknown_error"}`);
      }

      return data;
    }
  }

  private async waitForTurn(endpoint: string): Promise<void> {
    const minInterval = ENDPOINT_MIN_INTERVAL_MS[endpoint] ?? 750;
    const lastStartedAt = this.lastRequestStartedAt.get(endpoint) ?? 0;
    const waitMs = lastStartedAt + minInterval - Date.now();

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    this.lastRequestStartedAt.set(endpoint, Date.now());
  }
}

async function convertSlackMrkdwnToMarkdown(
  text: string,
  slack: SlackClient,
): Promise<string> {
  let output = decodeSlackEntities(text);

  for (const userId of extractMentionedUserIds(output)) {
    await slack.resolveUserName(userId);
  }

  output = output.replace(/<!date\^[^|>]+?\|([^>]+)>/g, "$1");
  output = output.replace(/<!(here|channel|everyone)>/g, "@$1");
  output = output.replace(
    /<!subteam\^[^|>]+\|([^>]+)>/g,
    (_match, label: string) => `@${escapeMarkdownInline(label)}`,
  );
  output = output.replace(
    /<#([A-Z0-9]+)\|([^>]+)>/g,
    (_match, _channelId: string, label: string) => `#${escapeMarkdownInline(label)}`,
  );
  output = output.replace(/<@([A-Z0-9]+)>/g, (_match, userId: string) => {
    const name = slack.getCachedUserName(userId) ?? userId;
    return `@${escapeMarkdownInline(name)}`;
  });
  output = output.replace(
    /<(mailto:[^>|]+)\|([^>]+)>/g,
    (_match, url: string, label: string) => `[${escapeMarkdownLinkLabel(label)}](${url})`,
  );
  output = output.replace(
    /<(https?:\/\/[^>|]+)\|([^>]+)>/g,
    (_match, url: string, label: string) =>
      label === url ? `<${url}>` : `[${escapeMarkdownLinkLabel(label)}](${url})`,
  );
  output = output.replace(/<(https?:\/\/[^>]+)>/g, "<$1>");
  output = output.replace(/<(mailto:[^>]+)>/g, "<$1>");
  output = output.replace(/<([^>|]+)\|([^>]+)>/g, (_match, _target: string, label: string) => {
    return label;
  });

  return output.trim();
}

async function buildMessageText(message: SlackMessage, slack: SlackClient): Promise<string> {
  const parts: string[] = [];
  const rawText = (message.text ?? "").trim();
  if (rawText.length > 0) {
    const markdownText = await convertSlackMrkdwnToMarkdown(rawText, slack);
    if (markdownText.length > 0) {
      parts.push(markdownText);
    }
  }

  const fileLabels = summarizeFiles(message.files);
  if (fileLabels.length > 0) {
    parts.push(`_Files:_ ${fileLabels.map((label) => `\`${label.replaceAll("`", "\\`")}\``).join(", ")}`);
  }

  if (parts.length === 0 && Array.isArray(message.attachments) && message.attachments.length > 0) {
    parts.push(
      `_(contains ${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"})_`,
    );
  }

  return parts.length > 0 ? parts.join("\n\n") : "_(no text)_";
}

async function toExportMessage(
  message: SlackMessage,
  slack: SlackClient,
): Promise<ExportMessage | null> {
  if (shouldSkipMessage(message)) return null;

  const ts = message.ts?.trim();
  const epochMs = parseSlackTimestamp(ts);
  if (!ts || epochMs == null) {
    return null;
  }

  return {
    ts,
    epochMs,
    monthKey: getMonthKey(epochMs),
    author: await slack.resolveAuthorLabel(message),
    text: await buildMessageText(message, slack),
    replies: [],
  };
}

async function prepareOutputDirectory(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const existing = await readdir(OUTPUT_DIR, { withFileTypes: true });
  for (const entry of existing) {
    if (!entry.isFile()) continue;
      if (entry.name === "index.md" || /^\d{4}-\d{2}\.md$/.test(entry.name)) {
      await rm(join(OUTPUT_DIR, entry.name));
    }
  }
}

async function main(): Promise<void> {
  const token = assertNonEmpty(
    process.env.SLACK_USER_TOKEN,
    "Missing SLACK_USER_TOKEN environment variable.",
  );
  const slack = new SlackClient(token);

  console.log(`Fetching full history for #${CHANNEL_NAME} (${CHANNEL_ID})...`);
  const rawHistory = await slack.fetchAllChannelHistory(CHANNEL_ID);
  const topLevelHistory = rawHistory
    .filter((message) => !shouldSkipMessage(message))
    .filter((message) => !isThreadReply(message))
    .sort((left, right) => {
      return (parseSlackTimestamp(left.ts) ?? 0) - (parseSlackTimestamp(right.ts) ?? 0);
    });

  console.log(`Fetched ${topLevelHistory.length} top-level messages. Fetching thread replies...`);

  const replyMap = new Map<string, SlackMessage[]>();
  let threadedParents = 0;
  for (const message of topLevelHistory) {
    const replyCount = message.reply_count ?? 0;
    const threadTs = message.ts?.trim();
    if (!threadTs || replyCount <= 0) continue;

    threadedParents += 1;
    const replies = await slack.fetchThreadReplies(CHANNEL_ID, threadTs);
    const normalizedReplies = replies
      .filter((reply) => reply.ts?.trim() !== threadTs)
      .filter((reply) => !shouldSkipMessage(reply))
      .sort((left, right) => {
        return (parseSlackTimestamp(left.ts) ?? 0) - (parseSlackTimestamp(right.ts) ?? 0);
      });

    replyMap.set(threadTs, normalizedReplies);
  }

  console.log(`Fetched replies for ${threadedParents} threaded parents.`);

  const allRawMessages = [...topLevelHistory];
  for (const replies of Array.from(replyMap.values())) {
    allRawMessages.push(...replies);
  }
  await slack.primeUserCache(collectReferencedUserIds(allRawMessages));

  const exportMessages: ExportMessage[] = [];
  for (const parent of topLevelHistory) {
    const normalizedParent = await toExportMessage(parent, slack);
    if (!normalizedParent) continue;

    const replies = replyMap.get(normalizedParent.ts) ?? [];
    const normalizedReplies: ExportMessage[] = [];
    for (const reply of replies) {
      const normalizedReply = await toExportMessage(reply, slack);
      if (normalizedReply) {
        normalizedReplies.push(normalizedReply);
      }
    }

    normalizedParent.replies = normalizedReplies;
    exportMessages.push(normalizedParent);
  }

  await prepareOutputDirectory();

  const monthBuckets = new Map<string, ExportMessage[]>();
  for (const message of exportMessages) {
    const bucket = monthBuckets.get(message.monthKey) ?? [];
    bucket.push(message);
    monthBuckets.set(message.monthKey, bucket);
  }

  const monthSummaries: MonthSummary[] = [];
  const sortedMonthKeys = Array.from(monthBuckets.keys()).sort();
  for (const monthKey of sortedMonthKeys) {
    const messages = monthBuckets.get(monthKey) ?? [];
    const flattened = flattenExportMessages(messages);
    const range = getDateRange(messages);
    const filename = `${monthKey}.md`;
    const filePath = join(OUTPUT_DIR, filename);
    const content = buildMonthMarkdown(monthKey, messages);
    await writeFile(filePath, content, "utf8");

    monthSummaries.push({
      monthKey,
      filename,
      topLevelCount: messages.length,
      totalCount: flattened.length,
      firstTs: range.first,
      lastTs: range.last,
    });
  }

  const totalMessages = monthSummaries.reduce((total, month) => total + month.totalCount, 0);
  await writeFile(
    join(OUTPUT_DIR, "index.md"),
    `${buildIndexMarkdown(monthSummaries, totalMessages)}\n`,
    "utf8",
  );

  console.log(
    `Wrote ${monthSummaries.length} monthly files and index.md to ${OUTPUT_DIR} (${totalMessages} total exported entries).`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
