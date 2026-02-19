import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPRESSION_GUIDANCE, validateCompression } from "./reflect-prompt";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import type { CreateTaskInput, Task } from "../../tasks/port";

type MockShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const originalRedisMethods = {
  lrange: Redis.prototype.lrange,
  rpush: Redis.prototype.rpush,
  hset: Redis.prototype.hset,
  hmset: (Redis.prototype as { hmset?: unknown }).hmset,
};
const originalBunDollar = Bun.$;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalTodoistCreateTask = TodoistTaskAdapter.prototype.createTask;

const redisLists = new Map<string, string[]>();
const redisHashes = new Map<string, Record<string, string>>();
let shellCalls: string[] = [];
let shellResultQueue: MockShellResult[] = [];
let todoistCreateTaskCalls: CreateTaskInput[] = [];
let tempHome = "";

function buildCommandText(strings: TemplateStringsArray, values: unknown[]): string {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i] ?? "";
    if (i < values.length) out += String(values[i] ?? "");
  }
  return out;
}

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

function findReflectFunctionExport(mod: Record<string, unknown>) {
  const reflectFn = Object.values(mod).find((value) => {
    const candidate = value as { opts?: { triggers?: unknown[] } };
    return Array.isArray(candidate?.opts?.triggers);
  });
  if (!reflectFn) {
    throw new Error("Could not find reflect function export");
  }
  return reflectFn;
}

async function executeReflect(eventDate = "2026-02-17") {
  const mod = await import("./reflect.ts");
  const reflectFn = findReflectFunctionExport(mod as Record<string, unknown>);
  const engine = new InngestTestEngine({
    function: reflectFn as any,
    events: [
      {
        name: "memory/observations.accumulated",
        data: {
          date: eventDate,
          totalTokens: 200,
          observationCount: 2,
          capturedAt: `${eventDate}T06:00:00.000Z`,
        },
      },
    ],
  });
  return engine.execute();
}

async function executeReflectFromCron() {
  const mod = await import("./reflect.ts");
  const reflectFn = findReflectFunctionExport(mod as Record<string, unknown>);
  const engine = new InngestTestEngine({
    function: reflectFn as any,
    events: [
      {
        name: "inngest/scheduled.timer",
        data: {
          cron: "0 6 * * *",
        },
      } as any,
    ],
  });
  return engine.execute();
}

function countReflectedBlocks(markdown: string): number {
  return markdown.split("### 🔭 Reflected").length - 1;
}

beforeAll(() => {
  (Redis.prototype as any).lrange = async function (key: string, start: number, stop: number) {
    const list = redisLists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  };

  (Redis.prototype as any).rpush = async function (key: string, ...values: string[]) {
    const list = redisLists.get(key) ?? [];
    list.push(...values.map((value) => String(value)));
    redisLists.set(key, list);
    return list.length;
  };

  (Redis.prototype as any).hset = async function (key: string, ...args: unknown[]) {
    return upsertHash(String(key), args);
  };

  (Redis.prototype as any).hmset = async function (key: string, ...args: unknown[]) {
    return upsertHash(String(key), args);
  };

  // @ts-expect-error test monkey patch for deterministic subprocess behavior.
  Bun.$ = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    shellCalls.push(buildCommandText(strings, values));
    const next = shellResultQueue.shift() ?? {
      exitCode: 0,
      stdout: "<proposals></proposals>",
      stderr: "",
    };

    return {
      quiet() {
        return this;
      },
      async nothrow() {
        return next;
      },
    };
  }) as typeof Bun.$;

  (TodoistTaskAdapter.prototype as any).createTask = async function (task: CreateTaskInput) {
    todoistCreateTaskCalls.push(task);
    return {
      id: `mock-task-${todoistCreateTaskCalls.length}`,
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
  Bun.$ = originalBunDollar;
  TodoistTaskAdapter.prototype.createTask = originalTodoistCreateTask;
});

beforeEach(() => {
  redisLists.clear();
  redisHashes.clear();
  shellCalls = [];
  shellResultQueue = [];
  todoistCreateTaskCalls = [];
  tempHome = mkdtempSync(join(tmpdir(), "mem-16-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("MEM-16 reflect acceptance tests", () => {
  test("validateCompression returns true only when output tokens are lower", () => {
    expect(validateCompression(100, 99)).toBe(true);
    expect(validateCompression(100, 100)).toBe(false);
    expect(validateCompression(100, 120)).toBe(false);
  });

  test("COMPRESSION_GUIDANCE has exactly three levels", () => {
    expect(COMPRESSION_GUIDANCE).toHaveLength(3);
    expect(COMPRESSION_GUIDANCE).toMatchObject([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
  });

  test("mock Redis LRANGE supplies observation entries used by reflect run", async () => {
    redisLists.set("memory:observations:2026-02-17", [
      JSON.stringify({ summary: "Observation from Redis list entry." }),
    ]);

    shellResultQueue = [
      {
        exitCode: 0,
        stdout: "<proposals><proposal><section>Facts</section><change>Keep it concise.</change></proposal></proposals>",
        stderr: "",
      },
    ];

    const { result } = await executeReflect("2026-02-17");

    expect(shellCalls[0]).toContain("Observation from Redis list entry.");
    expect(result).toMatchObject({
      raw: expect.any(String),
      proposalCount: expect.any(Number),
      retryLevel: expect.any(Number),
    });
  });

  test("proposal IDs are deterministic and follow p-YYYYMMDD-NNN format", async () => {
    redisLists.set("memory:review:pending", ["p-20260217-009"]);
    redisLists.set("memory:observations:2026-02-17", [
      JSON.stringify({ summary: "ID formatting must be deterministic." }),
    ]);

    shellResultQueue = [
      {
        exitCode: 0,
        stdout: `<proposals>
  <proposal><section>Constraints</section><change>First change.</change></proposal>
  <proposal><section>Preferences</section><change>Second change.</change></proposal>
</proposals>`,
        stderr: "",
      },
    ];

    await executeReflect("2026-02-17");
    const pending = redisLists.get("memory:review:pending") ?? [];
    const newIds = pending.slice(-2);

    expect(newIds).toMatchObject(["p-20260217-010", "p-20260217-011"]);
    for (const id of newIds) {
      const [prefix, datePart, seqPart] = id.split("-");
      expect(prefix).toBe("p");
      expect(datePart).toHaveLength(8);
      expect(Number.isFinite(Number(datePart))).toBe(true);
      expect(seqPart).toHaveLength(3);
      expect(Number.isFinite(Number(seqPart))).toBe(true);
    }
  });

  test("stage-review writes proposals to Redis and appends daily log metadata", async () => {
    redisLists.set("memory:observations:2026-02-17", [
      JSON.stringify({ summary: "Prepare review structure test." }),
    ]);

    shellResultQueue = [
      {
        exitCode: 0,
        stdout: `<proposals>
  <proposal><section>Constraints</section><change>Retain strict acceptance coverage.</change></proposal>
  <proposal><section>Preferences</section><change>Prefer behavior-based assertions.</change></proposal>
</proposals>`,
        stderr: "",
      },
    ];

    const { result } = await executeReflect("2026-02-17");
    const pending = redisLists.get("memory:review:pending") ?? [];
    const proposalOne = redisHashes.get("memory:review:proposal:p-20260217-001") ?? {};
    const proposalTwo = redisHashes.get("memory:review:proposal:p-20260217-002") ?? {};

    expect(pending).toMatchObject(["p-20260217-001", "p-20260217-002"]);
    expect(proposalOne).toMatchObject({
      id: "p-20260217-001",
      date: "2026-02-17",
      section: "Constraints",
      change: "Retain strict acceptance coverage.",
      status: "pending",
      capturedAt: expect.any(String),
    });
    expect(proposalTwo).toMatchObject({
      id: "p-20260217-002",
      date: "2026-02-17",
      section: "Preferences",
      change: "Prefer behavior-based assertions.",
      status: "pending",
      capturedAt: expect.any(String),
    });
    expect(result).toMatchObject({
      proposalCount: 2,
      dailyLogPath: expect.any(String),
      emittedEvent: {
        name: "memory/observations.reflected",
        data: {
          date: "2026-02-17",
          proposalCount: 2,
        },
      },
    });

    expect(todoistCreateTaskCalls).toHaveLength(2);
    expect(todoistCreateTaskCalls[0]).toMatchObject({
      content: "Memory: Retain strict acceptance coverage. → Constraints",
      description: expect.stringContaining("Proposal: p-20260217-001"),
      labels: ["memory-review", "agent"],
      projectId: "Agent Work",
    });
    expect(todoistCreateTaskCalls[1]).toMatchObject({
      content: "Memory: Prefer behavior-based assertions. → Preferences",
      description: expect.stringContaining("Proposal: p-20260217-002"),
      labels: ["memory-review", "agent"],
      projectId: "Agent Work",
    });

  });

  test("Todoist task content truncates change text to 80 characters", async () => {
    redisLists.set("memory:observations:2026-02-17", [
      JSON.stringify({ summary: "Verify truncation behavior." }),
    ]);

    const longChange = "A".repeat(90);
    shellResultQueue = [
      {
        exitCode: 0,
        stdout: `<proposals>
  <proposal><section>Patterns</section><change>${longChange}</change></proposal>
</proposals>`,
        stderr: "",
      },
    ];

    await executeReflect("2026-02-17");

    expect(todoistCreateTaskCalls).toHaveLength(1);
    expect(todoistCreateTaskCalls[0]).toMatchObject({
      content: `Memory: ${"A".repeat(80)} → Patterns`,
      labels: ["memory-review", "agent"],
      projectId: "Agent Work",
    });
    expect(todoistCreateTaskCalls[0]?.description?.split("\n")[0]).toBe(
      "Proposal: p-20260217-001"
    );
  });

  test("running reflect twice on the same day appends at most one Reflected daily-log entry", async () => {
    redisLists.set("memory:observations:2026-02-17", [
      JSON.stringify({ summary: "Daily reflection dedup acceptance coverage." }),
    ]);

    shellResultQueue = [
      {
        exitCode: 0,
        stdout:
          "<proposals><proposal><section>Facts</section><change>First pass.</change></proposal></proposals>",
        stderr: "",
      },
      {
        exitCode: 0,
        stdout:
          "<proposals><proposal><section>Facts</section><change>Second pass.</change></proposal></proposals>",
        stderr: "",
      },
    ];

    const firstRun = await executeReflect("2026-02-17");
    const secondRun = await executeReflect("2026-02-17");
    const dailyLogPath = String((firstRun.result as { dailyLogPath?: unknown }).dailyLogPath ?? "");

    expect(firstRun.result).toMatchObject({
      dailyLogPath: expect.any(String),
    });
    expect(secondRun.result).toMatchObject({
      dailyLogPath: expect.any(String),
    });
    expect(dailyLogPath.length).toBeGreaterThan(0);

    const dailyLog = readFileSync(dailyLogPath, "utf8");
    const reflectedEntries = countReflectedBlocks(dailyLog);

    expect({
      reflectedEntries,
      hasOnlyOneReflectedEntry: reflectedEntries === 1,
    }).toMatchObject({
      reflectedEntries: 1,
      hasOnlyOneReflectedEntry: true,
    });
  });

  test("6 AM cron still processes backfill observations accumulated in Redis", async () => {
    const today = new Date().toISOString().slice(0, 10);
    redisLists.set(`memory:observations:${today}`, [
      JSON.stringify({
        summary: "Backfill summary block available for cron reflect.",
        metadata: { trigger: "backfill" },
      }),
    ]);

    shellResultQueue = [
      {
        exitCode: 0,
        stdout: `<proposals>
  <proposal><section>Patterns</section><change>Keep daily cron reflection for backfill.</change></proposal>
</proposals>`,
        stderr: "",
      },
    ];

    const { result } = await executeReflectFromCron();
    const cronResult = (result ?? {}) as Record<string, unknown>;
    const pending = redisLists.get("memory:review:pending") ?? [];

    expect(shellCalls[0]).toContain("Backfill summary block available for cron reflect.");
    expect({
      proposalCount: cronResult.proposalCount,
      emittedEvent: cronResult.emittedEvent,
      pendingCount: pending.length,
    }).toMatchObject({
      proposalCount: 1,
      emittedEvent: {
        name: "memory/observations.reflected",
        data: { date: today },
      },
      pendingCount: 1,
    });
  });

  test("mock pi subprocess valid <proposals> XML is accepted and staged", async () => {
    redisLists.set("memory:observations:2026-02-17", [
      JSON.stringify({ summary: "Verify XML handling." }),
    ]);

    const xml = `<proposals>
  <proposal><section>Facts</section><change>Parsed from XML.</change></proposal>
</proposals>`;
    shellResultQueue = [{ exitCode: 0, stdout: xml, stderr: "" }];

    const { result } = await executeReflect("2026-02-17");

    expect(result).toMatchObject({
      raw: xml,
      proposalCount: 1,
      emittedEvent: {
        name: "memory/observations.reflected",
        data: {
          date: "2026-02-17",
          proposalCount: 1,
        },
      },
    });
  });
});
