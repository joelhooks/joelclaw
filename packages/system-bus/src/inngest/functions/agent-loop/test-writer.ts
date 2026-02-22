import { inngest } from "../../client";
import { $ } from "bun";
import {
  isCancelled,
  writePidFile,
  cleanupPid,
  TOOL_TIMEOUTS,
  guardStory,
  renewLease,
  createLoopOnFailure,
  ensureClaudeAuth,
} from "./utils";

function buildTestWriterPrompt(story: {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
}): string {
  return [
    `## Write Acceptance Tests: ${story.title} (${story.id})`,
    "",
    "You are writing acceptance tests for this story.",
    "Focus on observable behavior and product intent only.",
    "Do NOT test internal structure, private functions, or implementation details.",
    "Do NOT use source code string matching (indexOf, regex on source text) to verify behavior.",
    "Instead, import the module and test its exports, return values, and side effects.",
    "",
    "## Story Description",
    story.description,
    "",
    "## Acceptance Criteria",
    ...story.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "",
    "## Instructions",
    "1. Write tests that directly validate each acceptance criterion through public behavior.",
    "2. Prefer end-to-end or integration-style assertions when possible.",
    "3. Use `expect(result).toMatchObject({...})` for structural assertions, not `toEqual`. This makes tests resilient to interface evolution — new fields don't break old tests.",
    "4. Use the existing project test framework and conventions.",
    "5. Keep tests readable and focused on intent.",
    "6. Do not modify implementation code.",
    "7. Do not run tests.",
  ].join("\n");
}

function isTestFilePath(path: string): boolean {
  if (path.includes("/__tests__/")) return true;
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(path);
}

async function listUntrackedFiles(project: string): Promise<string[]> {
  try {
    const result = await $`cd ${project} && git ls-files --others --exclude-standard`.quiet();
    return result
      .text()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function commitNewTestFiles(
  project: string,
  loopId: string,
  storyId: string,
  files: string[]
): Promise<void> {
  if (files.length === 0) return;

  for (const file of files) {
    await $`cd ${project} && git add ${file}`.quiet();
  }

  try {
    await $`cd ${project} && git diff --cached --quiet`.quiet();
    return;
  } catch {
    await $`cd ${project} && git commit -m ${`test: [${loopId}] [${storyId}] acceptance tests`}`.quiet();
  }
}

async function spawnReviewer(
  tool: string,
  prompt: string,
  project: string,
  loopId: string
): Promise<{ exitCode: number; output: string }> {
  let cmd: string[];

  switch (tool) {
    case "codex":
      cmd = ["codex", "exec", "--full-auto", prompt];
      break;
    case "claude":
      ensureClaudeAuth();
      cmd = ["claude", "-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"];
      break;
    case "pi":
      cmd = ["pi", "--prompt", prompt, "--no-tui"];
      break;
    default:
      ensureClaudeAuth();
      cmd = ["claude", "-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"];
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

export const agentLoopTestWriter = inngest.createFunction(
  {
    id: "agent-loop-test-writer",
    onFailure: createLoopOnFailure("test-writer"),
    cancelOn: [
      {
        event: "agent/loop.cancelled",
        if: "event.data.loopId == async.data.loopId",
      },
    ],
    concurrency: {
      key: "event.data.project",
      limit: 1,
    },
  },
  [{ event: "agent/loop.story.dispatched" }],
  async ({ event, step }) => {
    const {
      loopId,
      project,
      storyId,
      story,
      tool,
      attempt,
      maxRetries,
      maxIterations,
      storyStartedAt,
      retryLadder,
    } = event.data;
    const workDir = event.data.workDir ?? project;
    const runToken = event.data.runToken;
    if (!runToken) {
      console.log(`[agent-loop-test-writer] missing runToken for ${storyId}`);
      return { status: "blocked", loopId, storyId, reason: "missing_run_token" };
    }

    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId, storyId };

    const untrackedBefore = await step.run("snapshot-untracked-before", () =>
      listUntrackedFiles(workDir)
    );

    const writeResult = await step.run("write-tests", async () => {
      const guard = await guardStory(loopId, storyId, runToken);
      if (!guard.ok) {
        console.log(
          `[agent-loop-test-writer] guard blocked write-tests for ${storyId}: ${guard.reason}`
        );
        return { blocked: true as const, reason: guard.reason };
      }
      const prompt = buildTestWriterPrompt(story);
      const result = await spawnReviewer(tool, prompt, workDir, loopId);
      await renewLease(loopId, storyId, runToken);
      return { blocked: false as const, result };
    });
    if (writeResult.blocked) {
      return { status: "blocked", loopId, storyId, reason: writeResult.reason };
    }

    const testFiles = await step.run("collect-new-test-files", async () => {
      const beforeSet = new Set(untrackedBefore);
      const untrackedAfter = await listUntrackedFiles(workDir);
      const files: string[] = [];
      for (const path of untrackedAfter) {
        if (!beforeSet.has(path) && isTestFilePath(path)) {
          files.push(path);
        }
      }
      return files.sort();
    });

    await step.run("commit-new-test-files", () =>
      commitNewTestFiles(workDir, loopId, storyId, testFiles)
    );
    await renewLease(loopId, storyId, runToken);

    const emitResult = await step.run("emit-implement", async () => {
      const guard = await guardStory(loopId, storyId, runToken);
      if (!guard.ok) {
        console.log(
          `[agent-loop-test-writer] guard blocked emit-implement for ${storyId}: ${guard.reason}`
        );
        return { blocked: true as const, reason: guard.reason };
      }
      await step.sendEvent("emit-tests-written", {
        name: "agent/loop.tests.written",
        data: {
          loopId,
          project,
          workDir,
          storyId,
          tool,
          attempt,
          story,
          maxRetries,
          maxIterations,
          storyStartedAt,
          retryLadder,
          runToken,
          testFiles,
        },
      });
      await renewLease(loopId, storyId, runToken);
      return { blocked: false as const };
    });
    if (emitResult.blocked) {
      return { status: "blocked", loopId, storyId, reason: emitResult.reason };
    }

    return {
      status: "tests-written",
      loopId,
      storyId,
      attempt,
      testFiles,
      tool,
    };
  }
);
