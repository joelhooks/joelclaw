/**
 * ADR-0067: Pattern adapted from memory-curator by 77darius77 (openclaw/skills, MIT).
 *
 * Generate a structured daily digest from the raw memory log.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { traceLlmGeneration, type LlmUsage } from "../../lib/langfuse";
import { inngest } from "../client";
import { DIGEST_SYSTEM_PROMPT, DIGEST_USER_PROMPT } from "./daily-digest-prompt";

const DIGEST_MODEL = "claude-3-5-sonnet-latest";

function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || "/Users/joel";
}

function losAngelesIsoDate(now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function inferProviderFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const normalized = model.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("gpt") || normalized.includes("openai")) return "openai";
  if (normalized.includes("gemini") || normalized.includes("google")) return "google";
  return undefined;
}

function extractUsageFromAiResponse(response: unknown): LlmUsage | undefined {
  const value = response as
    | {
        usage?: {
          input_tokens?: number | string;
          output_tokens?: number | string;
          total_tokens?: number | string;
          cache_read_input_tokens?: number | string;
          cache_creation_input_tokens?: number | string;
          prompt_tokens?: number | string;
          completion_tokens?: number | string;
          totalTokens?: number | string;
          cacheRead?: number | string;
          cacheWrite?: number | string;
        };
      }
    | undefined;

  const usage = value?.usage;
  if (!usage) return undefined;

  const inputTokens = toFiniteNumber(usage.input_tokens) ?? toFiniteNumber(usage.prompt_tokens);
  const outputTokens = toFiniteNumber(usage.output_tokens) ?? toFiniteNumber(usage.completion_tokens);
  const totalTokens = toFiniteNumber(usage.total_tokens) ?? toFiniteNumber(usage.totalTokens);
  const cacheReadTokens = toFiniteNumber(usage.cache_read_input_tokens) ?? toFiniteNumber(usage.cacheRead);
  const cacheWriteTokens = toFiniteNumber(usage.cache_creation_input_tokens) ?? toFiniteNumber(usage.cacheWrite);

  if (
    inputTokens == null
    && outputTokens == null
    && totalTokens == null
    && cacheReadTokens == null
    && cacheWriteTokens == null
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function extractModelFromAiResponse(response: unknown): string | undefined {
  const value = response as { model?: string; model_name?: string } | undefined;
  const model = (value?.model ?? value?.model_name)?.trim();
  return model && model.length > 0 ? model : undefined;
}

function extractTextFromAiResponse(response: unknown): string {
  const value = response as
    | {
        content?: Array<{ type?: string; text?: string }>;
        output_text?: string;
      }
    | undefined;

  const outputText = value?.output_text?.trim();
  if (outputText) return outputText;

  const contentText = value?.content
    ?.map((item) => (item?.type === "text" ? (item.text ?? "").trim() : ""))
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();

  return contentText ?? "";
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function buildDigestFileContent(date: string, sourcePath: string, digestBody: string): string {
  return [
    "---",
    "type: digest",
    `date: ${date}`,
    `source: ${sourcePath}`,
    "---",
    "",
    stripMarkdownFences(digestBody),
    "",
  ].join("\n");
}

export const dailyDigest = inngest.createFunction(
  {
    id: "memory/digest-daily",
    name: "Generate Daily Digest",
    retries: 1,
    concurrency: { limit: 1 },
  },
  [{ cron: "55 7 * * *" }, { event: "memory/digest.requested" }],
  async ({ step }) => {
    const date = losAngelesIsoDate();
    const home = getHomeDirectory();
    const sourcePath = join(home, ".joelclaw", "workspace", "memory", `${date}.md`);
    const sourceFrontmatterPath = `~/.joelclaw/workspace/memory/${date}.md`;
    const digestPath = join(home, "Vault", "Daily", "digests", `${date}-digest.md`);

    const alreadyExists = await step.run("check-digest-exists", async () => existsSync(digestPath));
    if (alreadyExists) {
      return { status: "noop", reason: "digest already exists", date, digestPath };
    }

    const rawLog = await step.run("read-daily-log", async () => {
      const file = Bun.file(sourcePath);
      if (!(await file.exists())) return "";
      return (await file.text()).trim();
    });

    if (!rawLog) {
      return { status: "noop", reason: "daily log missing or empty", date, sourcePath };
    }

    const digestPrompt = DIGEST_USER_PROMPT(date, rawLog);
    const digestStartedAt = Date.now();

    let digestBody: unknown;

    try {
      digestBody = await step.ai.infer("generate-digest-with-claude", {
        model: step.ai.models.anthropic({
          model: DIGEST_MODEL,
          defaultParameters: { max_tokens: 2200 },
        }),
        body: {
          max_tokens: 2200,
          system: DIGEST_SYSTEM_PROMPT,
          messages: [{ role: "user", content: digestPrompt }],
        },
      });
    } catch (error) {
      await traceLlmGeneration({
        traceName: "joelclaw.daily-digest",
        generationName: "memory.daily-digest",
        component: "daily-digest",
        action: "memory.digest.generate",
        input: {
          date,
          prompt: digestPrompt.slice(0, 6000),
        },
        output: {
          failed: true,
        },
        provider: "anthropic",
        model: DIGEST_MODEL,
        durationMs: Date.now() - digestStartedAt,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        metadata: {
          date,
          failed: true,
        },
      });
      throw error;
    }

    const digestText = await step.run("normalize-digest-text", async () => {
      const text = stripMarkdownFences(extractTextFromAiResponse(digestBody));
      if (!text) throw new Error("Digest generation returned empty output");
      return text;
    });

    const responseModel = extractModelFromAiResponse(digestBody) ?? DIGEST_MODEL;
    const responseUsage = extractUsageFromAiResponse(digestBody);

    await step.run("trace-digest-llm", async () => {
      await traceLlmGeneration({
        traceName: "joelclaw.daily-digest",
        generationName: "memory.daily-digest",
        component: "daily-digest",
        action: "memory.digest.generate",
        input: {
          date,
          prompt: digestPrompt.slice(0, 6000),
        },
        output: {
          digest: digestText.slice(0, 6000),
        },
        provider: inferProviderFromModel(responseModel),
        model: responseModel,
        usage: responseUsage,
        durationMs: Date.now() - digestStartedAt,
        metadata: {
          date,
        },
      });
    });

    await step.run("write-digest-file", async () => {
      mkdirSync(dirname(digestPath), { recursive: true });
      const content = buildDigestFileContent(date, sourceFrontmatterPath, digestText);
      await Bun.write(digestPath, content);
    });

    await step.sendEvent("emit-digest-created", {
      name: "memory/digest.created",
      data: {
        date,
        sourcePath,
        digestPath,
      },
    });

    return { status: "created", date, sourcePath, digestPath };
  }
);
