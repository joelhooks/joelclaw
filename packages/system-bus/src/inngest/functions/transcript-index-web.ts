import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { inngest } from "../client";
import { chunkBySegments, chunkBySpeakerTurns } from "../../lib/transcript-chunk";
import * as typesense from "../../lib/typesense";
import { pushContentResource } from "../../lib/convex";

type SpeakerTurn = {
  speaker?: string;
  text: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function htmlToPlainText(html: string): string {
  const plain = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|li|section|article|h[1-6]|br|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );

  return plain
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .join("\n");
}

function isLikelySpeaker(value: string): boolean {
  if (!value || value.length > 60) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (/[.!?]/.test(value)) return false;

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  return words.every((word) => /^[A-Za-z0-9'&().-]+$/.test(word));
}

function extractSpeakerTurnsFromHtml(html: string): SpeakerTurn[] {
  const spans = Array.from(html.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi))
    .map((match) => normalizeWhitespace(decodeHtmlEntities(stripHtmlTags(match[1] ?? ""))))
    .filter(Boolean);

  const turns: SpeakerTurn[] = [];
  for (let index = 0; index < spans.length - 1; index++) {
    const maybeSpeaker = spans[index]!;
    const maybeText = spans[index + 1]!;

    if (!isLikelySpeaker(maybeSpeaker)) continue;
    if (!maybeText || isLikelySpeaker(maybeText)) continue;

    turns.push({ speaker: maybeSpeaker, text: maybeText });
    index += 1;
  }

  return turns;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 80) || "transcript";
}

function buildSourceId(url: string, title: string): string {
  let fallback = title;
  if (!fallback) {
    try {
      const parsed = new URL(url);
      fallback = parsed.pathname.split("/").filter(Boolean).pop() ?? "transcript";
    } catch {
      fallback = "transcript";
    }
  }
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
  return `${slugify(fallback)}-${hash}`;
}

export const transcriptIndexWeb = inngest.createFunction(
  {
    id: "transcript-index-web",
    name: "Transcript Index: Web",
    concurrency: { limit: 2 },
    retries: 2,
  },
  { event: "transcript/web.fetched" },
  async ({ event, step }) => {
    const { url, title, channel, sourceUrl, type } = event.data;
    const sourceId = buildSourceId(url, title);
    const canonicalSourceUrl = sourceUrl ?? url;
    const sourceDate = Math.floor(Date.now() / 1000);

    const htmlPath = await step.run("fetch-transcript-page", async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        throw new Error(`transcript web fetch failed (${response.status})`);
      }
      const html = await response.text();
      await mkdir("/tmp/transcript-web", { recursive: true });
      const outPath = `/tmp/transcript-web/${sourceId}.html`;
      await Bun.write(outPath, html);
      return outPath;
    });

    const indexed = await step.run("chunk-and-index", async () => {
      const html = await Bun.file(htmlPath).text();
      const turns = extractSpeakerTurnsFromHtml(html);

      const chunks =
        turns.length > 0
          ? chunkBySegments(
              turns.map((turn) => ({
                text: turn.text,
                ...(turn.speaker ? { speaker: turn.speaker } : {}),
              })),
              { maxTokens: 500, overlapSentences: 1 }
            )
          : chunkBySpeakerTurns(htmlToPlainText(html), {
              maxTokens: 500,
              overlapSentences: 1,
            });

      if (chunks.length === 0) {
        return { sourceId, chunks: 0, indexed: 0, errors: 0, convex: 0 };
      }

      await typesense.ensureTranscriptsCollection();

      type TranscriptDoc = {
        id: string;
        chunk_id: string;
        source_id: string;
        type: "video" | "meeting";
        title: string;
        text: string;
        source_date: number;
        speaker?: string;
        start_seconds?: number;
        end_seconds?: number;
        source_url?: string;
        channel?: string;
      };

      const docs: TranscriptDoc[] = chunks.map((chunk) => {
        const chunkId = `${sourceId}:${chunk.chunk_index}`;
        return {
          id: chunkId,
          chunk_id: chunkId,
          source_id: sourceId,
          type,
          title,
          ...(chunk.speaker ? { speaker: chunk.speaker } : {}),
          text: chunk.text,
          ...(chunk.start_seconds != null ? { start_seconds: chunk.start_seconds } : {}),
          ...(chunk.end_seconds != null ? { end_seconds: chunk.end_seconds } : {}),
          ...(canonicalSourceUrl ? { source_url: canonicalSourceUrl } : {}),
          ...(channel ? { channel } : {}),
          source_date: sourceDate,
        };
      });

      const result = await typesense.bulkImport(typesense.TRANSCRIPTS_COLLECTION, docs);

      let convex = 0;
      for (const doc of docs) {
        const searchText = [doc.title, doc.speaker ?? "", doc.text, doc.channel ?? ""]
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
            startSeconds: doc.start_seconds,
            endSeconds: doc.end_seconds,
            sourceUrl: doc.source_url,
            channel: doc.channel,
            sourceDate: doc.source_date,
          },
          searchText
        ).catch(() => {});

        convex++;
      }

      return {
        sourceId,
        chunks: docs.length,
        indexed: result.success,
        errors: result.errors,
        convex,
      };
    });

    await step.run("cleanup-transcript-page", async () => {
      await rm(htmlPath, { force: true }).catch(() => {});
      return { cleaned: true };
    });

    return {
      title,
      type,
      ...indexed,
    };
  }
);
