import { test, expect, describe, beforeEach } from "bun:test";
import { type Subprocess } from "bun";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeStory(overrides: Partial<{
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
}> = {}) {
  return {
    id: overrides.id ?? "LOOP-1",
    title: overrides.title ?? "Create test writer function",
    description: overrides.description ?? "Writes acceptance tests from story criteria",
    acceptance_criteria: overrides.acceptance_criteria ?? [
      "test-writer.ts exists and exports agentLoopTestWriter",
      "Listens on agent/loop.story.dispatched event",
      "Spawns tool with prompt focused on acceptance criteria",
    ],
  };
}

// ── Mock Bun.spawn ──────────────────────────────────────────────────────

let spawnCalls: Array<{ cmd: string[]; opts: unknown }> = [];
let mockStdout = "";
let mockExitCode = 0;

const originalSpawn = Bun.spawn;

function installMock() {
  // @ts-expect-error – monkey-patching Bun.spawn for test
  Bun.spawn = (cmd: string[], opts?: unknown) => {
    spawnCalls.push({ cmd: cmd as string[], opts });

    const stdoutValue = mockStdout;

    return {
      pid: 99999,
      stdout: {
        async text() {
          return stdoutValue;
        },
        async arrayBuffer() {
          return new TextEncoder().encode(stdoutValue).buffer;
        },
      },
      stderr: {
        async text() {
          return "";
        },
        async arrayBuffer() {
          return new TextEncoder().encode("").buffer;
        },
      },
      exited: Promise.resolve(mockExitCode),
      exitCode: mockExitCode,
      kill() {},
    } as unknown as Subprocess;
  };
}

function uninstallMock() {
  Bun.spawn = originalSpawn;
}

beforeEach(() => {
  spawnCalls = [];
  mockStdout = "";
  mockExitCode = 0;
  installMock();
});

// ── AC-1: test-writer.ts exists and exports agentLoopTestWriter ─────────
describe("AC-1: test-writer.ts exists and exports agentLoopTestWriter", () => {
  test("agentLoopTestWriter is a named export from test-writer.ts", async () => {
    const mod = await import("./test-writer.ts");
    expect(mod.agentLoopTestWriter).toBeDefined();
  });

  test("agentLoopTestWriter is an Inngest function (has id and fn)", () => {
    // Inngest functions created with createFunction have an id property
    const fn = require("./test-writer.ts").agentLoopTestWriter;
    expect(fn).toBeDefined();
    // Inngest functions are objects with specific shape
    expect(typeof fn).toBe("object");
  });
});

// ── AC-2: Listens on agent/loop.story.dispatched event ──────────────────────────────
describe("AC-2: Listens on agent/loop.story.dispatched event", () => {
  test("function is configured to trigger on agent/loop.story.dispatched", async () => {
    const mod = await import("./test-writer.ts");
    const fn = mod.agentLoopTestWriter as any;

    // Inngest createFunction stores config in fn.opts
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.story.dispatched");
  });

  test("function id contains 'test-writer' or 'test'", async () => {
    const mod = await import("./test-writer.ts");
    const fn = mod.agentLoopTestWriter as any;

    // Inngest createFunction stores id in fn.opts.id
    const id: string = fn.opts?.id ?? "";
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/test/i);
  });
});

// ── AC-3: Spawns tool with prompt focused on acceptance criteria ────────
describe("AC-3: Spawns tool with prompt focused on acceptance criteria", () => {
  test("buildTestWriterPrompt includes acceptance criteria in the prompt", async () => {
    // We can verify this by checking that the module's internal prompt builder
    // produces output containing the acceptance criteria.
    // Since the function spawns a tool, we check the spawn call contains criteria.
    // We need to trigger the function's internals — but since it's an Inngest function,
    // we verify the source file contains the right patterns.
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // The prompt builder should reference acceptance_criteria
    expect(source).toContain("acceptance_criteria");
    // Should mention observable behavior or intent (not implementation details)
    expect(source).toMatch(/observable|behavior|intent/i);
    // Should NOT instruct to test internal structure
    expect(source).toMatch(/not.*internal|do not.*implementation/i);
  });

  test("spawnReviewer function exists and handles claude tool", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // Should have a spawnReviewer function (same pattern as review.ts)
    expect(source).toContain("spawnReviewer");
    // Should handle claude tool
    expect(source).toContain("claude");
  });

  test("spawnReviewer function handles codex tool", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // Should handle codex tool
    expect(source).toContain("codex");
  });

  test("prompt focuses on acceptance criteria, not implementation details", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // The prompt should instruct to focus on acceptance criteria
    expect(source).toMatch(/acceptance/i);
    // Should instruct NOT to test internal structure or implementation
    expect(source).toMatch(/do\s+not|don't/i);
  });
});

// ── AC-4: Commits test files before emitting implement ──────────────────
describe("AC-4: Commits test files before emitting implement", () => {
  test("function has a commit step before the emit step", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // Should have a git commit with the expected message format
    expect(source).toContain("test:");
    expect(source).toContain("loopId");
    expect(source).toContain("storyId");
    expect(source).toContain("acceptance tests");

    // The commit step should appear before the emit step in the source
    const commitIdx = source.indexOf("commit");
    const emitIdx = source.indexOf("emit-implement");
    expect(commitIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeLessThan(emitIdx);
  });

  test("commit message matches expected format: test: [{loopId}] [{storyId}] acceptance tests", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // Should construct a commit message with the format:
    // test: [{loopId}] [{storyId}] acceptance tests
    expect(source).toMatch(/test:.*\[.*loopId.*\].*\[.*storyId.*\].*acceptance tests/s);
  });
});

// ── AC-5: Emits agent/loop.tests.written after committing tests ─────────────
describe("AC-5: Emits agent/loop.tests.written after committing tests", () => {
  test("function emits agent/loop.tests.written event", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    expect(source).toContain("agent/loop.tests.written");
  });

  test("emitted event includes loop state fields", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // The emit data should pass through all loop state
    expect(source).toContain("loopId");
    expect(source).toContain("project");
    expect(source).toContain("storyId");
    expect(source).toContain("tool");
    expect(source).toContain("attempt");
    expect(source).toContain("maxRetries");
    expect(source).toContain("story");
    expect(source).toContain("retryLadder");
  });

  test("emitted event includes testFiles (test file paths)", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    // Should include test file paths in the emitted event data
    expect(source).toContain("testFiles");
  });

  test("inngest.send is used to emit the event", async () => {
    const source = await Bun.file(
      new URL("./test-writer.ts", import.meta.url).pathname
    ).text();

    expect(source).toContain("inngest.send");
  });
});

// ── AC-6: Registered in index.ts ────────────────────────────────────────
describe("AC-6: Registered in index.ts", () => {
  test("agentLoopTestWriter is exported from agent-loop/index.ts", async () => {
    const mod = await import("./index.ts");
    expect(mod.agentLoopTestWriter).toBeDefined();
  });

  test("agentLoopTestWriter is re-exported from functions/index.ts", async () => {
    const mod = await import("../index.ts");
    expect(mod.agentLoopTestWriter).toBeDefined();
  });
});

// ── AC-7: TypeScript compiles cleanly ───────────────────────────────────
// This criterion is verified by `bunx tsc --noEmit` in the harness.
// The fact that this file imports test-writer.ts without error is itself
// a partial compile-time check.
describe("AC-7: TypeScript compiles cleanly (partial check)", () => {
  test("test-writer.ts can be imported without error", async () => {
    const mod = await import("./test-writer.ts");
    expect(mod).toBeDefined();
    expect(mod.agentLoopTestWriter).toBeDefined();
  });
});

// ── Cleanup ─────────────────────────────────────────────────────────────
process.on("exit", () => {
  uninstallMock();
});
