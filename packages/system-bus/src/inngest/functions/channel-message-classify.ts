import { NonRetriableError } from "inngest";
import { infer } from "../../lib/inference";
import { traceLlmGeneration } from "../../lib/langfuse";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const CHANNEL_CLASSIFIER_MODEL = "anthropic/claude-haiku-4-5";
const TAXONOMY_VERSION = "workload-v1";
const DEFAULT_PRIMARY_CONCEPT_ID = "joelclaw:concept:comms";

const CHANNEL_TYPES = ["slack", "discord", "telegram", "email"] as const;
type ChannelType = (typeof CHANNEL_TYPES)[number];

const CLASSIFICATION_VALUES = ["signal", "context", "noise"] as const;
type MessageClassificationLevel = (typeof CLASSIFICATION_VALUES)[number];

const URGENCY_VALUES = ["high", "normal", "low"] as const;
type MessageUrgency = (typeof URGENCY_VALUES)[number];

type WorkloadConceptId =
  | "joelclaw:concept:platform"
  | "joelclaw:concept:integration"
  | "joelclaw:concept:tooling"
  | "joelclaw:concept:pipeline"
  | "joelclaw:concept:build"
  | "joelclaw:concept:knowledge"
  | "joelclaw:concept:comms"
  | "joelclaw:concept:observe"
  | "joelclaw:concept:meta";

const WORKLOAD_CONCEPT_IDS: readonly WorkloadConceptId[] = [
  "joelclaw:concept:platform",
  "joelclaw:concept:integration",
  "joelclaw:concept:tooling",
  "joelclaw:concept:pipeline",
  "joelclaw:concept:build",
  "joelclaw:concept:knowledge",
  "joelclaw:concept:comms",
  "joelclaw:concept:observe",
  "joelclaw:concept:meta",
] as const;

const WORKLOAD_CONCEPT_CHEATSHEET = [
  "- joelclaw:concept:platform — infrastructure, runtime, hosting, cluster, pods, deployment substrate",
  "- joelclaw:concept:integration — external APIs, vendors, webhooks, Slack, Front, GitHub, service connections",
  "- joelclaw:concept:tooling — CLI, scripts, local automation, developer tooling",
  "- joelclaw:concept:pipeline — workflows, ingestion, durable jobs, event flow, queues",
  "- joelclaw:concept:build — implementation, bugs, features, tests, code changes",
  "- joelclaw:concept:knowledge — docs, notes, ADRs, memory, vault context",
  "- joelclaw:concept:comms — conversations, coordination, replies, messaging",
  "- joelclaw:concept:observe — monitoring, telemetry, logs, incidents, health",
  "- joelclaw:concept:meta — governance, process, prioritization, planning",
].join("\n");

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
  primaryConceptId: WorkloadConceptId;
  conceptIds: WorkloadConceptId[];
  taxonomyVersion: string;
  conceptSource: "llm" | "fallback";
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

Use these canonical workload concept IDs only:
${WORKLOAD_CONCEPT_CHEATSHEET}

Return ONLY valid JSON with this shape:
{
  "classification": "signal | context | noise",
  "topics": ["topic-one", "topic-two"],
  "urgency": "high | normal | low",
  "actionable": true,
  "summary": "optional one-sentence summary",
  "primaryConceptId": "joelclaw:concept:comms",
  "conceptIds": ["joelclaw:concept:comms", "joelclaw:concept:build"]
}

Rules:
- Keep topics concise (max 6) and lowercase kebab-case.
- urgency should be high only for time-sensitive content.
- actionable should be true only when Joel should likely take action soon.
- summary may be omitted for obvious noise.
- conceptIds must contain 1-3 canonical concept IDs from the allowed list.
- primaryConceptId must be the first and most important concept in conceptIds.
- If unsure, default to joelclaw:concept:comms.`;

function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

function isClassification(value: string): value is MessageClassificationLevel {
  return (CLASSIFICATION_VALUES as readonly string[]).includes(value);
}

function isUrgency(value: string): value is MessageUrgency {
  return (URGENCY_VALUES as readonly string[]).includes(value);
}

function isWorkloadConceptId(value: string): value is WorkloadConceptId {
  return (WORKLOAD_CONCEPT_IDS as readonly string[]).includes(value);
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

function normalizeConceptIds(value: unknown): WorkloadConceptId[] {
  if (!Array.isArray(value)) return [DEFAULT_PRIMARY_CONCEPT_ID];

  const unique = new Set<WorkloadConceptId>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase();
    if (!isWorkloadConceptId(normalized)) continue;
    unique.add(normalized);
    if (unique.size >= 3) break;
  }

  return unique.size > 0 ? [...unique] : [DEFAULT_PRIMARY_CONCEPT_ID];
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
    // continue
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
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
  const conceptIds = normalizeConceptIds(candidate.conceptIds);
  const requestedPrimary = optionalString(candidate.primaryConceptId)?.toLowerCase();
  const primaryConceptId = requestedPrimary && isWorkloadConceptId(requestedPrimary)
    ? requestedPrimary
    : conceptIds[0] ?? DEFAULT_PRIMARY_CONCEPT_ID;
  const orderedConceptIds = [
    primaryConceptId,
    ...conceptIds.filter((conceptId) => conceptId !== primaryConceptId),
  ] as WorkloadConceptId[];

  return {
    classification: classificationValue,
    topics: normalizeTopics(candidate.topics),
    urgency,
    actionable,
    ...(summary ? { summary } : {}),
    primaryConceptId,
    conceptIds: orderedConceptIds,
    taxonomyVersion: TAXONOMY_VERSION,
    conceptSource: orderedConceptIds.length > 0 ? "llm" : "fallback",
  };
}

function inferConceptIdsFromText(text: string): WorkloadConceptId[] {
  const normalized = text.toLowerCase();
  const concepts: WorkloadConceptId[] = [];

  const maybeAdd = (conceptId: WorkloadConceptId, patterns: RegExp[]) => {
    if (concepts.includes(conceptId)) return;
    if (patterns.some((pattern) => pattern.test(normalized))) {
      concepts.push(conceptId);
    }
  };

  maybeAdd("joelclaw:concept:observe", [/error/u, /failed/u, /timeout/u, /health/u, /incident/u, /otel/u, /observ/u, /log/u]);
  maybeAdd("joelclaw:concept:platform", [/k8s/u, /cluster/u, /deploy/u, /worker/u, /gateway/u, /runtime/u, /pod/u]);
  maybeAdd("joelclaw:concept:integration", [/webhook/u, /github/u, /front/u, /slack/u, /telegram/u, /discord/u, /vendor/u, /api/u]);
  maybeAdd("joelclaw:concept:tooling", [/cli/u, /script/u, /tool/u, /automation/u, /codex/u, /pi /u]);
  maybeAdd("joelclaw:concept:pipeline", [/queue/u, /workflow/u, /inngest/u, /restate/u, /pipeline/u, /event/u]);
  maybeAdd("joelclaw:concept:build", [/bug/u, /fix/u, /code/u, /test/u, /build/u, /compile/u, /patch/u]);
  maybeAdd("joelclaw:concept:knowledge", [/adr/u, /docs/u, /memory/u, /vault/u, /note/u]);
  maybeAdd("joelclaw:concept:meta", [/priority/u, /plan/u, /triage/u, /process/u, /govern/u]);
  maybeAdd("joelclaw:concept:comms", [/message/u, /reply/u, /thread/u, /conversation/u, /mail/u, /contact/u]);

  if (concepts.length === 0) concepts.push(DEFAULT_PRIMARY_CONCEPT_ID);
  return concepts.slice(0, 3);
}

function fallbackClassificationFromMessage(message: ChannelMessage): MessageClassification {
  const normalized = message.text.toLowerCase();
  const urgent = /urgent|asap|immediately|outage|down|broken|failing|failure|error|incident|blocked/u.test(normalized);
  const noisy = /^(thanks|thx|ok|okay|lol|👍|✅|done)$/u.test(message.text.trim()) || message.text.trim().length < 8;
  const classification: MessageClassificationLevel = noisy ? "noise" : urgent ? "signal" : "context";
  const urgency: MessageUrgency = urgent ? "high" : "normal";
  const actionable = urgent;
  const conceptIds = inferConceptIdsFromText(message.text);
  const primaryConceptId = conceptIds[0] ?? DEFAULT_PRIMARY_CONCEPT_ID;
  const summary = noisy ? undefined : optionalString(message.text, 140);
  const topics = normalizeTopics(message.text.split(/[^a-zA-Z0-9-_]+/u).filter(Boolean).slice(0, 6));

  return {
    classification,
    topics,
    urgency,
    actionable,
    ...(summary ? { summary } : {}),
    primaryConceptId,
    conceptIds,
    taxonomyVersion: TAXONOMY_VERSION,
    conceptSource: "fallback",
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

function resolveThreadId(message: ChannelMessage): string | undefined {
  if (message.threadId) return message.threadId;
  if (message.channelType === "email") return message.channelId;
  return undefined;
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

        let classification: MessageClassification;
        try {
          classification = parseClassification(result.data, result.text);
        } catch (error) {
          classification = fallbackClassificationFromMessage(message);
          await emitOtelEvent({
            level: "warn",
            source: "worker",
            component: "channel-classify",
            action: "channel.message.classify_fallback",
            success: true,
            error: error instanceof Error ? error.message : String(error),
            metadata: {
              eventId: event.id,
              messageId,
              channelId: message.channelId,
              model: CHANNEL_CLASSIFIER_MODEL,
              conceptSource: classification.conceptSource,
            },
          });
        }

        return {
          message,
          classification,
          durationMs: Date.now() - startedAt,
          threadId: resolveThreadId(message),
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
          ...(classified.threadId ? { thread_id: classified.threadId } : {}),
          classification: classified.classification.classification,
          topics: classified.classification.topics,
          urgency: classified.classification.urgency,
          actionable: classified.classification.actionable,
          primary_concept_id: classified.classification.primaryConceptId,
          concept_ids: classified.classification.conceptIds,
          taxonomy_version: classified.classification.taxonomyVersion,
          concept_source: classified.classification.conceptSource,
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
            primaryConceptId: classified.classification.primaryConceptId,
            conceptIds: classified.classification.conceptIds,
            taxonomyVersion: classified.classification.taxonomyVersion,
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
            primaryConceptId: classified.classification.primaryConceptId,
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
          ...(classified.threadId ? { threadId: classified.threadId } : {}),
          userId: classified.message.userId,
          userName: classified.message.userName,
          text: classified.message.text,
          timestamp: classified.message.timestamp,
          ...(classified.message.sourceUrl ? { sourceUrl: classified.message.sourceUrl } : {}),
          classification: "signal" as const,
          topics: classified.classification.topics,
          urgency: classified.classification.urgency,
          actionable: classified.classification.actionable,
          primaryConceptId: classified.classification.primaryConceptId,
          conceptIds: classified.classification.conceptIds,
          taxonomyVersion: classified.classification.taxonomyVersion,
          conceptSource: classified.classification.conceptSource,
          ...(classified.classification.summary
            ? { summary: classified.classification.summary }
            : {}),
        },
      });
      signalEventId = dispatched.ids[0] ?? null;
    }

    let threadEventId: string | null = null;
    if (classified.threadId) {
      const dispatched = await step.sendEvent("emit-thread-updated", {
        name: "conversation/thread.updated",
        data: {
          messageId: classified.message.id,
          channelType: classified.message.channelType,
          channelId: classified.message.channelId,
          channelName: classified.message.channelName,
          threadId: classified.threadId,
          timestamp: classified.message.timestamp,
          primaryConceptId: classified.classification.primaryConceptId,
          conceptIds: classified.classification.conceptIds,
          taxonomyVersion: classified.classification.taxonomyVersion,
        },
      });
      threadEventId = dispatched.ids[0] ?? null;
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
      threadEventId,
    };
  }
);

export const __channelMessageClassifyTestUtils = {
  parseJsonObject,
  parseClassification,
  fallbackClassificationFromMessage,
};
