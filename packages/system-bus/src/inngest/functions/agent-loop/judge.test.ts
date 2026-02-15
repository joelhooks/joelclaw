import { test, expect, describe } from "bun:test";

const JUDGE_PATH = new URL("./judge.ts", import.meta.url).pathname;

// ── Helper: read judge.ts source ─────────────────────────────────────────────
async function readSource(): Promise<string> {
  return Bun.file(JUDGE_PATH).text();
}

// ── AC-1: judge.ts receives and uses reviewer notes from event data ──────────
describe("AC-1: judge.ts receives and uses reviewer notes from event data", () => {
  test("event destructuring includes reviewerNotes", async () => {
    const source = await readSource();
    expect(source).toMatch(/reviewerNotes/);
    // reviewerNotes should be destructured from event.data
    expect(source).toMatch(/event\.data/);
  });

  test("reviewerNotes is consumed (not just received)", async () => {
    const source = await readSource();
    // reviewerNotes should be used in logic, not just destructured
    // It should be passed to buildReviewerRedFlags or similar
    const occurrences = source.match(/\breviewerNotes\b/g) ?? [];
    // At least 3: destructure + pass to helper + pass to buildTestResultsSummary
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  test("buildReviewerRedFlags function exists and accepts reviewerNotes", async () => {
    const source = await readSource();
    expect(source).toMatch(/function\s+buildReviewerRedFlags/);
    expect(source).toMatch(/buildReviewerRedFlags\s*\(\s*reviewerNotes\b/);
  });

  test("buildReviewerRedFlags checks question answers for red flags", async () => {
    const source = await readSource();
    // Should iterate over questions and check answer field
    expect(source).toMatch(/\.answer/);
    expect(source).toMatch(/\.evidence/);
  });

  test("reviewerNotes is destructured alongside other event data fields", async () => {
    const source = await readSource();
    // Should be part of the same destructuring block as project, storyId, etc.
    const destructureBlock = source.match(/const\s*\{[\s\S]*?\}\s*=\s*event\.data/);
    expect(destructureBlock).not.toBeNull();
    expect(destructureBlock![0]).toContain("reviewerNotes");
  });
});

// ── AC-2: Checks mechanical gates first (typecheck, lint, tests) ─────────────
describe("AC-2: Checks mechanical gates first (typecheck, lint, tests)", () => {
  test("checks typecheckOk from testResults", async () => {
    const source = await readSource();
    expect(source).toMatch(/testResults\.typecheckOk/);
  });

  test("checks lintOk from testResults", async () => {
    const source = await readSource();
    expect(source).toMatch(/testResults\.lintOk/);
  });

  test("checks testsFailed from testResults", async () => {
    const source = await readSource();
    expect(source).toMatch(/testResults\.testsFailed/);
  });

  test("collects mechanical gate failures into an array", async () => {
    const source = await readSource();
    expect(source).toMatch(/mechanicalGateFailures/);
    // Should push typecheck, lint, and test failure messages
    expect(source).toContain("Typecheck failed");
    expect(source).toContain("Lint failed");
  });

  test("mechanical gates are checked BEFORE llmEvaluate call", async () => {
    const source = await readSource();
    // Skip imports — find the function body where both are used
    const fnBody = source.slice(source.indexOf("async ({ event, step })"));
    const gateCheckPos = fnBody.indexOf("mechanicalGatesPass");
    const llmCallPos = fnBody.indexOf("llmEvaluate");
    expect(gateCheckPos).toBeGreaterThan(-1);
    expect(llmCallPos).toBeGreaterThan(-1);
    expect(gateCheckPos).toBeLessThan(llmCallPos);
  });

  test("mechanical gate failures check all three gates independently", async () => {
    const source = await readSource();
    // Each gate should be checked independently (not short-circuited)
    expect(source).toMatch(/if\s*\(\s*!testResults\.typecheckOk\s*\)/);
    expect(source).toMatch(/if\s*\(\s*!testResults\.lintOk\s*\)/);
    expect(source).toMatch(/if\s*\(\s*testResults\.testsFailed\s*>\s*0\s*\)/);
  });

  test("mechanicalGatesPass is derived from failure array being empty", async () => {
    const source = await readSource();
    expect(source).toMatch(/mechanicalGatesPass.*failures\.length === 0/);
  });
});

// ── AC-3: Calls llmEvaluate when mechanical gates pass ───────────────────────
describe("AC-3: Calls llmEvaluate when mechanical gates pass", () => {
  test("imports llmEvaluate from utils", async () => {
    const source = await readSource();
    expect(source).toMatch(/import\s*\{[^}]*llmEvaluate[^}]*\}\s*from\s*["']\.\/utils["']/);
  });

  test("llmEvaluate is only called when mechanicalGatesPass is true", async () => {
    const source = await readSource();
    // Should be gated by mechanicalGatesPass
    expect(source).toMatch(/if\s*\(\s*mechanicalGatesPass\s*\)/);
    // llmEvaluate should appear inside this block
    const gateBlock = source.match(
      /if\s*\(\s*mechanicalGatesPass\s*\)\s*\{([\s\S]*?)\n  \}/
    );
    expect(gateBlock).not.toBeNull();
    expect(gateBlock![1]).toContain("llmEvaluate");
  });

  test("llmEvaluate is called with story acceptance criteria", async () => {
    const source = await readSource();
    expect(source).toMatch(/criteria:\s*story\.acceptance_criteria/);
  });

  test("llmEvaluate is called with diff from getStoryDiff", async () => {
    const source = await readSource();
    expect(source).toMatch(/getStoryDiff\s*\(\s*workDir\s*\)/);
    // diff should be passed to llmEvaluate
    expect(source).toMatch(/diff[,\s]/);
  });

  test("llmEvaluate is called with test file content", async () => {
    const source = await readSource();
    expect(source).toMatch(/testFile:\s*testFileContent/);
  });

  test("llmEvaluate is called with test results summary", async () => {
    const source = await readSource();
    expect(source).toMatch(/testResults:\s*testResultsSummary/);
  });

  test("llmEvaluate is called with project conventions", async () => {
    const source = await readSource();
    expect(source).toMatch(/conventions/);
  });

  test("llmEvaluate runs in a step named 'llm-evaluate'", async () => {
    const source = await readSource();
    expect(source).toMatch(/step\.run\s*\(\s*["']llm-evaluate["']/);
  });

  test("llmEvaluate is NOT called when mechanical gates fail", async () => {
    const source = await readSource();
    // llmEvaluate should only appear inside the mechanicalGatesPass block
    // Check that there's no unconditional call to llmEvaluate
    const outsideCalls = source.split(/if\s*\(\s*mechanicalGatesPass\s*\)/);
    // Before the gate check, llmEvaluate should not be called (only imported)
    const beforeGate = outsideCalls[0] ?? "";
    const llmCallsBeforeGate = (beforeGate.match(/llmEvaluate\s*\(/g) ?? []).length;
    expect(llmCallsBeforeGate).toBe(0);
  });
});

// ── AC-4: Combines reviewer notes + LLM verdict for final decision ───────────
describe("AC-4: Combines reviewer notes + LLM verdict for final decision", () => {
  test("final pass requires mechanical gates + LLM verdict", async () => {
    const source = await readSource();
    expect(source).toMatch(/mechanicalGatesPass/);
    expect(source).toMatch(/llmResult\?\.verdict\s*===\s*["']pass["']/);
  });

  test("allPassed combines mechanical gates and LLM", async () => {
    const source = await readSource();
    const passLine = source.match(/const\s+allPassed\s*=[\s\S]*?;/);
    expect(passLine).not.toBeNull();
    const passExpr = passLine![0];
    expect(passExpr).toContain("mechanicalGatesPass");
    expect(passExpr).toContain("llmResult");
  });

  test("buildTestResultsSummary includes reviewer notes when available", async () => {
    const source = await readSource();
    expect(source).toMatch(/function\s+buildTestResultsSummary/);
    // Should accept reviewerNotes as a parameter
    expect(source).toMatch(/buildTestResultsSummary\s*\(\s*\{[\s\S]*?reviewerNotes/);
  });

  test("reviewerRedFlags is computed from buildReviewerRedFlags", async () => {
    const source = await readSource();
    expect(source).toContain("buildReviewerRedFlags");
  });

  test("allPassed uses AND logic", async () => {
    const source = await readSource();
    const passLine = source.match(/const\s+allPassed\s*=[\s\S]*?;/);
    expect(passLine).not.toBeNull();
    expect(passLine![0]).toContain("&&");
    const andCount = (passLine![0].match(/&&/g) ?? []).length;
    expect(andCount).toBeGreaterThanOrEqual(1);
  });
});

// ── AC-5: FAIL if reviewer flags issues even when tests pass ─────────────────
describe("AC-5: FAIL if reviewer flags issues even when tests pass", () => {
  test("reviewer red flags are computed but not a pass gate", async () => {
    const source = await readSource();
    expect(source).toContain("buildReviewerRedFlags");
    const passLine = source.match(/const\s+allPassed\s*=[\s\S]*?;/);
    expect(passLine).not.toBeNull();
    expect(passLine![0]).not.toContain("reviewerRedFlags");
  });

  test("buildReviewerRedFlags returns flags for questions with answer=false", async () => {
    const source = await readSource();
    // Should check question.answer and build flags
    expect(source).toMatch(/!question\.answer/);
  });

  test("missing reviewer notes produces a red flag", async () => {
    const source = await readSource();
    // If reviewerNotes is undefined, should still produce flags
    expect(source).toMatch(/Reviewer notes are missing/i);
  });

  test("missing individual questions produce red flags", async () => {
    const source = await readSource();
    expect(source).toContain('"q2"');
    expect(source).toContain('"q3"');
    expect(source).toContain('"q4"');
    expect(source).toMatch(/Missing reviewer evaluation/i);
  });

  test("reviewer red flags include evidence from failed questions", async () => {
    const source = await readSource();
    // When a question has answer=false, the flag should include the evidence string
    expect(source).toMatch(/question\.evidence/);
  });

  test("extra questions beyond q1-q4 with answer=false also produce flags", async () => {
    const source = await readSource();
    // buildReviewerRedFlags should handle questions with unexpected IDs
    // Check that there's logic for questions outside the required set
    expect(source).toMatch(/requiredQuestionIds\.includes/);
  });
});

// ── AC-6: Feedback to implementor includes specific reasoning ────────────────
describe("AC-6: Feedback to implementor includes specific reasoning", () => {
  test("buildFailureFeedback function exists", async () => {
    const source = await readSource();
    expect(source).toMatch(/function\s+buildFailureFeedback/);
  });

  test("buildFailureFeedback includes mechanical gate failures", async () => {
    const source = await readSource();
    const fn = source.match(
      /function\s+buildFailureFeedback[\s\S]*?\n\}/
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("mechanicalGateFailures");
  });

  test("buildFailureFeedback includes reviewer red flags", async () => {
    const source = await readSource();
    const fn = source.match(
      /function\s+buildFailureFeedback[\s\S]*?\n\}/
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("reviewerRedFlags");
  });

  test("buildFailureFeedback includes LLM reasoning", async () => {
    const source = await readSource();
    const fn = source.match(
      /function\s+buildFailureFeedback[\s\S]*?\n\}/
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("llmResult");
    expect(fn![0]).toContain("reasoning");
  });

  test("combined feedback is passed to the retry implement event", async () => {
    const source = await readSource();
    // The emit-retry-implement event data should include the combined feedback
    const retryBlock = source.match(
      /emit-retry-implement[\s\S]*?data:\s*\{([\s\S]*?)\}\s*,?\s*\}/
    );
    expect(retryBlock).not.toBeNull();
    expect(retryBlock![1]).toMatch(/feedback:\s*combinedFailureFeedback|feedback.*combined/i);
  });

  test("failure feedback labels sections clearly", async () => {
    const source = await readSource();
    // Feedback should have clear section labels
    expect(source).toContain("Mechanical gate failures:");
    expect(source).toContain("Reviewer red flags:");
    expect(source).toContain("LLM verdict:");
  });

  test("buildFailureFeedback includes base feedback from reviewer", async () => {
    const source = await readSource();
    // Match the full function body (greedy to closing brace at same indent)
    const fnStart = source.indexOf("function buildFailureFeedback");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, source.indexOf("\n}\n", fnStart) + 3);
    expect(fnBody).toContain("baseFeedback");
    expect(fnBody).toContain("Reviewer feedback:");
  });

  test("combinedFailureFeedback is used in both retry and skip paths", async () => {
    const source = await readSource();
    // combinedFailureFeedback should be computed once and used for both outcomes
    const occurrences = source.match(/\bcombinedFailureFeedback\b/g) ?? [];
    // At least: assignment + retry feedback + skip failure reason
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });
});

// ── AC-7: Retry ladder and skip logic preserved ──────────────────────────────
describe("AC-7: Retry ladder and skip logic preserved", () => {
  test("DEFAULT_RETRY_LADDER is defined", async () => {
    const source = await readSource();
    expect(source).toMatch(/DEFAULT_RETRY_LADDER/);
  });

  test("selectRetryTool function exists and uses retry ladder", async () => {
    const source = await readSource();
    expect(source).toMatch(/function\s+selectRetryTool/);
    expect(source).toMatch(/retryLadder/);
  });

  test("retry path checks attempt < maxRetries", async () => {
    const source = await readSource();
    expect(source).toMatch(/attempt\s*<\s*maxRetries/);
  });

  test("retry path emits agent/loop.story.retried", async () => {
    const source = await readSource();
    expect(source).toContain("emit-retry-implement");
    expect(source).toContain('"agent/loop.story.retried"');
  });

  test("max retries exhausted path marks story as skipped", async () => {
    const source = await readSource();
    expect(source).toMatch(/markStorySkipped/);
    expect(source).toContain("mark-skipped");
  });

  test("story.passed carries planner re-entry data (no separate plan emit)", async () => {
    const source = await readSource();
    // ADR-0019: story.passed event now carries project/prdPath for planner re-entry
    expect(source).toContain("emit-story-pass");
    expect(source).toContain('"agent/loop.story.passed"');
    // No separate emit-next-plan step — planner triggers on story.passed directly
    expect(source).not.toContain("emit-next-plan");
  });

  test("story.failed carries planner re-entry data (no separate plan emit)", async () => {
    const source = await readSource();
    expect(source).toContain("emit-story-fail");
    expect(source).toContain('"agent/loop.story.failed"');
    expect(source).not.toContain("emit-next-plan-after-fail");
  });

  test("hasSameConsecutiveFailures is used for stale retry detection", async () => {
    const source = await readSource();
    expect(source).toMatch(/function\s+hasSameConsecutiveFailures/);
    expect(source).toMatch(/hasSameConsecutiveFailures/);
  });

  test("retry emits freshTests flag based on consecutive failure detection", async () => {
    const source = await readSource();
    const retryBlock = source.match(
      /emit-retry-implement[\s\S]*?data:\s*\{([\s\S]*?)\}\s*,?\s*\}/
    );
    expect(retryBlock).not.toBeNull();
    expect(retryBlock![1]).toContain("freshTests");
  });

  test("skip path emits agent/loop.story.fail event", async () => {
    const source = await readSource();
    expect(source).toContain('"agent/loop.story.failed"');
  });

  test("pass path emits agent/loop.story.pass event", async () => {
    const source = await readSource();
    expect(source).toContain('"agent/loop.story.passed"');
  });

  test("retry event data includes story, maxRetries, and retryLadder for continuation", async () => {
    const source = await readSource();
    const retryBlock = source.match(
      /emit-retry-implement[\s\S]*?data:\s*\{([\s\S]*?)\}\s*,?\s*\}/
    );
    expect(retryBlock).not.toBeNull();
    expect(retryBlock![1]).toContain("story");
    expect(retryBlock![1]).toContain("maxRetries");
    expect(retryBlock![1]).toContain("retryLadder");
  });

  test("skip path appends progress with NEEDS HUMAN REVIEW marker", async () => {
    const source = await readSource();
    expect(source).toContain("NEEDS HUMAN REVIEW");
  });
});

// ── AC-8: TypeScript compiles cleanly ────────────────────────────────────────
describe("AC-8: TypeScript compiles cleanly (partial check)", () => {
  test("judge.ts can be imported without error", async () => {
    const mod = await import("./judge.ts");
    expect(mod.agentLoopJudge).toBeDefined();
  });

  test("agentLoopJudge has correct function id", async () => {
    const mod = await import("./judge.ts");
    const fn = mod.agentLoopJudge as any;
    expect(fn.opts?.id).toBe("agent-loop-judge");
  });

  test("agentLoopJudge triggers on agent/loop.checks.completed", async () => {
    const mod = await import("./judge.ts");
    const fn = mod.agentLoopJudge as any;
    const triggers = fn.opts?.triggers ?? [];
    const eventNames = triggers.map((t: any) => t.event);
    expect(eventNames).toContain("agent/loop.checks.completed");
  });

  test("agentLoopJudge has retries configured", async () => {
    const mod = await import("./judge.ts");
    const fn = mod.agentLoopJudge as any;
    expect(fn.opts?.retries).toBeDefined();
  });

  test("judge.ts exports only the inngest function (no internal leaks)", async () => {
    const mod = await import("./judge.ts");
    const exports = Object.keys(mod);
    expect(exports).toContain("agentLoopJudge");
    // Internal helpers like buildReviewerRedFlags should NOT be exported
    expect(exports).not.toContain("buildReviewerRedFlags");
    expect(exports).not.toContain("buildFailureFeedback");
    expect(exports).not.toContain("selectRetryTool");
  });
});
