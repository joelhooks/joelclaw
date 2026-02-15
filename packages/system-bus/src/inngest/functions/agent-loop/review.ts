import { inngest } from "../../client";
import { $ } from "bun";
import {
  isCancelled,
  writePidFile,
  cleanupPid,
  claimCheckWrite,
  TOOL_TIMEOUTS,
} from "./utils";

/**
 * Build prompt for the reviewer to write tests from acceptance criteria.
 * Key insight from AgentCoder: reviewer should NOT read implementation code
 * when designing tests — this avoids bias.
 */
function buildTestPrompt(
  story: { id: string; title: string; description: string; acceptance_criteria: string[] },
  freshTests = false
): string {
  return [
    `## Write Tests for: ${story.title} (${story.id})`,
    "",
    "You are a test engineer. Write tests for the following story based ONLY on the",
    "acceptance criteria below. Do NOT read or examine the implementation code first.",
    freshTests
      ? "Treat this as a fresh-eyes rewrite: do NOT look at any prior test files."
      : "Design tests that verify the criteria are met from the outside.",
    "",
    "## Story Description",
    story.description,
    "",
    "## Acceptance Criteria",
    ...story.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "## Instructions",
    "1. Write test files that verify each acceptance criterion",
    "2. Use the project's existing test framework (bun test)",
    "3. Put tests in a sensible location (e.g. __tests__/ or alongside source)",
    "4. Tests should be runnable with `bun test`",
    "5. After writing tests, do NOT run them — the harness runs them separately",
    freshTests
      ? "6. Fresh-eyes mode: do NOT reference or recover previous test files."
      : "",
  ].join("\n");
}

async function findExistingTestFiles(project: string): Promise<string[]> {
  try {
    const files = await $`cd ${project} && rg --files -g "**/*.test.ts" -g "**/*.test.tsx" -g "**/*.test.js" -g "**/*.test.jsx" -g "**/*.spec.ts" -g "**/*.spec.tsx" -g "**/*.spec.js" -g "**/*.spec.jsx" -g "**/__tests__/**" -g "!node_modules/**" -g "!.git/**"`.quiet();
    return files
      .text()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function deleteExistingTestFiles(project: string): Promise<number> {
  const files = await findExistingTestFiles(project);
  for (const file of files) {
    await $`cd ${project} && rm -f ${file}`.quiet();
  }
  return files.length;
}

/**
 * Spawn reviewer tool to write tests.
 */
async function spawnReviewer(
  tool: string,
  prompt: string,
  project: string,
  loopId: string
): Promise<{ exitCode: number; output: string }> {
  let cmd: string[];

  switch (tool) {
    case "claude":
      cmd = ["claude", "-p", prompt, "--output-format", "text"];
      break;
    case "pi":
      cmd = ["pi", "--prompt", prompt, "--no-tui"];
      break;
    default:
      cmd = ["claude", "-p", prompt, "--output-format", "text"];
  }

  const timeout = TOOL_TIMEOUTS[tool] ?? 20 * 60 * 1000;

  const proc = Bun.spawn(cmd, {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HOME },
  });

  await writePidFile(loopId, proc.pid);

  const timeoutId = setTimeout(() => {
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  }, timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeoutId);
  await cleanupPid(loopId);

  return {
    exitCode: proc.exitCode ?? 1,
    output: stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : ""),
  };
}

/**
 * Run checks based on what the PRD requests. Default: all.
 * checks param: ["typecheck", "lint", "test"] or subset.
 * For document/ADR projects, pass ["test"] to skip typecheck/lint.
 */
async function runChecks(project: string, checks?: string[]): Promise<{
  typecheckOk: boolean;
  typecheckOutput: string;
  lintOk: boolean;
  lintOutput: string;
  testsPassed: number;
  testsFailed: number;
  testOutput: string;
}> {
  const enabledChecks = checks ?? ["typecheck", "lint", "test"];

  // Typecheck
  let typecheckOk = true;
  let typecheckOutput = "";
  if (enabledChecks.includes("typecheck")) {
    try {
      const tc = await $`cd ${project} && bunx tsc --noEmit 2>&1`.quiet();
      typecheckOutput = tc.text().trim();
      typecheckOk = tc.exitCode === 0;
    } catch (e: any) {
      typecheckOk = false;
      typecheckOutput = e?.stdout?.toString() ?? e?.message ?? "typecheck failed";
    }
  }

  // Lint (try biome, then eslint, then skip)
  let lintOk = true;
  let lintOutput = "";
  if (enabledChecks.includes("lint")) {
    try {
      const lint = await $`cd ${project} && bunx biome check --no-errors-on-unmatched . 2>&1`.quiet();
      lintOutput = lint.text().trim();
      lintOk = lint.exitCode === 0;
    } catch {
      try {
        const lint = await $`cd ${project} && bunx eslint . 2>&1`.quiet();
        lintOutput = lint.text().trim();
        lintOk = lint.exitCode === 0;
      } catch {
        lintOk = true; // no linter configured
        lintOutput = "No linter configured";
      }
    }
  }

  // Tests
  let testsPassed = 0;
  let testsFailed = 0;
  let testOutput = "";
  try {
    const test = await $`cd ${project} && bun test 2>&1`.quiet();
    testOutput = test.text().trim();
    // Parse bun test output for pass/fail counts
    const passMatch = testOutput.match(/(\d+) pass/);
    const failMatch = testOutput.match(/(\d+) fail/);
    testsPassed = passMatch ? parseInt(passMatch[1], 10) : 0;
    testsFailed = failMatch ? parseInt(failMatch[1], 10) : 0;
    if (test.exitCode !== 0) testsFailed = Math.max(testsFailed, 1);
  } catch (e: any) {
    testsFailed = 1;
    testOutput = e?.stdout?.toString() ?? e?.message ?? "tests failed";
  }

  return { typecheckOk, typecheckOutput, lintOk, lintOutput, testsPassed, testsFailed, testOutput };
}

/**
 * REVIEWER — Writes tests from acceptance criteria, then runs checks.
 */
export const agentLoopReview = inngest.createFunction(
  {
    id: "agent-loop-review",
    concurrency: {
      key: "event.data.project",
      limit: 1,
    },
    retries: 0,
  },
  [{ event: "agent/loop.review" }],
  async ({ event, step }) => {
    const {
      loopId,
      project,
      storyId,
      commitSha,
      attempt,
      tool,
      story,
      maxRetries,
      maxIterations,
      storyStartedAt,
      retryLadder,
      freshTests,
      priorFeedback,
      checks,
    } =
      event.data;

    // Step 0: Check cancellation
    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId, storyId };

    if (freshTests) {
      await step.run("delete-existing-tests", () => deleteExistingTestFiles(project));
    }

    // Step 1: Write tests (independent of implementation — AgentCoder insight)
    await step.run("write-tests", async () => {
      const prompt = buildTestPrompt(story, Boolean(freshTests));
      return await spawnReviewer(tool, prompt, project, loopId);
    });

    // Step 2: Commit test files
    await step.run("commit-tests", async () => {
      await $`cd ${project} && git add -A`.quiet();
      try {
        await $`cd ${project} && git diff --cached --quiet`.quiet();
        // No new test files — that's ok
      } catch {
        await $`cd ${project} && git commit -m "test: [${loopId}] [${storyId}] attempt-${attempt} — reviewer tests"`.quiet();
      }
    });

    // Step 3: Run checks (typecheck + lint + tests)
    const results = await step.run("run-checks", () => runChecks(project, checks as string[] | undefined));

    // Step 4: Build structured feedback
    const feedback = await step.run("build-feedback", async () => {
      const parts: string[] = [];

      if (!results.typecheckOk) {
        parts.push(`## Typecheck Failures\n${results.typecheckOutput.slice(0, 5000)}`);
      }
      if (!results.lintOk) {
        parts.push(`## Lint Issues\n${results.lintOutput.slice(0, 3000)}`);
      }
      if (results.testsFailed > 0) {
        parts.push(`## Test Failures\n${results.testOutput.slice(0, 10000)}`);
      }
      if (parts.length === 0) {
        parts.push("All checks passed. Typecheck clean, lint clean, all tests pass.");
      }

      const feedbackText = parts.join("\n\n");

      // Use claim-check if feedback is large
      if (feedbackText.length > 10000) {
        return await claimCheckWrite(loopId, `review-${storyId}-${attempt}`, {
          feedback: feedbackText,
          results,
        });
      }
      return feedbackText;
    });

    // Step 5: Emit judge event
    await step.run("emit-judge", async () => {
      await inngest.send({
        name: "agent/loop.judge",
        data: {
          loopId,
          project,
          prdPath: "prd.json", // canonical location
          storyId,
          testResults: {
            testsPassed: results.testsPassed,
            testsFailed: results.testsFailed,
            typecheckOk: results.typecheckOk,
            lintOk: results.lintOk,
            details: results.testOutput.slice(0, 5000),
          },
          feedback,
          attempt,
          maxRetries,
          maxIterations,
          checks,
          storyStartedAt,
          retryLadder,
          priorFeedback,
          story,
          tool,
        },
      });
    });

    return {
      status: "reviewed",
      loopId,
      storyId,
      attempt,
      testsPassed: results.testsPassed,
      testsFailed: results.testsFailed,
      typecheckOk: results.typecheckOk,
      lintOk: results.lintOk,
    };
  }
);
