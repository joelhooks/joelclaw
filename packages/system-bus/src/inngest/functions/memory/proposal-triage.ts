import { rename } from "node:fs/promises";
import { join } from "node:path";
import Redis from "ioredis";
import { inngest } from "../../client";
import { triageProposal, type Proposal } from "../../../memory/triage";
import { TodoistTaskAdapter } from "../../../tasks/adapters/todoist";
import { emitOtelEvent } from "../../../observability/emit";

const REVIEW_PENDING_KEY = "memory:review:pending";

type MemorySection =
  | "Joel"
  | "Miller Hooks"
  | "Conventions"
  | "Hard Rules"
  | "System Architecture"
  | "Patterns";

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

function getMemoryPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/Users/joel";
  return join(home, ".joelclaw", "workspace", "MEMORY.md");
}

function jsonKey(id: string): string {
  return `memory:proposal:${id}`;
}

function hashKey(id: string): string {
  return `memory:review:proposal:${id}`;
}

function normalizeSection(input: string | undefined): MemorySection {
  const value = input?.trim();
  if (value === "Joel") return value;
  if (value === "Miller Hooks") return value;
  if (value === "Conventions") return value;
  if (value === "Hard Rules") return value;
  if (value === "System Architecture") return value;
  if (value === "Patterns") return value;
  return "Hard Rules";
}

function extractDate(value: string | undefined): string | null {
  if (!value) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/u.exec(value);
  if (iso?.[1]) return iso[1];

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function extractDateFromProposal(proposal: Proposal): string {
  const fromTimestamp = extractDate(proposal.timestamp);
  if (fromTimestamp) return fromTimestamp;

  const idMatch = /^p-(\d{4})(\d{2})(\d{2})-\d+$/u.exec(proposal.id);
  if (idMatch?.[1] && idMatch[2] && idMatch[3]) {
    return `${idMatch[1]}-${idMatch[2]}-${idMatch[3]}`;
  }

  return new Date().toISOString().slice(0, 10);
}

function appendBulletToSection(markdown: string, section: MemorySection, bullet: string): string {
  const lines = markdown.split(/\r?\n/u);
  const header = `## ${section}`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  const fallbackHeaderIndex = lines.findIndex((line) => line.trim() === "## Hard Rules");
  const targetHeaderIndex = headerIndex >= 0 ? headerIndex : fallbackHeaderIndex;

  if (targetHeaderIndex < 0) {
    throw new Error(`Target section not found in MEMORY.md: ${section}`);
  }

  let sectionEnd = lines.length;
  for (let i = targetHeaderIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  let insertIndex = sectionEnd;
  while (insertIndex > targetHeaderIndex + 1 && (lines[insertIndex - 1]?.trim() ?? "") === "") {
    insertIndex -= 1;
  }

  lines.splice(insertIndex, 0, bullet);
  return lines.join("\n");
}

function mergeChanges(primary: string, secondary: string): string {
  const a = primary.trim();
  const b = secondary.trim();
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return a.length >= b.length ? `${a}\n${b}` : `${b}\n${a}`;
}

function toProposalRecord(input: Partial<Proposal> & { id: string }): Proposal {
  return {
    id: input.id,
    section: (input.section ?? "Hard Rules").trim(),
    change: (input.change ?? "").trim(),
    source: input.source?.trim(),
    timestamp: input.timestamp?.trim(),
  };
}

async function readProposal(redis: Redis, proposalId: string): Promise<Proposal | null> {
  const rawJson = await redis.get(jsonKey(proposalId));
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Partial<Proposal>;
      return toProposalRecord({ ...parsed, id: proposalId });
    } catch {
      // Fall through to hash format.
    }
  }

  const hash = await redis.hgetall(hashKey(proposalId));
  if (!hash || Object.keys(hash).length === 0) {
    return null;
  }

  return toProposalRecord({
    id: proposalId,
    section: hash.section,
    change: hash.change,
    source: hash.source,
    timestamp: hash.timestamp ?? hash.capturedAt ?? hash.date,
  });
}

async function writeProposal(redis: Redis, proposal: Proposal): Promise<void> {
  await redis.set(jsonKey(proposal.id), JSON.stringify(proposal));
  await redis.hset(
    hashKey(proposal.id),
    "id",
    proposal.id,
    "section",
    proposal.section,
    "change",
    proposal.change,
    "source",
    proposal.source ?? "",
    "timestamp",
    proposal.timestamp ?? "",
    "capturedAt",
    proposal.timestamp ?? ""
  );
}

async function deleteProposal(redis: Redis, proposalId: string): Promise<void> {
  await redis.lrem(REVIEW_PENDING_KEY, 0, proposalId);
  await redis.del(jsonKey(proposalId));
  await redis.del(hashKey(proposalId));
}

async function loadPendingProposals(redis: Redis, excludeId?: string): Promise<Proposal[]> {
  const ids = await redis.lrange(REVIEW_PENDING_KEY, 0, -1);
  const proposals: Proposal[] = [];

  for (const id of ids) {
    if (excludeId && id === excludeId) continue;
    const proposal = await readProposal(redis, id);
    if (proposal) proposals.push(proposal);
  }

  return proposals;
}

async function appendProposalToMemory(proposal: Proposal): Promise<void> {
  const memoryPath = getMemoryPath();
  const memoryFile = Bun.file(memoryPath);
  const memoryMarkdown = await memoryFile.text();

  const section = normalizeSection(proposal.section);
  const date = extractDateFromProposal(proposal);
  const bullet = `- (${date}) ${proposal.change.trim()}`;
  const nextMemory = appendBulletToSection(memoryMarkdown, section, bullet);

  const tmpPath = `${memoryPath}.tmp`;
  await Bun.write(tmpPath, nextMemory);
  await rename(tmpPath, memoryPath);
}

export const proposalTriage = inngest.createFunction(
  {
    id: "memory/proposal-triage",
    name: "Auto Triage Memory Proposal",
    concurrency: { limit: 1 },
  },
  { event: "memory/proposal.created" },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const eventId = (event as { id?: string }).id ?? null;
    let proposalId: string | null = null;

    await step.run("otel-proposal-triage-start", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "proposal-triage",
        action: "proposal-triage.started",
        success: true,
        metadata: {
          eventId,
        },
      });
    });

    try {
      const resolvedProposalId = await step.run("resolve-proposal-id", async () => {
        const idFromEvent = (event.data as { proposalId?: unknown }).proposalId;
        const id = typeof idFromEvent === "string" && idFromEvent.trim().length > 0
          ? idFromEvent
          : typeof (event.data as { id?: unknown }).id === "string"
            ? String((event.data as { id?: unknown }).id)
            : "";

        if (!id) {
          throw new Error("memory/proposal.created requires proposalId or id");
        }

        return id;
      });
      proposalId = resolvedProposalId;

      const triaged = await step.run("triage-proposal", async () => {
        const redis = getRedis();
        const proposal = await readProposal(redis, resolvedProposalId);
        if (!proposal) {
          return {
            action: "auto-reject" as const,
            reason: "proposal missing in redis",
            mergeWith: undefined,
          };
        }

        const memoryText = await Bun.file(getMemoryPath()).text();
        const pending = await loadPendingProposals(redis, resolvedProposalId);
        const result = triageProposal(proposal, memoryText, pending);

        if (result.action === "auto-promote") {
          // Don't append raw text — queue for LLM batch review (ADR-0068).
          // Sonnet reviews proposals against current MEMORY.md and outputs clean entries.
          const LLM_PENDING_KEY = "memory:review:llm-pending";
          await redis.rpush(LLM_PENDING_KEY, proposal.id);
          // Reclassify as llm-pending so downstream knows the path
          return {
            action: "llm-pending" as const,
            reason: result.reason + " — queued for LLM batch review",
            mergeWith: undefined,
          };
        } else if (result.action === "auto-reject") {
          await deleteProposal(redis, proposal.id);
        } else if (result.action === "auto-merge") {
          const mergeTargetId = result.mergeWith;
          if (!mergeTargetId) {
            return {
              action: "needs-review" as const,
              reason: "auto-merge target missing; requires manual review",
              mergeWith: undefined,
            };
          }

          const target = await readProposal(redis, mergeTargetId);
          if (!target) {
            return {
              action: "needs-review" as const,
              reason: `merge target ${mergeTargetId} missing; requires manual review`,
              mergeWith: undefined,
            };
          }

          const merged: Proposal = {
            ...target,
            change: mergeChanges(target.change, proposal.change),
            timestamp: target.timestamp ?? proposal.timestamp,
            source: target.source ?? proposal.source,
          };

          await writeProposal(redis, merged);
          await deleteProposal(redis, proposal.id);
        }

        return result;
      });

      console.log(`[memory/proposal-triage] ${proposalId} -> ${triaged.action}: ${triaged.reason}`);

      // Only create Todoist task for proposals that need human review.
      // Auto-promoted and auto-rejected proposals don't need tasks.
      // This prevents 50+ junk tasks per compaction from instruction-text artifacts.
      if (triaged.action === "needs-review") {
        await step.run("create-review-task", async () => {
          const redis = getRedis();
          const proposal = await readProposal(redis, resolvedProposalId);
          if (!proposal) return;

          const taskAdapter = new TodoistTaskAdapter();
          const summary = proposal.change.replace(/\s+/gu, " ").trim().slice(0, 90);
          const source = proposal.source?.trim() || "unknown";
          const capturedAt = proposal.timestamp?.trim() || "unknown";
          await taskAdapter.createTask({
            content: `Memory: ${proposal.section} (${resolvedProposalId}) — ${summary}`,
            description: [
              `Proposal: ${resolvedProposalId}`,
              `Section: ${proposal.section}`,
              `Reason: ${triaged.reason}`,
              `Source: ${source}`,
              `CapturedAt: ${capturedAt}`,
              "Decision: Complete = approve. Add @rejected label, then complete = reject.",
              "",
              "Change:",
              proposal.change,
            ].join("\n"),
            labels: ["memory-review", "agent"],
            projectId: "Agent Work",
            priority: 4,
            dueString: "today",
          });
        });
      }

      const triagedMergeWith = "mergeWith" in triaged ? triaged.mergeWith : undefined;

      await step.sendEvent("emit-triage-result", {
        name: "memory/proposal.triaged",
        data: {
          proposalId: resolvedProposalId,
          action: triaged.action,
          reason: triaged.reason,
          mergeWith: triagedMergeWith,
          triagedAt: new Date().toISOString(),
        },
      });

      const result = {
        proposalId: resolvedProposalId,
        ...triaged,
      };

      await step.run("otel-proposal-triage-completed", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "proposal-triage",
          action: "proposal-triage.completed",
          success: true,
          duration_ms: Date.now() - startedAt,
          metadata: {
            eventId,
            proposalId,
            proposalCount: 1,
            action: triaged.action,
            mergeWith: triagedMergeWith ?? null,
          },
        });
      });

      return result;
    } catch (error) {
      await step.run("otel-proposal-triage-failed", async () => {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "proposal-triage",
          action: "proposal-triage.failed",
          success: false,
          error: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - startedAt,
          metadata: {
            eventId,
            proposalId,
            proposalCount: proposalId ? 1 : 0,
          },
        });
      });
      throw error;
    }
  }
);
