import { inngest } from "../client";
import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const VAULT = process.env.VAULT_PATH ?? `${process.env.HOME}/Vault`;

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
  { event: "pipeline/transcript.process" },
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
        throw new Error(
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

## Full Transcript

> [!note]- Transcript
>${formattedTranscript}
`;

      await Bun.write(notePath, note);
      return notePath;
    });

    // Step 3: Append to daily note
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

    // Step 4: Log + cleanup + emit
    await step.run("log-and-cleanup", async () => {
      await $`slog write --action transcribe --tool transcript-process --detail "${title} (${source})" --reason "transcript processing via inngest"`.quiet();

      // Cleanup tmp dir if we created one
      if (tmpDir) {
        await $`rm -rf ${tmpDir}`.quiet();
      }
    });

    // Step 5: Emit completion + trigger summarization
    await step.run("emit-events", async () => {
      await inngest.send([
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
          name: "content/summarize",
          data: { vaultPath },
        },
      ]);
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
