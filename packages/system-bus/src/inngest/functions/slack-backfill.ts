import { execSync } from "node:child_process";
import { NonRetriableError } from "inngest";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const SLACK_MESSAGES_COLLECTION = "slack_messages";
const SLACK_PAGE_LIMIT = 200;
const DEFAULT_BACKFILL_DAYS = 60;
const SLACK_BACKFILL_FLOW_KEY = '"slack-backfill"';

type SlackHistoryMessage = {
  type?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  reactions?: Array<{ name?: string; count?: number }>;
  attachments?: unknown[];
  files?: unknown[];
};

type SlackHistoryResponse = {
  ok: boolean;
  error?: string;
  messages?: SlackHistoryMessage[];
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackUserInfoResponse = {
  ok: boolean;
  error?: string;
  user?: {
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
    };
  };
};

type SlackMessageDocument = {
  id: string;
  channel_type: "slack";
  channel_id: string;
  channel_name: string;
  channel_category: string;
  thread_ts?: string;
  user_id: string;
  user_name: string;
  text: string;
  timestamp: number;
  message_ts: string;
  is_thread_reply: boolean;
  reactions?: string[];
  has_attachments?: boolean;
  ingested_at: number;
};

const SLACK_MESSAGES_SCHEMA = {
  name: SLACK_MESSAGES_COLLECTION,
  fields: [
    { name: "id", type: "string" },
    { name: "channel_type", type: "string", facet: true },
    { name: "channel_id", type: "string", facet: true },
    { name: "channel_name", type: "string", facet: true },
    { name: "channel_category", type: "string", facet: true },
    { name: "thread_ts", type: "string", optional: true },
    { name: "user_id", type: "string", facet: true },
    { name: "user_name", type: "string", facet: true },
    { name: "text", type: "string" },
    { name: "timestamp", type: "int64" },
    { name: "message_ts", type: "string" },
    { name: "is_thread_reply", type: "bool", facet: true },
    { name: "reactions", type: "string[]", optional: true, facet: true },
    { name: "has_attachments", type: "bool", facet: true, optional: true },
    { name: "ingested_at", type: "int64" },
  ],
  default_sorting_field: "timestamp",
} satisfies Record<string, unknown>;

function classifyChannelCategory(name: string): string {
  if (name.startsWith("cc-")) return "cc";
  if (name.startsWith("lc-")) return "lc";
  if (name.startsWith("dd-")) return "dd";
  if (name.startsWith("brain-")) return "brain";
  if (name.startsWith("project-")) return "project";
  if (name === "egghead-hq") return "hq";
  if (name.startsWith("skill-")) return "skill";
  if (name.startsWith("sp-") || name.startsWith("sp_")) return "partner";
  if (name.startsWith("pm-")) return "pm";
  if (name.endsWith("-chat")) return "legacy-chat";
  return "other";
}

function defaultOldestTs(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oldest = nowSeconds - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60;
  return String(oldest);
}

function defaultLatestTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

function parseSlackTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function hasMessageAttachments(message: SlackHistoryMessage): boolean {
  const attachmentsCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
  const filesCount = Array.isArray(message.files) ? message.files.length : 0;
  return attachmentsCount > 0 || filesCount > 0;
}

function normalizeReactions(reactions: SlackHistoryMessage["reactions"]): string[] | undefined {
  if (!Array.isArray(reactions) || reactions.length === 0) return undefined;
  const names = new Set<string>();
  for (const reaction of reactions) {
    if (!reaction || typeof reaction.name !== "string") continue;
    const normalized = reaction.name.trim();
    if (!normalized) continue;
    names.add(normalized);
  }
  return names.size > 0 ? [...names] : undefined;
}

function shouldSkipMessage(message: SlackHistoryMessage): boolean {
  const subtype = message.subtype?.trim();
  if (!subtype) return false;
  if (subtype === "channel_join") return true;
  if (subtype === "channel_leave") return true;
  if (subtype === "tombstone") return true;
  if (subtype === "bot_message" && !(message.text ?? "").trim()) return true;
  return false;
}

function isPermanentSlackError(errorCode: string | undefined): boolean {
  if (!errorCode) return false;
  return new Set([
    "invalid_auth",
    "account_inactive",
    "not_authed",
    "missing_scope",
    "channel_not_found",
    "is_archived",
  ]).has(errorCode);
}

function leaseSlackUserToken(): string {
  try {
    const token = execSync("secrets lease slack_user_token --ttl 1h", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!token) {
      throw new NonRetriableError("secrets lease returned empty value for slack_user_token");
    }

    return token;
  } catch (error) {
    if (error instanceof NonRetriableError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new NonRetriableError(`Failed to lease slack_user_token: ${message}`);
  }
}

async function ensureSlackMessagesCollection(): Promise<void> {
  await typesense.ensureCollection(SLACK_MESSAGES_COLLECTION, SLACK_MESSAGES_SCHEMA);
}

async function fetchSlackApi<T>(
  endpoint: string,
  token: string,
  params: Record<string, string | undefined>
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    search.set(key, value);
  }

  const response = await fetch(`https://slack.com/api/${endpoint}?${search.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Slack ${endpoint} failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as { ok?: boolean; error?: string };
  if (!data.ok) {
    if (isPermanentSlackError(data.error)) {
      throw new NonRetriableError(`Slack ${endpoint} failed permanently: ${data.error}`);
    }
    throw new Error(`Slack ${endpoint} failed: ${data.error ?? "unknown_error"}`);
  }

  return data as T;
}

export const slackChannelBackfill = inngest.createFunction(
  {
    id: "slack-channel-backfill",
    concurrency: { limit: 2, key: SLACK_BACKFILL_FLOW_KEY },
    throttle: { limit: 10, period: "60s", key: SLACK_BACKFILL_FLOW_KEY },
    retries: 3,
  },
  { event: "channel/slack.backfill.requested" },
  async ({ event, step }) => {
    const channelId = event.data.channelId?.trim();
    const channelName = event.data.channelName?.trim();

    if (!channelId) {
      throw new NonRetriableError("channel/slack.backfill.requested requires data.channelId");
    }
    if (!channelName) {
      throw new NonRetriableError("channel/slack.backfill.requested requires data.channelName");
    }

    const range = await step.run("resolve-time-range", async () => {
      const oldestTs = event.data.oldestTs?.trim() || defaultOldestTs();
      const latestTs = event.data.latestTs?.trim() || defaultLatestTs();
      const oldest = Number.parseFloat(oldestTs);
      const latest = Number.parseFloat(latestTs);

      if (!Number.isFinite(oldest) || !Number.isFinite(latest)) {
        throw new NonRetriableError("oldestTs/latestTs must be valid Slack timestamp strings");
      }
      if (oldest > latest) {
        throw new NonRetriableError("oldestTs must be less than or equal to latestTs");
      }

      return { oldestTs, latestTs };
    });

    const token = await step.run("lease-slack-user-token", async () => {
      return leaseSlackUserToken();
    });

    await step.run("ensure-slack-messages-collection", async () => {
      await ensureSlackMessagesCollection();
      return { ensured: true };
    });

    const channelCategory = classifyChannelCategory(channelName);

    const userCache = new Map<string, string>();

    async function resolveUserName(userId: string, slackToken: string): Promise<string> {
      if (userCache.has(userId)) {
        return userCache.get(userId)!;
      }

      const response = await fetch(
        `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
        {
          headers: { Authorization: `Bearer ${slackToken}` },
        }
      );

      if (!response.ok) {
        throw new Error(`Slack users.info failed with HTTP ${response.status} for ${userId}`);
      }

      const data = (await response.json()) as SlackUserInfoResponse;
      const name = data.ok
        ? data.user?.profile?.display_name || data.user?.real_name || data.user?.name || userId
        : userId;
      userCache.set(userId, name);
      return name;
    }

    await step.run("emit-slack-backfill-started", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "slack-backfill",
        action: "channel.slack.backfill.started",
        success: true,
        metadata: {
          eventId: event.id,
          channelId,
          channelName,
          channelCategory,
          oldestTs: range.oldestTs,
          latestTs: range.latestTs,
          reason: event.data.reason ?? null,
        },
      });
      return { emitted: true };
    });

    let cursor: string | undefined;
    let pageNumber = 0;
    let pagesProcessed = 0;
    let totalFetched = 0;
    let totalIndexed = 0;
    let totalSkipped = 0;
    let totalTypesenseSuccess = 0;
    let totalTypesenseErrors = 0;

    while (true) {
      pageNumber += 1;

      const history = await step.run(`fetch-history-page-${pageNumber}`, async () => {
        return fetchSlackApi<SlackHistoryResponse>("conversations.history", token, {
          channel: channelId,
          limit: String(SLACK_PAGE_LIMIT),
          oldest: range.oldestTs,
          latest: range.latestTs,
          inclusive: "true",
          ...(cursor ? { cursor } : {}),
        });
      });

      const pageStats = await step.run(`process-history-page-${pageNumber}`, async () => {
        const messages = Array.isArray(history.messages) ? history.messages : [];
        const normalizedDocs: SlackMessageDocument[] = [];
        const ingestedAt = Math.floor(Date.now() / 1000);

        let skipped = 0;

        for (const message of messages) {
          if (shouldSkipMessage(message)) {
            skipped += 1;
            continue;
          }

          const messageTs = message.ts?.trim();
          const timestamp = parseSlackTimestamp(messageTs);
          if (!messageTs || timestamp == null) {
            skipped += 1;
            continue;
          }

          const threadTs = message.thread_ts?.trim();
          const userId = message.user?.trim() || "unknown";
          const userName = await resolveUserName(userId, token);
          const reactions = normalizeReactions(message.reactions);
          const hasAttachments = hasMessageAttachments(message);

          normalizedDocs.push({
            id: `${channelId}:${messageTs}`,
            channel_type: "slack",
            channel_id: channelId,
            channel_name: channelName,
            channel_category: channelCategory,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            user_id: userId,
            user_name: userName,
            text: (message.text ?? "").trim(),
            timestamp,
            message_ts: messageTs,
            is_thread_reply: Boolean(threadTs && threadTs !== messageTs),
            ...(reactions ? { reactions } : {}),
            has_attachments: hasAttachments,
            ingested_at: ingestedAt,
          });
        }

        let importResult = { success: 0, errors: 0 };
        if (normalizedDocs.length > 0) {
          importResult = await typesense.bulkImport(
            SLACK_MESSAGES_COLLECTION,
            normalizedDocs as unknown as Record<string, unknown>[],
            "upsert"
          );
        }

        await emitOtelEvent({
          level: importResult.errors > 0 ? "warn" : "info",
          source: "worker",
          component: "slack-backfill",
          action: "channel.slack.backfill.page_indexed",
          success: importResult.errors === 0,
          ...(importResult.errors > 0
            ? { error: "typesense_bulk_import_errors" }
            : {}),
          metadata: {
            eventId: event.id,
            channelId,
            channelName,
            pageNumber,
            fetchedMessages: messages.length,
            indexedMessages: normalizedDocs.length,
            skippedMessages: skipped,
            typesenseSuccess: importResult.success,
            typesenseErrors: importResult.errors,
            hasMore: Boolean(history.has_more),
          },
        });

        return {
          fetchedMessages: messages.length,
          indexedMessages: normalizedDocs.length,
          skippedMessages: skipped,
          typesenseSuccess: importResult.success,
          typesenseErrors: importResult.errors,
        };
      });

      pagesProcessed += 1;
      totalFetched += pageStats.fetchedMessages;
      totalIndexed += pageStats.indexedMessages;
      totalSkipped += pageStats.skippedMessages;
      totalTypesenseSuccess += pageStats.typesenseSuccess;
      totalTypesenseErrors += pageStats.typesenseErrors;

      const hasMore = Boolean(history.has_more);
      const nextCursor = history.response_metadata?.next_cursor?.trim();

      if (!hasMore || !nextCursor) {
        break;
      }

      cursor = nextCursor;
      await step.sleep(`rate-limit-${pageNumber}`, "1.5s");
    }

    await step.run("emit-slack-backfill-completed", async () => {
      await emitOtelEvent({
        level: totalTypesenseErrors > 0 ? "warn" : "info",
        source: "worker",
        component: "slack-backfill",
        action: "channel.slack.backfill.completed",
        success: totalTypesenseErrors === 0,
        ...(totalTypesenseErrors > 0
          ? { error: "typesense_bulk_import_errors" }
          : {}),
        metadata: {
          eventId: event.id,
          channelId,
          channelName,
          channelCategory,
          oldestTs: range.oldestTs,
          latestTs: range.latestTs,
          pagesProcessed,
          fetchedMessages: totalFetched,
          indexedMessages: totalIndexed,
          skippedMessages: totalSkipped,
          typesenseSuccess: totalTypesenseSuccess,
          typesenseErrors: totalTypesenseErrors,
          reason: event.data.reason ?? null,
        },
      });
      return { emitted: true };
    });

    return {
      channelId,
      channelName,
      channelCategory,
      oldestTs: range.oldestTs,
      latestTs: range.latestTs,
      pagesProcessed,
      fetchedMessages: totalFetched,
      indexedMessages: totalIndexed,
      skippedMessages: totalSkipped,
      typesenseSuccess: totalTypesenseSuccess,
      typesenseErrors: totalTypesenseErrors,
    };
  }
);

export const slackBackfillBatch = inngest.createFunction(
  {
    id: "slack-backfill-batch",
    retries: 1,
  },
  { event: "channel/slack.backfill.batch.requested" },
  async ({ event, step }) => {
    const channels = event.data.channels;

    if (channels.length === 0) {
      await step.run("emit-slack-backfill-batch-empty", async () => {
        await emitOtelEvent({
          level: "warn",
          source: "worker",
          component: "slack-backfill",
          action: "channel.slack.backfill.batch.empty",
          success: true,
          metadata: {
            eventId: event.id,
            oldestTs: event.data.oldestTs ?? null,
            reason: event.data.reason ?? null,
          },
        });
        return { emitted: true };
      });

      return {
        queued: 0,
        channels: 0,
      };
    }

    const queueResult = await step.sendEvent(
      "fan-out-slack-channel-backfill",
      channels.map((channel: { id: string; name: string }) => {
        const id = channel.id?.trim();
        const name = channel.name?.trim();

        if (!id || !name) {
          throw new NonRetriableError("Each batch channel requires id and name");
        }

        return {
          name: "channel/slack.backfill.requested" as const,
          data: {
            channelId: id,
            channelName: name,
            ...(event.data.oldestTs ? { oldestTs: event.data.oldestTs } : {}),
            reason: event.data.reason ?? "batch_backfill",
          },
        };
      })
    );

    await step.run("emit-slack-backfill-batch-queued", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "slack-backfill",
        action: "channel.slack.backfill.batch.queued",
        success: true,
        metadata: {
          eventId: event.id,
          channels: channels.length,
          queuedEvents: queueResult.ids.length,
          oldestTs: event.data.oldestTs ?? null,
          reason: event.data.reason ?? null,
        },
      });
      return { emitted: true };
    });

    return {
      queued: queueResult.ids.length,
      channels: channels.length,
      eventIds: queueResult.ids,
    };
  }
);
