import { test, expect, describe, mock, beforeEach } from "bun:test";
import { spawn, type Subprocess } from "bun";

// ── AC-1: llmEvaluate is exported from utils.ts ────────────────────────
describe("AC-1: llmEvaluate is exported from utils.ts", () => {
  test("llmEvaluate is a named export", async () => {
    const utils = await import("./utils.ts");
    expect(utils.llmEvaluate).toBeDefined();
    expect(typeof utils.llmEvaluate).toBe("function");
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────
function makeOpts(overrides: Partial<Parameters<typeof llmEvaluate>[0]> = {}) {
  return {
    criteria: ["tests pass", "code is clean"],
    diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
    testFile: "src/thing.test.ts",
    testResults: "PASS src/thing.test.ts\n  ✓ works (2ms)",
    conventions: "Use bun. Prefer const.",
    ...overrides,
  };
}

// Import after defining helpers so we can use the type
import { llmEvaluate } from "./utils.ts";

// ── Mock Bun.spawn to intercept claude CLI calls ────────────────────────
// We capture the spawn calls to verify prompts / args
let spawnCalls: Array<{ cmd: string[]; opts: unknown }> = [];
let mockStdout: string | (() => string) =
  '{"verdict":"pass","reasoning":"looks good"}';
let mockExitCode: number = 0;

const originalSpawn = Bun.spawn;

function installMock() {
  // @ts-expect-error – monkey-patching Bun.spawn for test
  Bun.spawn = (cmd: string[], opts?: unknown) => {
    spawnCalls.push({ cmd: cmd as string[], opts });

    const stdoutValue =
      typeof mockStdout === "function" ? mockStdout() : mockStdout;
    const stdoutBlob = new Blob([stdoutValue]);

    return {
      pid: 12345,
      stdout: {
        // Bun's ReadableStream from stdout
        async text() {
          return stdoutValue;
        },
        // Some code paths may use arrayBuffer
        async arrayBuffer() {
          return new TextEncoder().encode(stdoutValue).buffer;
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
  mockStdout = '{"verdict":"pass","reasoning":"looks good"}';
  mockExitCode = 0;
  installMock();
});

// ── AC-2: Accepts criteria, diff, testFile, testResults, conventions ────
describe("AC-2: Accepts all required parameters", () => {
  test("accepts all five parameters and returns a result", async () => {
    const result = await llmEvaluate(makeOpts());
    expect(result).toBeDefined();
    expect(result).toHaveProperty("verdict");
    expect(result).toHaveProperty("reasoning");
  });

  test("passes criteria array into the prompt", async () => {
    await llmEvaluate(
      makeOpts({ criteria: ["criterion-alpha", "criterion-beta"] })
    );
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
    const cmd = spawnCalls[0]!.cmd.join(" ");
    expect(cmd).toContain("criterion-alpha");
    expect(cmd).toContain("criterion-beta");
  });

  test("passes diff into the prompt", async () => {
    await llmEvaluate(makeOpts({ diff: "UNIQUE_DIFF_MARKER_XYZ" }));
    const cmd = spawnCalls[0]!.cmd.join(" ");
    expect(cmd).toContain("UNIQUE_DIFF_MARKER_XYZ");
  });

  test("passes testFile into the prompt", async () => {
    await llmEvaluate(makeOpts({ testFile: "my/special/test.ts" }));
    const cmd = spawnCalls[0]!.cmd.join(" ");
    expect(cmd).toContain("my/special/test.ts");
  });

  test("passes testResults into the prompt", async () => {
    await llmEvaluate(makeOpts({ testResults: "ALL_TESTS_GREEN" }));
    const cmd = spawnCalls[0]!.cmd.join(" ");
    expect(cmd).toContain("ALL_TESTS_GREEN");
  });

  test("passes conventions into the prompt", async () => {
    await llmEvaluate(makeOpts({ conventions: "CUSTOM_CONVENTIONS_HERE" }));
    const cmd = spawnCalls[0]!.cmd.join(" ");
    expect(cmd).toContain("CUSTOM_CONVENTIONS_HERE");
  });
});

// ── AC-3: Returns { verdict: 'pass' | 'fail', reasoning: string } ──────
describe("AC-3: Return type shape", () => {
  test("returns verdict 'pass' with reasoning", async () => {
    mockStdout = '{"verdict":"pass","reasoning":"all criteria met"}';
    const result = await llmEvaluate(makeOpts());
    expect(result.verdict).toBe("pass");
    expect(typeof result.reasoning).toBe("string");
    expect(result.reasoning).toBe("all criteria met");
  });

  test("returns verdict 'fail' with reasoning", async () => {
    mockStdout = '{"verdict":"fail","reasoning":"missing test coverage"}';
    const result = await llmEvaluate(makeOpts());
    expect(result.verdict).toBe("fail");
    expect(result.reasoning).toBe("missing test coverage");
  });
});

// ── AC-4: Calls claude CLI with a structured prompt ─────────────────────
describe("AC-4: Calls claude CLI with structured prompt", () => {
  test("invokes claude command", async () => {
    await llmEvaluate(makeOpts());
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
    const cmd = spawnCalls[0]!.cmd;
    expect(cmd[0]).toBe("claude");
  });

  test("passes -p flag for prompt mode", async () => {
    await llmEvaluate(makeOpts());
    const cmd = spawnCalls[0]!.cmd;
    expect(cmd).toContain("-p");
  });

  test("requests text output format", async () => {
    await llmEvaluate(makeOpts());
    const cmd = spawnCalls[0]!.cmd;
    const outputFmtIdx = cmd.indexOf("--output-format");
    expect(outputFmtIdx).toBeGreaterThan(-1);
    expect(cmd[outputFmtIdx + 1]).toBe("text");
  });
});

// ── AC-5: Truncates diff at 3000 lines with a note ─────────────────────
describe("AC-5: Diff truncation at 3000 lines", () => {
  test("diff under 3000 lines is passed in full", async () => {
    const shortDiff = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n"
    );
    await llmEvaluate(makeOpts({ diff: shortDiff }));
    const cmd = spawnCalls[0]!.cmd.join(" ");
    // All lines should be present
    expect(cmd).toContain("line 0");
    expect(cmd).toContain("line 99");
    // No truncation note
    expect(cmd).not.toMatch(/truncat/i);
  });

  test("diff at exactly 3000 lines is not truncated", async () => {
    const exactDiff = Array.from(
      { length: 3000 },
      (_, i) => `line ${i}`
    ).join("\n");
    await llmEvaluate(makeOpts({ diff: exactDiff }));
    const cmd = spawnCalls[0]!.cmd.join(" ");
    expect(cmd).toContain("line 2999");
    expect(cmd).not.toMatch(/truncat/i);
  });

  test("diff over 3000 lines is truncated with a note", async () => {
    const longDiff = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join(
      "\n"
    );
    await llmEvaluate(makeOpts({ diff: longDiff }));
    const cmd = spawnCalls[0]!.cmd.join(" ");
    // First 3000 lines should be present
    expect(cmd).toContain("line 0");
    expect(cmd).toContain("line 2999");
    // Line 3000 (0-indexed) should NOT be present
    expect(cmd).not.toContain("line 3000");
    // Should contain a truncation note
    expect(cmd).toMatch(/truncat/i);
  });

  test("conventions over 2000 chars are truncated", async () => {
    const longConventions = "x".repeat(3000);
    await llmEvaluate(makeOpts({ conventions: longConventions }));
    const cmd = spawnCalls[0]!.cmd.join(" ");
    // Should not contain the full 3000-char string
    expect(cmd.includes("x".repeat(3000))).toBe(false);
    // Should contain at most 2000 chars of x's
    const xRun = cmd.match(/x+/g);
    const longestRun = xRun
      ? Math.max(...xRun.map((s: string) => s.length))
      : 0;
    expect(longestRun).toBeLessThanOrEqual(2000);
  });
});

// ── AC-6: Falls back to { verdict: 'pass' } when claude call fails ──────
describe("AC-6: Fallback on failure", () => {
  test("returns pass with fallback reasoning when claude exits non-zero", async () => {
    mockExitCode = 1;
    mockStdout = "error: something went wrong";
    const result = await llmEvaluate(makeOpts());
    expect(result.verdict).toBe("pass");
    expect(result.reasoning).toMatch(/fallback|unavailable/i);
  });

  test("returns pass with fallback reasoning when output is not valid JSON", async () => {
    mockExitCode = 0;
    mockStdout = "this is not json at all";
    const result = await llmEvaluate(makeOpts());
    expect(result.verdict).toBe("pass");
    expect(result.reasoning).toMatch(/fallback|unavailable/i);
  });

  test("returns pass with fallback reasoning when JSON lacks verdict field", async () => {
    mockExitCode = 0;
    mockStdout = '{"something":"else"}';
    const result = await llmEvaluate(makeOpts());
    expect(result.verdict).toBe("pass");
    expect(result.reasoning).toMatch(/fallback|unavailable/i);
  });

  test("returns pass when spawn throws an error", async () => {
    Bun.spawn = () => {
      throw new Error("spawn failed");
    };
    const result = await llmEvaluate(makeOpts());
    expect(result.verdict).toBe("pass");
    expect(result.reasoning).toMatch(/fallback|unavailable/i);
  });

  test("fallback reasoning mentions test-only gate", async () => {
    mockExitCode = 1;
    mockStdout = "";
    const result = await llmEvaluate(makeOpts());
    expect(result.verdict).toBe("pass");
    expect(result.reasoning).toContain("test-only");
  });
});

// ── AC-7: TypeScript compiles cleanly ───────────────────────────────────
// This criterion is verified by `bunx tsc --noEmit` in CI, not by a
// runtime test. The fact that this file imports and type-checks
// llmEvaluate is itself a compile-time verification.

// ── Cleanup ─────────────────────────────────────────────────────────────
// Restore original Bun.spawn after all tests (belt-and-suspenders)
process.on("exit", () => {
  uninstallMock();
});
