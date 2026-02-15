import { inngest } from "../../client";
import { $ } from "bun";
import {
  isCancelled,
  writePidFile,
  cleanupPid,
  TOOL_TIMEOUTS,
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
    "3. Use the existing project test framework and conventions.",
    "4. Keep tests readable and focused on intent.",
    "5. Do not modify implementation code.",
    "6. Do not run tests.",
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

export const agentLoopTestWriter = inngest.createFunction(
  {
    id: "agent-loop-test-writer",
    concurrency: {
      key: "event.data.project",
      limit: 1,
    },
    retries: 0,
  },
  [{ event: "agent/loop.test" }],
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

    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId, storyId };

    const untrackedBefore = await step.run("snapshot-untracked-before", () =>
      listUntrackedFiles(project)
    );

    await step.run("write-tests", async () => {
      const prompt = buildTestWriterPrompt(story);
      return spawnReviewer(tool, prompt, project, loopId);
    });

    const testFiles = await step.run("collect-new-test-files", async () => {
      const beforeSet = new Set(untrackedBefore);
      const untrackedAfter = await listUntrackedFiles(project);
      const files: string[] = [];
      for (const path of untrackedAfter) {
        if (!beforeSet.has(path) && isTestFilePath(path)) {
          files.push(path);
        }
      }
      return files.sort();
    });

    await step.run("commit-new-test-files", () =>
      commitNewTestFiles(project, loopId, storyId, testFiles)
    );

    await step.run("emit-implement", async () => {
      await inngest.send({
        name: "agent/loop.implement",
        data: {
          loopId,
          project,
          storyId,
          tool,
          attempt,
          story,
          maxRetries,
          maxIterations,
          storyStartedAt,
          retryLadder,
          testFiles,
        },
      });
    });

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
