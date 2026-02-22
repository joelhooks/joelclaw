import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import * as promoteModule from "./promote";
import { archiveProposal, expireProposal, promote, promoteToMemory } from "./promote";

type RedisMockState = {
  hashes: Map<string, Record<string, string>>;
  lists: Map<string, string[]>;
};

const REVIEW_PENDING_KEY = "memory:review:pending";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPath = process.env.PATH;
const originalRedisMethods = {
  lrange: Redis.prototype.lrange,
  hgetall: Redis.prototype.hgetall,
  hset: Redis.prototype.hset,
  lrem: (Redis.prototype as { lrem?: unknown }).lrem,
  del: Redis.prototype.del,
  rpush: Redis.prototype.rpush,
};
const originalTodoistMethods = {
  listTasks: TodoistTaskAdapter.prototype.listTasks,
  completeTask: TodoistTaskAdapter.prototype.completeTask,
};

let redisState: RedisMockState = {
  hashes: new Map(),
  lists: new Map(),
};

let tempHome = "";
let workspaceDir = "";
let reviewPath = "";
let memoryPath = "";
let todoistTasks: Array<{ id: string; description?: string }> = [];
let completedTodoistTaskIds: string[] = [];

function proposalKey(id: string): string {
  return `memory:review:proposal:${id}`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compactDate(date: Date): string {
  return isoDate(date).replaceAll("-", "");
}

function proposalIdDaysAgo(daysAgo: number, seq = "001"): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `p-${compactDate(d)}-${seq}`;
}

function todayLogPath(): string {
  return join(workspaceDir, "memory", `${isoDate(new Date())}.md`);
}

function writeWorkspaceFiles(reviewMarkdown: string): void {
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });

  writeFileSync(
    memoryPath,
    [
      "# Team Memory",
      "",
      "## Hard Rules",
      "- Existing hard rule.",
      "",
      "## System Architecture",
      "- Existing architecture note.",
      "",
      "## Patterns",
      "- Existing pattern note.",
      "",
    ].join("\n")
  );

  writeFileSync(reviewPath, reviewMarkdown);
}

function putProposal(id: string, fields: Record<string, string>): void {
  redisState.hashes.set(proposalKey(id), {
    id,
    status: "pending",
    ...fields,
  });
}

async function executePromoteWithEvent(event: { name: string; data: Record<string, unknown> }) {
  const engine = new InngestTestEngine({
    function: promote as any,
    events: [event as any],
  });
  return engine.execute();
}

beforeAll(() => {
  (Redis.prototype as any).lrange = async function (key: string, start: number, stop: number) {
    const list = redisState.lists.get(String(key)) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  };

  (Redis.prototype as any).hgetall = async function (key: string) {
    return { ...(redisState.hashes.get(String(key)) ?? {}) };
  };

  (Redis.prototype as any).hset = async function (key: string, ...args: string[]) {
    const existing = redisState.hashes.get(String(key)) ?? {};
    for (let i = 0; i < args.length; i += 2) {
      const field = args[i];
      const value = args[i + 1];
      if (field === undefined) continue;
      existing[String(field)] = String(value ?? "");
    }
    redisState.hashes.set(String(key), existing);
    return Object.keys(existing).length;
  };

  (Redis.prototype as any).lrem = async function (key: string, count: number, value: string) {
    const list = redisState.lists.get(String(key)) ?? [];
    const target = String(value);

    if (count === 0) {
      const next = list.filter((item) => item !== target);
      redisState.lists.set(String(key), next);
      return list.length - next.length;
    }

    const next = [...list];
    const limit = Math.abs(count);
    let removed = 0;

    if (count > 0) {
      for (let i = 0; i < next.length && removed < limit; i += 1) {
        if (next[i] === target) {
          next.splice(i, 1);
          i -= 1;
          removed += 1;
        }
      }
    } else {
      for (let i = next.length - 1; i >= 0 && removed < limit; i -= 1) {
        if (next[i] === target) {
          next.splice(i, 1);
          removed += 1;
        }
      }
    }

    redisState.lists.set(String(key), next);
    return removed;
  };

  (Redis.prototype as any).del = async function (...keys: string[]) {
    let deleted = 0;
    for (const key of keys.map(String)) {
      if (redisState.hashes.delete(key)) deleted += 1;
      if (redisState.lists.delete(key)) deleted += 1;
    }
    return deleted;
  };

  (Redis.prototype as any).rpush = async function (key: string, ...values: string[]) {
    const list = redisState.lists.get(String(key)) ?? [];
    list.push(...values.map(String));
    redisState.lists.set(String(key), list);
    return list.length;
  };

  (TodoistTaskAdapter.prototype as any).listTasks = async function () {
    return todoistTasks.map((task) => ({
      id: task.id,
      content: "",
      description: task.description,
      priority: 1,
      completed: false,
      labels: [],
      url: "",
      createdAt: new Date(0),
    }));
  };

  (TodoistTaskAdapter.prototype as any).completeTask = async function (id: string) {
    completedTodoistTaskIds.push(String(id));
  };
});

afterAll(() => {
  Redis.prototype.lrange = originalRedisMethods.lrange;
  Redis.prototype.hgetall = originalRedisMethods.hgetall;
  Redis.prototype.hset = originalRedisMethods.hset;
  (Redis.prototype as { lrem?: unknown }).lrem = originalRedisMethods.lrem;
  Redis.prototype.del = originalRedisMethods.del;
  Redis.prototype.rpush = originalRedisMethods.rpush;
  TodoistTaskAdapter.prototype.listTasks = originalTodoistMethods.listTasks;
  TodoistTaskAdapter.prototype.completeTask = originalTodoistMethods.completeTask;
});

beforeEach(() => {
  redisState = {
    hashes: new Map(),
    lists: new Map(),
  };
  todoistTasks = [];
  completedTodoistTaskIds = [];

  tempHome = mkdtempSync(join(tmpdir(), "mem-3-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  workspaceDir = join(tempHome, ".joelclaw", "workspace");
  reviewPath = join(workspaceDir, "REVIEW.md");
  memoryPath = join(workspaceDir, "MEMORY.md");

  const shimBinDir = join(tempHome, "bin");
  const piShimPath = join(shimBinDir, "pi");
  mkdirSync(shimBinDir, { recursive: true });
  writeFileSync(
    piShimPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "exit 0",
    ].join("\n")
  );
  Bun.spawnSync(["chmod", "+x", piShimPath]);
  process.env.PATH = `${shimBinDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("MEM-3 promote acceptance tests", () => {
  test("exports public promotion operations and does not export REVIEW parser helpers", () => {
    const exportsMap = promoteModule as Record<string, unknown>;

    expect({
      promoteToMemory: typeof exportsMap.promoteToMemory,
      archiveProposal: typeof exportsMap.archiveProposal,
      expireProposal: typeof exportsMap.expireProposal,
    }).toMatchObject({
      promoteToMemory: "function",
      archiveProposal: "function",
      expireProposal: "function",
    });

    expect({
      parseReviewMd: "parseReviewMd" in exportsMap,
      getReviewPath: "getReviewPath" in exportsMap,
      removeProposalFromReview: "removeProposalFromReview" in exportsMap,
      extractContentPath: "extractContentPath" in exportsMap,
    }).toMatchObject({
      parseReviewMd: false,
      getReviewPath: false,
      removeProposalFromReview: false,
      extractContentPath: false,
    });
  });

  test("registers approved/rejected event triggers and retains daily 8 AM cron trigger", () => {
    const triggerDefs = (((promote as any).opts?.triggers ?? []) as Array<Record<string, unknown>>).map((trigger) => ({
      event: trigger.event,
      cron: trigger.cron,
    }));

    expect({
      hasApprovedTrigger: triggerDefs.some((trigger) => trigger.event === "memory/proposal.approved"),
      hasRejectedTrigger: triggerDefs.some((trigger) => trigger.event === "memory/proposal.rejected"),
      hasDailyCronTrigger: triggerDefs.some((trigger) => trigger.cron === "0 8 * * *"),
      hasLegacyContentUpdatedTrigger: triggerDefs.some((trigger) => trigger.event === "content/updated"),
    }).toMatchObject({
      hasApprovedTrigger: true,
      hasRejectedTrigger: true,
      hasDailyCronTrigger: true,
      hasLegacyContentUpdatedTrigger: false,
    });
  });

  test("approved proposal event promotes memory and leaves REVIEW.md untouched", async () => {
    const approvedId = proposalIdDaysAgo(1, "101");
    const approvedText = "Approved proposal written to memory from event trigger.";
    const initialReview = ["# REVIEW Staging", `- [ ] ${approvedId}: ${approvedText}`, ""].join("\n");

    writeWorkspaceFiles(initialReview);
    redisState.lists.set(REVIEW_PENDING_KEY, [approvedId]);
    putProposal(approvedId, {
      targetSection: "Hard Rules",
      proposedText: approvedText,
      capturedAt: new Date().toISOString(),
    });

    await executePromoteWithEvent({
      name: "memory/proposal.approved",
      data: {
        proposalId: approvedId,
        approvedBy: "acceptance-test",
      },
    });

    const memory = readFileSync(memoryPath, "utf8");
    const review = readFileSync(reviewPath, "utf8");

    expect({
      memoryContainsApprovedText: memory.includes(approvedText),
      reviewUnchanged: review === initialReview,
      pendingIds: redisState.lists.get(REVIEW_PENDING_KEY) ?? [],
      proposalExists: redisState.hashes.has(proposalKey(approvedId)),
    }).toMatchObject({
      memoryContainsApprovedText: true,
      reviewUnchanged: true,
      pendingIds: [],
      proposalExists: false,
    });
  });

  test("rejected proposal event archives reason and leaves REVIEW.md untouched", async () => {
    const rejectedId = proposalIdDaysAgo(1, "102");
    const rejectedText = "Rejected proposal should be logged with explicit reason.";
    const rejectReason = "insufficient evidence";
    const initialReview = ["# REVIEW Staging", `- [ ] ${rejectedId}: ${rejectedText}`, ""].join("\n");

    writeWorkspaceFiles(initialReview);
    redisState.lists.set(REVIEW_PENDING_KEY, [rejectedId]);
    putProposal(rejectedId, {
      proposedText: rejectedText,
      capturedAt: new Date().toISOString(),
    });

    await executePromoteWithEvent({
      name: "memory/proposal.rejected",
      data: {
        proposalId: rejectedId,
        reason: rejectReason,
        rejectedBy: "acceptance-test",
      },
    });

    const log = readFileSync(todayLogPath(), "utf8");
    const review = readFileSync(reviewPath, "utf8");

    expect({
      logContainsHeader: log.includes("### Rejected Proposals"),
      logContainsReason: log.includes(`${rejectedId}: ${rejectedText} [reason: ${rejectReason}]`),
      reviewUnchanged: review === initialReview,
      pendingIds: redisState.lists.get(REVIEW_PENDING_KEY) ?? [],
      proposalExists: redisState.hashes.has(proposalKey(rejectedId)),
    }).toMatchObject({
      logContainsHeader: true,
      logContainsReason: true,
      reviewUnchanged: true,
      pendingIds: [],
      proposalExists: false,
    });
  });

  test("cron trigger auto-expires proposals older than 7 days", async () => {
    const staleId = proposalIdDaysAgo(8, "201");
    const recentId = proposalIdDaysAgo(2, "202");
    const initialReview = [
      "# REVIEW Staging",
      `- [ ] ${staleId}: stale proposal`,
      `- [ ] ${recentId}: recent proposal`,
      "",
    ].join("\n");

    writeWorkspaceFiles(initialReview);
    redisState.lists.set(REVIEW_PENDING_KEY, [staleId, recentId]);
    putProposal(staleId, {
      proposedText: "stale proposal",
      capturedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    putProposal(recentId, {
      proposedText: "recent proposal",
      capturedAt: new Date().toISOString(),
    });
    todoistTasks = [
      {
        id: "todo-stale",
        description: `Proposal: ${staleId}\nSection: Patterns`,
      },
      {
        id: "todo-recent",
        description: `Proposal: ${recentId}\nSection: Patterns`,
      },
    ];

    await executePromoteWithEvent({
      name: "inngest/scheduled.timer",
      data: { cron: "0 8 * * *" },
    });

    const log = readFileSync(todayLogPath(), "utf8");
    const review = readFileSync(reviewPath, "utf8");

    expect({
      logContainsExpiredHeader: log.includes("### Expired Proposals"),
      logContainsStaleId: log.includes(staleId),
      logContainsRecentId: log.includes(recentId),
      reviewUnchanged: review === initialReview,
      pendingIds: redisState.lists.get(REVIEW_PENDING_KEY) ?? [],
      staleExists: redisState.hashes.has(proposalKey(staleId)),
      recentExists: redisState.hashes.has(proposalKey(recentId)),
      completedTodoistTaskIds,
    }).toMatchObject({
      logContainsExpiredHeader: true,
      logContainsStaleId: true,
      logContainsRecentId: false,
      reviewUnchanged: true,
      pendingIds: [recentId],
      staleExists: false,
      recentExists: true,
      completedTodoistTaskIds: ["todo-stale"],
    });
  });

  test("direct public operations do not mutate REVIEW.md", async () => {
    const promotedId = proposalIdDaysAgo(1, "301");
    const archivedId = proposalIdDaysAgo(1, "302");
    const expiredId = proposalIdDaysAgo(9, "303");
    const initialReview = [
      "# REVIEW Staging",
      `- [ ] ${promotedId}: promote candidate`,
      `- [ ] ${archivedId}: archive candidate`,
      `- [ ] ${expiredId}: expire candidate`,
      "",
    ].join("\n");

    writeWorkspaceFiles(initialReview);
    redisState.lists.set(REVIEW_PENDING_KEY, [promotedId, archivedId, expiredId]);

    putProposal(promotedId, {
      targetSection: "Patterns",
      proposedText: "promote candidate",
      capturedAt: new Date().toISOString(),
    });
    putProposal(archivedId, {
      proposedText: "archive candidate",
      capturedAt: new Date().toISOString(),
    });
    putProposal(expiredId, {
      proposedText: "expire candidate",
      capturedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await promoteToMemory(promotedId);
    await archiveProposal(archivedId, "deleted");
    await expireProposal(expiredId);

    const review = readFileSync(reviewPath, "utf8");

    expect({ reviewUnchanged: review === initialReview }).toMatchObject({
      reviewUnchanged: true,
    });
  });
});
