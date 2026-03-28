import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

type ThreadDoc = {
  id: string;
  source: string;
  channel_id: string;
  channel_name: string;
  thread_id: string;
  participants?: string[];
  message_count: number;
  first_message_at: number;
  last_message_at: number;
  status?: string;
  primary_concept_id?: string;
  concept_ids?: string[];
  taxonomy_version?: string;
  summary?: string;
  related_projects?: string[];
  related_contacts?: string[];
  vault_gap?: boolean;
  vault_gap_signal?: string;
  urgency?: string;
  needs_joel?: boolean;
  enriched_at?: number;
};

function normalizeThread(doc: Record<string, unknown>): ThreadDoc {
  return {
    id: String(doc.id ?? ""),
    source: String(doc.source ?? ""),
    channel_id: String(doc.channel_id ?? ""),
    channel_name: String(doc.channel_name ?? ""),
    thread_id: String(doc.thread_id ?? ""),
    participants: Array.isArray(doc.participants)
      ? doc.participants.filter((value): value is string => typeof value === "string")
      : [],
    message_count: Number(doc.message_count ?? 0),
    first_message_at: Number(doc.first_message_at ?? 0),
    last_message_at: Number(doc.last_message_at ?? 0),
    status: typeof doc.status === "string" ? doc.status : undefined,
    primary_concept_id: typeof doc.primary_concept_id === "string" ? doc.primary_concept_id : undefined,
    concept_ids: Array.isArray(doc.concept_ids)
      ? doc.concept_ids.filter((value): value is string => typeof value === "string")
      : undefined,
    taxonomy_version: typeof doc.taxonomy_version === "string" ? doc.taxonomy_version : undefined,
    summary: typeof doc.summary === "string" ? doc.summary : undefined,
    related_projects: Array.isArray(doc.related_projects)
      ? doc.related_projects.filter((value): value is string => typeof value === "string")
      : undefined,
    related_contacts: Array.isArray(doc.related_contacts)
      ? doc.related_contacts.filter((value): value is string => typeof value === "string")
      : undefined,
    vault_gap: doc.vault_gap === true,
    vault_gap_signal: typeof doc.vault_gap_signal === "string" ? doc.vault_gap_signal : undefined,
    urgency: typeof doc.urgency === "string" ? doc.urgency : undefined,
    needs_joel: doc.needs_joel === true,
    enriched_at: typeof doc.enriched_at === "number" ? doc.enriched_at : undefined,
  };
}

export const conversationThreadStaleSweep = inngest.createFunction(
  {
    id: "conversation-thread-stale-sweep",
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: "0 * * * *" },
  async ({ event, step }) => {
    const result = await step.run("mark-stale-threads", async () => {
      await typesense.ensureConversationThreadsCollection();
      const now = Date.now();
      let page = 1;
      let updated = 0;

      while (true) {
        const response = await typesense.search({
          collection: typesense.CONVERSATION_THREADS_COLLECTION,
          q: "*",
          query_by: "summary",
          filter_by: "status:=[active]",
          sort_by: "last_message_at:asc",
          per_page: 250,
          page,
        });

        const hits = Array.isArray(response.hits) ? response.hits : [];
        for (const hit of hits) {
          const thread = normalizeThread(hit.document);
          if (!thread.id || !Number.isFinite(thread.last_message_at)) continue;
          if (now - thread.last_message_at < STALE_AFTER_MS) continue;

          await typesense.upsert(typesense.CONVERSATION_THREADS_COLLECTION, {
            ...thread,
            status: "stale",
          } as unknown as Record<string, unknown>);
          updated += 1;
        }

        if (hits.length < 250) break;
        page += 1;
      }

      return { updated };
    });

    await step.run("emit-otel", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "conversation-thread-stale-sweep",
        action: "conversation.thread.stale_sweep.completed",
        success: true,
        metadata: {
          eventId: event.id,
          updated: result.updated,
        },
      });
    });

    return result;
  },
);
