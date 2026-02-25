import { inngest } from "../client";
import Redis from "ioredis";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// TodoistTaskAdapter removed — task creation moved to proposal-triage.ts (ADR-0068)
import {
  COMPRESSION_GUIDANCE,
  REFLECTOR_SYSTEM_PROMPT,
  REFLECTOR_USER_PROMPT,
  validateCompression,
} from "./reflect-prompt";
import { sanitizeObservationText } from "./observation-sanitize";
import { parsePiJsonAssistant, traceLlmGeneration, type LlmUsage } from "../../lib/langfuse";
import { emitOtelEvent } from "../../observability/emit";

type ObservationRecord = {
  summary?: unknown;
  metadata?: {
    session_id?: unknown;
    captured_at?: unknown;
  };
};

type ReflectRunResult = {
  raw: string;
  inputTokens: number;
  outputTokens: number;
  provider?: string;
  model?: string;
  usage?: LlmUsage;
  durationMs?: number;
};

type ParsedProposal = {
  section: string;
  change: string;
};

type StagedProposal = ParsedProposal & {
  id: string;
};

let redisClient: Redis | null = null;

const MAX_STEP_OBSERVATIONS_CHARS = Number.parseInt(
  process.env.REFLECT_MAX_OBSERVATIONS_CHARS ?? "120000",
  10
);
const MAX_STEP_MEMORY_CHARS = Number.parseInt(
  process.env.REFLECT_MAX_MEMORY_CHARS ?? "80000",
  10
);
const MAX_RESULT_RAW_CHARS = Number.parseInt(
  process.env.REFLECT_MAX_RESULT_RAW_CHARS ?? "6000",
  10
);

function truncateForStepOutput(text: string, maxChars: number): { value: string; truncated: boolean } {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { value: text, truncated: false };
  }

  // Keep tail to preserve most recent context in accumulated observations.
  return {
    value: text.slice(-maxChars),
    truncated: true,
  };
}

function getRedisClient(): Redis {
  if (!redisClient) {
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
    redisClient = new Redis({
      host: "localhost",
      port: 6379,
      lazyConnect: true,
      retryStrategy: isTestEnv ? () => null : undefined,
    });
    if (typeof redisClient.on === "function") redisClient.on("error", () => {});
  }
  return redisClient;
}

function readShellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
}

function shouldSkipExternalEventSends(): boolean {
  return process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/u).length;
}

function parseDate(date: string | undefined): Date {
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toCompactDate(date: string): string {
  return date.replaceAll("-", "");
}

function getRecentDates(anchorDate: string | undefined, days: number): string[] {
  const anchor = parseDate(anchorDate);
  const dates: string[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const current = new Date(anchor);
    current.setUTCDate(anchor.getUTCDate() - offset);
    dates.push(toISODate(current));
  }

  return dates;
}

function parseObservation(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as ObservationRecord;
    if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) {
      return sanitizeObservationText(parsed.summary);
    }
  } catch {
    // Skip malformed entries.
  }
  return null;
}

function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || "/Users/joel";
}

function getWorkspaceRoot(): string {
  return join(getHomeDirectory(), ".joelclaw", "workspace");
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function extractXmlTag(content: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(content);
  if (!match?.[1]) return null;
  return decodeXmlText(match[1]).trim();
}

function parseProposals(rawXml: string): ParsedProposal[] {
  const proposalMatches = rawXml.matchAll(/<proposal>([\s\S]*?)<\/proposal>/gi);
  const proposals: ParsedProposal[] = [];

  for (const match of proposalMatches) {
    const body = match[1] ?? "";
    // Accept both <section> and <target> — LLMs vary
    const section = extractXmlTag(body, "section") ?? extractXmlTag(body, "target");
    const changeTag = extractXmlTag(body, "change");

    // Stage only structured proposals to avoid false positives from malformed output.
    if (section && changeTag && section.length > 0 && changeTag.length > 0) {
      proposals.push({ section, change: changeTag });
    }
  }

  return proposals;
}

function formatProposalId(date: string, sequence: number): string {
  return `p-${toCompactDate(date)}-${String(sequence).padStart(3, "0")}`;
}

async function getNextProposalSequence(redis: Redis, date: string): Promise<number> {
  const compactDate = toCompactDate(date);
  const pending = await redis.lrange("memory:review:pending", 0, -1);
  let maxForDate = 0;

  for (const id of pending) {
    const match = /^p-(\d{8})-(\d{3,})$/.exec(id);
    if (!match) continue;
    if (match[1] !== compactDate) continue;
    const n = Number.parseInt(match[2] ?? "0", 10);
    if (!Number.isNaN(n) && n > maxForDate) {
      maxForDate = n;
    }
  }

  return maxForDate + 1;
}

function groupBySection(proposals: StagedProposal[]): Map<string, StagedProposal[]> {
  const grouped = new Map<string, StagedProposal[]>();
  for (const proposal of proposals) {
    const existing = grouped.get(proposal.section);
    if (existing) {
      existing.push(proposal);
    } else {
      grouped.set(proposal.section, [proposal]);
    }
  }
  return grouped;
}

function truncateForTaskContent(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function summarizeChangeForTask(change: string): string {
  const normalized = change.replace(/\s+/gu, " ").trim();
  const withoutDatePrefix = normalized.replace(/^-\s*\(\d{4}-\d{2}-\d{2}\)\s*/u, "");
  const firstSentence = withoutDatePrefix.split(/[.!?](?:\s|$)/u)[0] ?? withoutDatePrefix;
  return truncateForTaskContent(firstSentence.trim(), 90);
}

function appendToFile(path: string, content: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const prefix = existsSync(path) ? "\n\n" : "";
    appendFileSync(path, `${prefix}${content}`, "utf8");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readMemoryContent(): Promise<string> {
  const memoryPath = join(getWorkspaceRoot(), "MEMORY.md");
  const memoryFile = Bun.file(memoryPath);
  if (!(await memoryFile.exists())) {
    return "";
  }
  return memoryFile.text();
}

async function withPromptFile<T>(
  content: string,
  run: (promptFileArg: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "reflect-prompt-"));
  const promptPath = join(dir, "prompt.md");
  await writeFile(promptPath, content, "utf8");

  try {
    return await run(`@${promptPath}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runReflectorLLM(
  observations: string,
  memoryContent: string,
  retryLevel: number
): Promise<ReflectRunResult> {
  const guidance = COMPRESSION_GUIDANCE[retryLevel] ?? "";
  const systemPrompt = guidance
    ? `${REFLECTOR_SYSTEM_PROMPT}\n\n${guidance}`
    : REFLECTOR_SYSTEM_PROMPT;
  const userPrompt = REFLECTOR_USER_PROMPT(observations, memoryContent);
  const reflectorModel = "anthropic/claude-haiku";
  const startedAt = Date.now();

  const result = await withPromptFile(userPrompt, (promptFileArg) =>
    Bun.$`pi --no-tools --no-session --no-extensions --print --mode json --model ${reflectorModel} --system-prompt ${systemPrompt} ${promptFileArg}`
      .env({
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:${process.env.HOME}/.local/share/fnm/aliases/default/bin:${process.env.PATH}`,
      })
      .quiet()
      .nothrow()
  );

  const stdoutRaw = readShellText(result.stdout);
  const parsedPi = parsePiJsonAssistant(stdoutRaw);
  const stdout = parsedPi?.text ?? stdoutRaw;
  const stderr = readShellText(result.stderr);

  if (result.exitCode !== 0) {
    const error = `Reflector subprocess failed with exit code ${result.exitCode}${
      stderr ? `: ${stderr}` : ""
    }`;

    await traceLlmGeneration({
      traceName: "joelclaw.reflect",
      generationName: "memory.reflect",
      component: "reflect",
      action: "reflect.llm.summarize",
      input: {
        retryLevel,
        prompt: userPrompt.slice(0, 6000),
      },
      output: {
        stderr: stderr.slice(0, 500),
      },
      provider: parsedPi?.provider,
      model: parsedPi?.model ?? reflectorModel,
      usage: parsedPi?.usage,
      durationMs: Date.now() - startedAt,
      error,
      metadata: {
        retryLevel,
      },
    });

    throw new Error(error);
  }

  const inputTokens = estimateTokens(`${systemPrompt}\n\n${userPrompt}`);
  const outputTokens = estimateTokens(stdout);

  await traceLlmGeneration({
    traceName: "joelclaw.reflect",
    generationName: "memory.reflect",
    component: "reflect",
    action: "reflect.llm.summarize",
    input: {
      retryLevel,
      prompt: userPrompt.slice(0, 6000),
    },
    output: {
      reflectorXml: stdout.slice(0, 6000),
      inputTokens,
      outputTokens,
    },
    provider: parsedPi?.provider,
    model: parsedPi?.model ?? reflectorModel,
    usage: parsedPi?.usage,
    durationMs: Date.now() - startedAt,
    metadata: {
      retryLevel,
    },
  });

  return {
    raw: stdout,
    inputTokens,
    outputTokens,
    provider: parsedPi?.provider,
    model: parsedPi?.model ?? reflectorModel,
    usage: parsedPi?.usage,
    durationMs: Date.now() - startedAt,
  };
}

export const reflect = inngest.createFunction(
  {
    id: "memory/reflect",
    name: "Reflect Observations",
  },
  [{ event: "memory/observations.accumulated" }, { cron: "0 6 * * *" }],
  async ({ event, step }) => {
    const startedAt = Date.now();
    const eventId = (event as { id?: string }).id ?? null;
    let anchorDate: string | null = null;
    let observationCount = 0;
    let proposalCount = 0;
    let retryLevel = 0;

    await step.run("otel-reflect-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "reflect",
        action: "reflect.started",
        success: true,
        metadata: {
          eventId,
        },
      });
    });

    try {
      const loaded = await step.run("load-observations", async () => {
        const redis = getRedisClient();
        const loadedAnchorDate =
          event.name === "memory/observations.accumulated"
            ? event.data.date
            : toISODate(new Date());
        const dates = getRecentDates(loadedAnchorDate, 7);
        const observations: string[] = [];

        for (const date of dates) {
          const key = `memory:observations:${date}`;
          const entries = await redis.lrange(key, 0, -1);

          for (const entry of entries) {
            const parsed = parseObservation(entry);
            if (parsed) {
              observations.push(parsed);
            }
          }
        }

        const memoryContentRaw = await readMemoryContent();
        const observationsTextRaw =
          observations.length > 0 ? observations.join("\n\n") : "No observations available.";

        const observationsText = truncateForStepOutput(
          observationsTextRaw,
          MAX_STEP_OBSERVATIONS_CHARS
        );
        const memoryContent = truncateForStepOutput(
          memoryContentRaw,
          MAX_STEP_MEMORY_CHARS
        );

        return {
          anchorDate: loadedAnchorDate,
          dates,
          observationCount: observations.length,
          observationsText: observationsText.value,
          observationsTextTruncated: observationsText.truncated,
          observationsTextChars: observationsTextRaw.length,
          memoryContent: memoryContent.value,
          memoryContentTruncated: memoryContent.truncated,
          memoryContentChars: memoryContentRaw.length,
        };
      });

      anchorDate = loaded.anchorDate;
      observationCount = loaded.observationCount;

      const initial = await step.run("call-reflector-llm", async () =>
        runReflectorLLM(loaded.observationsText, loaded.memoryContent, 0)
      );

      const validated = await step.run("validate-compression", async () => {
        let compressionRetryLevel = 0;
        let run = initial;

        while (!validateCompression(run.inputTokens, run.outputTokens) && compressionRetryLevel < 2) {
          compressionRetryLevel += 1;
          run = await runReflectorLLM(loaded.observationsText, loaded.memoryContent, compressionRetryLevel);
        }

        const compressionRatio = run.inputTokens > 0 ? run.outputTokens / run.inputTokens : 0;

        return {
          ...run,
          compressionRatio,
          retryLevel: compressionRetryLevel,
        };
      });

      retryLevel = validated.retryLevel;

      const staged = await step.run("stage-review", async () => {
        const redis = getRedisClient();
        const proposals = parseProposals(validated.raw);
        const capturedAt = new Date().toISOString();
        let nextSequence = 1;
        if (proposals.length > 0) {
          nextSequence = await getNextProposalSequence(redis, loaded.anchorDate);
        }
        const stagedProposals: StagedProposal[] = proposals.map((proposal) => {
          const id = formatProposalId(loaded.anchorDate, nextSequence);
          nextSequence += 1;
          return {
            id,
            section: proposal.section,
            change: proposal.change,
          };
        });

        for (const proposal of stagedProposals) {
          await redis.hset(
            `memory:review:proposal:${proposal.id}`,
            "id",
            proposal.id,
            "date",
            loaded.anchorDate,
            "section",
            proposal.section,
            "change",
            proposal.change,
            "status",
            "pending",
            "capturedAt",
            capturedAt
          );
          await redis.rpush("memory:review:pending", proposal.id);

          // Todoist task creation removed — proposal-triage.ts (ADR-0068)
          // now decides whether to create a task (only for needs-review).
          // This eliminates 50+ junk tasks per compaction from instruction-text
          // proposals that triage would auto-reject anyway.
        }

        const grouped = groupBySection(stagedProposals);

        return {
          proposals: stagedProposals,
          proposalCount: stagedProposals.length,
          capturedAt,
          sections: [...grouped.keys()],
        };
      });

      proposalCount = staged.proposalCount;

      const dailyLog = await step.run("append-daily-log", async () => {
        const dailyLogPath = join(getWorkspaceRoot(), "memory", `${loaded.anchorDate}.md`);
        const existingDailyLog = Bun.file(dailyLogPath);
        if ((await existingDailyLog.exists()) && (await existingDailyLog.text()).includes("### 🔭 Reflected")) {
          return {
            appended: false,
            path: dailyLogPath,
            reason: "already reflected today",
          };
        }
        const sectionSummary =
          staged.sections.length > 0 ? staged.sections.join(", ") : "none";
        const lines = [
          "### 🔭 Reflected",
          `- Proposals staged: ${staged.proposalCount}`,
          `- Sections: ${sectionSummary}`,
          `- Compression ratio: ${validated.compressionRatio}`,
          `- Captured at: ${staged.capturedAt}`,
          "",
        ];
        const writeResult = appendToFile(dailyLogPath, lines.join("\n"));
        return {
          appended: writeResult.ok,
          path: dailyLogPath,
          reason: writeResult.ok ? undefined : "append failed",
          error: writeResult.error,
        };
      });

      const emittedEvent = {
        name: "memory/observations.reflected" as const,
        data: {
          date: loaded.anchorDate,
          inputTokens: validated.inputTokens,
          outputTokens: validated.outputTokens,
          compressionRatio: validated.compressionRatio,
          proposalCount: staged.proposalCount,
          capturedAt: staged.capturedAt,
        },
      };

      const skipExternalSends = shouldSkipExternalEventSends();

      if (!skipExternalSends && staged.proposals.length > 0) {
        await step.sendEvent(
          "emit-proposal-created-events",
          staged.proposals.map((proposal) => ({
            name: "memory/proposal.created" as const,
            data: {
              proposalId: proposal.id,
              id: proposal.id,
              section: proposal.section,
              change: proposal.change,
              source: "reflect",
              timestamp: staged.capturedAt,
            },
          }))
        );
      }

      let emitCompleteError: string | undefined;
      if (!skipExternalSends) {
        step.sendEvent("emit-complete", [emittedEvent]).catch((error) => {
          emitCompleteError = error instanceof Error ? error.message : String(error);
        });
      }

      const rawPreviewLimit = Number.isFinite(MAX_RESULT_RAW_CHARS)
        ? Math.max(0, MAX_RESULT_RAW_CHARS)
        : 6000;
      const rawPreview = validated.raw.slice(0, rawPreviewLimit);

      const result = {
        raw: validated.raw,
        rawPreview,
        rawLength: validated.raw.length,
        rawPreviewTruncated: validated.raw.length > rawPreviewLimit,
        inputTokens: validated.inputTokens,
        outputTokens: validated.outputTokens,
        compressionRatio: validated.compressionRatio,
        retryLevel: validated.retryLevel,
        proposalCount: staged.proposalCount,
        dailyLogPath: dailyLog.path,
        emittedEvent,
        emitCompleteError,
      };

      await step.run("otel-reflect-completed", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "reflect",
          action: "reflect.completed",
          success: true,
          duration_ms: Date.now() - startedAt,
          metadata: {
            eventId,
            observationCount,
            proposalCount,
            retryLevel,
            date: loaded.anchorDate,
            inputTokens: validated.inputTokens,
            outputTokens: validated.outputTokens,
            observationsTextChars: loaded.observationsTextChars,
            observationsTextTruncated: loaded.observationsTextTruncated,
            memoryContentChars: loaded.memoryContentChars,
            memoryContentTruncated: loaded.memoryContentTruncated,
          },
        });
      });

      return result;
    } catch (error) {
      await step.run("otel-reflect-failed", async () => {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "reflect",
          action: "reflect.failed",
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - startedAt,
          metadata: {
            eventId,
            date: anchorDate,
            observationCount,
            proposalCount,
            retryLevel,
          },
        });
      });
      throw error;
    }
  }
);
