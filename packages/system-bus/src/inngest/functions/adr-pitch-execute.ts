import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NonRetriableError } from "inngest";
import Redis from "ioredis";
import { MODEL } from "../../lib/models";
import { getRedisPort } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const VAULT_PATH = process.env.VAULT_PATH ?? "/Users/joel/Vault";
const JOELCLAW_REPO_PATH = process.env.JOELCLAW_REPO_PATH ?? "/Users/joel/Code/joelhooks/joelclaw";
const ADR_ROLLBACK_KEY_PREFIX = "adr:pitch:rollback";
const ADR_ROLLBACK_TTL_SECONDS = 7 * 24 * 60 * 60;
const CODEX_TIMEOUT_MS = 10 * 60 * 1000;
const TYPECHECK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROMPT_ADR_CHARS = 40_000;
const MAX_ERROR_TEXT_CHARS = 8_000;
const MAX_TELEGRAM_ERROR_CHARS = 1_500;

type ExecutionStage = "load_adr" | "codex" | "git" | "typecheck";

type AdrDocument = {
  adrNumber: string;
  title: string;
  filePath: string;
  content: string;
  acceptanceCriteria: string[];
};

type GitInspection = {
  headSha: string;
  status: string;
  hasNewCommit: boolean;
  worktreeClean: boolean;
};

type RollbackRecord = {
  key: string;
  value: {
    sha: string;
    timestamp: string;
    adr_number: string;
  };
};

type TelegramNotifyResult = {
  notified: boolean;
  error?: string;
};

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: getRedisPort(),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

class StageError extends Error {
  readonly stage: ExecutionStage;

  constructor(stage: ExecutionStage, message: string) {
    super(message);
    this.name = "StageError";
    this.stage = stage;
  }
}

function normalizeAdrNumber(value: string | number): string {
  const digits = String(value).replace(/\D/g, "");
  if (!digits) {
    throw new StageError("load_adr", "adr_number is required");
  }
  return digits.padStart(4, "0").slice(-4);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    const execError = error as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = execError.stdout?.toString().trim() ?? "";
    const stderr = execError.stderr?.toString().trim() ?? "";
    const parts = [error.message];
    if (stdout) parts.push(`STDOUT:\n${clip(stdout, MAX_ERROR_TEXT_CHARS)}`);
    if (stderr) parts.push(`STDERR:\n${clip(stderr, MAX_ERROR_TEXT_CHARS)}`);
    return clip(parts.join("\n\n"), MAX_ERROR_TEXT_CHARS);
  }

  return clip(String(error), MAX_ERROR_TEXT_CHARS);
}

function readHeadSha(): string {
  return execSync("git rev-parse HEAD", {
    cwd: JOELCLAW_REPO_PATH,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: "true", TERM: "dumb" },
  }).trim();
}

function inspectGitState(initialHeadSha: string): GitInspection {
  const headSha = readHeadSha();
  const status = execSync("git status --porcelain", {
    cwd: JOELCLAW_REPO_PATH,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: "true", TERM: "dumb" },
  }).trim();

  return {
    headSha,
    status,
    hasNewCommit: headSha !== initialHeadSha,
    worktreeClean: status.length === 0,
  };
}

function findAdrFilePath(adrNumber: string): string {
  const decisionsPath = join(VAULT_PATH, "docs", "decisions");
  const filename = readdirSync(decisionsPath).find(
    (entry) => entry.startsWith(`${adrNumber}-`) && entry.endsWith(".md")
  );

  if (!filename) {
    throw new StageError(
      "load_adr",
      `Could not find ADR-${adrNumber} in ${join(VAULT_PATH, "docs", "decisions")}`
    );
  }

  return join(decisionsPath, filename);
}

function extractTitle(content: string, adrNumber: string): string {
  const headingMatch = content.match(/^#\s+ADR-\d+:\s*(.+)$/m);
  if (headingMatch?.[1]) return headingMatch[1].trim();

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const titleMatch = frontmatterMatch?.[1]?.match(/^title:\s*(.+)$/m);
  if (titleMatch?.[1]) return titleMatch[1].trim().replace(/^["']|["']$/g, "");

  return `ADR-${adrNumber}`;
}

function extractMarkdownSection(content: string, headings: string[]): string | null {
  const lines = content.split(/\r?\n/);

  for (const heading of headings) {
    const headingPattern = new RegExp(`^(#{2,6})\\s+${escapeRegExp(heading)}\\s*$`, "i");
    const startIndex = lines.findIndex((line) => headingPattern.test(line.trim()));

    if (startIndex === -1) continue;

    const startMatch = lines[startIndex]?.trim().match(/^(#{2,6})\s+/);
    const startLevel = startMatch?.[1]?.length ?? 2;
    const sectionLines: string[] = [];

    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const nextHeading = line.trim().match(/^(#{1,6})\s+/);
      if (nextHeading && nextHeading[1].length <= startLevel) break;
      sectionLines.push(line);
    }

    const section = sectionLines.join("\n").trim();
    if (section) return section;
  }

  return null;
}

function extractAcceptanceCriteria(content: string): string[] {
  const section = extractMarkdownSection(content, [
    "Acceptance Criteria",
    "How We Know It Worked",
    "How We'll Know It Worked",
    "Desired Outcomes",
    "Implementation Plan",
  ]);

  if (!section) return [];

  const bulletLines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, "").trim())
    .filter(Boolean);

  if (bulletLines.length > 0) {
    return bulletLines;
  }

  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .slice(0, 8);
}

function readAdrDocument(adrNumber: string): AdrDocument {
  const filePath = findAdrFilePath(adrNumber);
  const content = readFileSync(filePath, "utf-8");

  return {
    adrNumber,
    title: extractTitle(content, adrNumber),
    filePath,
    content,
    acceptanceCriteria: extractAcceptanceCriteria(content),
  };
}

function buildCodexPrompt(adr: AdrDocument): string {
  const acceptanceCriteria =
    adr.acceptanceCriteria.length > 0
      ? adr.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")
      : "- No explicit acceptance criteria section found; derive the implementation from the ADR intent, decision, and implementation plan.";

  return `Implement this ADR in ${JOELCLAW_REPO_PATH}.

ADR number: ${adr.adrNumber}
Title: ${adr.title}
ADR file: ${adr.filePath}

Acceptance criteria:
${acceptanceCriteria}

Instructions:
- implement this ADR, commit to main with message prefix 'ADR-${adr.adrNumber}: '
- run bunx tsc --noEmit before committing
- keep the changes focused on this ADR
- update relevant docs and skills if you change system reality
- do not stop at a plan; make the code changes and commit them

ADR content:
${clip(adr.content, MAX_PROMPT_ADR_CHARS)}
`;
}

function runCodexExec(prompt: string): string {
  const command = [
    "codex",
    "exec",
    "--full-auto",
    `-m ${MODEL.CODEX}`,
    `-C ${shellEscapeSingleQuoted(JOELCLAW_REPO_PATH)}`,
    shellEscapeSingleQuoted(prompt),
  ].join(" ");

  return execSync(command, {
    cwd: JOELCLAW_REPO_PATH,
    encoding: "utf-8",
    timeout: CODEX_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: "true", TERM: "dumb" },
  }).trim();
}

function runTypecheck(): string {
  return execSync("bunx tsc --noEmit", {
    cwd: JOELCLAW_REPO_PATH,
    encoding: "utf-8",
    timeout: TYPECHECK_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: "true", TERM: "dumb" },
  }).trim();
}

async function storeRollbackInfo(adrNumber: string, sha: string): Promise<RollbackRecord> {
  const key = `${ADR_ROLLBACK_KEY_PREFIX}:${adrNumber}`;
  const value = {
    sha,
    timestamp: new Date(Date.now()).toISOString(),
    adr_number: adrNumber,
  };

  const redis = getRedis();
  await redis.set(key, JSON.stringify(value), "EX", ADR_ROLLBACK_TTL_SECONDS);

  return { key, value };
}

async function notifyTelegram(
  text: string,
  metadata: Record<string, unknown>
): Promise<TelegramNotifyResult> {
  try {
    await pushGatewayEvent({
      type: "notification",
      source: "inngest/adr-pitch-execute",
      payload: {
        prompt: text,
        message: text,
        channel: "telegram",
        ...metadata,
      },
    });
    return { notified: true };
  } catch (error) {
    return { notified: false, error: stringifyError(error) };
  }
}

export const adrPitchExecute = inngest.createFunction(
  {
    id: "adr-pitch-execute",
    name: "ADR: Pitch Execute",
    retries: 2,
  },
  { event: "adr/pitch.approved" },
  async ({ event, step }) => {
    const adrNumber = normalizeAdrNumber(event.data.adr_number);
    let adr: AdrDocument | null = null;
    let initialHeadSha = "";
    let gitInspection: GitInspection | null = null;
    let rollbackRecord: RollbackRecord | null = null;
    let codexOutput = "";
    let typecheckOutput = "";

    try {
      initialHeadSha = await step.run("read-initial-head-sha", async () => readHeadSha());

      const loadedAdr = await step.run("load-adr", async () => readAdrDocument(adrNumber));
      adr = loadedAdr;

      await step.run("emit-pitch-execution-started", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "adr-pitch-execute",
          action: "pitch.execution.started",
          success: true,
          metadata: {
            adr_number: adrNumber,
            title: loadedAdr.title,
            filePath: loadedAdr.filePath,
            acceptanceCriteriaCount: loadedAdr.acceptanceCriteria.length,
          },
        });
      });

      try {
        const codexResult = await step.run("run-codex-exec", async () => {
          const output = runCodexExec(buildCodexPrompt(loadedAdr));
          return { output: clip(output, MAX_ERROR_TEXT_CHARS) };
        });
        codexOutput = codexResult.output;
      } catch (error) {
        throw new StageError("codex", stringifyError(error));
      }

      const currentGitInspection = await (async () => {
        try {
          return await step.run("inspect-git-after-codex", async () => inspectGitState(initialHeadSha));
        } catch (error) {
          throw new StageError("git", stringifyError(error));
        }
      })();
      gitInspection = currentGitInspection;
      if (currentGitInspection.hasNewCommit) {
        rollbackRecord = await step.run("store-rollback-info", async () =>
          storeRollbackInfo(adrNumber, currentGitInspection.headSha)
        );
      }

      if (!currentGitInspection.hasNewCommit) {
        throw new StageError("git", "Codex finished without creating a new commit on main");
      }

      if (!currentGitInspection.worktreeClean) {
        throw new StageError(
          "git",
          `Codex left a dirty worktree:\n${clip(currentGitInspection.status, MAX_ERROR_TEXT_CHARS)}`
        );
      }

      try {
        const typecheckResult = await step.run("verify-repo-typecheck", async () => {
          const output = runTypecheck();
          return { output: output ? clip(output, MAX_ERROR_TEXT_CHARS) : "TypeScript OK" };
        });
        typecheckOutput = typecheckResult.output;
      } catch (error) {
        throw new StageError("typecheck", stringifyError(error));
      }

      const successMessage = `✅ ADR-${adrNumber} shipped. Commit: ${currentGitInspection.headSha}. Revert: \`git revert ${currentGitInspection.headSha}\``;
      const successNotify = await step.run("notify-telegram-success", async () =>
        notifyTelegram(successMessage, {
          adr_number: adrNumber,
          sha: currentGitInspection.headSha,
          rollback_key: rollbackRecord?.key ?? null,
          status: "completed",
        })
      );

      await step.run("emit-pitch-execution-completed", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "adr-pitch-execute",
          action: "pitch.execution.completed",
          success: true,
          metadata: {
            adr_number: adrNumber,
            title: loadedAdr.title,
            sha: currentGitInspection.headSha,
            rollbackKey: rollbackRecord?.key ?? null,
            acceptanceCriteriaCount: loadedAdr.acceptanceCriteria.length,
            telegramNotified: successNotify.notified,
            telegramError: successNotify.error,
            codexOutput: codexOutput || null,
            typecheckOutput,
          },
        });
      });

      return {
        status: "completed",
        adr_number: adrNumber,
        title: loadedAdr.title,
        sha: currentGitInspection.headSha,
        rollbackKey: rollbackRecord?.key ?? null,
        telegramNotified: successNotify.notified,
      };
    } catch (error) {
      const stage = error instanceof StageError ? error.stage : "git";
      const errorText = error instanceof StageError ? error.message : stringifyError(error);

      if (initialHeadSha) {
        try {
          const failureGitInspection = await step.run("inspect-git-on-failure", async () =>
            inspectGitState(initialHeadSha)
          );
          gitInspection = failureGitInspection;

          if (failureGitInspection.hasNewCommit && !rollbackRecord) {
            rollbackRecord = await step.run("store-rollback-info-on-failure", async () =>
              storeRollbackInfo(adrNumber, failureGitInspection.headSha)
            );
          }
        } catch {
          // Best-effort failure context only. Preserve the original error path.
        }
      }

      const failureMessageParts = [
        `❌ ADR-${adrNumber} execution failed during ${stage}.`,
        gitInspection?.headSha ? `Commit: ${gitInspection.headSha}.` : null,
        gitInspection?.headSha ? `Revert: \`git revert ${gitInspection.headSha}\`.` : null,
        `Error: ${clip(errorText, MAX_TELEGRAM_ERROR_CHARS)}`,
      ].filter(Boolean);
      const failureMessage = failureMessageParts.join(" ");

      const failureNotify = await step.run("notify-telegram-failure", async () =>
        notifyTelegram(failureMessage, {
          adr_number: adrNumber,
          sha: gitInspection?.headSha ?? null,
          rollback_key: rollbackRecord?.key ?? null,
          stage,
          status: "failed",
        })
      );

      await step.run("emit-pitch-execution-failed", async () => {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "adr-pitch-execute",
          action: "pitch.execution.failed",
          success: false,
          error: clip(errorText, MAX_ERROR_TEXT_CHARS),
          metadata: {
            adr_number: adrNumber,
            title: adr?.title ?? `ADR-${adrNumber}`,
            stage,
            sha: gitInspection?.headSha ?? null,
            rollbackKey: rollbackRecord?.key ?? null,
            worktreeClean: gitInspection?.worktreeClean ?? null,
            gitStatus: gitInspection?.status ? clip(gitInspection.status, MAX_ERROR_TEXT_CHARS) : null,
            telegramNotified: failureNotify.notified,
            telegramError: failureNotify.error,
            codexOutput: codexOutput || null,
          },
        });
      });

      throw new NonRetriableError(errorText);
    }
  }
);
