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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import type { CreateTaskInput, Task } from "../../tasks/port";
import { friction, parseFrictionPatterns } from "./friction";

type MockQdrantPage = {
  points?: Array<{ payload?: Record<string, unknown> }>;
  next_page_offset?: unknown;
};

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalQdrantMethods = {
  count: (QdrantClient.prototype as any).count,
  scroll: (QdrantClient.prototype as any).scroll,
};
const originalSpawn = Bun.spawn;
const originalTodoistCreateTask = TodoistTaskAdapter.prototype.createTask;

let tempHome = "";
let qdrantCount = 0;
let qdrantPages: MockQdrantPage[] = [];
let spawnCalls: string[][] = [];
let spawnExitCode = 0;
let spawnStdout = "";
let spawnStderr = "";
let createdTasks: CreateTaskInput[] = [];

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function executeCron() {
  const engine = new InngestTestEngine({
    function: friction as any,
    events: [
      {
        name: "inngest/scheduled.timer",
        data: { cron: "0 7 * * *" },
      } as any,
    ],
  });

  return engine.execute();
}

beforeAll(() => {
  (QdrantClient.prototype as any).count = async function () {
    return { count: qdrantCount };
  };

  (QdrantClient.prototype as any).scroll = async function () {
    return qdrantPages.shift() ?? { points: [], next_page_offset: undefined };
  };

  // @ts-expect-error deterministic subprocess shim for tests.
  Bun.spawn = ((args: string[]) => {
    spawnCalls.push(args);
    return {
      stdout: textStream(spawnStdout),
      stderr: textStream(spawnStderr),
      exited: Promise.resolve(spawnExitCode),
    };
  }) as typeof Bun.spawn;

  (TodoistTaskAdapter.prototype as any).createTask = async function (task: CreateTaskInput) {
    createdTasks.push(task);
    return {
      id: `mock-task-${createdTasks.length}`,
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
  (QdrantClient.prototype as any).count = originalQdrantMethods.count;
  (QdrantClient.prototype as any).scroll = originalQdrantMethods.scroll;
  Bun.spawn = originalSpawn;
  TodoistTaskAdapter.prototype.createTask = originalTodoistCreateTask;
});

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "mem-friction-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  qdrantCount = 0;
  qdrantPages = [];
  spawnCalls = [];
  spawnExitCode = 0;
  spawnStdout = "<frictions></frictions>";
  spawnStderr = "";
  createdTasks = [];

  const workspace = join(tempHome, ".joelclaw", "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "MEMORY.md"), "# Memory\n\n## Hard Rules\n- Example", "utf8");
  writeFileSync(join(workspace, "AGENTS.md"), "# Agents\n\n- Example rule", "utf8");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  rmSync(tempHome, { recursive: true, force: true });
});

describe("MEM-FRICTION-1 friction function", () => {
  test("registers daily 7 AM cron trigger and concurrency limit 1", () => {
    const opts = (friction as any).opts;
    const triggers = Array.isArray(opts?.triggers) ? opts.triggers : [];
    expect(triggers.some((trigger: { cron?: string }) => trigger.cron === "0 7 * * *")).toBe(true);
    expect(opts?.concurrency).toBe(1);
  });

  test("skips analysis when Qdrant has fewer than 100 points", async () => {
    qdrantCount = 99;

    const { result } = await executeCron();

    expect(result).toMatchObject({
      status: "skipped",
      reason: "insufficient-qdrant-points",
      totalPoints: 99,
      threshold: 100,
    });
    expect(spawnCalls).toHaveLength(0);
    expect(createdTasks).toHaveLength(0);
  });

  test("parses friction patterns and creates Todoist tasks with friction labels", async () => {
    qdrantCount = 120;
    qdrantPages = [
      {
        points: [
          {
            payload: {
              timestamp: new Date().toISOString(),
              observation: "Reflector proposals are created but not reviewed quickly.",
              observation_type: "segment_fact",
              session_id: "s-1",
            },
          },
          {
            payload: {
              timestamp: new Date().toISOString(),
              observation: "Promotion waits for manual triage when task context is ambiguous.",
              observation_type: "segment_fact",
              session_id: "s-2",
            },
          },
        ],
      },
    ];
    spawnStdout = [
      "<frictions>",
      "<pattern><title>Review queue ambiguity</title><summary>Review tasks lack enough context.</summary><suggestion>Add clearer task descriptions.</suggestion><evidence><item>Tasks wait for manual interpretation.</item></evidence></pattern>",
      "<pattern><title>Delayed approvals</title><summary>Approved proposals are not acted on quickly.</summary><suggestion>Prioritize memory-review tasks daily.</suggestion><evidence><item>Proposals sit pending across days.</item></evidence></pattern>",
      "</frictions>",
    ].join("");

    const { result } = await executeCron();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toContain("--model");
    expect(spawnCalls[0]).toContain("anthropic/claude-sonnet-4-6");
    expect(result).toMatchObject({
      status: "ok",
      patternsDetected: 2,
      tasksCreated: 2,
    });
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks.every((task) => task.labels?.includes("friction"))).toBe(true);
    expect(createdTasks.every((task) => task.labels?.includes("memory-review"))).toBe(true);
    expect(createdTasks.every((task) => task.labels?.includes("agent"))).toBe(true);
  });

  test("parseFrictionPatterns extracts structured XML patterns", () => {
    const parsed = parseFrictionPatterns(
      "<frictions><pattern><title>T1</title><summary>S1</summary><suggestion>Do X</suggestion><evidence><item>E1</item><item>E2</item></evidence></pattern></frictions>"
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      title: "T1",
      summary: "S1",
      suggestion: "Do X",
      evidence: ["E1", "E2"],
    });
  });
});
