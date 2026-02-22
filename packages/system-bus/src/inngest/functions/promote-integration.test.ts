import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import { promote } from "./promote";

type RedisMockState = {
  hashes: Map<string, Record<string, string>>;
  lists: Map<string, string[]>;
};

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
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
const originalSpawn = Bun.spawn;

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

let redisState: RedisMockState = {
  hashes: new Map(),
  lists: new Map(),
};

let tempHome = "";
let workspaceDir = "";
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

function proposalDateFromId(id: string): string {
  const match = /^p-(\d{4})(\d{2})(\d{2})-\d{3,}$/u.exec(id);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid proposal id for date extraction: ${id}`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function todayLogPath(): string {
  return join(workspaceDir, "memory", `${isoDate(new Date())}.md`);
}

function putProposal(id: string, fields: Record<string, string>): void {
  redisState.hashes.set(proposalKey(id), {
    id,
    status: "pending",
    ...fields,
  });
}

function getSectionBlock(markdown: string, sectionTitle: string): string {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${sectionTitle}`);
  if (start === -1) return "";

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").startsWith("## ")) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
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

  Bun.spawn = ((args: string[]) => {
    if (args[0] === "pi") {
      const output = `- (promoted) ${args.includes("--system-prompt") ? "formatted" : "formatted"}`;
      return {
        stdout: textStream(`${output}\n`),
        stderr: textStream(""),
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }

    return originalSpawn(args) as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
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
  Bun.spawn = originalSpawn;
});

beforeEach(() => {
  redisState = {
    hashes: new Map(),
    lists: new Map(),
  };
  todoistTasks = [];
  completedTodoistTaskIds = [];

  tempHome = mkdtempSync(join(tmpdir(), "mem-22-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  workspaceDir = join(tempHome, ".joelclaw", "workspace");
  memoryPath = join(workspaceDir, "MEMORY.md");

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
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("MEM-22 promote integration acceptance test", () => {
  test("runs end-to-end promotion workflow through event-driven handlers with no proposal loss", async () => {
    const approvedId = proposalIdDaysAgo(1, "101");
    const deletedId = proposalIdDaysAgo(1, "102");
    const expiredId = proposalIdDaysAgo(8, "103");
    const activePendingId = proposalIdDaysAgo(2, "104");

    const approvedText = "Hard rule: preserve externally observable behavior in acceptance tests.";
    const deletedText = "Architecture note removed during review.";
    const expiredText = "Pattern proposal that expired after remaining unchecked for 8 days.";
    const activePendingText = "Recent unchecked proposal should stay pending.";

    redisState.lists.set("memory:review:pending", [approvedId, deletedId, expiredId, activePendingId]);

    putProposal(approvedId, {
      targetSection: "Hard Rules",
      proposedText: approvedText,
      capturedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    putProposal(deletedId, {
      targetSection: "System Architecture",
      proposedText: deletedText,
      capturedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    putProposal(expiredId, {
      targetSection: "Patterns",
      proposedText: expiredText,
      capturedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    putProposal(activePendingId, {
      targetSection: "Patterns",
      proposedText: activePendingText,
      capturedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    todoistTasks = [
      {
        id: "task-expired",
        description: `Proposal: ${expiredId}\nSection: Patterns`,
      },
      {
        id: "task-active",
        description: `Proposal: ${activePendingId}\nSection: Patterns`,
      },
    ];

    const { result: approvedResult } = await executePromoteWithEvent({
      name: "memory/proposal.approved",
      data: { proposalId: approvedId },
    });
    const { result: rejectedResult } = await executePromoteWithEvent({
      name: "memory/proposal.rejected",
      data: { proposalId: deletedId, reason: "deleted" },
    });
    const { result: expiredResult } = await executePromoteWithEvent({
      name: "inngest/scheduled.timer",
      data: { cron: "0 8 * * *" },
    });

    const memory = readFileSync(memoryPath, "utf8");
    const hardRules = getSectionBlock(memory, "Hard Rules");
    const log = readFileSync(todayLogPath(), "utf8");

    expect(approvedResult).toMatchObject({
      approved: [approvedId],
    });
    expect(rejectedResult).toMatchObject({
      rejected: [deletedId],
      reason: "deleted",
    });
    expect(expiredResult).toMatchObject({
      expired: [expiredId],
    });

    expect(hardRules).toContain(`- (${proposalDateFromId(approvedId)})`);
    expect(log).toContain("### Rejected Proposals");
    expect(log).toContain(`${deletedId}: ${deletedText} [reason: deleted]`);
    expect(log).toContain("### Expired Proposals");
    expect(log).toContain(`${expiredId}: ${expiredText}`);

    expect(redisState.lists.get("memory:review:pending") ?? []).toMatchObject([activePendingId]);
    expect(redisState.hashes.has(proposalKey(activePendingId))).toBe(true);
    expect(redisState.hashes.has(proposalKey(approvedId))).toBe(false);
    expect(redisState.hashes.has(proposalKey(deletedId))).toBe(false);
    expect(redisState.hashes.has(proposalKey(expiredId))).toBe(false);
    expect(completedTodoistTaskIds).toEqual(["task-expired"]);

    expect({
      approvedInMemory: hardRules.includes(`- (${proposalDateFromId(approvedId)})`),
      deletedInDailyLog: log.includes(deletedId),
      expiredInDailyLog: log.includes(expiredId),
      activePendingInRedis:
        (redisState.lists.get("memory:review:pending") ?? []).includes(activePendingId) &&
        redisState.hashes.has(proposalKey(activePendingId)),
    }).toMatchObject({
      approvedInMemory: true,
      deletedInDailyLog: true,
      expiredInDailyLog: true,
      activePendingInRedis: true,
    });
  });
});
