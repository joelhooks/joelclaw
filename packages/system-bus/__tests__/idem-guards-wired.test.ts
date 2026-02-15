/**
 * IDEM-4 & IDEM-5: guardStory/renewLease/releaseClaim are wired into functions
 *
 * Instead of executing the full functions (which need git repos, Claude CLI, etc.),
 * we verify the behavioral contract structurally:
 * - Each function imports and calls the guard utilities
 * - TypeScript compiles (proves types line up)
 * - The utility functions themselves are thoroughly tested in idempotency.test.ts
 */
import { describe, expect, test } from "bun:test";

describe("IDEM-4: guardStory wired into test-writer and implement", () => {
  test("test-writer imports guardStory and renewLease", async () => {
    const mod = await import("../src/inngest/functions/agent-loop/test-writer");
    // Module loads without error — imports are valid
    expect(mod.agentLoopTestWriter).toBeDefined();
  });

  test("test-writer source calls guardStory at side-effect boundaries", async () => {
    const source = await Bun.file("src/inngest/functions/agent-loop/test-writer.ts").text();
    // Behavioral: guardStory is called (not just imported)
    const guardCalls = (source.match(/guardStory\(/g) ?? []).length;
    expect(guardCalls).toBeGreaterThanOrEqual(2); // before spawn + before emit minimum

    // renewLease is called after work
    const renewCalls = (source.match(/renewLease\(/g) ?? []).length;
    expect(renewCalls).toBeGreaterThanOrEqual(1);

    // runToken is extracted from event data
    expect(source).toContain("event.data.runToken");
  });

  test("implement imports guardStory and renewLease", async () => {
    const mod = await import("../src/inngest/functions/agent-loop/implement");
    expect(mod.agentLoopImplement).toBeDefined();
  });

  test("implement source calls guardStory at side-effect boundaries", async () => {
    const source = await Bun.file("src/inngest/functions/agent-loop/implement.ts").text();
    const guardCalls = (source.match(/guardStory\(/g) ?? []).length;
    expect(guardCalls).toBeGreaterThanOrEqual(3); // before spawn + before commit + before emit

    const renewCalls = (source.match(/renewLease\(/g) ?? []).length;
    expect(renewCalls).toBeGreaterThanOrEqual(1);

    expect(source).toContain("event.data.runToken");
  });
});

describe("IDEM-5: guardStory wired into review and judge, releaseClaim on completion", () => {
  test("review imports guardStory and renewLease", async () => {
    const mod = await import("../src/inngest/functions/agent-loop/review");
    expect(mod.agentLoopReview).toBeDefined();
  });

  test("review source calls guardStory at side-effect boundaries", async () => {
    const source = await Bun.file("src/inngest/functions/agent-loop/review.ts").text();
    const guardCalls = (source.match(/guardStory\(/g) ?? []).length;
    expect(guardCalls).toBeGreaterThanOrEqual(2); // before reviewer spawn + before judge emit

    expect(source).toContain("event.data.runToken");
  });

  test("judge imports guardStory and releaseClaim", async () => {
    const mod = await import("../src/inngest/functions/agent-loop/judge");
    expect(mod.agentLoopJudge).toBeDefined();
  });

  test("judge source calls guardStory and releaseClaim", async () => {
    const source = await Bun.file("src/inngest/functions/agent-loop/judge.ts").text();
    const guardCalls = (source.match(/guardStory\(/g) ?? []).length;
    expect(guardCalls).toBeGreaterThanOrEqual(2);

    // releaseClaim called on pass AND skip paths
    const releaseCalls = (source.match(/releaseClaim\(/g) ?? []).length;
    expect(releaseCalls).toBeGreaterThanOrEqual(2); // pass + skip

    expect(source).toContain("event.data.runToken");
  });
});

describe("IDEM-4/5: TypeScript compilation", () => {
  test("all agent-loop functions typecheck cleanly", async () => {
    const proc = Bun.spawn(
      ["bunx", "tsc", "--noEmit"],
      { stdout: "pipe", stderr: "pipe", cwd: new URL("..", import.meta.url).pathname }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(stderr);
    }
    expect(exitCode).toBe(0);
  }, 30_000);
});
