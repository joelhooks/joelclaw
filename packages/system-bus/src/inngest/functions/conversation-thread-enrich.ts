import { infer } from "../../lib/inference";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const THREAD_SUMMARIZER_MODEL = "anthropic/claude-haiku-4-5";
const VAULT_MATCHES_PER_MESSAGE = 3;
const MAX_MESSAGES_FOR_PROMPT = 12;

type SupportedThreadSource = "slack" | "email";

type ThreadEnrichmentRequestedEvent = {
  source: SupportedThreadSource;
  channelId: string;
  channelName: string;
  threadId: string;
  threadKey: string;
  reason: "new-thread" | "message-threshold" | "time-gap" | "manual";
  newMessageCount: number;
  lastMessageAt: number;
};

type ChannelMessageDoc = {
  id: string;
  user_name: string;
  text: string;
  timestamp: number;
  urgency?: string;
  primary_concept_id?: string;
  concept_ids?: string[];
  summary?: string;
};

type VaultHit = {
  id: string;
  title?: string;
  path?: string;
  type?: string;
  tags?: string[];
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

function encodeFilterValue(value: string): string {
  return value.replace(/([,\]])/g, "\\$1");
}

function normalizeMessage(doc: Record<string, unknown>): ChannelMessageDoc {
  return {
    id: requireString(doc.id, "id"),
    user_name: requireString(doc.user_name, "user_name"),
    text: requireString(doc.text, "text"),
    timestamp: requireNumber(doc.timestamp, "timestamp"),
    urgency: typeof doc.urgency === "string" ? doc.urgency : undefined,
    primary_concept_id: typeof doc.primary_concept_id === "string" ? doc.primary_concept_id : undefined,
    concept_ids: Array.isArray(doc.concept_ids)
      ? doc.concept_ids.filter((value): value is string => typeof value === "string")
      : undefined,
    summary: typeof doc.summary === "string" ? doc.summary : undefined,
  };
}

function normalizeVaultHit(doc: Record<string, unknown>): VaultHit {
  return {
    id: requireString(doc.id, "id"),
    title: typeof doc.title === "string" ? doc.title : undefined,
    path: typeof doc.path === "string" ? doc.path : undefined,
    type: typeof doc.type === "string" ? doc.type : undefined,
    tags: Array.isArray(doc.tags)
      ? doc.tags.filter((value): value is string => typeof value === "string")
      : undefined,
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
      include_fields: "id,user_name,text,timestamp,urgency,primary_concept_id,concept_ids,summary",
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

function deriveProjectFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const match = path.match(/^Projects\/([^/]+)/u);
  return match?.[1] ?? null;
}

function deriveContactFromHit(hit: VaultHit): string | null {
  if (hit.path?.startsWith("Resources/contacts/") || hit.path?.startsWith("Resources/Contacts/")) {
    return hit.title ?? hit.id;
  }
  return null;
}

function rankUrgency(messages: ChannelMessageDoc[]): "low" | "normal" | "high" | "critical" {
  if (messages.some((message) => message.urgency === "high")) return "high";
  return "normal";
}

function buildSummaryPrompt(
  input: {
    source: SupportedThreadSource;
    channelName: string;
    threadId: string;
    messages: ChannelMessageDoc[];
    concepts: string[];
    relatedProjects: string[];
    relatedContacts: string[];
    vaultGapSignal: string | null;
  },
): string {
  const messages = input.messages.slice(-MAX_MESSAGES_FOR_PROMPT).map((message) => ({
    user: message.user_name,
    text: message.text.slice(0, 280),
    summary: message.summary,
    urgency: message.urgency,
    concepts: message.concept_ids ?? [],
  }));

  return JSON.stringify({
    source: input.source,
    channelName: input.channelName,
    threadId: input.threadId,
    concepts: input.concepts,
    relatedProjects: input.relatedProjects,
    relatedContacts: input.relatedContacts,
    vaultGapSignal: input.vaultGapSignal,
    messages,
  }, null, 2);
}

const THREAD_SUMMARY_SYSTEM_PROMPT = `You summarize operational conversation threads for Joel Hooks.

Return ONLY valid JSON with this shape:
{
  "summary": "one sentence summary",
  "needsJoel": true,
  "urgency": "low | normal | high | critical",
  "vaultGapSignal": "short gap note or empty string"
}

Rules:
- Be concise and specific.
- needsJoel is true when the thread clearly needs Joel's direct reply, decision, or attention.
- urgency is critical only for actively broken or blocked situations.
- Reuse the supplied relatedProjects and vaultGapSignal if they are relevant.
- Do not invent facts.`;

async function searchVaultForMessage(message: ChannelMessageDoc): Promise<VaultHit[]> {
  const response = await typesense.search({
    collection: "vault_notes",
    q: message.text,
    query_by: "title,content,path,tags",
    vector_query: `embedding:([], k:${VAULT_MATCHES_PER_MESSAGE})`,
    per_page: VAULT_MATCHES_PER_MESSAGE,
    include_fields: "id,title,path,type,tags",
  });

  return (Array.isArray(response.hits) ? response.hits : []).map((hit) => normalizeVaultHit(hit.document));
}

export const conversationThreadEnrich = inngest.createFunction(
  {
    id: "conversation-thread-enrich",
    concurrency: { limit: 2 },
    throttle: { limit: 20, period: "1m" },
    retries: 2,
  },
  { event: "conversation/thread.enrichment.requested" },
  async ({ event, step }) => {
    const input = event.data as ThreadEnrichmentRequestedEvent;
    const source = input.source;
    const channelId = requireString(input.channelId, "channelId");
    const channelName = requireString(input.channelName, "channelName");
    const threadId = requireString(input.threadId, "threadId");
    const threadKey = requireString(input.threadKey, "threadKey");

    const enriched = await step.run("enrich-thread", async () => {
      await typesense.ensureConversationThreadsCollection();
      const messages = await listThreadMessages(source, channelId, threadId);
      if (messages.length === 0) {
        throw new Error(`No messages found for thread ${threadKey}`);
      }

      const vaultHitsByMessage = await Promise.all(messages.map((message) => searchVaultForMessage(message)));
      const relatedProjects = new Set<string>();
      const relatedContacts = new Set<string>();
      const matchedVaultNotes = new Set<string>();
      let unmatchedMessages = 0;

      for (const hits of vaultHitsByMessage) {
        if (hits.length === 0) {
          unmatchedMessages += 1;
          continue;
        }

        for (const hit of hits) {
          matchedVaultNotes.add(hit.id);
          const project = deriveProjectFromPath(hit.path);
          if (project) relatedProjects.add(project);
          const contact = deriveContactFromHit(hit);
          if (contact) relatedContacts.add(contact);
        }
      }

      const conceptIds = [...new Set(messages.flatMap((message) => message.concept_ids ?? []))];
      const vaultGap = unmatchedMessages >= Math.max(1, Math.ceil(messages.length / 2));
      const fallbackVaultGapSignal = vaultGap
        ? `Limited vault coverage for ${unmatchedMessages} of ${messages.length} messages.`
        : null;

      const summaryResult = await infer(buildSummaryPrompt({
        source,
        channelName,
        threadId,
        messages,
        concepts: conceptIds,
        relatedProjects: [...relatedProjects],
        relatedContacts: [...relatedContacts],
        vaultGapSignal: fallbackVaultGapSignal,
      }), {
        model: THREAD_SUMMARIZER_MODEL,
        task: "summary",
        system: THREAD_SUMMARY_SYSTEM_PROMPT,
        json: true,
        component: "conversation-thread-enrich",
        action: "conversation.thread.enriched",
        timeout: 45_000,
      });

      const payload = (
        summaryResult.data && typeof summaryResult.data === "object" && !Array.isArray(summaryResult.data)
          ? summaryResult.data as Record<string, unknown>
          : JSON.parse(summaryResult.text)
      ) as Record<string, unknown>;

      const summary = requireString(payload.summary, "summary");
      const needsJoel = payload.needsJoel === true || String(payload.needsJoel).toLowerCase() === "true";
      const urgencyRaw = typeof payload.urgency === "string" ? payload.urgency.trim().toLowerCase() : "normal";
      const urgency = ["low", "normal", "high", "critical"].includes(urgencyRaw)
        ? urgencyRaw as "low" | "normal" | "high" | "critical"
        : rankUrgency(messages);
      const modelVaultGapSignal = typeof payload.vaultGapSignal === "string" && payload.vaultGapSignal.trim().length > 0
        ? payload.vaultGapSignal.trim()
        : fallbackVaultGapSignal;

      await typesense.upsert(typesense.CONVERSATION_THREADS_COLLECTION, {
        id: threadKey,
        source,
        channel_id: channelId,
        channel_name: channelName,
        thread_id: threadId,
        participants: [...new Set(messages.map((message) => message.user_name))],
        message_count: messages.length,
        first_message_at: messages[0]?.timestamp ?? input.lastMessageAt,
        last_message_at: messages[messages.length - 1]?.timestamp ?? input.lastMessageAt,
        status: "active",
        ...(conceptIds[0] ? { primary_concept_id: conceptIds[0] } : {}),
        ...(conceptIds.length > 0 ? { concept_ids: conceptIds } : {}),
        taxonomy_version: "workload-v1",
        summary,
        related_projects: [...relatedProjects],
        related_contacts: [...relatedContacts],
        vault_gap: vaultGap,
        ...(modelVaultGapSignal ? { vault_gap_signal: modelVaultGapSignal } : {}),
        urgency,
        needs_joel: needsJoel,
        enriched_at: Date.now(),
      });

      return {
        threadKey,
        messageCount: messages.length,
        matchedVaultNotes: matchedVaultNotes.size,
        relatedProjects: [...relatedProjects],
        relatedContacts: [...relatedContacts],
        vaultGap,
        urgency,
        needsJoel,
      };
    });

    await step.run("emit-otel", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "conversation-thread-enrich",
        action: "conversation.thread.enriched",
        success: true,
        metadata: {
          eventId: event.id,
          threadKey: enriched.threadKey,
          messageCount: enriched.messageCount,
          matchedVaultNotes: enriched.matchedVaultNotes,
          relatedProjects: enriched.relatedProjects,
          relatedContacts: enriched.relatedContacts,
          vaultGap: enriched.vaultGap,
          urgency: enriched.urgency,
          needsJoel: enriched.needsJoel,
        },
      });
    });

    return enriched;
  },
);
