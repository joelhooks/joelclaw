import { createHash } from "node:crypto";
import { NonRetriableError } from "inngest";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const CHANNEL_TYPES = ["slack", "discord", "telegram"] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];

type IncomingMessage = {
  channelType: ChannelType;
  channelId: string;
  channelName: string;
  threadId?: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
  sourceUrl?: string;
};

type ChannelMessageDocument = {
  id: string;
  channel_type: ChannelType;
  channel_id: string;
  channel_name: string;
  thread_id?: string;
  user_id: string;
  user_name: string;
  text: string;
  timestamp: number;
  classification: "unclassified";
  topics: string[];
  urgency: "normal";
  actionable: boolean;
  source_url?: string;
};

function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new NonRetriableError(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new NonRetriableError(`${fieldName} must not be empty`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function requireTimestamp(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    throw new NonRetriableError("timestamp must be a finite unix-ms number");
  }
  const normalized = Math.trunc(parsed);
  if (normalized <= 0) {
    throw new NonRetriableError("timestamp must be greater than 0");
  }
  return normalized;
}

function requireChannelType(value: unknown): ChannelType {
  const normalized = requireString(value, "channelType").toLowerCase();
  if (!isChannelType(normalized)) {
    throw new NonRetriableError(`channelType must be one of ${CHANNEL_TYPES.join(", ")}`);
  }
  return normalized;
}

function normalizeIncomingMessage(raw: Record<string, unknown>): IncomingMessage {
  const channelType = requireChannelType(raw.channelType);
  return {
    channelType,
    channelId: requireString(raw.channelId, "channelId"),
    channelName: requireString(raw.channelName, "channelName"),
    threadId: optionalString(raw.threadId),
    userId: requireString(raw.userId, "userId"),
    userName: requireString(raw.userName, "userName"),
    text: requireString(raw.text, "text"),
    timestamp: requireTimestamp(raw.timestamp),
    sourceUrl: optionalString(raw.sourceUrl),
  };
}

function buildMessageId(message: IncomingMessage): string {
  const digest = createHash("sha1")
    .update(
      [
        message.channelType,
        message.channelId,
        message.threadId ?? "",
        message.userId,
        String(message.timestamp),
        message.text,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return `${message.channelType}:${message.channelId}:${message.timestamp}:${digest}`;
}

export const channelMessageIngest = inngest.createFunction(
  {
    id: "channel-message-ingest",
    concurrency: { limit: 10 },
    throttle: { limit: 30, period: "1m" },
    retries: 2,
  },
  { event: "channel/message.received" },
  async ({ event, step }) => {
    const incoming = normalizeIncomingMessage(event.data as Record<string, unknown>);

    const indexed = await step.run("index-to-typesense", async () => {
      const messageId = buildMessageId(incoming);
      const document: ChannelMessageDocument = {
        id: messageId,
        channel_type: incoming.channelType,
        channel_id: incoming.channelId,
        channel_name: incoming.channelName,
        ...(incoming.threadId ? { thread_id: incoming.threadId } : {}),
        user_id: incoming.userId,
        user_name: incoming.userName,
        text: incoming.text,
        timestamp: incoming.timestamp,
        classification: "unclassified",
        topics: [],
        urgency: "normal",
        actionable: false,
        ...(incoming.sourceUrl ? { source_url: incoming.sourceUrl } : {}),
      };

      try {
        await typesense.ensureChannelMessagesCollection();
        await typesense.upsert(typesense.CHANNEL_MESSAGES_COLLECTION, document);

        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "channel-ingest",
          action: "channel.message.ingested",
          success: true,
          metadata: {
            eventId: event.id,
            messageId,
            channelType: incoming.channelType,
            channelId: incoming.channelId,
            channelName: incoming.channelName,
            threadId: incoming.threadId ?? null,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "channel-ingest",
          action: "channel.message.ingested",
          success: false,
          error: message,
          metadata: {
            eventId: event.id,
            messageId,
            channelType: incoming.channelType,
            channelId: incoming.channelId,
          },
        });
        throw error;
      }

      return { messageId };
    });

    const queued = await step.sendEvent("emit-classify", {
      name: "channel/message.classify.requested",
      data: {
        messageId: indexed.messageId,
      },
    });

    return {
      messageId: indexed.messageId,
      classifyEventId: queued.ids[0] ?? null,
    };
  }
);
