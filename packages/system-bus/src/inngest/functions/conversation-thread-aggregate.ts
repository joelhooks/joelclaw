import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const ENRICH_MESSAGE_THRESHOLD = 5;
const ENRICH_TIME_GAP_MS = 30 * 60 * 1000;

type SupportedThreadSource = "slack" | "email";
type ThreadStatus = "active" | "stale" | "resolved";
type EnrichReason = "new-thread" | "message-threshold" | "time-gap" | "manual";

type ThreadUpdatedEvent = {
  messageId: string;
  channelType: "slack" | "discord" | "telegram" | "email";
  channelId: string;
  channelName: string;
  threadId: string;
  timestamp: number;
  primaryConceptId?: string;
  conceptIds?: string[];
  taxonomyVersion?: string;
};

type ChannelMessageDoc = {
  id: string;
  channel_type: string;
  channel_id: string;
  channel_name: string;
  thread_id?: string;
  user_name: string;
  timestamp: number;
  urgency?: string;
  primary_concept_id?: string;
  concept_ids?: string[];
};

type ConversationThreadDoc = {
  id: string;
  source: SupportedThreadSource;
  channel_id: string;
  channel_name: string;
  thread_id: string;
  participants: string[];
  message_count: number;
  first_message_at: number;
  last_message_at: number;
  status: ThreadStatus;
  primary_concept_id?: string;
  concept_ids?: string[];
  taxonomy_version?: string;
  summary: string;
  related_projects?: string[];
  related_contacts?: string[];
  vault_gap: boolean;
  vault_gap_signal?: string;
  urgency: "low" | "normal" | "high" | "critical";
  needs_joel: boolean;
  enriched_at?: number;
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function requireNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a finite number`);
  return Math.trunc(parsed);
}

function normalizeSource(value: string): SupportedThreadSource | null {
  return value === "slack" || value === "email" ? value : null;
}

function encodeFilterValue(value: string): string {
  return value.replace(/([,\]])/g, "\\$1");
}

function normalizeMessage(doc: Record<string, unknown>): ChannelMessageDoc {
  return {
    id: requireString(doc.id, "id"),
    channel_type: requireString(doc.channel_type, "channel_type"),
    channel_id: requireString(doc.channel_id, "channel_id"),
    channel_name: requireString(doc.channel_name, "channel_name"),
    thread_id: typeof doc.thread_id === "string" ? doc.thread_id : undefined,
    user_name: requireString(doc.user_name, "user_name"),
    timestamp: requireNumber(doc.timestamp, "timestamp"),
    urgency: typeof doc.urgency === "string" ? doc.urgency : undefined,
    primary_concept_id: typeof doc.primary_concept_id === "string" ? doc.primary_concept_id : undefined,
    concept_ids: Array.isArray(doc.concept_ids)
      ? doc.concept_ids.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

function normalizeThreadDoc(doc: Record<string, unknown>): ConversationThreadDoc {
  const source = normalizeSource(requireString(doc.source, "source"));
  if (!source) throw new Error(`unsupported source ${String(doc.source)}`);

  return {
    id: requireString(doc.id, "id"),
    source,
    channel_id: requireString(doc.channel_id, "channel_id"),
    channel_name: requireString(doc.channel_name, "channel_name"),
    thread_id: requireString(doc.thread_id, "thread_id"),
    participants: Array.isArray(doc.participants)
      ? doc.participants.filter((value): value is string => typeof value === "string")
      : [],
    message_count: requireNumber(doc.message_count, "message_count"),
    first_message_at: requireNumber(doc.first_message_at, "first_message_at"),
    last_message_at: requireNumber(doc.last_message_at, "last_message_at"),
    status: (typeof doc.status === "string" ? doc.status : "active") as ThreadStatus,
    primary_concept_id: typeof doc.primary_concept_id === "string" ? doc.primary_concept_id : undefined,
    concept_ids: Array.isArray(doc.concept_ids)
      ? doc.concept_ids.filter((value): value is string => typeof value === "string")
      : undefined,
    taxonomy_version: typeof doc.taxonomy_version === "string" ? doc.taxonomy_version : undefined,
    summary: typeof doc.summary === "string" ? doc.summary : "",
    related_projects: Array.isArray(doc.related_projects)
      ? doc.related_projects.filter((value): value is string => typeof value === "string")
      : undefined,
    related_contacts: Array.isArray(doc.related_contacts)
      ? doc.related_contacts.filter((value): value is string => typeof value === "string")
      : undefined,
    vault_gap: doc.vault_gap === true,
    vault_gap_signal: typeof doc.vault_gap_signal === "string" ? doc.vault_gap_signal : undefined,
    urgency: (typeof doc.urgency === "string" ? doc.urgency : "normal") as ConversationThreadDoc["urgency"],
    needs_joel: doc.needs_joel === true,
    enriched_at: typeof doc.enriched_at === "number" ? Math.trunc(doc.enriched_at) : undefined,
  };
}

async function listThreadMessages(
  source: SupportedThreadSource,
  channelId: string,
  threadId: string,
): Promise<ChannelMessageDoc[]> {
  const results: ChannelMessageDoc[] = [];
  let page = 1;

  while (true) {
    const response = await typesense.search({
      collection: typesense.CHANNEL_MESSAGES_COLLECTION,
      q: "*",
      query_by: "text",
      filter_by: [
        `channel_type:=[${encodeFilterValue(source)}]`,
        `channel_id:=[${encodeFilterValue(channelId)}]`,
        `thread_id:=[${encodeFilterValue(threadId)}]`,
      ].join(" && "),
      sort_by: "timestamp:asc",
      per_page: 250,
      page,
      include_fields: "id,channel_type,channel_id,channel_name,thread_id,user_name,timestamp,urgency,primary_concept_id,concept_ids",
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];
    for (const hit of hits) {
      results.push(normalizeMessage(hit.document));
    }

    if (hits.length < 250) break;
    page += 1;
  }

  return results;
}

async function getExistingThread(threadKey: string): Promise<ConversationThreadDoc | null> {
  try {
    const doc = await typesense.getDoc(typesense.CONVERSATION_THREADS_COLLECTION, threadKey);
    return normalizeThreadDoc(doc);
  } catch {
    return null;
  }
}

function resolveStatus(): ThreadStatus {
  return "active";
}

function resolveUrgency(messages: ChannelMessageDoc[], existing: ConversationThreadDoc | null): ConversationThreadDoc["urgency"] {
  if (messages.some((message) => message.urgency === "high")) return "high";
  return existing?.urgency ?? "normal";
}

function summarizeFallback(source: SupportedThreadSource, channelName: string, messageCount: number, participants: string[]): string {
  const who = participants.slice(0, 3).join(", ");
  const sourceLabel = source === "email" ? "email thread" : `thread in ${channelName}`;
  return who
    ? `${messageCount} messages in ${sourceLabel} involving ${who}.`
    : `${messageCount} messages in ${sourceLabel}.`;
}

function buildThreadKey(source: SupportedThreadSource, channelId: string, threadId: string): string {
  return `${source}:${channelId}:${threadId}`;
}

function resolveEnrichReason(
  existing: ConversationThreadDoc | null,
  messageCount: number,
  lastMessageAt: number,
): { shouldEnrich: boolean; reason: EnrichReason | null; newMessageCount: number } {
  if (!existing) {
    return { shouldEnrich: true, reason: "new-thread", newMessageCount: messageCount };
  }

  const newMessageCount = Math.max(0, messageCount - existing.message_count);
  if (newMessageCount >= ENRICH_MESSAGE_THRESHOLD) {
    return { shouldEnrich: true, reason: "message-threshold", newMessageCount };
  }

  if (newMessageCount > 0 && existing.enriched_at && lastMessageAt - existing.enriched_at >= ENRICH_TIME_GAP_MS) {
    return { shouldEnrich: true, reason: "time-gap", newMessageCount };
  }

  return { shouldEnrich: false, reason: null, newMessageCount };
}

export const conversationThreadAggregate = inngest.createFunction(
  {
    id: "conversation-thread-aggregate",
    concurrency: { limit: 1, key: "event.data.threadId" },
    throttle: { limit: 30, period: "1m" },
    retries: 2,
  },
  { event: "conversation/thread.updated" },
  async ({ event, step }) => {
    const input = event.data as ThreadUpdatedEvent;
    const source = normalizeSource(requireString(input.channelType, "channelType"));
    if (!source) {
      return { skipped: true, reason: "unsupported-source" };
    }

    const channelId = requireString(input.channelId, "channelId");
    const channelName = requireString(input.channelName, "channelName");
    const threadId = requireString(input.threadId, "threadId");
    const threadKey = buildThreadKey(source, channelId, threadId);

    const aggregate = await step.run("aggregate-thread", async () => {
      await typesense.ensureConversationThreadsCollection();
      const messages = await listThreadMessages(source, channelId, threadId);
      if (messages.length === 0) {
        throw new Error(`No messages found for thread ${threadKey}`);
      }

      const existing = await getExistingThread(threadKey);
      const participants = [...new Set(messages.map((message) => message.user_name))];
      const conceptCounts = new Map<string, number>();
      const conceptSet = new Set<string>();

      for (const message of messages) {
        if (message.primary_concept_id) {
          conceptCounts.set(
            message.primary_concept_id,
            (conceptCounts.get(message.primary_concept_id) ?? 0) + 1,
          );
        }
        for (const conceptId of message.concept_ids ?? []) {
          conceptSet.add(conceptId);
        }
      }

      const primaryConceptId = [...conceptCounts.entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? existing?.primary_concept_id;
      const conceptIds = primaryConceptId
        ? [primaryConceptId, ...[...conceptSet].filter((conceptId) => conceptId !== primaryConceptId)]
        : [...conceptSet];

      const firstMessageAt = messages[0]?.timestamp ?? Date.now();
      const lastMessageAt = messages[messages.length - 1]?.timestamp ?? firstMessageAt;
      const enrich = resolveEnrichReason(existing, messages.length, lastMessageAt);

      const threadDoc: ConversationThreadDoc = {
        id: threadKey,
        source,
        channel_id: channelId,
        channel_name: channelName,
        thread_id: threadId,
        participants,
        message_count: messages.length,
        first_message_at: firstMessageAt,
        last_message_at: lastMessageAt,
        status: resolveStatus(),
        ...(primaryConceptId ? { primary_concept_id: primaryConceptId } : {}),
        ...(conceptIds.length > 0 ? { concept_ids: conceptIds } : {}),
        ...(typeof input.taxonomyVersion === "string" ? { taxonomy_version: input.taxonomyVersion } : {}),
        summary: existing?.summary || summarizeFallback(source, channelName, messages.length, participants),
        related_projects: existing?.related_projects ?? [],
        related_contacts: existing?.related_contacts ?? [],
        vault_gap: existing?.vault_gap ?? false,
        ...(existing?.vault_gap_signal ? { vault_gap_signal: existing.vault_gap_signal } : {}),
        urgency: resolveUrgency(messages, existing),
        needs_joel: existing?.needs_joel ?? false,
        ...(existing?.enriched_at ? { enriched_at: existing.enriched_at } : {}),
      };

      await typesense.upsert(typesense.CONVERSATION_THREADS_COLLECTION, threadDoc as unknown as Record<string, unknown>);

      return {
        threadKey,
        source,
        channelId,
        channelName,
        threadId,
        messageCount: messages.length,
        lastMessageAt,
        enrich,
      };
    });

    let enrichmentEventId: string | null = null;
    if (aggregate.enrich.shouldEnrich && aggregate.enrich.reason) {
      const result = await step.sendEvent("request-thread-enrichment", {
        name: "conversation/thread.enrichment.requested",
        data: {
          source: aggregate.source,
          channelId: aggregate.channelId,
          channelName: aggregate.channelName,
          threadId: aggregate.threadId,
          threadKey: aggregate.threadKey,
          reason: aggregate.enrich.reason,
          newMessageCount: aggregate.enrich.newMessageCount,
          lastMessageAt: aggregate.lastMessageAt,
        },
      });
      enrichmentEventId = result.ids[0] ?? null;
    }

    await step.run("emit-otel", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "conversation-thread-aggregate",
        action: "conversation.thread.aggregated",
        success: true,
        metadata: {
          eventId: event.id,
          threadKey: aggregate.threadKey,
          source: aggregate.source,
          channelId: aggregate.channelId,
          threadId: aggregate.threadId,
          messageCount: aggregate.messageCount,
          enrichRequested: aggregate.enrich.shouldEnrich,
          enrichReason: aggregate.enrich.reason,
          enrichmentEventId,
        },
      });
    });

    return {
      threadKey: aggregate.threadKey,
      messageCount: aggregate.messageCount,
      enrichmentEventId,
    };
  },
);
