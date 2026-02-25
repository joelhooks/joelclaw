import { inngest } from "../client";
import { NonRetriableError } from "inngest";
import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pushGatewayEvent } from "./agent-loop/utils";
import { execSync } from "node:child_process";
import { infer } from "../../lib/inference";
import { pushContentResource } from "../../lib/convex";
import * as typesense from "../../lib/typesense";
import { chunkBySegments, chunkBySpeakerTurns } from "../../lib/transcript-chunk";

const VAULT = process.env.VAULT_PATH ?? `${process.env.HOME}/Vault`;
const INVALID_ANTHROPIC_KEY_ERROR =
  "secrets lease returned invalid value for anthropic_api_key";

// --- Screenshot naming: extract descriptive slugs from transcript context ---
const STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall","can",
  "to","of","in","for","on","with","at","by","from","as","into","through",
  "during","before","after","above","below","between","out","off","over","under",
  "again","further","then","once","here","there","when","where","why","how",
  "all","both","each","few","more","most","other","some","such","no","not",
  "only","own","same","so","than","too","very","just","because","but","and",
  "or","if","while","about","up","its","it","this","that","these","those",
  "i","me","my","we","our","you","your","he","him","his","she","her","they",
  "them","their","what","which","who","whom","am","like","going","get","got",
  "know","think","thing","things","really","actually","kind","right","well",
  "also","now","way","much","many","even","still","back","something",
  "dont","ive","thats","youre","lets","gonna","wanna","yeah","okay",
  "um","uh","sort","lot","bit","want","need","say","said","see","look",
  "come","take","make","go","use","try","put","basically","literally",
  "absolutely","definitely","probably","obviously","essentially","talking",
  "showing","looking","pretty","stuff","everything","nothing",
]);

function extractKeyPhrase(text: string, maxWords = 4): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  const seen = new Set<string>();
  const unique = words.filter((w) => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
  return unique.slice(0, maxWords).join("-").slice(0, 50) || "scene";
}

function fmtTs(seconds: number): string {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${m}:${s}`;
}

function resolveTranscriptType(source: string): "video" | "meeting" {
  if (source === "granola" || source === "meeting" || source === "fathom") {
    return "meeting";
  }
  return "video";
}

function resolveSourceDateSeconds(publishedDate: string | undefined): number {
  if (!publishedDate) return Math.floor(Date.now() / 1000);
  const parsed = Date.parse(publishedDate);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  return Math.floor(Date.now() / 1000);
}

function assertValidAnthropicKey(value: string | undefined): string {
  const key = (value ?? "").trim();
  if (!key || key.startsWith("{")) {
    throw new Error(INVALID_ANTHROPIC_KEY_ERROR);
  }
  return key;
}

function leaseAnthropicApiKey(): string {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) {
    return assertValidAnthropicKey(envKey);
  }

  try {
    const leased = execSync(
      "secrets lease anthropic_api_key --ttl 1h 2>/dev/null",
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    return assertValidAnthropicKey(leased);
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_ANTHROPIC_KEY_ERROR) {
      throw error;
    }
    throw new Error(INVALID_ANTHROPIC_KEY_ERROR);
  }
}

/**
 * Transcript Process — accepts audio files OR raw text from any source.
 *
 * Sources: youtube (via video-download), granola, fathom, podcast, manual
 *
 * If audioPath is provided → runs mlx-whisper
 * If text is provided → uses directly (no whisper needed)
 *
 * Creates vault note, updates daily note, emits transcript.processed + content/summarize
 */
export const transcriptProcess = inngest.createFunction(
  {
    id: "transcript-process",
    concurrency: { limit: 1 },
    retries: 2,
  },
  { event: "pipeline/transcript.requested" },
  async ({ event, step }) => {
    const {
      source,
      audioPath,
      text: rawText,
      title,
      slug,
      channel,
      publishedDate,
      duration,
      sourceUrl,
      nasPath,
      tmpDir,
    } = event.data;

    // Step 1: Get transcript — writes to file, returns path (avoids Inngest step output size limit)
    const transcriptPath = await step.run("transcribe", async () => {
      const outFile = `/tmp/transcript-process/${slug ?? "transcript"}-processed.json`;
      await $`mkdir -p /tmp/transcript-process`.quiet();

      if (rawText) {
        // Direct text input (Granola, Fathom, manual paste)
        await Bun.write(outFile, JSON.stringify({
          text: rawText,
          segments: [],
        }));
        return outFile;
      }

      if (!audioPath) {
        throw new NonRetriableError(
          "transcript.process requires either audioPath or text"
        );
      }

      // Run mlx-whisper on the audio/video file
      const outputDir = tmpDir ?? "/tmp/transcript-process";
      await $`mkdir -p ${outputDir}`.quiet();

      await $`mlx_whisper --model mlx-community/whisper-large-v3-turbo --output-format json --output-dir ${outputDir} ${audioPath}`.quiet();

      // Find transcript JSON (not info.json if present)
      const postFiles = await readdir(outputDir);
      const transcriptFile = postFiles.find(
        (f) => f.endsWith(".json") && !f.endsWith(".info.json")
      );
      if (!transcriptFile) throw new Error("No transcript JSON found");
      // mlx-whisper outputs NaN values (valid Python, invalid JSON) — sanitize
      const raw = await Bun.file(join(outputDir, transcriptFile)).text();
      const data = JSON.parse(raw.replace(/\bNaN\b/g, "null"));

      // Write cleaned transcript to a separate file — step returns only the path
      // (full transcript data can be >1MB, exceeds Inngest step output limit)
      await Bun.write(outFile, JSON.stringify({
        text: data.text as string,
        segments: (data.segments as Array<{ start: number; end: number; text: string }>)
          .map(({ start, end, text }) => ({ start, end, text })),
      }));

      return outFile;
    });

    // Step 1b: Extract key moment screenshots — named from transcript context
    const screenshots = await step.run("extract-screenshots", async () => {
      if (!audioPath) return [] as Array<{ name: string; timestamp: string }>;

      const transcript: {
        text: string;
        segments: Array<{ start: number; end: number; text: string }>;
      } = await Bun.file(transcriptPath).json();

      if (!transcript.segments.length)
        return [] as Array<{ name: string; timestamp: string }>;

      const screenshotDir = `/tmp/screenshots-${slug}`;
      await $`mkdir -p ${screenshotDir}`.quiet();

      const totalDur =
        transcript.segments[transcript.segments.length - 1]!.end;
      // ~1 screenshot per 2 minutes, min 4 max 10
      const count = Math.min(10, Math.max(4, Math.floor(totalDur / 120)));
      const interval = totalDur / (count + 1);
      const results: Array<{ name: string; timestamp: string }> = [];
      const usedNames = new Set<string>();

      for (let i = 1; i <= count; i++) {
        const ts = interval * i;

        // Grab transcript text ±30s around this timestamp
        const windowText = transcript.segments
          .filter((s) => s.start >= ts - 30 && s.start <= ts + 30)
          .map((s) => s.text)
          .join(" ");

        let baseName = extractKeyPhrase(windowText);
        let name = baseName;
        let n = 2;
        while (usedNames.has(name)) {
          name = `${baseName}-${n}`;
          n++;
        }
        usedNames.add(name);

        const filename = `${name}.jpg`;
        try {
          await $`ffmpeg -ss ${Math.floor(ts)} -i ${audioPath} -vframes 1 -vf scale=1280:-1 -q:v 2 ${join(screenshotDir, filename)}`.quiet();
          results.push({ name: filename, timestamp: fmtTs(ts) });
        } catch {}
      }

      // Copy to vault
      const vaultDir = join(
        process.env.HOME ?? "/Users/joel",
        "Vault/Resources/videos",
        slug
      );
      await $`mkdir -p ${vaultDir}`.quiet();
      for (const f of results) {
        await $`cp ${join(screenshotDir, f.name)} ${join(vaultDir, f.name)}`.quiet();
      }

      // Transfer to NAS alongside video
      if (nasPath) {
        try {
          await $`ssh joel@three-body "mkdir -p ${nasPath}/screenshots"`.quiet();
          await $`scp -r ${screenshotDir}/. joel@three-body:${nasPath}/screenshots/`.quiet();
        } catch {}
      }

      await $`rm -rf ${screenshotDir}`.quiet();
      return results;
    });

    // Step 1c: LLM vision review — describe, name, and filter screenshots
    const reviewedScreenshots = await step.run(
      "review-screenshots",
      async () => {
        type Reviewed = { name: string; altText: string; timestamp: string };
        if (screenshots.length === 0) return [] as Reviewed[];

        const apiKey = leaseAnthropicApiKey();

        // Read transcript for cross-reference
        const transcript: {
          text: string;
          segments: Array<{ start: number; end: number; text: string }>;
        } = await Bun.file(transcriptPath).json();

        const vaultDir = join(
          process.env.HOME ?? "/Users/joel",
          "Vault/Resources/videos",
          slug,
        );
        const fallback = screenshots.map((s) => ({
          name: s.name,
          altText: s.name.replace(".jpg", "").replace(/-/g, " "),
          timestamp: s.timestamp,
        }));

        const sceneLines = [
          `Review these ${screenshots.length} screenshots from "${title}". Return only JSON.`,
          "Return a JSON array with this exact schema:",
          '[{"index":0,"keep":true,"filename":"descriptive-name.jpg","altText":"what is visible in frame"}]',
          "Rules:",
          "- index maps to the screenshot number in this list.",
          "- KEEP: diagrams, code, demos, slides with text, terminal output, dashboards, meaningful visuals.",
          "- DISCARD (keep:false): speaker-only faces, blurry frames, transition slides, duplicates.",
          "- filename: lowercase-kebab-case, max 50 chars; describe what is visible.",
          "- altText: concise text visible in image and context.",
          "No markdown fences or explanation.",
          "",
          "Screenshots:",
        ];

        for (let idx = 0; idx < screenshots.length; idx++) {
          const shot = screenshots[idx]!;
          const [mins, secs] = shot.timestamp.split(":").map(Number);
          const ts = (mins ?? 0) * 60 + (secs ?? 0);
          const windowText = transcript.segments
            .filter((s) => s.start >= ts - 20 && s.start <= ts + 20)
            .map((s) => s.text)
            .join(" ")
            .trim();

          sceneLines.push(
            `- index ${idx}: ${join(vaultDir, shot.name)} (speaker says: "${windowText.slice(0, 300)}")`,
          );
        }

        const prompt = sceneLines.join("\n");

        const reviewModel = "anthropic/claude-sonnet-4-6";
        let result: Awaited<ReturnType<typeof infer>>;
        try {
          result = await infer(prompt, {
            task: "vision",
            model: reviewModel,
            print: true,
            system: "You are a careful screenshot reviewer for technical videos.",
            component: "transcript-process",
            action: "transcript.screenshot.review",
            timeout: 120_000,
            json: true,
            env: { ...process.env, TERM: "dumb", ANTHROPIC_API_KEY: apiKey },
            metadata: {
              slug,
              title,
              screenshotCount: screenshots.length,
            },
          });
        } catch (error) {
          console.error(
            "[transcript-process] screenshot review inference failed, using passthrough:",
            error instanceof Error ? error.message : String(error),
          );
          return fallback;
        }

        const rawReviews = result.data;
        if (!Array.isArray(rawReviews) || rawReviews.length === 0) {
          // Keep behavior conservative on model parse issues
          return fallback;
        }

        let reviews: Array<{
          index: number;
          keep: boolean;
          filename: string;
          altText: string;
        }> = rawReviews
          .map((raw) => {
            if (!raw || typeof raw !== "object") return null;
            const entry = raw as {
              index?: unknown;
              keep?: unknown;
              filename?: unknown;
              altText?: unknown;
            };
            if (typeof entry.index !== "number" || typeof entry.keep !== "boolean") return null;
            if (typeof entry.filename !== "string" || typeof entry.altText !== "string") return null;
            return {
              index: entry.index,
              keep: entry.keep,
              filename: entry.filename,
              altText: entry.altText,
            };
          })
          .filter(
            (
              value: {
                index: number;
                keep: boolean;
                filename: string;
                altText: string;
              } | null,
            ): value is {
              index: number;
              keep: boolean;
              filename: string;
              altText: string;
            } => value !== null && value.index >= 0 && value.index < screenshots.length
          );

        if (reviews.length === 0) {
          return fallback;
        }

        // Rename kept files, discard the rest
        const approved: Reviewed[] = [];
        const usedNames = new Set<string>();

        for (const review of reviews) {
          if (!review.keep || review.index >= screenshots.length) continue;
          const shot = screenshots[review.index]!;

          // Sanitize and deduplicate filename
          let cleaned = review.filename
            .toLowerCase()
            .replace(/[^a-z0-9-\.]/g, "")
            .slice(0, 54);
          if (!cleaned.endsWith(".jpg")) cleaned = cleaned.replace(/\.jpg$/, "") + ".jpg";
          let baseName = cleaned.replace(".jpg", "");
          let finalName = cleaned;
          let n = 2;
          while (usedNames.has(finalName)) {
            finalName = `${baseName}-${n}.jpg`;
            n++;
          }
          usedNames.add(finalName);

          // Rename in vault
          try {
            await $`mv ${join(vaultDir, shot.name)} ${join(vaultDir, finalName)}`.quiet();
          } catch {}

          // Rename on NAS
          if (nasPath) {
            try {
              await $`ssh joel@three-body "mv '${nasPath}/screenshots/${shot.name}' '${nasPath}/screenshots/${finalName}'"`.quiet();
            } catch {}
          }

          approved.push({
            name: finalName,
            altText: review.altText,
            timestamp: shot.timestamp,
          });
        }

        if (approved.length === 0) {
          return fallback;
        }

        // Clean up discarded screenshots from vault + NAS
        for (const shot of screenshots) {
          if (!approved.some((r) => r.timestamp === shot.timestamp)) {
            try {
              await $`rm -f ${join(vaultDir, shot.name)}`.quiet();
            } catch {}
            if (nasPath) {
              try {
                await $`ssh joel@three-body "rm -f '${nasPath}/screenshots/${shot.name}'"`.quiet();
              } catch {}
            }
          }
        }

        return approved;
      },
    );

    // Step 2: Create Vault note — reads transcript from file
    const vaultPath = await step.run("create-vault-note", async () => {
      const notePath = `${VAULT}/Resources/videos/${slug}.md`;

      // Read transcript from file (kept off step state to avoid Inngest size limit)
      const transcript: { text: string; segments: Array<{ start: number; end: number; text: string }> } =
        await Bun.file(transcriptPath).json();

      // Format transcript — with timestamps if segments available
      let formattedTranscript = "";
      if (transcript.segments.length > 0) {
        let lastTimestamp = -120;
        for (const seg of transcript.segments) {
          if (seg.start - lastTimestamp >= 120) {
            const mins = Math.floor(seg.start / 60);
            const secs = Math.floor(seg.start % 60);
            formattedTranscript += `\n>\n> **[${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}]**`;
            lastTimestamp = seg.start;
          }
          formattedTranscript += seg.text;
        }
      } else {
        // Raw text — no timestamps
        formattedTranscript = `\n> ${transcript.text}`;
      }

      // Build frontmatter dynamically based on available metadata
      const fm: Record<string, string> = {
        type: source === "youtube" || source === "podcast" ? "video" : "transcript",
      };
      const tags = [fm.type, source];
      if (sourceUrl) fm.source = sourceUrl;
      if (channel) fm.channel = channel;
      if (publishedDate) fm.published = publishedDate;
      if (duration) fm.duration = `"${duration}"`;
      if (nasPath) fm.nas_path = nasPath;
      fm.transcribed = new Date().toISOString().split("T")[0] ?? new Date().toISOString();

      const frontmatter = Object.entries(fm)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      const tagLines = tags.map((t) => `  - ${t}`).join("\n");

      // Build info callout
      const infoParts: string[] = [];
      if (channel) infoParts.push(`**Channel**: ${channel}`);
      if (publishedDate) infoParts.push(`**Published**: ${publishedDate}`);
      if (duration) infoParts.push(`**Duration**: ${duration}`);
      const infoLine = infoParts.length > 0 ? infoParts.join(" · ") : "";
      const urlLine = sourceUrl ? `\n> **URL**: ${sourceUrl}` : "";

      // List reviewed screenshots as assets for the summarizer to place inline
      const screenshotSection =
        reviewedScreenshots.length > 0
          ? `\n## Screenshots (place inline during enrichment)\n\n${reviewedScreenshots
              .map((f) => {
                const safeAlt = f.altText.replace(/"/g, "'").replace(/\n/g, " ").slice(0, 200);
                return `![${safeAlt}](${slug}/${f.name}) <!-- ${f.timestamp} -->`;
              })
              .join("\n\n")}\n`
          : "";

      const note = `---
${frontmatter}
tags:
${tagLines}
---

# ${title}
${infoLine || urlLine ? `
> [!info] Source
> ${infoLine}${urlLine}
` : ""}
## Executive Summary

<!-- TODO: enrichment via content/summarize -->
${screenshotSection}
## Full Transcript

> [!note]- Transcript
>${formattedTranscript}
`;

      await Bun.write(notePath, note);
      return notePath;
    });

    // Step 3: Index transcript chunks in Typesense + Convex
    await step.run("index-transcript-chunks", async () => {
      try {
        const transcript: {
          text: string;
          segments: Array<{ start: number; end: number; text: string; speaker?: string }>;
        } = await Bun.file(transcriptPath).json();

        const chunks =
          transcript.segments.length > 0
            ? chunkBySegments(transcript.segments, {
                maxTokens: 500,
                overlapSentences: 1,
              })
            : chunkBySpeakerTurns(transcript.text ?? "", {
                maxTokens: 500,
                overlapSentences: 1,
              });

        if (chunks.length === 0) {
          return { indexed: 0, errors: 0, convex: 0, sourceId: slug };
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

        const sourceType = resolveTranscriptType(source);
        const sourceDate = resolveSourceDateSeconds(publishedDate);
        const docs: TranscriptDoc[] = chunks.map((chunk) => {
          const chunkId = `${slug}:${chunk.chunk_index}`;
          return {
            id: chunkId,
            chunk_id: chunkId,
            source_id: slug,
            type: sourceType,
            title,
            ...(chunk.speaker ? { speaker: chunk.speaker } : {}),
            text: chunk.text,
            ...(chunk.start_seconds != null
              ? { start_seconds: chunk.start_seconds }
              : {}),
            ...(chunk.end_seconds != null ? { end_seconds: chunk.end_seconds } : {}),
            ...(sourceUrl ? { source_url: sourceUrl } : {}),
            ...(channel ? { channel } : {}),
            source_date: sourceDate,
          };
        });

        const result = await typesense.bulkImport(typesense.TRANSCRIPTS_COLLECTION, docs);

        let convex = 0;
        for (const doc of docs) {
          const searchText = [
            doc.title,
            doc.speaker ?? "",
            doc.text,
            doc.channel ?? "",
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
              startSeconds: doc.start_seconds,
              endSeconds: doc.end_seconds,
              sourceUrl: doc.source_url,
              channel: doc.channel,
              sourceDate: doc.source_date,
              vaultPath,
            },
            searchText
          ).catch(() => {});
          convex++;
        }

        return {
          indexed: result.success,
          errors: result.errors,
          convex,
          sourceId: slug,
        };
      } catch (error) {
        console.warn("[transcript-process] transcript chunk indexing failed:", error);
        return { indexed: 0, errors: 1, convex: 0, sourceId: slug };
      }
    });

    // Step 4: Append to daily note
    await step.run("update-daily-note", async () => {
      const today = new Date().toISOString().split("T")[0];
      const dailyPath = `${VAULT}/Daily/${today}.md`;

      const file = Bun.file(dailyPath);
      let content: string;

      if (await file.exists()) {
        content = await file.text();
        if (!content.includes("## Videos")) {
          content += `\n## Videos\n`;
        }
      } else {
        content = `---
type: daily
date: ${today}
---

# ${today}

## Videos
`;
      }

      const sourceLabel = channel ? `${channel}` : source;
      const durationLabel = duration ? ` · ${duration}` : "";
      content += `\n- [[${slug}]] — ${title} by ${sourceLabel}${durationLabel}`;
      await Bun.write(dailyPath, content);
    });

    // Step 5: Log + cleanup + emit
    await step.run("log-and-cleanup", async () => {
      await $`slog write --action transcribe --tool transcript-process --detail "${title} (${source})" --reason "transcript processing via inngest"`.quiet();

      // Cleanup tmp dir if we created one
      if (tmpDir) {
        await $`rm -rf ${tmpDir}`.quiet();
      }
    });

    // Step 6: Emit completion + trigger summarization
    await step.sendEvent("emit-events", [
      {
        name: "pipeline/transcript.processed",
        data: {
          vaultPath,
          title,
          slug,
          source,
        },
      },
      {
        name: "content/summarize.requested",
        data: { vaultPath },
      },
    ]);

    await step.run("push-gateway-event", async () => {
      try {
        await pushGatewayEvent({
          type: "media.transcribed",
          source: "inngest",
          payload: {
            title,
            vaultPath,
          },
        });
      } catch {}
    });

    return {
      vaultPath,
      title,
      slug,
      source,
      status: "processed",
    };
  }
);
