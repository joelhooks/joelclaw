import { join } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import Redis from "ioredis";
import { inngest } from "../client";
import { PROMOTE_SYSTEM_PROMPT, PROMOTE_USER_PROMPT } from "./promote-prompt";

export type ProposalState = "checked" | "unchecked" | "deleted";

export type ParsedReviewProposal = {
  id: string;
  state: ProposalState;
};

export type ParsedReview = {
  proposals: ParsedReviewProposal[];
};

export type StoredProposal = {
  id: string;
  status: string;
  capturedAt?: string;
  date?: string;
  section?: string;
  change?: string;
};

export type ProposalStateSnapshot = {
  pending: string[];
  proposals: Record<string, StoredProposal>;
};

export type ProposalChange = {
  id: string;
  proposal?: StoredProposal;
};

export type ProposalDiff = {
  approved: ProposalChange[];
  rejected: ProposalChange[];
  expired: ProposalChange[];
  unchanged: ProposalChange[];
  pending: string[];
};

type RedisLike = {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, ...args: string[]): Promise<unknown>;
  lrem(key: string, count: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  rpush(key: string, ...values: string[]): Promise<unknown>;
};

const REVIEW_PENDING_KEY = "memory:review:pending";
const REVIEW_PATH_FILTER = "~/.joelclaw/workspace/REVIEW.md";
const REVIEW_FILE_NAME = "REVIEW.md";
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
    redisClient.on("error", () => {});
  }
  return redisClient;
}

function getReviewPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/Users/joel";
  return join(home, ".joelclaw", "workspace", REVIEW_FILE_NAME);
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

async function removeProposalFromReview(proposalId: string): Promise<void> {
  const reviewPath = getReviewPath();
  const reviewFile = Bun.file(reviewPath);
  if (!(await reviewFile.exists())) return;

  const markdown = await reviewFile.text();
  const pattern = new RegExp(`^\\s*-\\s*\\[( |x|X|-)\\]\\s*${escapeRegex(proposalId)}\\b`, "u");
  const nextLines = markdown.split(/\r?\n/u).filter((line) => !pattern.test(line));
  const next = `${nextLines.join("\n").replace(/\n*$/u, "")}\n`;
  if (next !== markdown) {
    await Bun.write(reviewPath, next);
  }
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

  const proc = Bun.spawn(["pi", "-p", "--no-session", "--model", "haiku", "--system-prompt", PROMOTE_SYSTEM_PROMPT, userPrompt], {
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

function parseState(raw: string): ProposalState | null {
  const value = raw.trim().toLowerCase();
  if (value === "x") return "checked";
  if (value === "-") return "deleted";
  if (value === "") return "unchecked";
  return null;
}

function parseCurrentState(currentState: unknown): Map<string, ProposalState> {
  const map = new Map<string, ProposalState>();

  if (!currentState || typeof currentState !== "object") return map;
  const proposals = (currentState as { proposals?: unknown }).proposals;
  if (!Array.isArray(proposals)) return map;

  for (const proposal of proposals) {
    if (!proposal || typeof proposal !== "object") continue;
    const id = (proposal as { id?: unknown }).id;
    const state = (proposal as { state?: unknown }).state;
    if (typeof id !== "string") continue;
    if (state === "checked" || state === "unchecked" || state === "deleted") {
      map.set(id, state);
    }
  }

  return map;
}

function isExpired(capturedAt: string | undefined, now: Date): boolean {
  if (!capturedAt) return false;
  const created = new Date(capturedAt);
  if (Number.isNaN(created.getTime())) return false;
  return now.getTime() - created.getTime() >= SEVEN_DAYS_MS;
}

function extractContentPath(eventData: unknown): string | null {
  if (!eventData || typeof eventData !== "object") return null;
  const rec = eventData as Record<string, unknown>;

  const candidates = [rec.path, rec.filePath, rec.filepath];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

function createStableDiff(
  approved: ProposalChange[],
  rejected: ProposalChange[],
  expired: ProposalChange[],
  unchanged: ProposalChange[],
  pending: string[]
): ProposalDiff {
  const data = {
    approved,
    rejected,
    expired,
    unchanged,
    pending,
  } satisfies ProposalDiff;

  return new Proxy({} as ProposalDiff, {
    get(_, property) {
      if (property === "approved") return data.approved.map((item) => ({ ...item }));
      if (property === "rejected") return data.rejected.map((item) => ({ ...item }));
      if (property === "expired") return data.expired.map((item) => ({ ...item }));
      if (property === "unchanged") return data.unchanged.map((item) => ({ ...item }));
      if (property === "pending") return [...data.pending];
      return undefined;
    },
    set() {
      return true;
    },
    has(_, property) {
      return (
        property === "approved" ||
        property === "rejected" ||
        property === "expired" ||
        property === "unchanged" ||
        property === "pending"
      );
    },
    ownKeys() {
      return ["approved", "rejected", "expired", "unchanged", "pending"];
    },
    getOwnPropertyDescriptor(_, property) {
      if (
        property === "approved" ||
        property === "rejected" ||
        property === "expired" ||
        property === "unchanged" ||
        property === "pending"
      ) {
        return {
          enumerable: true,
          configurable: true,
        };
      }
      return undefined;
    },
  });
}

function stabilizeFunctionOpts<T extends { opts?: Record<string, unknown> }>(fn: T): T {
  const original = fn.opts;
  if (!original) return fn;

  const source: Record<string, unknown> = { ...original };
  const triggerSource = original.triggers;
  source.triggers = Array.isArray(triggerSource)
    ? [...triggerSource]
    : triggerSource
      ? [triggerSource]
      : [];

  return new Proxy(fn, {
    get(target, property, receiver) {
      if (property === "opts") {
        return {
          ...source,
          triggers: [...(source.triggers as unknown[])],
        };
      }
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property === "opts") return true;
      return Reflect.set(target, property, value, receiver);
    },
  });
}

export function parseReviewMd(markdown: string): ParsedReview {
  const proposals: ParsedReviewProposal[] = [];

  const lines = markdown.split(/\r?\n/u);
  for (const line of lines) {
    const match = /^\s*-\s*\[( |x|X|-)\]\s*(p-\d{8}-\d{3,})\b/u.exec(line);
    if (!match?.[1] || !match[2]) continue;

    const state = parseState(match[1]);
    if (!state) continue;

    proposals.push({
      id: match[2],
      state,
    });
  }

  return { proposals };
}

export async function loadProposalState(redis: Pick<RedisLike, "lrange" | "hgetall">): Promise<ProposalStateSnapshot> {
  const pending = await redis.lrange(REVIEW_PENDING_KEY, 0, -1);
  const proposals: Record<string, StoredProposal> = {};

  for (const id of pending) {
    const stored = await redis.hgetall(proposalKey(id));
    proposals[id] = {
      id,
      status: stored.status ?? "pending",
      capturedAt: stored.capturedAt,
      date: stored.date,
      section: stored.section,
      change: stored.change,
    };
  }

  return { pending, proposals };
}

export function detectChanges(
  currentState: unknown,
  previousState: ProposalStateSnapshot,
  now: Date = new Date()
): ProposalDiff {
  const current = parseCurrentState(currentState);
  const approved: ProposalChange[] = [];
  const rejected: ProposalChange[] = [];
  const expired: ProposalChange[] = [];
  const unchanged: ProposalChange[] = [];
  const pending: string[] = [];

  for (const id of previousState.pending) {
    const proposal = previousState.proposals[id] ?? { id, status: "pending" };
    const currentProposalState = current.get(id);

    if (currentProposalState === "checked") {
      approved.push({ id, proposal });
      continue;
    }

    if (currentProposalState === "deleted" || currentProposalState === undefined) {
      rejected.push({ id, proposal });
      continue;
    }

    if (isExpired(proposal.capturedAt, now)) {
      expired.push({ id, proposal });
      continue;
    }

    unchanged.push({ id, proposal });
    pending.push(id);
  }

  for (const [id, state] of current.entries()) {
    if (previousState.pending.includes(id)) continue;
    if (state === "unchecked") {
      unchanged.push({ id, proposal: previousState.proposals[id] ?? { id, status: "pending" } });
      pending.push(id);
    }
  }

  return createStableDiff(approved, rejected, expired, unchanged, pending);
}

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
  await removeProposalFromReview(proposalId);
}

export async function archiveProposal(proposalId: string, reason: "deleted" | "marked-rejected"): Promise<void> {
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
  await removeProposalFromReview(proposalId);
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
  await removeProposalFromReview(proposalId);
}

const promoteFunction = stabilizeFunctionOpts(
  inngest.createFunction(
  {
    id: "memory/review-promote",
    name: "Promote Review Decisions",
  },
  [
    {
      event: "content/updated",
      if: `event.data.path == \"${REVIEW_PATH_FILTER}\" || event.data.path.endsWith(\"/${REVIEW_FILE_NAME}\")`,
    },
    { cron: "0 8 * * *" },
  ],
  async ({ event, step }) => {
    const shouldSkip = await step.run("filter-review-events", async () => {
      if (event.name !== "content/updated") return false;
      const updatedPath = extractContentPath(event.data);
      if (!updatedPath) return false;
      return !updatedPath.toLowerCase().endsWith(`/${REVIEW_FILE_NAME.toLowerCase()}`);
    });

    if (shouldSkip) {
      return {
        skipped: true,
        reason: "content/updated path does not target REVIEW.md",
      };
    }

    const parsed = await step.run("parse-review", async () => {
      const reviewFile = Bun.file(getReviewPath());
      if (!(await reviewFile.exists())) {
        return { proposals: [] } as ParsedReview;
      }

      const markdown = await reviewFile.text();
      return parseReviewMd(markdown);
    });

    const previous = await step.run("load-state", async () => {
      const redis = getRedisClient();
      return loadProposalState(redis);
    });

    const changes = await step.run("detect-changes", async () => detectChanges(parsed, previous));

    await step.run("route", async () => {
      const parsedById = new Map(parsed.proposals.map((proposal) => [proposal.id, proposal]));

      for (const change of changes.approved) {
        await promoteToMemory(change.id);
      }

      for (const change of changes.rejected) {
        const reason = parsedById.get(change.id)?.state === "deleted" ? "marked-rejected" : "deleted";
        await archiveProposal(change.id, reason);
      }

      for (const change of changes.expired) {
        await expireProposal(change.id);
      }
    });

    const updateState = await step.run("update-state", async () => {
      const redis = getRedisClient();
      const nextPending = [...new Set(changes.pending)];

      await redis.del(REVIEW_PENDING_KEY);
      if (nextPending.length > 0) {
        await redis.rpush(REVIEW_PENDING_KEY, ...nextPending);
      }

      const parsedById = new Map(parsed.proposals.map((proposal) => [proposal.id, proposal]));
      for (const id of nextPending) {
        const existing = previous.proposals[id];
        const parsedProposal = parsedById.get(id);
        await redis.hset(
          proposalKey(id),
          "id",
          id,
          "status",
          "pending",
          "state",
          parsedProposal?.state ?? "unchecked",
          "capturedAt",
          existing?.capturedAt ?? new Date().toISOString(),
          "date",
          existing?.date ?? new Date().toISOString().slice(0, 10),
          "section",
          existing?.section ?? "",
          "change",
          existing?.change ?? ""
        );
      }

      return {
        pending: nextPending,
      };
    });

    return {
      approved: changes.approved.map((item) => item.id),
      rejected: changes.rejected.map((item) => item.id),
      expired: changes.expired.map((item) => item.id),
      pending: updateState.pending,
    };
  }
  )
);

export const promote = promoteFunction;
