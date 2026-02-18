/**
 * Media Processing Pipeline — ADR-0041
 *
 * Handles media received from connected channels (Telegram, etc.).
 * Phase 1: Image vision description via Claude API.
 *
 * Flow: media/received → classify → process → notify gateway → emit media/processed
 *
 * Uses claim-check pattern: localPath passed between steps, not base64 in events.
 */

import { inngest } from "../client";
import { readFile, stat, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { execSync } from "node:child_process";

const MEDIA_TMP = "/tmp/joelclaw-media";

// Supported image MIME types for vision
const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Supported audio MIME types for transcription
const AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-m4a",
  "audio/webm",
  "audio/opus",
]);

export const mediaProcess = inngest.createFunction(
  {
    id: "media-process",
    concurrency: { limit: 2 },
    retries: 3,
  },
  [{ event: "media/received" }],
  async ({ event, step, gateway }) => {
    const { source, type, localPath, mimeType, caption, originSession, fileName, fileSize } =
      event.data;

    // Step 1: Validate the file exists and is readable
    const fileInfo = await step.run("validate-file", async () => {
      const s = await stat(localPath);
      if (!s.isFile()) throw new Error(`Not a file: ${localPath}`);
      return {
        size: s.size,
        ext: extname(localPath).toLowerCase(),
        name: fileName ?? basename(localPath),
      };
    });

    gateway.progress(`Processing ${type} from ${source}: ${fileInfo.name} (${formatBytes(fileInfo.size)})`);

    // Step 2: Process based on type
    let description: string | undefined;
    let transcript: string | undefined;

    if (type === "image" && IMAGE_MIMES.has(mimeType)) {
      description = await step.run("vision-describe", async () => {
        return await describeImage(localPath, mimeType, caption);
      });
    } else if (type === "audio" && AUDIO_MIMES.has(mimeType)) {
      transcript = await step.run("transcribe-audio", async () => {
        return await transcribeAudio(localPath);
      });
    } else if (type === "video") {
      // Phase 3: extract audio track, transcribe, sample frames
      // For now, just note it was received
      description = `Video received: ${fileInfo.name} (${formatBytes(fileInfo.size)})`;
    } else if (type === "document") {
      // Phase 3: text extraction
      description = `Document received: ${fileInfo.name} (${formatBytes(fileInfo.size)})`;
    } else {
      description = `Media received but no processor for ${mimeType}: ${fileInfo.name}`;
    }

    // Step 3: Format and notify the gateway
    await step.run("notify-gateway", async () => {
      const emoji = type === "image" ? "🖼️" : type === "audio" ? "🎙️" : type === "video" ? "🎬" : "📎";
      const parts = [
        `## ${emoji} Media from ${source}`,
        "",
      ];

      if (description) parts.push(description, "");
      if (transcript) parts.push("**Transcript:**", transcript, "");
      if (caption) parts.push(`**Caption:** ${caption}`, "");
      parts.push(`File: \`${fileInfo.name}\` (${formatBytes(fileInfo.size)})`);
      parts.push(`Path: \`${localPath}\``);

      gateway.notify("media.processed", {
        message: parts.join("\n"),
        originSession,
      });
    });

    // Step 4: Emit processed event for downstream consumers
    await step.sendEvent("emit-processed", {
      name: "media/processed",
      data: {
        source,
        type,
        localPath,
        description,
        transcript,
        originSession,
      },
    });

    return {
      status: "processed",
      type,
      source,
      description: description?.slice(0, 200),
      hasTranscript: !!transcript,
    };
  },
);

// ── Image Vision ────────────────────────────────────────────────────

async function describeImage(
  imagePath: string,
  mimeType: string,
  caption?: string,
): Promise<string> {
  const buffer = await readFile(imagePath);
  const base64 = buffer.toString("base64");

  const prompt = caption
    ? `Describe this image in detail. The sender included this caption: "${caption}". Include what you see and any text visible in the image.`
    : "Describe this image in detail. Include what you see and any text visible in the image. If there's handwritten or printed text, transcribe it.";

  try {
    // Use Anthropic API directly for vision — ANTHROPIC_API_KEY from env or agent-secrets
    let apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      try {
        apiKey = execSync("secrets lease anthropic_api_key --ttl 1h --raw 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
      } catch {}
    }
    if (!apiKey) throw new Error("No ANTHROPIC_API_KEY available");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: "You describe images sent to an AI assistant via messaging. Be thorough but concise. Transcribe any visible text accurately. If it appears personal, still describe it factually — the recipient asked to see it.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64,
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const text = data.content?.[0]?.text;
    return text || "Image received but vision description produced no output.";
  } catch (err: any) {
    return `Image received (${mimeType}, ${buffer.length} bytes). Vision description failed: ${err.message?.slice(0, 100)}`;
  }
}

// ── Audio Transcription ─────────────────────────────────────────────

async function transcribeAudio(audioPath: string): Promise<string> {
  // Reuse mlx-whisper from the video pipeline
  const ext = extname(audioPath).toLowerCase();

  // Convert ogg (Telegram voice) to wav if needed
  let processPath = audioPath;
  if (ext === ".ogg" || ext === ".opus") {
    const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");
    execSync(`ffmpeg -i "${audioPath}" -ar 16000 -ac 1 "${wavPath}" -y`, {
      timeout: 30_000,
    });
    processPath = wavPath;
  }

  try {
    const result = execSync(
      `mlx_whisper --model mlx-community/whisper-large-v3-turbo "${processPath}" --output-format txt`,
      {
        encoding: "utf-8",
        timeout: 300_000, // 5 min for long audio
        maxBuffer: 10 * 1024 * 1024,
      },
    ).trim();

    return result || "Audio received but transcription produced no output.";
  } catch (err: any) {
    return `Audio received. Transcription failed: ${err.message?.slice(0, 100)}`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
