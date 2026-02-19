import { inngest } from "../client";
import { NonRetriableError } from "inngest";
import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pushGatewayEvent } from "./agent-loop/utils";

const VAULT = process.env.VAULT_PATH ?? `${process.env.HOME}/Vault`;

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

      // Build key moment screenshots section
      const screenshotSection =
        screenshots.length > 0
          ? `\n## Key Moments\n\n${screenshots
              .map((f) => {
                const alt = f.name.replace(".jpg", "").replace(/-/g, " ");
                return `![${alt}](${slug}/${f.name})\n*${f.timestamp}*`;
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
