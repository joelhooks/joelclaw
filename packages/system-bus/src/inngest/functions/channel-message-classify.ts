import { NonRetriableError } from "inngest";
import { infer } from "../../lib/inference";
import { traceLlmGeneration } from "../../lib/langfuse";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const CHANNEL_CLASSIFIER_MODEL = "anthropic/claude-haiku-4-5";

const CHANNEL_TYPES = ["slack", "discord", "telegram"] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];

const CLASSIFICATION_VALUES = ["signal", "context", "noise"] as const;
type MessageClassificationLevel = (typeof CLASSIFICATION_VALUES)[number];

const URGENCY_VALUES = ["high", "normal", "low"] as const;
type MessageUrgency = (typeof URGENCY_VALUES)[number];

type ChannelMessage = {
  id: string;
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

type MessageClassification = {
  classification: MessageClassificationLevel;
  topics: string[];
  urgency: MessageUrgency;
  actionable: boolean;
  summary?: string;
};

type RouteDestination = "session" | "digest" | "dropped";

const CHANNEL_CLASSIFICATION_SYSTEM_PROMPT = `You are the channel intelligence classifier for Joel Hooks.

Joel context:
- Joel is the owner of egghead.io.
- Joel is actively building the joelclaw personal AI system.
- Joel is working on the MEGA course project.

VIP contacts:
- Kent C. Dodds
- Matt Pocock
- John Lindquist
- Theo Browne
- Grzegorz Rog

Classify each message into one of:
- signal: high-value information Joel should likely see quickly. Includes direct mentions of Joel/egghead, VIP messages, bug reports, purchase issues, deployment failures, and time-sensitive requests.
- context: relevant ongoing discussion, technical decisions, and product updates that matter for summaries but do not need immediate interruption.
- noise: bot chatter, emoji-only reactions, routine CI notifications, low-value social chatter, and content that should not surface.

Return ONLY valid JSON with this shape:
{
  "classification": "signal | context | noise",
  "topics": ["topic-one", "topic-two"],
  "urgency": "high | normal | low",
  "actionable": true,
  "summary": "optional one-sentence summary"
}

Rules:
- Keep topics concise (max 6) and lowercase kebab-case.
- urgency should be high only for time-sensitive content.
- actionable should be true only when Joel should likely take action soon.
- summary may be omitted for obvious noise.`;

function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

function isClassification(value: string): value is MessageClassificationLevel {
  return (CLASSIFICATION_VALUES as readonly string[]).includes(value);
}

function isUrgency(value: string): value is MessageUrgency {
  return (URGENCY_VALUES as readonly string[]).includes(value);
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

function optionalString(value: unknown, maxLength = 280): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
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

function normalizeTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_ ]+/gu, "")
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-|-$/gu, "");

    if (!normalized) continue;
    unique.add(normalized);
    if (unique.size >= 6) break;
  }

  return [...unique];
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors; caller handles null
  }

  return null;
}

function parseClassification(data: unknown, rawText: string): MessageClassification {
  const candidate = (
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : parseJsonObject(rawText)
  );

  if (!candidate) {
    throw new NonRetriableError("classification response was not valid JSON");
  }

  const classificationValue = requireString(candidate.classification, "classification").toLowerCase();
  if (!isClassification(classificationValue)) {
    throw new NonRetriableError(`classification must be one of ${CLASSIFICATION_VALUES.join(", ")}`);
  }

  const urgencyRaw = optionalString(candidate.urgency)?.toLowerCase() ?? "normal";
  const urgency = isUrgency(urgencyRaw) ? urgencyRaw : "normal";
  const actionable = candidate.actionable === true || String(candidate.actionable).toLowerCase() === "true";
  const summary = optionalString(candidate.summary);

  return {
    classification: classificationValue,
    topics: normalizeTopics(candidate.topics),
    urgency,
    actionable,
    ...(summary ? { summary } : {}),
  };
}

function normalizeMessage(doc: Record<string, unknown>): ChannelMessage {
  const channelTypeRaw = requireString(doc.channel_type, "channel_type").toLowerCase();
  if (!isChannelType(channelTypeRaw)) {
    throw new NonRetriableError(`channel_type must be one of ${CHANNEL_TYPES.join(", ")}`);
  }

  return {
    id: requireString(doc.id, "id"),
    channelType: channelTypeRaw,
    channelId: requireString(doc.channel_id, "channel_id"),
    channelName: requireString(doc.channel_name, "channel_name"),
    threadId: optionalString(doc.thread_id),
    userId: requireString(doc.user_id, "user_id"),
    userName: requireString(doc.user_name, "user_name"),
    text: requireString(doc.text, "text"),
    timestamp: requireTimestamp(doc.timestamp),
    sourceUrl: optionalString(doc.source_url),
  };
}

function buildUserPrompt(message: ChannelMessage): string {
  return [
    `channel_type: ${message.channelType}`,
    `channel_name: ${message.channelName}`,
    `channel_id: ${message.channelId}`,
    `thread_id: ${message.threadId ?? "(none)"}`,
    `user_name: ${message.userName}`,
    `user_id: ${message.userId}`,
    `timestamp_unix_ms: ${message.timestamp}`,
    "",
    "message_text:",
    message.text,
  ].join("\n");
}

function resolveDestination(classification: MessageClassification): RouteDestination {
  if (classification.classification === "signal" && classification.actionable) {
    return "session";
  }

  if (classification.classification === "context" || classification.classification === "signal") {
    return "digest";
  }

  return "dropped";
}

export const channelMessageClassify = inngest.createFunction(
  {
    id: "channel-message-classify",
    concurrency: { limit: 5 },
    throttle: { limit: 20, period: "1m" },
    retries: 2,
  },
  { event: "channel/message.classify.requested" },
  async ({ event, step }) => {
    const messageId = requireString(
      (event.data as Record<string, unknown>).messageId,
      "messageId"
    );

    const classified = await step.run("classify-message", async () => {
      const rawDoc = await typesense.getDoc(typesense.CHANNEL_MESSAGES_COLLECTION, messageId);
      const message = normalizeMessage(rawDoc);

      const startedAt = Date.now();
      try {
        const result = await infer(buildUserPrompt(message), {
          model: CHANNEL_CLASSIFIER_MODEL,
          task: "classification",
          system: CHANNEL_CLASSIFICATION_SYSTEM_PROMPT,
          json: true,
          component: "channel-message-classify",
          action: "channel.message.classified",
          timeout: 45_000,
        });
        const classification = parseClassification(result.data, result.text);
        return {
          message,
          classification,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "channel-classify",
          action: "channel.message.classified",
          success: false,
          error: errorMessage,
          metadata: {
            eventId: event.id,
            messageId,
            channelId: message.channelId,
            model: CHANNEL_CLASSIFIER_MODEL,
          },
        });
        throw error;
      }
    });

    await step.run("update-typesense", async () => {
      try {
        await typesense.upsert(typesense.CHANNEL_MESSAGES_COLLECTION, {
          id: classified.message.id,
          classification: classified.classification.classification,
          topics: classified.classification.topics,
          urgency: classified.classification.urgency,
          actionable: classified.classification.actionable,
          ...(classified.classification.summary
            ? { summary: classified.classification.summary }
            : {}),
        });

        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "channel-classify",
          action: "channel.message.classified",
          success: true,
          duration_ms: classified.durationMs,
          metadata: {
            eventId: event.id,
            messageId: classified.message.id,
            channelType: classified.message.channelType,
            channelId: classified.message.channelId,
            classification: classified.classification.classification,
            topics: classified.classification.topics,
            urgency: classified.classification.urgency,
            actionable: classified.classification.actionable,
            model: CHANNEL_CLASSIFIER_MODEL,
            latency: classified.durationMs,
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "channel-classify",
          action: "channel.message.classified",
          success: false,
          error: errorMessage,
          duration_ms: classified.durationMs,
          metadata: {
            eventId: event.id,
            messageId: classified.message.id,
            channelType: classified.message.channelType,
            channelId: classified.message.channelId,
            model: CHANNEL_CLASSIFIER_MODEL,
          },
        });
        throw error;
      }
    });

    const routing = await step.run("route-message", async () => {
      const destination = resolveDestination(classified.classification);

      try {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "channel-route",
          action: "channel.message.routed",
          success: true,
          metadata: {
            eventId: event.id,
            messageId: classified.message.id,
            channelId: classified.message.channelId,
            destination,
            classification: classified.classification.classification,
            actionable: classified.classification.actionable,
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "channel-route",
          action: "channel.message.routed",
          success: false,
          error: errorMessage,
          metadata: {
            eventId: event.id,
            messageId: classified.message.id,
            channelId: classified.message.channelId,
            destination,
          },
        });
        throw error;
      }

      return { destination };
    });

    let signalEventId: string | null = null;
    if (routing.destination === "session") {
      const dispatched = await step.sendEvent("emit-signal", {
        name: "channel/message.signal",
        data: {
          messageId: classified.message.id,
          channelType: classified.message.channelType,
          channelId: classified.message.channelId,
          channelName: classified.message.channelName,
          ...(classified.message.threadId ? { threadId: classified.message.threadId } : {}),
          userId: classified.message.userId,
          userName: classified.message.userName,
          text: classified.message.text,
          timestamp: classified.message.timestamp,
          ...(classified.message.sourceUrl ? { sourceUrl: classified.message.sourceUrl } : {}),
          classification: "signal" as const,
          topics: classified.classification.topics,
          urgency: classified.classification.urgency,
          actionable: classified.classification.actionable,
          ...(classified.classification.summary
            ? { summary: classified.classification.summary }
            : {}),
        },
      });
      signalEventId = dispatched.ids[0] ?? null;
    }

    await step.run("trace-langfuse", async () => {
      await traceLlmGeneration({
        traceName: "joelclaw.channel-classify",
        generationName: "channel.message.classify",
        component: "channel-classify",
        action: "channel.classify.llm",
        input: {
          text: classified.message.text,
          channelName: classified.message.channelName,
          channelType: classified.message.channelType,
        },
        output: {
          classification: classified.classification,
        },
        model: CHANNEL_CLASSIFIER_MODEL,
        durationMs: classified.durationMs,
        metadata: {
          channelId: classified.message.channelId,
          messageId: classified.message.id,
        },
      });
      return { traced: true };
    });

    return {
      messageId: classified.message.id,
      classification: classified.classification.classification,
      destination: routing.destination,
      signalEventId,
    };
  }
);
