import { cacheGet } from "../../lib/cache";
import { pushContentResource } from "../../lib/convex";
import { chunkBySpeakerTurns } from "../../lib/transcript-chunk";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const MEETING_TRANSCRIPT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

type TranscriptDoc = {
  id: string;
  chunk_id: string;
  source_id: string;
  type: "video" | "meeting";
  title: string;
  text: string;
  source_date: number;
  speaker?: string;
  source_url?: string;
  channel?: string;
};

type MeetingTranscriptIndexResult = {
  meetingId?: string;
  sourceId?: string;
  chunks?: number;
  indexed: number;
  errors?: number;
  convex?: number;
  skipped?: boolean;
  reason?: "missing_meeting_metadata" | "missing_transcript" | "empty_chunks";
};

function resolveSourceDateSeconds(value: string | undefined): number {
  if (!value) return Math.floor(Date.now() / 1000);
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  return Math.floor(Date.now() / 1000);
}

async function resolveTranscript(
  meetingId: string,
  transcriptFromEvent?: string
): Promise<string | null> {
  const direct =
    typeof transcriptFromEvent === "string" ? transcriptFromEvent.trim() : "";
  if (direct.length > 0) return direct;

  const cached = await cacheGet<string>(`meeting:${meetingId}:transcript`, {
    namespace: "granola",
    tier: "warm",
    hotTtlSeconds: 1800,
    warmTtlSeconds: MEETING_TRANSCRIPT_CACHE_TTL_SECONDS,
  });

  if (typeof cached === "string") {
    const trimmed = cached.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return null;
}

export const meetingTranscriptIndex = inngest.createFunction(
  {
    id: "meeting-transcript-index",
    name: "Meeting Transcript Index",
    idempotency: "event.data.meetingId",
    concurrency: { key: "event.data.meetingId", limit: 1 },
    throttle: { limit: 8, period: "1m" },
    retries: 2,
  },
  { event: "meeting/transcript.fetched" },
  async ({ event, step }) => {
    const {
      meetingId,
      title,
      date,
      sourceUrl,
      transcript: transcriptFromEvent,
    } = event.data;
    const rawParticipants = event.data.participants as unknown;
    const participants: string[] = Array.isArray(rawParticipants)
      ? rawParticipants.filter(
          (value: unknown): value is string => typeof value === "string"
        )
      : [];

    let result: MeetingTranscriptIndexResult;

    if (!meetingId || !title) {
      result = { indexed: 0, skipped: true, reason: "missing_meeting_metadata" };
    } else {
      const transcript = await step.run("resolve-transcript", async () =>
        resolveTranscript(meetingId, transcriptFromEvent)
      );

      if (!transcript) {
        result = { indexed: 0, skipped: true, reason: "missing_transcript" };
      } else {
        const chunks = chunkBySpeakerTurns(transcript, {
          maxTokens: 350,
          minMergeTokens: 80,
          overlapSentences: 1,
        });

        if (chunks.length === 0) {
          result = { indexed: 0, skipped: true, reason: "empty_chunks" };
        } else {
          const sourceId = `meeting-${meetingId}`;
          const sourceDate = resolveSourceDateSeconds(date);
          const docs: TranscriptDoc[] = chunks.map((chunk) => {
            const chunkId = `${sourceId}:${chunk.chunk_index}`;
            return {
              id: chunkId,
              chunk_id: chunkId,
              source_id: sourceId,
              type: "meeting",
              title,
              ...(chunk.speaker ? { speaker: chunk.speaker } : {}),
              text: chunk.text,
              ...(sourceUrl ? { source_url: sourceUrl } : {}),
              channel: "granola",
              source_date: sourceDate,
            };
          });

          const typesenseResult = await step.run("index-typesense", async () => {
            await typesense.ensureTranscriptsCollection();
            return typesense.bulkImport(typesense.TRANSCRIPTS_COLLECTION, docs);
          });

          const convex = await step.run("index-convex", async () => {
            let count = 0;
            for (const doc of docs) {
              const searchText = [
                doc.title,
                doc.speaker ?? "",
                doc.text,
                ...participants,
              ]
                .filter(Boolean)
                .join(" ");

              await pushContentResource(
                `transcript:${doc.chunk_id}`,
                "transcript_chunk",
                {
                  chunkId: doc.chunk_id,
                  sourceId: doc.source_id,
                  type: doc.type,
                  title: doc.title,
                  speaker: doc.speaker,
                  text: doc.text,
                  sourceUrl: doc.source_url,
                  channel: doc.channel,
                  sourceDate: doc.source_date,
                  meetingId,
                  participants,
                },
                searchText
              ).catch(() => {});

              count += 1;
            }

            return count;
          });

          result = {
            meetingId,
            sourceId,
            chunks: docs.length,
            indexed: typesenseResult.success,
            errors: typesenseResult.errors,
            convex,
          };
        }
      }
    }

    const skipped = result.skipped === true;
    const errors = result.errors ?? 0;
    const success = skipped ? true : errors === 0;
    const otel = await emitOtelEvent({
      level: skipped ? "info" : success ? "info" : "warn",
      source: "worker",
      component: "meeting-transcript-index",
      action: skipped ? "meeting.transcript.skipped" : "meeting.transcript.indexed",
      success,
      ...(success ? {} : { error: "typesense_bulk_import_errors" }),
      metadata: {
        meetingId: meetingId || null,
        sourceId: result.sourceId || null,
        chunks: result.chunks ?? 0,
        indexed: result.indexed,
        errors,
        convex: result.convex ?? 0,
        skipped,
        reason: result.reason ?? null,
        source: event.data.source ?? "unknown",
        participantsCount: participants.length,
      },
    });

    return result;
  }
);
