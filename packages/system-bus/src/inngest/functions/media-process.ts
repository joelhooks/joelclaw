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
import { execSync, spawnSync } from "node:child_process";
import { $ } from "bun";
import { parsePiJsonAssistant, traceLlmGeneration } from "../../lib/langfuse";
import Redis from "ioredis";

const MEDIA_TMP = "/tmp/joelclaw-media";
const NAS_HOST = "joel@three-body";
const NAS_MEDIA_BASE = "/volume1/home/joel/media";
const MEDIA_PROCESSED_KEY_PREFIX = "media:processed";
const MEDIA_PROCESSED_TTL_SECONDS = 24 * 60 * 60;

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

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

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
    const dedupeKey = `${MEDIA_PROCESSED_KEY_PREFIX}:${fileInfo.name}`;

    const alreadyProcessed = await step.run("check-dedup", async () => {
      const redis = getRedis();
      return !!(await redis.get(dedupeKey));
    });

    if (alreadyProcessed) {
      console.info(
        `[media] dedup skip: file already processed (${fileInfo.name}) source=${source} type=${type}`,
      );
      return {
        status: "already_processed",
        type,
        source,
        fileName: fileInfo.name,
      };
    }

    // NOTE: gateway.progress() MUST be inside a step — outside, it fires on every
    // step replay (once per step = 5x for a single image). See ADR-0043 gotcha.

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

    // Step 3: Archive to NAS for durability
    const archivePath = await step.run("archive-to-nas", async () => {
      try {
        const year = new Date().getFullYear();
        const destDir = `${NAS_MEDIA_BASE}/${year}/${source}`;
        const destFile = `${destDir}/${fileInfo.name}`;

        await $`ssh ${NAS_HOST} "mkdir -p ${destDir}"`.quiet();
        await $`scp "${localPath}" "${NAS_HOST}:${destFile}"`.quiet();

        return destFile;
      } catch (err: any) {
        // Archive failure is non-fatal — file still in /tmp
        console.error(`[media] NAS archive failed: ${err.message}`);
        return null;
      }
    });

    // Step 4: Format and notify the gateway
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
      if (archivePath) parts.push(`NAS: \`${archivePath}\``);

      await gateway.notify("media.processed", {
        message: parts.join("\n"),
        originSession,
      });

      // Voice commands from Telegram should be treated as direct user prompts,
      // not as passive media status updates.
      if (source === "telegram" && type === "audio" && transcript && originSession?.startsWith("telegram:")) {
        await gateway.notify("telegram.message.received", {
          originSession,
          prompt: transcript,
          transcript,
          source: "telegram.voice",
        });
      }
    });

    // Step 5: Emit processed event for downstream consumers
    await step.sendEvent("emit-processed", {
      name: "media/processed",
      data: {
        source,
        type,
        localPath,
        description,
        transcript,
        archivePath: archivePath ?? undefined,
        originSession,
      },
    });

    await step.run("mark-processed", async () => {
      const redis = getRedis();
      const payload = JSON.stringify({
        source,
        type,
        processedAt: new Date().toISOString(),
      });
      await redis.set(dedupeKey, payload, "EX", MEDIA_PROCESSED_TTL_SECONDS);
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
  // Use pi CLI with file ref — pi's read tool handles images natively.
  // No --no-tools here so pi can read the image file.
  const captionCtx = caption ? ` The sender included this caption: "${caption}".` : "";
  const systemPrompt = "You describe images sent to an AI assistant via messaging. Be thorough but concise. Transcribe any visible text accurately.";
  const userPrompt = `Read the file ${imagePath} and describe the image in detail.${captionCtx} Include what you see and any text visible in the image.`;

  const visionModel = "anthropic/claude-haiku";
  const startedAt = Date.now();

  try {
    const proc = spawnSync(
      "pi",
      [
        "--no-session",
        "--no-extensions",
        "--print",
        "--mode",
        "json",
        "--model",
        visionModel,
        "--system-prompt",
        systemPrompt,
        userPrompt,
      ],
      {
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, TERM: "dumb" },
      },
    );

    const stdoutRaw = (proc.stdout ?? "").trim();
    const parsedPi = parsePiJsonAssistant(stdoutRaw);
    const result = (parsedPi?.text ?? stdoutRaw).trim();
    const stderr = (proc.stderr ?? "").trim();

    if ((proc.status ?? 0) !== 0 && !result) {
      const error = `vision_failed_${proc.status ?? "unknown"}: ${stderr.slice(0, 120)}`;
      await traceLlmGeneration({
        traceName: "joelclaw.media-process",
        generationName: "media.image.describe",
        component: "media-process",
        action: "media.image.describe",
        input: {
          file: basename(imagePath),
          mimeType,
          caption: caption ?? null,
        },
        output: {
          stderr: stderr.slice(0, 300),
        },
        provider: parsedPi?.provider,
        model: parsedPi?.model ?? visionModel,
        usage: parsedPi?.usage,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw new Error(error);
    }

    await traceLlmGeneration({
      traceName: "joelclaw.media-process",
      generationName: "media.image.describe",
      component: "media-process",
      action: "media.image.describe",
      input: {
        file: basename(imagePath),
        mimeType,
        caption: caption ?? null,
      },
      output: {
        description: result.slice(0, 3000),
      },
      provider: parsedPi?.provider,
      model: parsedPi?.model ?? visionModel,
      usage: parsedPi?.usage,
      durationMs: Date.now() - startedAt,
    });

    return result || "Image received but vision description produced no output.";
  } catch (err: any) {
    await traceLlmGeneration({
      traceName: "joelclaw.media-process",
      generationName: "media.image.describe",
      component: "media-process",
      action: "media.image.describe",
      input: {
        file: basename(imagePath),
        mimeType,
        caption: caption ?? null,
      },
      output: {
        failed: true,
      },
      model: visionModel,
      durationMs: Date.now() - startedAt,
      error: err?.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200),
      metadata: {
        failed: true,
      },
    });

    const info = await stat(imagePath).catch(() => null);
    const size = info?.size ?? 0;
    return `Image received (${mimeType}, ${size} bytes). Vision description failed: ${err.message?.slice(0, 100)}`;
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
