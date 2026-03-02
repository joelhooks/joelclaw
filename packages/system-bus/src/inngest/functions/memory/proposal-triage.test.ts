import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";
import { TodoistTaskAdapter } from "../../../tasks/adapters/todoist";
import type { CreateTaskInput, Task } from "../../../tasks/port";
import { proposalTriage } from "./proposal-triage";

const REVIEW_PENDING_KEY = "memory:review:pending";

const originalRedisMethods = {
  get: Redis.prototype.get,
  set: Redis.prototype.set,
  hgetall: Redis.prototype.hgetall,
  hset: Redis.prototype.hset,
  lrange: Redis.prototype.lrange,
  lrem: Redis.prototype.lrem,
  del: Redis.prototype.del,
  rpush: Redis.prototype.rpush,
};

const originalTodoistCreateTask = TodoistTaskAdapter.prototype.createTask;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalOtelEnabled = process.env.OTEL_EVENTS_ENABLED;

const redisStrings = new Map<string, string>();
const redisHashes = new Map<string, Record<string, string>>();
const redisLists = new Map<string, string[]>();

let tempHome = "";
let createTaskCalls: CreateTaskInput[] = [];
let createTaskError: Error | null = null;

function upsertHash(key: string, args: unknown[]): number {
  const existing = redisHashes.get(key) ?? {};

  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    Object.entries(args[0] as Record<string, unknown>).forEach(([field, value]) => {
      existing[field] = String(value ?? "");
    });
    redisHashes.set(key, existing);
    return Object.keys(existing).length;
  }

  for (let i = 0; i < args.length; i += 2) {
    const field = args[i];
    if (field == null) continue;
    existing[String(field)] = String(args[i + 1] ?? "");
  }

  redisHashes.set(key, existing);
  return Object.keys(existing).length;
}

function getList(key: string): string[] {
  return redisLists.get(key) ?? [];
}

function setList(key: string, values: string[]): void {
  redisLists.set(key, [...values]);
}

function stageProposal(proposal: {
  id: string;
  section: string;
  change: string;
  source?: string;
  timestamp?: string;
}): void {
  redisStrings.set(`memory:proposal:${proposal.id}`, JSON.stringify(proposal));
  setList(REVIEW_PENDING_KEY, [proposal.id]);
}

async function executeProposalTriage(proposalId: string) {
  const sendEventCalls: Array<{ name: string; data: Record<string, unknown> }> = [];

  const step = {
    run: async (_stepId: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: async (_stepId: string, payload: { name: string; data: Record<string, unknown> }) => {
      sendEventCalls.push(payload);
      return { ids: ["evt-test-1"] };
    },
  };

  const result = await (proposalTriage as any).fn({
    event: {
      id: "evt-test-proposal-triage",
      name: "memory/proposal.created",
      data: { proposalId },
    },
    step,
  });

  return { result, sendEventCalls };
}

beforeAll(() => {
  (Redis.prototype as any).get = async function (key: string) {
    return redisStrings.get(String(key)) ?? null;
  };

  (Redis.prototype as any).set = async function (key: string, value: unknown) {
    redisStrings.set(String(key), String(value ?? ""));
    return "OK";
  };

  (Redis.prototype as any).hgetall = async function (key: string) {
    return { ...(redisHashes.get(String(key)) ?? {}) };
  };

  (Redis.prototype as any).hset = async function (key: string, ...args: unknown[]) {
    return upsertHash(String(key), args);
  };

  (Redis.prototype as any).lrange = async function (key: string, start: number, stop: number) {
    const list = getList(String(key));
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  };

  (Redis.prototype as any).lrem = async function (key: string, count: number, value: string) {
    const list = getList(String(key));
    const next = [...list];
    let removed = 0;

    if (count === 0) {
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i] === value) {
          next.splice(i, 1);
          removed += 1;
        }
      }
    } else {
      for (let i = 0; i < next.length && removed < Math.abs(count); i += 1) {
        if (next[i] === value) {
          next.splice(i, 1);
          removed += 1;
          i -= 1;
        }
      }
    }

    setList(String(key), next);
    return removed;
  };

  (Redis.prototype as any).del = async function (...keys: string[]) {
    let removed = 0;
    for (const key of keys) {
      const normalized = String(key);
      if (redisStrings.delete(normalized)) removed += 1;
      if (redisHashes.delete(normalized)) removed += 1;
      if (redisLists.delete(normalized)) removed += 1;
    }
    return removed;
  };

  (Redis.prototype as any).rpush = async function (key: string, ...values: string[]) {
    const list = getList(String(key));
    const next = [...list, ...values.map((value) => String(value))];
    setList(String(key), next);
    return next.length;
  };

  (TodoistTaskAdapter.prototype as any).createTask = async function (task: CreateTaskInput) {
    createTaskCalls.push(task);
    if (createTaskError) throw createTaskError;

    return {
      id: `mock-task-${createTaskCalls.length}`,
      content: task.content,
      description: task.description,
      priority: task.priority ?? 1,
      due: task.due,
      dueString: task.dueString,
      isRecurring: false,
      deadline: task.deadline,
      completed: false,
      projectId: task.projectId,
      sectionId: task.sectionId,
      parentId: task.parentId,
      labels: task.labels ?? [],
      url: "",
      createdAt: new Date(),
    } satisfies Task;
  };
});

afterAll(() => {
  Object.assign(Redis.prototype, originalRedisMethods);
  TodoistTaskAdapter.prototype.createTask = originalTodoistCreateTask;
});

beforeEach(() => {
  redisStrings.clear();
  redisHashes.clear();
  redisLists.clear();
  createTaskCalls = [];
  createTaskError = null;

  tempHome = mkdtempSync(join(tmpdir(), "proposal-triage-home-"));
  const workspaceDir = join(tempHome, ".joelclaw", "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "MEMORY.md"), "# MEMORY\n\n- Keep this tidy.\n", "utf8");

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.OTEL_EVENTS_ENABLED = "0";
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  if (originalOtelEnabled === undefined) delete process.env.OTEL_EVENTS_ENABLED;
  else process.env.OTEL_EVENTS_ENABLED = originalOtelEnabled;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("memory/proposal-triage review task reliability", () => {
  test("completes triage when Todoist task creation returns 403", async () => {
    const proposalId = "p-20260302-403";
    stageProposal({
      id: proposalId,
      section: "System Architecture",
      change: "Need explicit review for this ambiguous policy update.",
      source: "reflect",
      timestamp: "2026-03-02T18:00:00.000Z",
    });

    createTaskError = new Error("todoist-cli add failed (1): {\"ok\":false,\"error\":\"add failed: HTTP 403: Forbidden\"}");

    const { result, sendEventCalls } = await executeProposalTriage(proposalId);
    const reviewHash = redisHashes.get(`memory:review:proposal:${proposalId}`) ?? {};

    expect(result).toMatchObject({
      proposalId,
      action: "needs-review",
      reviewTask: {
        attempted: true,
        created: false,
        authFailure: true,
      },
    });

    expect(reviewHash).toMatchObject({
      reviewTaskStatus: "failed",
    });
    expect(reviewHash.reviewTaskError).toContain("HTTP 403");

    expect(sendEventCalls[0]).toMatchObject({
      name: "memory/proposal.triaged",
      data: {
        proposalId,
        action: "needs-review",
      },
    });
  });

  test("records created review task metadata when Todoist task succeeds", async () => {
    const proposalId = "p-20260302-ok";
    stageProposal({
      id: proposalId,
      section: "Patterns",
      change: "Unclear preference call that still needs manual review.",
      source: "reflect",
      timestamp: "2026-03-02T19:00:00.000Z",
    });

    const { result } = await executeProposalTriage(proposalId);
    const reviewHash = redisHashes.get(`memory:review:proposal:${proposalId}`) ?? {};

    expect(result).toMatchObject({
      proposalId,
      action: "needs-review",
      reviewTask: {
        attempted: true,
        created: true,
        authFailure: false,
      },
    });

    expect(reviewHash).toMatchObject({
      reviewTaskStatus: "created",
      reviewTaskId: "mock-task-1",
    });
    expect(createTaskCalls).toHaveLength(1);
  });
});
