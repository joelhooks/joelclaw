import { inngest } from "../../client";
import { $ } from "bun";
import {
  isCancelled,
  commitExists,
  commitMessage,
  gitCommit,
  outputPath,
  writePidFile,
  cleanupPid,
  parseToolOutput,
  TOOL_TIMEOUTS,
  hasUncommittedChanges,
  getHeadSha,
  isDockerAvailable,
  spawnInContainer,
  guardStory,
  renewLease,
  readLessons,
  readRecommendations,
  readPatterns,
} from "./utils";

/**
 * Read a file if it exists, return empty string otherwise.
 */
async function readFileIfExists(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

function formatRecommendationsContext(
  raw: string | {
    toolRankings?: Array<{ tool?: string; passRate?: number; avgAttempts?: number }>;
    retryPatterns?: string[];
    suggestedRetryLadder?: string[];
    lastUpdated?: string;
    sourceLoopId?: string;
  } | null
): string {
  if (!raw) return "";
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

    const lines: string[] = [];
    if (parsed.sourceLoopId) lines.push(`Source loop: ${parsed.sourceLoopId}`);
    if (parsed.lastUpdated) lines.push(`Last updated: ${parsed.lastUpdated}`);

    if (parsed.toolRankings && parsed.toolRankings.length > 0) {
      lines.push("", "Tool rankings:");
      for (const rank of parsed.toolRankings.slice(0, 5)) {
        lines.push(
          `- ${rank.tool ?? "unknown"}: passRate=${rank.passRate ?? 0}, avgAttempts=${rank.avgAttempts ?? 0}`
        );
      }
    }

    if (parsed.retryPatterns && parsed.retryPatterns.length > 0) {
      lines.push("", "Retry patterns:");
      for (const pattern of parsed.retryPatterns.slice(0, 5)) {
        lines.push(`- ${pattern}`);
      }
    }

    if (parsed.suggestedRetryLadder && parsed.suggestedRetryLadder.length > 0) {
      lines.push("", `Suggested retry ladder: ${parsed.suggestedRetryLadder.join(" -> ")}`);
    }

    return lines.join("\n").trim();
  } catch {
    return "";
  }
}

type RecommendationsContext = {
  toolRankings?: Array<{ tool?: string; passRate?: number; avgAttempts?: number }>;
  retryPatterns?: string[];
  suggestedRetryLadder?: string[];
  lastUpdated?: string;
  sourceLoopId?: string;
};

/**
 * Get a brief file listing of the project (top-level + src/ if exists).
 * Capped at 50 lines.
 */
async function getFileListing(project: string): Promise<string> {
  try {
    const topLevel = await $`cd ${project} && ls -1`.quiet();
    let listing = topLevel.text().trim();

    // If src/ exists, include its contents too
    try {
      const srcListing = await $`cd ${project} && find src -maxdepth 2 -type f 2>/dev/null`.quiet();
      const srcText = srcListing.text().trim();
      if (srcText) {
        listing += "\n\n# src/ files:\n" + srcText;
      }
    } catch { /* no src/ */ }

    // Cap at 50 lines
    const lines = listing.split("\n");
    if (lines.length > 50) {
      return lines.slice(0, 50).join("\n") + `\n... (${lines.length - 50} more files)`;
    }
    return listing;
  } catch {
    return "";
  }
}

const PROMPT_MAX_CHARS = 8000;

/**
 * Build the prompt for the implementor tool with rich project context.
 * Includes: story + criteria, codebase patterns, CLAUDE.md, AGENTS.md,
 * file listing, and prior attempt feedback.
 *
 * Truncation order (cut from bottom):
 *   1. CLAUDE.md / AGENTS.md (least critical — tool may read itself)
 *   2. File listing (helpful but not essential)
 *   3. Codebase patterns (important for avoiding known issues)
 *   4. Story + feedback (never truncated)
 */
async function buildPrompt(
  story: { id: string; title: string; description: string; acceptance_criteria: string[] },
  project: string,
  feedback?: string
): Promise<string> {
  // Core sections (never truncated)
  const coreParts = [
    `## Story: ${story.title} (${story.id})`,
    "",
    story.description,
    "",
    "## Acceptance Criteria",
    ...story.acceptance_criteria.map((c) => `- ${c}`),
  ];

  if (feedback) {
    coreParts.push("", "## Feedback from Previous Attempt", "", feedback);
  }

  coreParts.push(
    "",
    "## Instructions",
    "Implement the story above. Do NOT write tests — a separate reviewer will handle testing.",
    "Make clean, focused changes. Commit nothing — the harness handles git.",
  );

  const coreText = coreParts.join("\n");

  // Context sections (truncatable, in priority order)
  const patterns = await readPatterns(project);
  const recommendationsRaw = await readRecommendations<RecommendationsContext>(project);
  const recommendations = formatRecommendationsContext(recommendationsRaw);
  const lessons = await readLessons(project);

  const fileListing = await getFileListing(project);

  const claudeMd = await readFileIfExists(`${project}/CLAUDE.md`);
  const agentsMd = await readFileIfExists(`${project}/AGENTS.md`);

  // Assemble context sections with budget
  const contextSections: { label: string; content: string; priority: number }[] = [];

  if (patterns) {
    contextSections.push({ label: "## Codebase Patterns", content: patterns, priority: 1 });
  }
  if (recommendations) {
    contextSections.push({
      label: "## Prior Loop Recommendations",
      content: recommendations.slice(0, 2000),
      priority: 2,
    });
  }
  if (lessons.length > 0) {
    const lessonsText = lessons.slice(-5).reverse().join("\n\n");
    contextSections.push({
      label: "## Lessons from Prior Loops",
      content: lessonsText.slice(0, 3000),
      priority: 2,
    });
  }
  if (fileListing) {
    contextSections.push({ label: "## Project File Listing", content: fileListing, priority: 3 });
  }
  if (claudeMd) {
    contextSections.push({ label: "## Project Instructions (CLAUDE.md)", content: claudeMd.slice(0, 2000), priority: 4 });
  }
  if (agentsMd) {
    contextSections.push({ label: "## Agent Instructions (AGENTS.md)", content: agentsMd.slice(0, 2000), priority: 5 });
  }

  // Build prompt, dropping lowest-priority sections first if over budget
  let contextText = "";
  // Sort by priority (1 = highest, keep first)
  const sorted = contextSections.sort((a, b) => a.priority - b.priority);

  for (const section of sorted) {
    const candidate = `\n\n${section.label}\n\n${section.content}`;
    if (coreText.length + contextText.length + candidate.length <= PROMPT_MAX_CHARS) {
      contextText += candidate;
    }
  }

  return contextText ? contextText + "\n\n---\n\n" + coreText : coreText;
}

/**
 * Spawn a tool subprocess and capture output (host-mode).
 * Returns the exit code.
 */
async function spawnToolHost(
  tool: string,
  prompt: string,
  project: string,
  loopId: string,
  outPath: string
): Promise<number> {
  let cmd: string[];

  switch (tool) {
    case "codex":
      cmd = ["codex", "exec", "--full-auto", prompt];
      break;
    case "claude":
      cmd = ["claude", "-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"];
      break;
    case "pi":
      cmd = ["pi", "--prompt", prompt, "--no-tui"];
      break;
    default:
      cmd = ["codex", "exec", "--full-auto", prompt];
  }

  const timeout = TOOL_TIMEOUTS[tool] ?? 15 * 60 * 1000;
  const outFile = Bun.file(outPath);

  const proc = Bun.spawn(cmd, {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HOME },
  });

  // Write PID for cancellation support
  await writePidFile(loopId, proc.pid);

  // Set up timeout
  const timeoutId = setTimeout(() => {
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  }, timeout);

  // Capture stdout
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeoutId);

  await Bun.write(outFile, stdout + (stderr ? `\n\n--- STDERR ---\n${stderr}` : ""));
  await cleanupPid(loopId);

  return proc.exitCode ?? 1;
}

/**
 * Spawn a tool — defaults to Docker container execution.
 * Falls back to host-mode when AGENT_LOOP_HOST=1 or Docker is unavailable.
 */
async function spawnTool(
  tool: string,
  prompt: string,
  project: string,
  loopId: string,
  outPath: string,
  branchName?: string
): Promise<number> {
  const forceHost = process.env.AGENT_LOOP_HOST === "1";

  if (!forceHost && (await isDockerAvailable())) {
    // Resolve repo URL from git remote
    const { $ } = await import("bun");
    let repoUrl: string | null = null;
    try {
      const remote = await $`cd ${project} && git remote get-url origin`.quiet();
      repoUrl = remote.text()?.trim() ?? "";
      // Convert SSH to HTTPS if needed
      if (repoUrl.startsWith("git@github.com:")) {
        repoUrl = repoUrl.replace("git@github.com:", "https://github.com/");
      }
      if (!repoUrl.endsWith(".git")) repoUrl += ".git";
    } catch {
      // No remote — fall through to host-mode fallback
      repoUrl = null;
    }

    if (repoUrl) {
      const branch = branchName ?? `agent-loop/${loopId}`;
      const result = await spawnInContainer(
        tool as "codex" | "claude" | "pi",
        prompt,
        repoUrl,
        branch,
        loopId,
        "impl"
      );

      await Bun.write(Bun.file(outPath), result.output);
      return result.exitCode;
    }
  }

  // Host-mode fallback
  return spawnToolHost(tool, prompt, project, loopId, outPath);
}

/**
 * IMPLEMENTOR — Spawns tool, captures output, commits changes.
 */
export const agentLoopImplement = inngest.createFunction(
  {
    id: "agent-loop-implement",
    concurrency: {
      key: "event.data.project",
      limit: 1,
    },
    retries: 0, // retries handled by JUDGE loop, not Inngest
  },
  [{ event: "agent/loop.tests.written" }, { event: "agent/loop.story.retried" }],
  async ({ event, step }) => {
    const {
      loopId,
      project,
      storyId,
      tool,
      attempt,
      feedback,
      story,
      maxRetries,
      maxIterations,
      retryLadder,
      freshTests,
      storyStartedAt: incomingStoryStartedAt,
    } =
      event.data;
    const runToken = event.data.runToken;
    if (!runToken) {
      console.log(`[agent-loop-implement] missing runToken for ${storyId}`);
      return { status: "blocked", loopId, storyId, reason: "missing_run_token" };
    }

    // Record story start time for duration tracking
    const storyStartedAt = await step.run("record-start-time", () =>
      incomingStoryStartedAt ?? Date.now()
    );

    // Step 0: Check cancellation
    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId, storyId };

    // Step 0.5: Idempotency — check if commit already exists
    const alreadyDone = await step.run("check-idempotency", () =>
      commitExists(project, loopId, storyId, attempt)
    );

    let sha: string;

    if (alreadyDone) {
      // Skip re-execution, get existing commit sha
      sha = await step.run("get-existing-sha", async () => {
        const result =
          await $`cd ${project} && git log --oneline --all --grep="[${loopId}] [${storyId}] attempt-${attempt}" --format="%H"`.quiet();
        return result.text().trim().split("\n")[0] ?? "";
      });
    } else {
      // Step 1: Record HEAD before tool runs (to detect tool auto-commits)
      const headBefore = await step.run("record-head-before", () =>
        getHeadSha(project)
      );

      // Step 2: Spawn tool
      const outPath = outputPath(loopId, storyId, attempt);
      const prompt = await buildPrompt(story, project, feedback);

      const runToolResult = await step.run("run-tool", async () => {
        const guard = await guardStory(loopId, storyId, runToken);
        if (!guard.ok) {
          console.log(
            `[agent-loop-implement] guard blocked run-tool for ${storyId}: ${guard.reason}`
          );
          return { blocked: true as const, reason: guard.reason };
        }
        const exitCode = await spawnTool(tool, prompt, project, loopId, outPath);
        await renewLease(loopId, storyId, runToken);
        return { blocked: false as const, exitCode };
      });
      if (runToolResult.blocked) {
        return { status: "blocked", loopId, storyId, reason: runToolResult.reason };
      }

      // Step 3: Smart commit — detect if tool already committed
      const commitResult = await step.run("git-commit", async () => {
        const guard = await guardStory(loopId, storyId, runToken);
        if (!guard.ok) {
          console.log(
            `[agent-loop-implement] guard blocked git-commit for ${storyId}: ${guard.reason}`
          );
          return { blocked: true as const, reason: guard.reason, sha: "" };
        }
        const headAfter = await getHeadSha(project);
        const toolCommitted = headAfter !== headBefore;
        const uncommitted = await hasUncommittedChanges(project);

        if (toolCommitted && !uncommitted) {
          // Tool already committed and no remaining changes — use its sha
          await renewLease(loopId, storyId, runToken);
          return { blocked: false as const, sha: headAfter };
        }

        if (!uncommitted) {
          // No tool commit AND no changes — nothing happened, return HEAD
          await renewLease(loopId, storyId, runToken);
          return { blocked: false as const, sha: headAfter };
        }

        // There are uncommitted changes — make the harness commit
        const msg = commitMessage(loopId, storyId, attempt, story.title);
        const sha = await gitCommit(project, msg);
        await renewLease(loopId, storyId, runToken);
        return { blocked: false as const, sha };
      });
      if (commitResult.blocked) {
        return { status: "blocked", loopId, storyId, reason: commitResult.reason };
      }
      sha = commitResult.sha;
    }

    // Step 3: Determine reviewer tool (default: claude)
    const reviewerTool = "claude" as const;

    // Step 4: Emit review event
    const emitResult = await step.run("emit-review", async () => {
      const guard = await guardStory(loopId, storyId, runToken);
      if (!guard.ok) {
        console.log(
          `[agent-loop-implement] guard blocked emit-review for ${storyId}: ${guard.reason}`
        );
        return { blocked: true as const, reason: guard.reason };
      }
      await inngest.send({
        name: "agent/loop.code.committed",
        data: {
          loopId,
          project,
          storyId,
          commitSha: sha,
          attempt,
          tool: reviewerTool,
          story,
          maxRetries,
          maxIterations,
          storyStartedAt,
          retryLadder,
          freshTests,
          runToken,
          priorFeedback: feedback,
        },
      });
      await renewLease(loopId, storyId, runToken);
      return { event: "agent/loop.code.committed", storyId, sha: sha.slice(0, 8), reviewer: reviewerTool };
    });
    if ("blocked" in emitResult && emitResult.blocked) {
      return { status: "blocked", loopId, storyId, reason: emitResult.reason };
    }

    return { status: "implemented", loopId, storyId, attempt, sha, tool };
  }
);
