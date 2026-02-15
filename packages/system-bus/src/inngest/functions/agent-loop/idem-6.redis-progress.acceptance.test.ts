import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import Redis from "ioredis";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type RedisStringValue = {
  value: string;
  expiresAtMs: number | null;
};

type SetCall = {
  key: string;
  value: string;
  args: unknown[];
};

type RPushCall = {
  key: string;
  values: string[];
};

type LRangeCall = {
  key: string;
  start: number;
  stop: number;
};

const stringStore = new Map<string, RedisStringValue>();
const listStore = new Map<string, string[]>();
const setCalls: SetCall[] = [];
const rpushCalls: RPushCall[] = [];
const lrangeCalls: LRangeCall[] = [];

function getLiveEntry(key: string): RedisStringValue | null {
  const entry = stringStore.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    stringStore.delete(key);
    return null;
  }
  return entry;
}

const originalRedisMethods = {
  set: (Redis as any).prototype.set,
  get: (Redis as any).prototype.get,
  expire: (Redis as any).prototype.expire,
  del: (Redis as any).prototype.del,
  ttl: (Redis as any).prototype.ttl,
  rpush: (Redis as any).prototype.rpush,
  lrange: (Redis as any).prototype.lrange,
};

beforeAll(() => {
  (Redis as any).prototype.set = async function (...args: unknown[]) {
    const [key, rawValue, ...rest] = args as [string, string, ...unknown[]];
    const value = String(rawValue);
    setCalls.push({ key, value, args: rest });

    let exSeconds: number | null = null;
    let nx = false;

    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === "EX") {
        exSeconds = Number(rest[i + 1]);
        i += 1;
      }
      if (token === "NX") {
        nx = true;
      }
    }

    const existing = getLiveEntry(key);
    if (nx && existing) return null;

    const expiresAtMs =
      exSeconds !== null ? Date.now() + exSeconds * 1000 : existing?.expiresAtMs ?? null;

    stringStore.set(key, { value, expiresAtMs });
    return "OK";
  };

  (Redis as any).prototype.get = async function (key: string) {
    const entry = getLiveEntry(key);
    return entry ? entry.value : null;
  };

  (Redis as any).prototype.expire = async function (key: string, seconds: number) {
    const entry = getLiveEntry(key);
    if (!entry) return 0;
    entry.expiresAtMs = Date.now() + Number(seconds) * 1000;
    stringStore.set(key, entry);
    return 1;
  };

  (Redis as any).prototype.del = async function (...keys: string[]) {
    let deleted = 0;
    for (const key of keys) {
      if (stringStore.delete(key)) deleted += 1;
      if (listStore.delete(key)) deleted += 1;
    }
    return deleted;
  };

  (Redis as any).prototype.ttl = async function (key: string) {
    const entry = getLiveEntry(key);
    if (!entry) return -2;
    if (entry.expiresAtMs === null) return -1;
    const remainingMs = entry.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      stringStore.delete(key);
      return -2;
    }
    return Math.ceil(remainingMs / 1000);
  };

  (Redis as any).prototype.rpush = async function (key: string, ...values: string[]) {
    const existing = listStore.get(key) ?? [];
    const normalized = values.map((v) => String(v));
    listStore.set(key, existing.concat(normalized));
    rpushCalls.push({ key, values: normalized });
    return listStore.get(key)?.length ?? 0;
  };

  (Redis as any).prototype.lrange = async function (key: string, start: number, stop: number) {
    const list = listStore.get(key) ?? [];
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    const slice = list.slice(start, normalizedStop + 1);
    lrangeCalls.push({ key, start, stop });
    return slice;
  };
});

afterAll(() => {
  (Redis as any).prototype.set = originalRedisMethods.set;
  (Redis as any).prototype.get = originalRedisMethods.get;
  (Redis as any).prototype.expire = originalRedisMethods.expire;
  (Redis as any).prototype.del = originalRedisMethods.del;
  (Redis as any).prototype.ttl = originalRedisMethods.ttl;
  (Redis as any).prototype.rpush = originalRedisMethods.rpush;
  (Redis as any).prototype.lrange = originalRedisMethods.lrange;
});

beforeEach(() => {
  stringStore.clear();
  listStore.clear();
  setCalls.length = 0;
  rpushCalls.length = 0;
  lrangeCalls.length = 0;
  mock.restore();
});

afterEach(() => {
  mock.restore();
});

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("IDEM-6 AC-1: appendProgress/readProgress are Redis-backed", () => {
  test("appendProgress uses RPUSH on agent-loop:progress:{loopId} and readProgress uses LRANGE 0 -1", async () => {
    const utils = await import(`./utils.ts?case=${Date.now()}-${Math.random()}`);
    const appendProgress = (utils as any).appendProgress;
    const readProgress = (utils as any).readProgress;

    expect(typeof appendProgress).toBe("function");
    expect(typeof readProgress).toBe("function");

    await appendProgress("loop-ac1", "first message");
    await appendProgress("loop-ac1", "second message");

    const entries = await readProgress("loop-ac1");

    expect(rpushCalls.length).toBe(2);
    expect(rpushCalls[0]?.key).toBe("agent-loop:progress:loop-ac1");
    expect(rpushCalls[1]?.key).toBe("agent-loop:progress:loop-ac1");
    expect(lrangeCalls.some((c) => c.key === "agent-loop:progress:loop-ac1" && c.start === 0 && c.stop === -1)).toBe(true);

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(2);
    expect(entries[0]).toContain("first message");
    expect(entries[1]).toContain("second message");
    expect(entries[0]).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("IDEM-6 AC-2: former progress writers use appendProgress(loopId, message)", () => {
  test("judge pass flow appends progress with loopId as key scope", async () => {
    const appendProgress = mock(async () => {});

    mock.module("./utils", () => ({
      isCancelled: () => false,
      updateStoryPass: async () => {},
      markStorySkipped: async () => {},
      appendProgress,
      getStoryDiff: async () => "",
      llmEvaluate: async () => ({ verdict: "pass" as const, reasoning: "ok" }),
      guardStory: async () => ({ ok: true as const }),
      releaseClaim: async () => {},
    }));

    mock.module("../../client", () => ({
      inngest: {
        send: async () => ({ ids: ["evt_1"] }),
        createFunction: (opts: unknown, triggers: unknown, fn: unknown) => ({
          opts: { ...(opts as object), triggers },
          fn,
        }),
      },
    }));

    const mod = await import(`./judge.ts?case=${Date.now()}-${Math.random()}`);
    const fn = (mod.agentLoopJudge as any).fn;

    await fn({
      event: {
        data: {
          loopId: "loop-ac2-judge",
          project: process.cwd(),
          prdPath: "prd.json",
          storyId: "IDEM-6",
          testResults: {
            testsPassed: 2,
            testsFailed: 0,
            typecheckOk: true,
            lintOk: true,
            details: "ok",
          },
          feedback: "",
          reviewerNotes: {
            questions: [
              { id: "q2", answer: true, evidence: "ok" },
              { id: "q3", answer: true, evidence: "ok" },
              { id: "q4", answer: true, evidence: "ok" },
            ],
            testResults: {
              typecheckOk: true,
              typecheckOutput: "",
              lintOk: true,
              lintOutput: "",
              testsPassed: 2,
              testsFailed: 0,
              testOutput: "",
            },
          },
          attempt: 1,
          maxRetries: 2,
          maxIterations: 5,
          storyStartedAt: Date.now(),
          retryLadder: ["codex"],
          priorFeedback: "",
          story: {
            id: "IDEM-6",
            title: "Move progress to Redis",
            description: "",
            acceptance_criteria: ["done"],
          },
          tool: "codex",
          runToken: "run-token-ac2",
        },
      },
      step: {
        run: async (_name: string, f: () => unknown) => await f(),
      },
    });

    expect(appendProgress.mock.calls.length).toBe(1);
    const judgeAppendCalls = appendProgress.mock.calls as unknown[][];
    expect(judgeAppendCalls[0]?.[0]).toBe("loop-ac2-judge");
    expect(String(judgeAppendCalls[0]?.[1] ?? "")).toContain("IDEM-6");
  });

  test("plan recheck flow appends progress with loopId as key scope", async () => {
    const appendProgress = mock(async () => {});
    const markStoryRechecked = mock(async () => {});
    const initialPrd = {
      title: "PRD",
      stories: [
        {
          id: "IDEM-6",
          title: "Move progress to Redis",
          description: "",
          acceptance_criteria: ["done"],
          priority: 1,
          passes: false,
          skipped: true,
        },
      ],
    };
    const finalPrd = {
      ...initialPrd,
      stories: [
        {
          ...initialPrd.stories[0],
          passes: true,
          skipped: false,
        },
      ],
    };

    let readPrdCount = 0;

    mock.module("./utils", () => ({
      appendProgress,
      claimStory: async () => "claim-token",
      isCancelled: () => false,
      seedPrd: async () => initialPrd,
      seedPrdFromData: async () => initialPrd,
      parseClaudeOutput: () => initialPrd,
      readPrd: async () => {
        readPrdCount += 1;
        return readPrdCount > 1 ? finalPrd : initialPrd;
      },
      markStoryRechecked,
    }));

    mock.module("../../client", () => ({
      inngest: {
        send: async () => ({ ids: ["evt_1"] }),
        createFunction: (opts: unknown, triggers: unknown, fn: unknown) => ({
          opts: { ...(opts as object), triggers },
          fn,
        }),
      },
    }));

    const mod = await import(`./plan.ts?case=${Date.now()}-${Math.random()}`);
    const fn = (mod.agentLoopPlan as any).fn;

    await fn({
      event: {
        name: "agent/loop.plan",
        data: {
          loopId: "loop-ac2-plan",
          project: process.cwd(),
          prdPath: "prd.json",
          maxIterations: 10,
          maxRetries: 2,
          retryLadder: ["codex"],
        },
      },
      step: {
        run: async (name: string, f: () => unknown) => {
          if (name === "verify-branch") return undefined;
          if (name === "check-cancel") return false;
          if (name.startsWith("recheck-suite-")) {
            return { passed: true, typecheckOutput: "", testOutput: "" };
          }
          return await f();
        },
      },
    });

    expect(markStoryRechecked.mock.calls.length).toBe(1);
    expect(appendProgress.mock.calls.length).toBe(1);
    const planAppendCalls = appendProgress.mock.calls as unknown[][];
    expect(planAppendCalls[0]?.[0]).toBe("loop-ac2-plan");
    expect(String(planAppendCalls[0]?.[1] ?? "")).toContain("RECHECK PASS");
  });
});

describe("IDEM-6 AC-3: recommendations helpers use Redis key agent-loop:recommendations:{project}", () => {
  test("write/read recommendations round-trip through Redis JSON string without NX", async () => {
    const utils = await import(`./utils.ts?case=${Date.now()}-${Math.random()}`);
    const writeRecommendations = (utils as any).writeRecommendations;
    const readRecommendations = (utils as any).readRecommendations;

    expect(typeof writeRecommendations).toBe("function");
    expect(typeof readRecommendations).toBe("function");

    const project = "project-ac3";
    const firstPayload = {
      retryPatterns: ["first"],
      suggestedRetryLadder: ["codex", "claude"],
    };
    const secondPayload = {
      retryPatterns: ["second"],
      suggestedRetryLadder: ["pi"],
    };

    await writeRecommendations(project, firstPayload);
    await writeRecommendations(project, secondPayload);

    const key = `agent-loop:recommendations:${project}`;
    const persisted = getLiveEntry(key);
    const roundTrip = await readRecommendations(project);

    expect(persisted?.value).toBe(JSON.stringify(secondPayload));
    expect(roundTrip).toEqual(secondPayload);

    const writesForKey = setCalls.filter((c) => c.key === key);
    expect(writesForKey.length).toBeGreaterThanOrEqual(2);
    expect(writesForKey.some((c) => c.args.includes("NX"))).toBe(false);
  });
});

describe("IDEM-6 AC-4: patterns helpers use Redis key agent-loop:patterns:{project}", () => {
  test("write/read patterns round-trip through Redis without NX", async () => {
    const utils = await import(`./utils.ts?case=${Date.now()}-${Math.random()}`);
    const writePatterns = (utils as any).writePatterns;
    const readPatterns = (utils as any).readPatterns;

    expect(typeof writePatterns).toBe("function");
    expect(typeof readPatterns).toBe("function");

    const project = "project-ac4";
    const firstPatterns = "## Codebase Patterns\n- avoid foo";
    const secondPatterns = "## Codebase Patterns\n- prefer bar";

    await writePatterns(project, firstPatterns);
    await writePatterns(project, secondPatterns);

    const key = `agent-loop:patterns:${project}`;
    const persisted = getLiveEntry(key);
    const roundTrip = await readPatterns(project);

    expect(persisted?.value).toBe(secondPatterns);
    expect(roundTrip).toBe(secondPatterns);

    const writesForKey = setCalls.filter((c) => c.key === key);
    expect(writesForKey.length).toBeGreaterThanOrEqual(2);
    expect(writesForKey.some((c) => c.args.includes("NX"))).toBe(false);
  });
});

describe("IDEM-6 AC-5: implement buildPrompt reads recommendations/patterns from Redis context", () => {
  test("implement prompt uses helper-provided recommendations/patterns instead of on-disk files", async () => {
    const tmpProject = mkdtempSync(join(tmpdir(), "idem-6-impl-"));
    await Bun.write(join(tmpProject, "progress.txt"), "## Codebase Patterns\nFILE_PATTERN_MARKER");
    await Bun.write(
      join(tmpProject, ".agent-loop-recommendations.json"),
      JSON.stringify({ retryPatterns: ["FILE_RECOMMENDATION_MARKER"] })
    );

    const readRecommendations = mock(async () =>
      JSON.stringify({
        retryPatterns: ["REDIS_RECOMMENDATION_MARKER"],
        suggestedRetryLadder: ["codex", "claude"],
        sourceLoopId: "loop-ac5",
      })
    );
    const readPatterns = mock(async () => "## Codebase Patterns\nREDIS_PATTERN_MARKER");

    mock.module("./utils", () => ({
      isCancelled: () => false,
      commitExists: async () => false,
      commitMessage: () => "msg",
      gitCommit: async () => "sha-after",
      outputPath: () => join(tmpProject, "tool.out"),
      writePidFile: async () => {},
      cleanupPid: async () => {},
      parseToolOutput: async () => ({ success: true, output: "ok" }),
      TOOL_TIMEOUTS: {} as Record<string, number>,
      hasUncommittedChanges: async () => false,
      getHeadSha: async () => "sha-before",
      isDockerAvailable: async () => false,
      spawnInContainer: async () => ({ exitCode: 0, output: "ok" }),
      guardStory: async () => ({ ok: true as const }),
      renewLease: async () => true,
      readRecommendations,
      readPatterns,
    }));

    const sent: unknown[] = [];
    mock.module("../../client", () => ({
      inngest: {
        send: async (payload: unknown) => {
          sent.push(payload);
          return { ids: ["evt_1"] };
        },
        createFunction: (opts: unknown, triggers: unknown, fn: unknown) => ({
          opts: { ...(opts as object), triggers },
          fn,
        }),
      },
    }));

    const originalHost = process.env.AGENT_LOOP_HOST;
    process.env.AGENT_LOOP_HOST = "1";

    const originalSpawn = Bun.spawn;
    let capturedPrompt = "";

    // @ts-expect-error test stub
    Bun.spawn = (cmd: string[]) => {
      if (cmd[0] === "codex" && cmd[1] === "exec") {
        capturedPrompt = cmd[3] ?? "";
      }
      return {
        pid: 999,
        stdout: streamFrom("ok"),
        stderr: streamFrom(""),
        exitCode: 0,
        kill() {},
      };
    };

    try {
      const mod = await import(`./implement.ts?case=${Date.now()}-${Math.random()}`);
      const fn = (mod.agentLoopImplement as any).fn;

      await fn({
        event: {
          data: {
            loopId: "loop-ac5",
            project: tmpProject,
            storyId: "IDEM-6",
            tool: "codex",
            attempt: 1,
            feedback: "",
            story: {
              id: "IDEM-6",
              title: "Use Redis context",
              description: "",
              acceptance_criteria: ["done"],
            },
            maxRetries: 2,
            maxIterations: 5,
            retryLadder: ["codex"],
            freshTests: true,
            runToken: "run-token-ac5",
          },
        },
        step: {
          run: async (_name: string, f: () => unknown) => await f(),
        },
      });
    } finally {
      Bun.spawn = originalSpawn;
      if (originalHost === undefined) delete process.env.AGENT_LOOP_HOST;
      else process.env.AGENT_LOOP_HOST = originalHost;
    }

    expect(readPatterns.mock.calls.length).toBeGreaterThan(0);
    expect(readRecommendations.mock.calls.length).toBeGreaterThan(0);
    expect(capturedPrompt).toContain("REDIS_PATTERN_MARKER");
    expect(capturedPrompt).toContain("REDIS_RECOMMENDATION_MARKER");
    expect(capturedPrompt).not.toContain("FILE_PATTERN_MARKER");
    expect(capturedPrompt).not.toContain("FILE_RECOMMENDATION_MARKER");
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("IDEM-6 AC-6: retro uses Redis helper writes (no active recommendation file write)", () => {
  test("retro writes recommendations through helper and does not require .agent-loop-recommendations.json disk writes", async () => {
    const tmpProject = mkdtempSync(join(tmpdir(), "idem-6-retro-"));
    mkdirSync(join(tmpProject, "notes"), { recursive: true });

    const readProgress = mock(async () => [
      "## Codebase Patterns",
      "- REDIS_PATTERN_FROM_PROGRESS",
      "**Story IDEM-6: Move progress to Redis** — PASSED (attempt 1)",
      "- Tool: codex",
    ]);
    const writeRecommendations = mock(async () => {});

    mock.module("./utils", () => ({
      readPrd: async () => ({
        title: "PRD",
        stories: [
          {
            id: "IDEM-6",
            title: "Move progress to Redis",
            description: "",
            acceptance_criteria: ["done"],
            priority: 1,
            passes: true,
          },
        ],
      }),
      readProgress,
      writeRecommendations,
    }));

    mock.module("../../client", () => ({
      inngest: {
        send: async () => ({ ids: ["evt_1"] }),
        createFunction: (opts: unknown, triggers: unknown, fn: unknown) => ({
          opts: { ...(opts as object), triggers },
          fn,
        }),
      },
    }));

    const mod = await import(`./retro.ts?case=${Date.now()}-${Math.random()}`);
    const fn = (mod.agentLoopRetro as any).fn;

    await fn({
      event: {
        data: {
          loopId: "loop-ac6",
          project: tmpProject,
          summary: "done",
          storiesCompleted: 1,
          storiesFailed: 0,
          cancelled: false,
          branchName: "agent-loop/loop-ac6",
        },
      },
      step: {
        run: async (name: string, f: () => unknown) => {
          if (name === "write-retrospective-note") return "skipped-in-test";
          return await f();
        },
      },
    });

    expect(readProgress.mock.calls.length).toBeGreaterThan(0);
    expect(writeRecommendations.mock.calls.length).toBe(1);
    const writeRecommendationCalls = writeRecommendations.mock.calls as unknown[][];
    expect(writeRecommendationCalls[0]?.[0]).toBe(tmpProject);
  });
});

describe("IDEM-6 AC-7: TypeScript compiles cleanly", () => {
  test(
    "bunx tsc --noEmit succeeds",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: join(import.meta.dir, "../../../.."),
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    },
    30_000
  );
});
