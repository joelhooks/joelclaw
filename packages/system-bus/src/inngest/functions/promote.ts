import { join } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import Redis from "ioredis";
import { inngest } from "../client";
import { PROMOTE_SYSTEM_PROMPT, PROMOTE_USER_PROMPT } from "./promote-prompt";

type RedisLike = {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  lrem(key: string, count: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

const REVIEW_PENDING_KEY = "memory:review:pending";
const MEMORY_FILE_NAME = "MEMORY.md";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const REJECTED_PROPOSALS_HEADER = "### Rejected Proposals";
const EXPIRED_PROPOSALS_HEADER = "### Expired Proposals";

let redisClient: Redis | null = null;

function getRedisClient(): RedisLike {
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

function getMemoryPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/Users/joel";
  return join(home, ".joelclaw", "workspace", MEMORY_FILE_NAME);
}

function getMemoryLogPath(date: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/Users/joel";
  return join(home, ".joelclaw", "workspace", "memory", `${date}.md`);
}

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function proposalKey(id: string): string {
  return `memory:review:proposal:${id}`;
}

function extractDateFromProposalId(id: string): string {
  const match = /^p-(\d{4})(\d{2})(\d{2})-\d{3,}$/u.exec(id);
  if (match?.[1] && match[2] && match[3]) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return new Date().toISOString().slice(0, 10);
}

function parseDateFromProposalId(id: string): Date | null {
  const match = /^p-(\d{4})(\d{2})(\d{2})-\d{3,}$/u.exec(id);
  if (!match?.[1] || !match[2] || !match[3]) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== year) return null;
  if (date.getUTCMonth() !== monthIndex) return null;
  if (date.getUTCDate() !== day) return null;
  return date;
}

function appendEntryToLogSection(markdown: string, header: string, entry: string): string {
  const lines = markdown.length > 0 ? markdown.split(/\r?\n/u) : [];
  const normalizedLines = [...lines];
  while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1]?.trim() === "") {
    normalizedLines.pop();
  }

  const headerIndex = normalizedLines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) {
    const prefix = normalizedLines.length > 0 ? `${normalizedLines.join("\n")}\n\n` : "";
    return `${prefix}${header}\n- ${entry}\n`;
  }

  let insertIndex = headerIndex + 1;
  while (insertIndex < normalizedLines.length && !/^###\s+/u.test(normalizedLines[insertIndex] ?? "")) {
    insertIndex += 1;
  }

  normalizedLines.splice(insertIndex, 0, `- ${entry}`);
  return `${normalizedLines.join("\n")}\n`;
}

async function appendToDailyLog(header: string, entry: string): Promise<void> {
  const today = getTodayDateString();
  const logPath = getMemoryLogPath(today);
  await mkdir(join(process.env.HOME || process.env.USERPROFILE || "/Users/joel", ".joelclaw", "workspace", "memory"), {
    recursive: true,
  });

  const logFile = Bun.file(logPath);
  const existing = (await logFile.exists()) ? await logFile.text() : "";
  const next = appendEntryToLogSection(existing, header, entry);
  await Bun.write(logPath, next);
}

function isProposalOlderThanSevenDays(proposalId: string, now: Date = new Date()): boolean {
  const proposalDate = parseDateFromProposalId(proposalId);
  if (!proposalDate) return false;
  return now.getTime() - proposalDate.getTime() >= SEVEN_DAYS_MS;
}

function normalizeSection(rawSection: string | undefined): "Hard Rules" | "System Architecture" | "Patterns" {
  const value = rawSection?.trim();
  if (value === "System Architecture") return value;
  if (value === "Patterns") return value;
  return "Hard Rules";
}

function appendBulletToSection(markdown: string, section: "Hard Rules" | "System Architecture" | "Patterns", bullet: string): string {
  const lines = markdown.split(/\r?\n/u);
  const header = `## ${section}`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) {
    throw new Error(`Target section not found in MEMORY.md: ${section}`);
  }

  let sectionEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  let insertIndex = sectionEnd;
  while (insertIndex > headerIndex + 1 && (lines[insertIndex - 1]?.trim() ?? "") === "") {
    insertIndex -= 1;
  }

  lines.splice(insertIndex, 0, bullet);
  return lines.join("\n");
}

function getSectionContent(markdown: string, section: "Hard Rules" | "System Architecture" | "Patterns"): string {
  const lines = markdown.split(/\r?\n/u);
  const header = `## ${section}`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) return "";

  let sectionEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  return lines
    .slice(headerIndex + 1, sectionEnd)
    .join("\n")
    .trim();
}

async function readProcessStream(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

async function formatProposalForMemoryIfNeeded(
  section: "Hard Rules" | "System Architecture" | "Patterns",
  proposedText: string,
  memoryMarkdown: string
): Promise<string> {
  if (typeof PROMOTE_SYSTEM_PROMPT !== "string" || PROMOTE_SYSTEM_PROMPT.trim().length === 0) {
    return proposedText;
  }

  const currentSectionContent = getSectionContent(memoryMarkdown, section);
  const userPrompt = PROMOTE_USER_PROMPT({
    section,
    proposalText: proposedText,
    currentSectionContent,
  });

  const proc = Bun.spawn(["pi", "-p", "--no-session", "--no-extensions", "--model", "haiku", "--system-prompt", PROMOTE_SYSTEM_PROMPT, userPrompt], {
    env: { ...process.env, TERM: "dumb" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessStream(proc.stdout),
    readProcessStream(proc.stderr),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    console.error(`promoteToMemory formatting failed (${exitCode}): ${stderr || "unknown error"}`);
    return proposedText;
  }

  const formatted = stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return formatted ?? proposedText;
}

// stabilizeFunctionOpts removed — was a Proxy wrapper that turned out to be
// unnecessary and obfuscated debugging. The underlying Inngest SDK properly
// handles function opts without mutation protection. The real trigger drift
// bug was server-side caching, now detected by trigger-audit.ts.

export async function promoteToMemory(proposalId: string): Promise<void> {
  const redis = getRedisClient();
  const key = proposalKey(proposalId);

  const proposal = await redis.hgetall(key);
  const section = normalizeSection(proposal.targetSection || proposal.section);
  const proposedText = (proposal.proposedText || proposal.change || "").trim();
  if (!proposedText) {
    throw new Error(`Proposal is missing proposed text: ${proposalId}`);
  }

  const date = extractDateFromProposalId(proposalId);
  const memoryPath = getMemoryPath();
  const memoryFile = Bun.file(memoryPath);
  const memoryMarkdown = await memoryFile.text();
  const promotedText = await formatProposalForMemoryIfNeeded(section, proposedText, memoryMarkdown);
  const nextMemoryMarkdown = appendBulletToSection(memoryMarkdown, section, `- (${date}) ${promotedText}`);

  const tmpPath = `${memoryPath}.tmp`;
  await Bun.write(tmpPath, nextMemoryMarkdown);
  await rename(tmpPath, memoryPath);

  const logPath = getMemoryLogPath(date);
  await mkdir(join(process.env.HOME || process.env.USERPROFILE || "/Users/joel", ".joelclaw", "workspace", "memory"), {
    recursive: true,
  });
  const existingLog = await Bun.file(logPath).text().catch(() => "");
  const logLine = `- promoted ${proposalId} -> ${section}: ${promotedText}`;
  const nextLog = `${existingLog}${existingLog.length > 0 && !existingLog.endsWith("\n") ? "\n" : ""}${logLine}\n`;
  await Bun.write(logPath, nextLog);

  await redis.lrem(REVIEW_PENDING_KEY, 0, proposalId);
  await redis.del(key);
}

export async function archiveProposal(proposalId: string, reason: string): Promise<void> {
  const redis = getRedisClient();
  const key = proposalKey(proposalId);
  const proposal = await redis.hgetall(key);
  const proposalText = (proposal.proposedText || proposal.change || "").trim();

  await appendToDailyLog(
    REJECTED_PROPOSALS_HEADER,
    `${proposalId}: ${proposalText}${proposalText ? "" : "(missing proposal text)"} [reason: ${reason}]`
  );

  await redis.lrem(REVIEW_PENDING_KEY, 0, proposalId);
  await redis.del(key);
}

export async function expireProposal(proposalId: string): Promise<void> {
  const redis = getRedisClient();
  const key = proposalKey(proposalId);
  const proposal = await redis.hgetall(key);

  if (!isProposalOlderThanSevenDays(proposalId)) return;

  const proposalText = (proposal.proposedText || proposal.change || "").trim();
  await appendToDailyLog(
    EXPIRED_PROPOSALS_HEADER,
    `${proposalId}: ${proposalText}${proposalText ? "" : "(missing proposal text)"}`
  );

  await redis.lrem(REVIEW_PENDING_KEY, 0, proposalId);
  await redis.del(key);
}

// NOTE: stabilizeFunctionOpts removed — its Proxy was mangling trigger
// registration, causing proposal events to be replaced with content/updated.
const promoteFunction =
  inngest.createFunction(
    {
      id: "memory/review-promote",
      name: "Promote Review Decisions",
    },
    [{ event: "memory/proposal.approved" }, { event: "memory/proposal.rejected" }, { cron: "0 8 * * *" }],
    async ({ event, step }) => {
      if (event.name === "memory/proposal.approved") {
        const proposalId = await step.run("resolve-approved-proposal-id", async () => {
          const id = (event.data as { proposalId?: unknown }).proposalId;
          if (typeof id !== "string" || id.trim().length === 0) {
            throw new Error("memory/proposal.approved requires event.data.proposalId");
          }
          return id;
        });

        await step.run("promote-approved-proposal", async () => promoteToMemory(proposalId));
        return { approved: [proposalId] };
      }

      if (event.name === "memory/proposal.rejected") {
        const payload = await step.run("resolve-rejected-payload", async () => {
          const id = (event.data as { proposalId?: unknown }).proposalId;
          const reason = (event.data as { reason?: unknown }).reason;
          if (typeof id !== "string" || id.trim().length === 0) {
            throw new Error("memory/proposal.rejected requires event.data.proposalId");
          }
          if (typeof reason !== "string" || reason.trim().length === 0) {
            throw new Error("memory/proposal.rejected requires event.data.reason");
          }
          return { proposalId: id, reason };
        });

        await step.run("archive-rejected-proposal", async () => archiveProposal(payload.proposalId, payload.reason));
        return { rejected: [payload.proposalId], reason: payload.reason };
      }

      const expiredIds = await step.run("expire-stale-proposals", async () => {
        const redis = getRedisClient();
        const pending = await redis.lrange(REVIEW_PENDING_KEY, 0, -1);
        const expired: string[] = [];

        for (const proposalId of pending) {
          if (!isProposalOlderThanSevenDays(proposalId)) continue;
          await expireProposal(proposalId);
          expired.push(proposalId);
        }

        return expired;
      });

      return { expired: expiredIds };
    }
  );

export const promote = promoteFunction;
