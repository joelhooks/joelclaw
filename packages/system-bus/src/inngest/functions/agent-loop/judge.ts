import { inngest } from "../../client";
import {
  isCancelled,
  updateStoryPass,
  markStorySkipped,
  appendProgress,
  getStoryDiff,
  llmEvaluate,
  guardStory,
  releaseClaim,
  readPatterns,
} from "./utils";

const DEFAULT_RETRY_LADDER: ("codex" | "claude" | "pi")[] = [
  "codex",
  "claude",
  "codex",
];

function normalizeTestName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[\-:|]+/, "")
    .toLowerCase();
}

function extractFailedTestNames(output: string): string[] {
  if (!output) return [];
  const names = new Set<string>();
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const patterns = [
      /^[✗xX]\s+(.+)$/,
      /^FAIL\s+(.+)$/i,
      /^●\s+(.+)$/,
      /^not ok\s+\d+\s*-\s*(.+)$/i,
    ];

    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match?.[1]) {
        names.add(normalizeTestName(match[1]));
        break;
      }
    }
  }

  return Array.from(names);
}

function hasSameConsecutiveFailures(
  currentDetails: string,
  priorFeedback?: string
): boolean {
  if (!priorFeedback) return false;

  const current = extractFailedTestNames(currentDetails);
  const previous = extractFailedTestNames(priorFeedback);
  if (current.length === 0 || previous.length === 0) return false;
  if (current.length !== previous.length) return false;

  const prevSet = new Set(previous);
  return current.every((name) => prevSet.has(name));
}

function selectRetryTool(
  retryLadder: ("codex" | "claude" | "pi")[] | undefined,
  nextAttempt: number
): "codex" | "claude" | "pi" {
  const ladder = retryLadder && retryLadder.length > 0
    ? retryLadder
    : DEFAULT_RETRY_LADDER;
  const index = Math.max(0, nextAttempt - 1);
  return ladder[Math.min(index, ladder.length - 1)] ?? "codex";
}

function isTestFilePath(path: string): boolean {
  if (path.includes("/__tests__/")) return true;
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(path);
}

function extractTestFilesFromDiff(diff: string): string[] {
  if (!diff) return [];
  const files = new Set<string>();
  const lines = diff.split("\n");

  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      const path = line.slice("+++ b/".length).trim();
      if (path && path !== "/dev/null" && isTestFilePath(path)) files.add(path);
    }
  }

  return Array.from(files);
}

async function readTestFilesFromDisk(workDir: string, files: string[]): Promise<string> {
  if (files.length === 0) return "";
  const chunks: string[] = [];

  for (const path of files.slice(0, 10)) {
    try {
      const content = await Bun.file(`${workDir}/${path}`).text();
      const snippet = content.length > 4000
        ? `${content.slice(0, 4000)}\n\n[Truncated at 4000 characters]`
        : content;
      chunks.push(`# ${path}\n${snippet}`);
    } catch {
      chunks.push(`# ${path}\n[Unable to read file from disk]`);
    }
  }

  return chunks.join("\n\n");
}

async function getProjectConventions(project: string): Promise<string> {
  const parts: string[] = [];

  try {
    const claudeMd = await Bun.file(`${project}/CLAUDE.md`).text();
    if (claudeMd.trim()) parts.push(`CLAUDE.md\n${claudeMd.trim()}`);
  } catch { /* ignore */ }

  try {
    const patterns = await readPatterns(project);
    if (patterns) parts.push(`## Codebase Patterns\n${patterns}`);
  } catch { /* ignore */ }

  return parts.join("\n\n");
}

function buildReviewerRedFlags(
  reviewerNotes: {
    questions: Array<{ id: string; answer: boolean; evidence: string }>;
  } | undefined
): string[] {
  if (!reviewerNotes) return ["Reviewer notes are missing."];

  const flags: string[] = [];
  // q1 (test files in diff) is informational in TDD flow — tests are committed
  // by test-writer before implement runs, so they won't appear in the implement diff.
  // Only q2-q4 (real implementations, truthful tests, story intent) are gates.
  const requiredQuestionIds = ["q2", "q3", "q4"];
  const questionById = new Map(
    reviewerNotes.questions.map((question) => [question.id, question] as const)
  );

  for (const questionId of requiredQuestionIds) {
    const question = questionById.get(questionId);
    if (!question) {
      flags.push(`${questionId}: Missing reviewer evaluation.`);
      continue;
    }
    if (!question.answer) {
      flags.push(`${question.id}: ${question.evidence || "Reviewer flagged an issue."}`);
    }
  }

  for (const question of reviewerNotes.questions) {
    if (!requiredQuestionIds.includes(question.id) && !question.answer) {
      flags.push(`${question.id}: ${question.evidence || "Reviewer flagged an issue."}`);
    }
  }

  return flags;
}

function buildTestResultsSummary(params: {
  testResults: {
    testsPassed: number;
    testsFailed: number;
    typecheckOk: boolean;
    lintOk: boolean;
    details: string;
  };
  reviewerNotes?: {
    testResults: {
      typecheckOutput: string;
      lintOutput: string;
      testOutput: string;
    };
  };
}): string {
  const lines = [
    `typecheckOk=${params.testResults.typecheckOk}`,
    `lintOk=${params.testResults.lintOk}`,
    `testsPassed=${params.testResults.testsPassed}`,
    `testsFailed=${params.testResults.testsFailed}`,
    "",
    "Runner details:",
    params.testResults.details || "(none)",
  ];

  if (params.reviewerNotes) {
    lines.push(
      "",
      "Reviewer typecheck output:",
      params.reviewerNotes.testResults.typecheckOutput || "(none)",
      "",
      "Reviewer lint output:",
      params.reviewerNotes.testResults.lintOutput || "(none)",
      "",
      "Reviewer test output:",
      params.reviewerNotes.testResults.testOutput || "(none)"
    );
  }

  return lines.join("\n");
}

function buildFailureFeedback(params: {
  baseFeedback: string;
  mechanicalGateFailures: string[];
  reviewerRedFlags: string[];
  llmResult?: { verdict: "pass" | "fail"; reasoning: string };
}): string {
  const sections: string[] = [];
  if (params.baseFeedback.trim()) {
    sections.push("Reviewer feedback:", params.baseFeedback.trim());
  }
  if (params.mechanicalGateFailures.length > 0) {
    sections.push(
      "Mechanical gate failures:",
      ...params.mechanicalGateFailures.map((f) => `- ${f}`)
    );
  }
  if (params.reviewerRedFlags.length > 0) {
    sections.push(
      "Reviewer red flags:",
      ...params.reviewerRedFlags.map((f) => `- ${f}`)
    );
  }
  if (params.llmResult) {
    sections.push(
      "LLM verdict:",
      `- ${params.llmResult.verdict.toUpperCase()}: ${params.llmResult.reasoning}`
    );
  }
  return sections.join("\n");
}

/**
 * JUDGE — Reads test results + feedback. Routes to next story or retry.
 *
 * PASS → update prd.json, append progress, emit plan
 * FAIL (retries left) → emit implement with feedback
 * FAIL (max retries) → skip story, emit plan for next story
 */
export const agentLoopJudge = inngest.createFunction(
  {
    id: "agent-loop-judge",
    concurrency: {
      key: "event.data.project",
      limit: 1,
    },
  },
  [{ event: "agent/loop.checks.completed" }],
  async ({ event, step }) => {
    const {
      loopId,
      project,
      prdPath,
      storyId,
      testResults,
      feedback,
      reviewerNotes,
      attempt,
      maxRetries,
      maxIterations,
      storyStartedAt,
      retryLadder,
      priorFeedback,
      story,
      tool,
    } = event.data;
    const workDir = event.data.workDir ?? project;
    const runToken = event.data.runToken;
    if (!runToken) {
      console.log(`[agent-loop-judge] missing runToken for ${storyId}`);
      return { status: "missing-run-token", loopId, storyId };
    }

    // Step 0: Check cancellation
    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId, storyId };

    // Step 1: Check mechanical gates
    const { mechanicalGatesPass, mechanicalGateFailures, reviewerRedFlags } = await step.run("check-gates", () => {
      const failures: string[] = [];
      if (!testResults.typecheckOk) failures.push("Typecheck failed.");
      if (!testResults.lintOk) failures.push("Lint failed.");
      if (testResults.testsFailed > 0) {
        failures.push(`${testResults.testsFailed} test(s) failed.`);
      }
      const flags = buildReviewerRedFlags(reviewerNotes);
      return {
        mechanicalGatesPass: failures.length === 0,
        mechanicalGateFailures: failures,
        reviewerRedFlags: flags,
        typecheck: testResults.typecheckOk,
        lint: testResults.lintOk,
        tests: `${testResults.testsPassed}✓ ${testResults.testsFailed}✗`,
        ...(failures.length > 0 ? { blocked: failures } : {}),
      };
    });

    let llmResult: { verdict: "pass" | "fail"; reasoning: string } | undefined;
    if (mechanicalGatesPass) {
      const diff = await step.run("get-story-diff", () => getStoryDiff(workDir));
      const testFilePaths = extractTestFilesFromDiff(diff);
      const testFileContent = await step.run("read-test-files", () =>
        readTestFilesFromDisk(workDir, testFilePaths)
      );
      const conventions = await step.run("read-project-conventions", () =>
        getProjectConventions(workDir)
      );
      const testResultsSummary = buildTestResultsSummary({
        testResults,
        reviewerNotes,
      });

      llmResult = await step.run("llm-evaluate", () =>
        llmEvaluate({
          criteria: story.acceptance_criteria,
          diff,
          testFile: testFileContent,
          testResults: testResultsSummary,
          conventions,
        })
      );
    }

    // Mechanical gates (typecheck, lint, tests) are objective — hard gate.
    // LLM verdict is the authority on implementation quality.
    // Reviewer notes are fed INTO llmEvaluate as context, not a separate gate.
    const allPassed =
      mechanicalGatesPass &&
      llmResult?.verdict === "pass";

    const combinedFailureFeedback = buildFailureFeedback({
      baseFeedback: feedback,
      mechanicalGateFailures,
      reviewerRedFlags,
      llmResult,
    });

    if (allPassed) {
      // ── PASS ─────────────────────────────────────────────────────
      const writeGuard = await step.run("guard-before-verdict-write", () =>
        guardStory(loopId, storyId, runToken)
      );
      if (!writeGuard.ok) {
        console.log(
          `[agent-loop-judge] guard blocked verdict write for ${storyId}: ${writeGuard.reason}`
        );
        return { status: "blocked", loopId, storyId, reason: writeGuard.reason };
      }

      // Update PRD (Redis + disk)
      await step.run("update-prd", async () => {
        await updateStoryPass(workDir, prdPath, storyId, loopId);
        return { storyId, action: "marked-passed" };
      });

      await step.run("append-progress", async () => {
        await appendProgress(loopId, [
          `**Story ${storyId}: ${story.title}** — PASSED (attempt ${attempt})`,
          `- Tool: ${tool}`,
          `- Tests passed: ${testResults.testsPassed}`,
          `- Typecheck: ✅ | Lint: ✅`,
        ].join("\n"));
        return { storyId, verdict: "pass", attempt, tool };
      });

      const durationMs = storyStartedAt ? Date.now() - storyStartedAt : 0;

      // Release claim BEFORE emitting — story is already passed in PRD
      await step.run("release-claim-pass", async () => {
        await releaseClaim(loopId, storyId);
        return { storyId, action: "released-claim" };
      });

      // ADR-0019: story.passed carries planner re-entry data (no separate plan emit)
      await step.run("emit-story-pass", async () => {
        await step.sendEvent("emit-story-pass", {
          name: "agent/loop.story.passed",
          data: {
            loopId,
            project,
            workDir,
            prdPath,
            storyId,
            commitSha: "HEAD",
            attempt,
            duration: durationMs,
            maxIterations,
            maxRetries,
            retryLadder,
          },
        });
        return { event: "agent/loop.story.passed", storyId, durationMs };
      });

      return { status: "passed", loopId, storyId, attempt };
    }

    // ── FAIL ───────────────────────────────────────────────────────

    if (attempt < maxRetries) {
      // Retry — send back to implementor with feedback
      const nextAttempt = attempt + 1;
      const retryTool = selectRetryTool(retryLadder, nextAttempt);
      const freshTests = hasSameConsecutiveFailures(
        testResults.details,
        priorFeedback
      );

      // ADR-0019: story.retried → triggers implementor (skips test-writer on retry)
      await step.run("emit-retry-implement", async () => {
        await step.sendEvent("emit-retry-implement", {
          name: "agent/loop.story.retried",
          data: {
            loopId,
            project,
            workDir,
            storyId,
            tool: retryTool,
            attempt: nextAttempt,
            feedback: combinedFailureFeedback || `Tests failed: ${testResults.testsFailed}. ${testResults.details}`,
            story,
            maxRetries,
            maxIterations,
            retryLadder,
            storyStartedAt,
            freshTests,
            runToken,
          },
        });
        return { event: "agent/loop.story.retried", storyId, attempt: nextAttempt, tool: retryTool, freshTests };
      });

      return {
        status: "retry",
        loopId,
        storyId,
        attempt,
        nextAttempt,
        tool: retryTool,
        freshTests,
      };
    }

    // Max retries exhausted — skip story
    const writeGuard = await step.run("guard-before-verdict-write", () =>
      guardStory(loopId, storyId, runToken)
    );
    if (!writeGuard.ok) {
      console.log(
        `[agent-loop-judge] guard blocked verdict write for ${storyId}: ${writeGuard.reason}`
      );
      return { status: "blocked", loopId, storyId, reason: writeGuard.reason };
    }

    // Mark story as skipped so planner doesn't re-pick it
    await step.run("mark-skipped", async () => {
      await markStorySkipped(workDir, prdPath, storyId, loopId);
      return { storyId, action: "marked-skipped", attempts: attempt };
    });

    await step.run("append-progress-fail", async () => {
      await appendProgress(loopId, [
        `**Story ${storyId}: ${story.title}** — FAILED (skipped after ${attempt} attempts)`,
        `- Tool: ${tool}`,
        `- Last results: ${testResults.testsFailed} test failures, typecheck: ${testResults.typecheckOk ? "✅" : "❌"}, lint: ${testResults.lintOk ? "✅" : "❌"}`,
        `- ⚠️ NEEDS HUMAN REVIEW`,
      ].join("\n"));
      return { storyId, verdict: "skipped", attempts: attempt };
    });

    // Emit story fail event with duration
    const failDurationMs = storyStartedAt ? Date.now() - storyStartedAt : 0;
    await step.run("emit-story-fail", async () => {
      await step.sendEvent("emit-story-fail", {
        // ADR-0019: story.failed carries planner re-entry data (no separate plan emit)
        name: "agent/loop.story.failed",
        data: {
          loopId,
          project,
          workDir,
          prdPath,
          storyId,
          reason: `Failed after ${attempt} attempts. ${(combinedFailureFeedback || testResults.details).slice(0, 500)}`,
          attempts: attempt,
          duration: failDurationMs,
          maxIterations,
          maxRetries,
          retryLadder,
        },
      });
      return { event: "agent/loop.story.failed", storyId, attempts: attempt, durationMs: failDurationMs };
    });

    // Release claim AFTER emit — story already skipped in PRD
    await step.run("release-claim-skip", async () => {
      await releaseClaim(loopId, storyId);
      return { storyId, action: "released-claim" };
    });

    return { status: "skipped", loopId, storyId, attempts: attempt };
  }
);
