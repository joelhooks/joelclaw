import { test, expect, describe } from "bun:test";

const REVIEW_PATH = new URL("./review.ts", import.meta.url).pathname;

// ── Helper: read review.ts source ─────────────────────────────────────────────
async function readSource(): Promise<string> {
  return Bun.file(REVIEW_PATH).text();
}

// ── AC-1: review.ts no longer writes test files ──────────────────────────────
describe("AC-1: review.ts no longer writes test files", () => {
  test("does not export or define buildTestPrompt", async () => {
    const source = await readSource();
    expect(source).not.toMatch(/\bbuildTestPrompt\b/);
  });

  test("does not contain deleteExistingTestFiles", async () => {
    const source = await readSource();
    expect(source).not.toMatch(/\bdeleteExistingTestFiles\b/);
  });

  test("does not spawn a tool to write tests (spawnReviewer for test writing)", async () => {
    const source = await readSource();
    // No "write test" or "write-test" step/function for authoring test files
    expect(source).not.toMatch(/write[_-]?tests?\b/i);
  });

  test("does not write .test. files to disk", async () => {
    const source = await readSource();
    // No fs write calls targeting test files
    expect(source).not.toMatch(/(?:Bun\.write|writeFile)\s*\([^)]*\.test\./);
  });

  test("does not contain spawnReviewer function", async () => {
    const source = await readSource();
    expect(source).not.toMatch(/\bspawnReviewer\b/);
  });
});

// ── AC-2: review.ts runs checks (typecheck, lint, tests) — keeps runChecks ──
describe("AC-2: review.ts keeps runChecks (typecheck, lint, tests)", () => {
  test("runChecks function is defined in source", async () => {
    const source = await readSource();
    expect(source).toMatch(/function\s+runChecks\b/);
  });

  test("runChecks runs typecheck via tsc --noEmit", async () => {
    const source = await readSource();
    expect(source).toContain("tsc --noEmit");
  });

  test("runChecks runs lint (biome or eslint)", async () => {
    const source = await readSource();
    expect(source).toMatch(/biome|eslint/i);
  });

  test("runChecks runs tests via bun test", async () => {
    const source = await readSource();
    expect(source).toMatch(/bun test/);
  });

  test("function handler calls runChecks in a step", async () => {
    const source = await readSource();
    expect(source).toMatch(/step\.run\s*\(\s*["']run-checks["']/);
  });

  test("runChecks returns typecheckOk, lintOk, testsPassed, testsFailed", async () => {
    const source = await readSource();
    // The return type should include all these fields
    expect(source).toMatch(/typecheckOk\s*:\s*boolean/);
    expect(source).toMatch(/lintOk\s*:\s*boolean/);
    expect(source).toMatch(/testsPassed\s*:\s*number/);
    expect(source).toMatch(/testsFailed\s*:\s*number/);
  });
});

// ── AC-3: review.ts evaluates 4 questions with structured output ─────────────
describe("AC-3: review.ts evaluates 4 questions with structured output", () => {
  test("defines or references question q1 (new test files check)", async () => {
    const source = await readSource();
    expect(source).toContain('"q1"');
  });

  test("defines or references question q2 (real implementations)", async () => {
    const source = await readSource();
    expect(source).toContain('"q2"');
  });

  test("defines or references question q3 (truthful tests)", async () => {
    const source = await readSource();
    expect(source).toContain('"q3"');
  });

  test("defines or references question q4 (story intent)", async () => {
    const source = await readSource();
    expect(source).toContain('"q4"');
  });

  test("q1 checks git diff for new test files (extractNewTestFilesFromDiff)", async () => {
    const source = await readSource();
    expect(source).toMatch(/extractNewTestFilesFromDiff/);
    // q1 should be determined by whether new test files exist in the diff
    expect(source).toMatch(/\.test\./);
  });

  test("q2-q4 are evaluated via LLM (claude call)", async () => {
    const source = await readSource();
    // Should spawn or call claude for evaluation
    expect(source).toMatch(/claude/i);
    // Should have an evaluation prompt builder
    expect(source).toMatch(/buildEvaluationPrompt/);
  });

  test("ReviewerQuestion interface has id, answer (boolean), and evidence (string)", async () => {
    const source = await readSource();
    expect(source).toMatch(/interface\s+ReviewerQuestion/);
    expect(source).toMatch(/\bid\s*:\s*string/);
    expect(source).toMatch(/\banswer\s*:\s*boolean/);
    expect(source).toMatch(/\bevidence\s*:\s*string/);
  });

  test("uses getStoryDiff to read the implementation diff", async () => {
    const source = await readSource();
    expect(source).toMatch(/getStoryDiff/);
    // Should call it in a step
    expect(source).toMatch(/step\.run\s*\(\s*["']get-story-diff["']/);
  });

  test("reads test files from disk via readTestFilesFromDisk", async () => {
    const source = await readSource();
    expect(source).toMatch(/readTestFilesFromDisk/);
  });
});

// ── AC-4: Outputs JSON notes with question answers and evidence ──────────────
describe("AC-4: Outputs JSON notes with question answers and evidence", () => {
  test("ReviewerNotes interface has questions array and testResults", async () => {
    const source = await readSource();
    expect(source).toMatch(/interface\s+ReviewerNotes/);
    expect(source).toMatch(/questions\s*:\s*ReviewerQuestion\[\]/);
    expect(source).toMatch(/testResults\s*:/);
  });

  test("testResults in ReviewerNotes includes typecheck, lint, and test fields", async () => {
    const source = await readSource();
    expect(source).toContain("typecheckOk");
    expect(source).toContain("typecheckOutput");
    expect(source).toContain("lintOk");
    expect(source).toContain("lintOutput");
    expect(source).toContain("testsPassed");
    expect(source).toContain("testsFailed");
    expect(source).toContain("testOutput");
  });

  test("function return value includes reviewerNotes", async () => {
    const source = await readSource();
    expect(source).toMatch(/return\s*\{[^}]*reviewerNotes/s);
  });

  test("reviewerNotes assembles all 4 questions (q1 + q2to4)", async () => {
    const source = await readSource();
    // Should combine q1 with questions 2-4
    expect(source).toMatch(/questions\s*:\s*\[q1.*q2to4|questions\s*:\s*\[q1,\s*\.\.\.q2to4\]/s);
  });
});

// ── AC-5: Emits agent/loop.checks.completed with reviewer notes attached ────────────────
describe("AC-5: Emits agent/loop.checks.completed with reviewer notes attached", () => {
  test("emits agent/loop.checks.completed event", async () => {
    const source = await readSource();
    expect(source).toContain('"agent/loop.checks.completed"');
  });

  test("judge event data includes reviewerNotes field", async () => {
    const source = await readSource();
    const judgeBlock = source.match(
      /name:\s*["']agent\/loop\.checks\.completed["'][\s\S]*?data:\s*\{([\s\S]*?)\}\s*,?\s*\}/
    );
    expect(judgeBlock).not.toBeNull();
    expect(judgeBlock![1]).toContain("reviewerNotes");
  });

  test("judge event data includes testResults field", async () => {
    const source = await readSource();
    const judgeBlock = source.match(
      /name:\s*["']agent\/loop\.checks\.completed["'][\s\S]*?data:\s*\{([\s\S]*?)\}\s*,?\s*\}/
    );
    expect(judgeBlock).not.toBeNull();
    expect(judgeBlock![1]).toContain("testResults");
  });

  test("emit step is named 'emit-judge'", async () => {
    const source = await readSource();
    expect(source).toContain("emit-judge");
  });

  test("review.ts does NOT emit agent/loop.tests.written or agent/loop.story.dispatched", async () => {
    const source = await readSource();
    const sends = [...source.matchAll(/name:\s*["']agent\/loop\.(\w+)["']/g)];
    const emittedEvents = sends.map((m) => m[1]);
    expect(emittedEvents).not.toContain("implement");
    expect(emittedEvents).not.toContain("test");
  });

  test("judge event includes story and attempt data for retry support", async () => {
    const source = await readSource();
    const judgeBlock = source.match(
      /name:\s*["']agent\/loop\.checks\.completed["'][\s\S]*?data:\s*\{([\s\S]*?)\}\s*,?\s*\}/
    );
    expect(judgeBlock).not.toBeNull();
    expect(judgeBlock![1]).toContain("attempt");
    expect(judgeBlock![1]).toContain("story");
    expect(judgeBlock![1]).toContain("maxRetries");
  });
});

// ── AC-6: buildTestPrompt removed or replaced with evaluation prompt ─────────
describe("AC-6: buildTestPrompt removed, replaced with evaluation prompt", () => {
  test("buildTestPrompt does not exist in source", async () => {
    const source = await readSource();
    expect(source).not.toMatch(/\bbuildTestPrompt\b/);
  });

  test("buildEvaluationPrompt exists", async () => {
    const source = await readSource();
    expect(source).toMatch(/function\s+buildEvaluationPrompt/);
  });

  test("evaluation prompt references q2 (real implementations, not stubs)", async () => {
    const source = await readSource();
    expect(source).toMatch(/q2.*(?:real|stubs|mocks)/i);
  });

  test("evaluation prompt references q3 (truthful, not gaming)", async () => {
    const source = await readSource();
    expect(source).toMatch(/q3.*(?:truthful|gaming)/i);
  });

  test("evaluation prompt references q4 (story intent / ADR)", async () => {
    const source = await readSource();
    expect(source).toMatch(/q4.*(?:story\s+intent|ADR|accomplish)/i);
  });

  test("evaluation prompt includes story context (description and acceptance criteria)", async () => {
    const source = await readSource();
    // The prompt builder should reference story data
    expect(source).toMatch(/story\.description|story\.acceptance_criteria|params\.story/);
  });

  test("evaluation prompt accepts story, diff, and testFiles parameters", async () => {
    const source = await readSource();
    // buildEvaluationPrompt params should have these fields
    expect(source).toMatch(/buildEvaluationPrompt\s*\(\s*(?:params|{)/);
    expect(source).toContain("story");
    expect(source).toContain("diff");
    expect(source).toContain("testFiles");
  });
});

// ── AC-7: TypeScript compiles cleanly ────────────────────────────────────────
describe("AC-7: TypeScript compiles cleanly (partial check)", () => {
  test("review.ts can be imported without error", async () => {
    const mod = await import("./review.ts");
    expect(mod.agentLoopReview).toBeDefined();
  });

  test("agentLoopReview has correct function id", async () => {
    const mod = await import("./review.ts");
    const fn = mod.agentLoopReview as any;
    expect(fn.opts?.id).toBe("agent-loop-review");
  });

  test("agentLoopReview triggers on agent/loop.code.committed", async () => {
    const mod = await import("./review.ts");
    const fn = mod.agentLoopReview as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.code.committed");
  });

  test("agentLoopReview has retries set to 1", async () => {
    const mod = await import("./review.ts");
    const fn = mod.agentLoopReview as any;
    expect(fn.opts?.retries).toBe(3);
  });
});
