import { inngest } from "../../client";
import { $ } from "bun";
import {
  isCancelled,
  writePidFile,
  cleanupPid,
  getStoryDiff,
  parseClaudeOutput,
  TOOL_TIMEOUTS,
  guardStory,
  renewLease,
  ensureClaudeAuth,
} from "./utils";
import { join } from "node:path";

const TEST_FILE_PATTERN = /(?:^|\/)\S+\.test\.[^/]+$/;

interface ReviewerQuestion {
  id: string;
  answer: boolean;
  evidence: string;
}

interface ReviewerNotes {
  questions: ReviewerQuestion[];
  testResults: {
    typecheckOk: boolean;
    typecheckOutput: string;
    lintOk: boolean;
    lintOutput: string;
    testsPassed: number;
    testsFailed: number;
    testOutput: string;
  };
}

function extractNewTestFilesFromDiff(diff: string): string[] {
  const newFiles: string[] = [];
  let currentPath: string | null = null;
  let currentIsNewFile = false;

  const commitIfMatch = () => {
    if (currentPath && currentIsNewFile && TEST_FILE_PATTERN.test(currentPath)) {
      newFiles.push(currentPath);
    }
  };

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch?.[2]) {
      commitIfMatch();
      currentPath = fileMatch[2];
      currentIsNewFile = false;
      continue;
    }

    if (line.startsWith("new file mode ")) {
      currentIsNewFile = true;
    }
  }

  commitIfMatch();
  return Array.from(new Set(newFiles)).sort();
}

async function readTestFilesFromDisk(
  project: string,
  files: string[]
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];

  for (const file of files) {
    const fullPath = join(project, file);
    const bunFile = Bun.file(fullPath);
    if (!(await bunFile.exists())) continue;

    out.push({ path: file, content: await bunFile.text() });
  }

  return out;
}

function buildEvaluationPrompt(params: {
  story: { id: string; title: string; description: string; acceptance_criteria: string[] };
  diff: string;
  testFiles: Array<{ path: string; content: string }>;
}): string {
  const testFileSection = params.testFiles.length > 0
    ? params.testFiles
      .map((file) => `### ${file.path}\n\`\`\`ts\n${file.content}\n\`\`\``)
      .join("\n\n")
    : "(No new test files found in this diff.)";

  return [
    `## Evaluate Story Implementation: ${params.story.title} (${params.story.id})`,
    "",
    "You are reviewing implementation quality and test integrity.",
    "Answer only questions q2, q3, q4 using the provided implementation diff and test files.",
    "Return ONLY valid JSON.",
    "",
    "Required JSON shape:",
    '{"questions":[{"id":"q2","answer":true,"evidence":"..."},{"id":"q3","answer":true,"evidence":"..."},{"id":"q4","answer":true,"evidence":"..."}]}',
    "",
    "Question definitions:",
    "q2: Do tests exercise real implementations (not stubs/mocks replacing core behavior)?",
    "q3: Are tests truthful and not gaming the checks?",
    "q4: Do test + implementation accomplish the story intent from the ADR?",
    "",
    "Story intent:",
    params.story.description,
    "",
    "Acceptance criteria:",
    ...params.story.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "",
    "Implementation diff (HEAD~1..HEAD):",
    params.diff || "(empty diff)",
    "",
    "New test files content:",
    testFileSection,
    "",
    "Rules:",
    "- Use concrete evidence from diff and tests.",
    "- If evidence is missing, answer false.",
    "- Keep evidence concise and specific.",
  ].join("\n");
}

function parseJsonFromOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (!fenced?.[1]) return null;

    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
}

async function evaluateQuestionsWithClaude(
  prompt: string,
  project: string,
  loopId: string
): Promise<ReviewerQuestion[]> {
  ensureClaudeAuth();
  const timeout = TOOL_TIMEOUTS.claude ?? 20 * 60 * 1000;
  const cmd = ["claude", "-p", prompt, "--output-format", "json"];

  const proc = Bun.spawn(cmd, {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HOME },
  });

  await writePidFile(loopId, proc.pid);

  const timeoutId = setTimeout(() => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }, timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeoutId);
  await cleanupPid(loopId);

  const output = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : "");
  const payload = parseClaudeOutput(output) as
    | { questions?: Array<{ id?: unknown; answer?: unknown; evidence?: unknown }> }
    | null;

  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return [
      { id: "q2", answer: false, evidence: "Claude output was not valid structured JSON." },
      { id: "q3", answer: false, evidence: "Claude output was not valid structured JSON." },
      { id: "q4", answer: false, evidence: "Claude output was not valid structured JSON." },
    ];
  }

  const byId = new Map<string, ReviewerQuestion>();
  for (const q of questions) {
    if (typeof q?.id !== "string") continue;
    if (q.id !== "q2" && q.id !== "q3" && q.id !== "q4") continue;

    byId.set(q.id, {
      id: q.id,
      answer: q.answer === true,
      evidence: typeof q.evidence === "string" ? q.evidence : "No evidence provided.",
    });
  }

  return [
    byId.get("q2") ?? { id: "q2", answer: false, evidence: "Claude did not return q2." },
    byId.get("q3") ?? { id: "q3", answer: false, evidence: "Claude did not return q3." },
    byId.get("q4") ?? { id: "q4", answer: false, evidence: "Claude did not return q4." },
  ];
}

function buildReviewerFeedback(notes: ReviewerNotes): string {
  const failedQuestions = notes.questions.filter((q) => !q.answer);
  const parts: string[] = [];

  if (!notes.testResults.typecheckOk) {
    parts.push(`Typecheck failed:\n${notes.testResults.typecheckOutput.slice(0, 3000)}`);
  }
  if (!notes.testResults.lintOk) {
    parts.push(`Lint failed:\n${notes.testResults.lintOutput.slice(0, 3000)}`);
  }
  if (notes.testResults.testsFailed > 0) {
    parts.push(`Tests failed:\n${notes.testResults.testOutput.slice(0, 5000)}`);
  }

  if (failedQuestions.length > 0) {
    parts.push(
      `Reviewer questions failed:\n${failedQuestions.map((q) => `${q.id}: ${q.evidence}`).join("\n")}`
    );
  }

  if (parts.length === 0) {
    return "Reviewer evaluation passed all checks and questions.";
  }

  return parts.join("\n\n");
}

/**
 * Run typecheck, lint, and tests. Returns structured results.
 */
async function runChecks(project: string): Promise<{
  typecheckOk: boolean;
  typecheckOutput: string;
  lintOk: boolean;
  lintOutput: string;
  testsPassed: number;
  testsFailed: number;
  testOutput: string;
}> {
  // Typecheck
  let typecheckOk = true;
  let typecheckOutput = "";
  try {
    const tc = await $`cd ${project} && bunx tsc --noEmit 2>&1`.quiet();
    typecheckOutput = tc.text().trim();
    typecheckOk = tc.exitCode === 0;
  } catch (e: any) {
    typecheckOk = false;
    typecheckOutput = e?.stdout?.toString() ?? e?.message ?? "typecheck failed";
  }

  // Lint (try biome, then eslint, then skip)
  let lintOk = true;
  let lintOutput = "";
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
    testsPassed = passMatch ? parseInt(passMatch[1] ?? "0", 10) : 0;
    testsFailed = failMatch ? parseInt(failMatch[1] ?? "0", 10) : 0;
    if (test.exitCode !== 0) testsFailed = Math.max(testsFailed, 1);
  } catch (e: any) {
    testsFailed = 1;
    testOutput = e?.stdout?.toString() ?? e?.message ?? "tests failed";
  }

  return { typecheckOk, typecheckOutput, lintOk, lintOutput, testsPassed, testsFailed, testOutput };
}

/**
 * REVIEWER — Evaluates implementation quality and test integrity.
 */
export const agentLoopReview = inngest.createFunction(
  {
    id: "agent-loop-review",
    concurrency: {
      key: "event.data.project",
      limit: 1,
    },
  },
  [{ event: "agent/loop.code.committed" }],
  async ({ event, step }) => {
    const {
      loopId,
      project,
      storyId,
      attempt,
      story,
      maxRetries,
      maxIterations,
      storyStartedAt,
      retryLadder,
      priorFeedback,
    } = event.data;
    const workDir = event.data.workDir ?? project;
    const runToken = event.data.runToken;
    if (!runToken) {
      console.log(`[agent-loop-review] missing runToken for ${storyId}`);
      return { status: "missing-run-token", loopId, storyId };
    }

    // Step 0: Check cancellation
    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId, storyId };

    // Step 1: Run checks (typecheck + lint + tests)
    const results = await step.run("run-checks", () => runChecks(workDir));

    // Step 2: Read implementation diff
    const diff = await step.run("get-story-diff", () => getStoryDiff(workDir));

    // Step 3: Question 1 + test files from disk
    const { q1, testFiles } = await step.run("collect-test-files", async () => {
      const newTestFiles = extractNewTestFilesFromDiff(diff);
      const fileContents = await readTestFilesFromDisk(workDir, newTestFiles);
      const q1: ReviewerQuestion = {
        id: "q1",
        answer: newTestFiles.length > 0,
        evidence: newTestFiles.length > 0
          ? `New test files in diff: ${newTestFiles.join(", ")}`
          : "No new *.test.* files detected in git diff.",
      };
      return { q1, testFiles: fileContents };
    });

    // Step 4: Questions 2-4 via Claude
    const q2to4Result = await step.run("evaluate-with-claude", async () => {
      const guard = await guardStory(loopId, storyId, runToken);
      if (!guard.ok) {
        console.log(
          `[agent-loop-review] guard blocked evaluate-with-claude for ${storyId}: ${guard.reason}`
        );
        return { blocked: true as const, reason: guard.reason };
      }

      const prompt = buildEvaluationPrompt({ story, diff, testFiles });
      const questions = await evaluateQuestionsWithClaude(prompt, workDir, loopId);
      await renewLease(loopId, storyId, runToken);
      return { blocked: false as const, questions };
    });
    if (q2to4Result.blocked) {
      return { status: "blocked", loopId, storyId, reason: q2to4Result.reason };
    }
    const q2to4 = q2to4Result.questions;

    const reviewerNotes: ReviewerNotes = {
      questions: [q1, ...q2to4],
      testResults: results,
    };

    const feedback = buildReviewerFeedback(reviewerNotes);

    // Step 5: Emit judge event
    const emitResult = await step.run("emit-judge", async () => {
      const guard = await guardStory(loopId, storyId, runToken);
      if (!guard.ok) {
        console.log(
          `[agent-loop-review] guard blocked emit-judge for ${storyId}: ${guard.reason}`
        );
        return { blocked: true as const, reason: guard.reason };
      }

      await inngest.send({
        name: "agent/loop.checks.completed",
        data: {
          loopId,
          project,
          workDir,
          prdPath: "prd.json",
          storyId,
          testResults: {
            testsPassed: results.testsPassed,
            testsFailed: results.testsFailed,
            typecheckOk: results.typecheckOk,
            lintOk: results.lintOk,
            details: results.testOutput.slice(0, 5000),
          },
          feedback,
          reviewerNotes,
          attempt,
          maxRetries,
          maxIterations,
          storyStartedAt,
          retryLadder,
          priorFeedback,
          runToken,
          story,
          tool: "claude",
        },
      });
      return {
        event: "agent/loop.checks.completed",
        storyId,
        typecheck: results.typecheckOk,
        lint: results.lintOk,
        tests: `${results.testsPassed}✓ ${results.testsFailed}✗`,
        reviewerFlags: reviewerNotes.questions.filter(q => !q.answer).map(q => q.id),
      };
    });
    if ("blocked" in emitResult && emitResult.blocked) {
      return { status: "blocked", loopId, storyId, reason: emitResult.reason };
    }

    return {
      status: "reviewed",
      loopId,
      storyId,
      attempt,
      reviewerNotes,
      testsPassed: results.testsPassed,
      testsFailed: results.testsFailed,
      typecheckOk: results.typecheckOk,
      lintOk: results.lintOk,
    };
  }
);
