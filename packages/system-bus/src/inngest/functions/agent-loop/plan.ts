import { inngest } from "../../client";
import { NonRetriableError } from "inngest";
import { $ } from "bun";
import { join } from "node:path";
import { appendProgress, claimStory, createLoopOnFailure, isCancelled, readPrd, seedPrd, seedPrdFromData, markStoryRechecked, parseClaudeOutput, ensureClaudeAuth } from "./utils";

const DEFAULT_RETRY_LADDER = ["codex", "claude", "codex"] as const;

/**
 * Generate a PRD from a goal description + context files.
 * ADR-0012: Planner generates PRD.
 */
async function generatePrd(
  goal: string,
  project: string,
  contextPaths?: string[],
  maxStories: number = 6
): Promise<{ title: string; adr?: string; stories: any[] }> {
  // Read project structure
  let projectStructure = "";
  try {
    const top = await $`cd ${project} && ls -1`.quiet();
    projectStructure = top.text().trim();
    try {
      const src = await $`cd ${project} && find src -maxdepth 3 -type f 2>/dev/null`.quiet();
      if (src.text().trim()) projectStructure += "\n\nsrc/ files:\n" + src.text().trim();
    } catch { /* no src/ */ }
  } catch { /* empty project */ }

  // Read CLAUDE.md / AGENTS.md
  let projectInstructions = "";
  for (const f of ["CLAUDE.md", "AGENTS.md", ".agents/AGENTS.md"]) {
    try {
      const content = await Bun.file(join(project, f)).text();
      projectInstructions += `\n\n## ${f}\n${content.slice(0, 2000)}`;
    } catch { /* not found */ }
  }

  // Read context files (ADRs, docs)
  let contextContent = "";
  if (contextPaths) {
    for (const p of contextPaths) {
      try {
        const content = await Bun.file(p).text();
        contextContent += `\n\n## ${p.split("/").pop()}\n${content}`;
      } catch { /* not found */ }
    }
  }

  const prompt = `You are a technical project planner. Generate a PRD (Product Requirements Document) as JSON for an agent coding loop.

## Goal
${goal}

## Project Structure
${projectStructure}
${projectInstructions}

## Context Files
${contextContent || "(none provided)"}

## Instructions
Generate ${maxStories} or fewer small, focused stories. Each story must be completable by a single AI coding tool (codex or claude) in one invocation.

IMPORTANT: Output the JSON directly to stdout. Do NOT write any files. Do NOT use any tools. Just output the raw JSON and nothing else.

Output ONLY valid JSON matching this schema — no markdown, no commentary:
{
  "title": "short PRD title",
  "stories": [
    {
      "id": "SHORT-1",
      "title": "short title",
      "description": "detailed description of what to implement",
      "acceptance_criteria": ["criterion 1", "criterion 2", "TypeScript compiles cleanly: bunx tsc --noEmit"],
      "priority": 1,
      "passes": false
    }
  ]
}

Rules:
- Stories should be ordered by dependency (earlier stories are prerequisites)
- Each story MUST include "TypeScript compiles cleanly: bunx tsc --noEmit" in acceptance_criteria
- acceptance_criteria must be verifiable by reading source code, running typecheck, or running tests
- IDs should be short uppercase prefixes with numbers (e.g., GUARD-1, MEM-1)
- descriptions should include specific file paths and function names when known
- Keep stories small — one logical change per story`;

  ensureClaudeAuth();
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "json"],
    { cwd: project, stdout: "pipe", stderr: "pipe", env: process.env }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`PRD generation failed (exit ${proc.exitCode}): ${stderr.slice(0, 500)}`);
  }

  let parsed = parseClaudeOutput(stdout) as any;

  // Fallback: Claude may have written the PRD to a file instead of stdout
  if (!parsed) {
    try {
      const prdFile = await Bun.file(`${project}/prd.json`).text();
      parsed = JSON.parse(prdFile);
      console.log("[generatePrd] parsed PRD from file fallback");
    } catch {
      // noop
    }
  }
  if (!parsed) {
    throw new Error(`Failed to parse PRD JSON from claude output: ${stdout.slice(0, 500)}`);
  }

  // Validate shape
  if (!parsed.stories || !Array.isArray(parsed.stories) || parsed.stories.length === 0) {
    throw new NonRetriableError(`Generated PRD has no stories: ${JSON.stringify(parsed).slice(0, 500)}`);
  }

  // Cap stories
  if (parsed.stories.length > maxStories) {
    parsed.stories = parsed.stories.slice(0, maxStories);
  }

  // Ensure all stories have passes: false
  for (const s of parsed.stories) {
    s.passes = false;
  }

  return parsed;
}

async function runRecheckSuite(project: string): Promise<{
  passed: boolean;
  typecheckOutput: string;
  testOutput: string;
}> {
  let typecheckOk = true;
  let typecheckOutput = "";
  try {
    const tc = await $`cd ${project} && bunx tsc --noEmit 2>&1`.quiet();
    typecheckOk = tc.exitCode === 0;
    typecheckOutput = tc.text().trim();
  } catch (e: any) {
    typecheckOk = false;
    typecheckOutput = e?.stdout?.toString() ?? e?.message ?? "typecheck failed";
  }

  let testsOk = true;
  let testOutput = "";
  try {
    const test = await $`cd ${project} && bun test 2>&1`.quiet();
    testsOk = test.exitCode === 0;
    testOutput = test.text().trim();
  } catch (e: any) {
    testsOk = false;
    testOutput = e?.stdout?.toString() ?? e?.message ?? "tests failed";
  }

  return {
    passed: typecheckOk && testsOk,
    typecheckOutput,
    testOutput,
  };
}

// markStoryPassedFromRecheck is now markStoryRechecked in utils.ts

/**
 * PLANNER — Reads prd.json, finds next unpassed story, emits test.
 * If no stories remain, emits complete.
 */
export const agentLoopPlan = inngest.createFunction(
  {
    id: "agent-loop-plan",
    onFailure: createLoopOnFailure("plan"),
    cancelOn: [
      {
        event: "agent/loop.cancelled",
        if: "event.data.loopId == async.data.loopId",
      },
    ],
    concurrency: [
      {
        key: "event.data.loopId",
        limit: 1,
      },
    ],
  },
  [{ event: "agent/loop.started" }, { event: "agent/loop.story.passed" }, { event: "agent/loop.story.failed" }],
  async ({ event, step }) => {
    const { loopId, project } = event.data;
    const eventWorkDir = event.data.workDir ?? event.data.project;
    const prdPath = event.data.prdPath ?? "prd.json";
    const goal = (event.data as any).goal as string | undefined;
    const contextFiles = (event.data as any).context as string[] | undefined;
    const maxStories = (event.data as any).maxStories as number | undefined;

    // Read maxIterations from start event or re-entry plan event (default 100)
    const maxIterations =
      event.name === "agent/loop.started"
        ? event.data.maxIterations ?? 100
        : (event.data as any).maxIterations ?? 100;
    const retryLadder =
      event.name === "agent/loop.started"
        ? event.data.retryLadder ?? [...DEFAULT_RETRY_LADDER]
        : (event.data as any).retryLadder ?? [...DEFAULT_RETRY_LADDER];

    const isStartEvent = event.name === "agent/loop.started";

    // Step 0: Check cancellation before any worktree or filesystem work.
    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId };

    // Worktree isolation: each loop gets its own working directory.
    // Main repo working tree is NEVER touched by loop operations.
    const worktreeBase = `/tmp/agent-loop`;
    const worktreePath = `${worktreeBase}/${loopId}`;  // Always the worktree root
    const branchName = `agent-loop/${loopId}`;

    if (isStartEvent) {
      await step.run("create-worktree", async () => {
        await $`mkdir -p ${worktreeBase}`.quiet();
        // Compute relative path from git root to project (e.g. "packages/system-bus")
        const gitRoot = (await $`cd ${project} && git rev-parse --show-toplevel`.quiet()).text().trim();
        const relPath = project.startsWith(gitRoot) ? project.slice(gitRoot.length + 1) : "";
        // Create worktree on a new branch from current HEAD
        await $`cd ${project} && git worktree add ${worktreePath} -b ${branchName}`.quiet();
        // Copy PRD into the subpath where the project lives
        const worktreeProject = relPath ? join(worktreePath, relPath) : worktreePath;
        const prdFile = join(project, prdPath ?? "prd.json");
        const worktreePrd = join(worktreeProject, prdPath ?? "prd.json");
        if (await Bun.file(prdFile).exists()) {
          await $`cp ${prdFile} ${worktreePrd}`.quiet();
        }
      });

      // Install dependencies in the worktree so tests/typecheck work
      await step.run("install-worktree-deps", async () => {
        // Detect package manager from lockfile
        const hasPnpmLock = await Bun.file(`${worktreePath}/pnpm-lock.yaml`).exists();
        const hasBunLock = await Bun.file(`${worktreePath}/bun.lock`).exists() || await Bun.file(`${worktreePath}/bun.lockb`).exists();
        const hasYarnLock = await Bun.file(`${worktreePath}/yarn.lock`).exists();

        let installCmd: string;
        let pm: string;
        if (hasPnpmLock) {
          pm = "pnpm";
          installCmd = "pnpm install --frozen-lockfile 2>&1";
        } else if (hasBunLock) {
          pm = "bun";
          installCmd = "bun install --frozen-lockfile 2>&1";
        } else if (hasYarnLock) {
          pm = "yarn";
          installCmd = "yarn install --frozen-lockfile 2>&1";
        } else {
          pm = "npm";
          installCmd = "npm ci 2>&1";
        }

        try {
          // Use shell exec for reliable install — Bun.spawn can race on pnpm writes
          const { execSync } = await import("node:child_process");
          const output = execSync(installCmd, {
            cwd: worktreePath,
            timeout: 120_000,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          return {
            installed: true,
            packageManager: pm,
            output: output.slice(-200),
          };
        } catch (e: any) {
          // Non-fatal — tool may still work if it doesn't need deps
          return { installed: false, packageManager: pm, error: e?.message?.slice(0, 200) };
        }
      });
    } else {
      // Re-entry: verify worktree still exists
      await step.run("verify-worktree", async () => {
        const exists = await Bun.file(`${worktreePath}/.git`).exists();
        if (!exists) {
          throw new NonRetriableError(`Worktree missing at ${worktreePath} — loop may have been cleaned up`);
        }
      });

      // Ensure deps are installed on re-entry too (may have been missed or cleaned)
      await step.run("ensure-worktree-deps", async () => {
        const { existsSync } = await import("node:fs");
        const hasNodeModules = existsSync(`${worktreePath}/node_modules`);
        if (hasNodeModules) {
          return { installed: true, skipped: true, reason: "node_modules exists" };
        }
        // Same install logic as create path
        const hasPnpmLock = await Bun.file(`${worktreePath}/pnpm-lock.yaml`).exists();
        const hasBunLock = await Bun.file(`${worktreePath}/bun.lock`).exists() || await Bun.file(`${worktreePath}/bun.lockb`).exists();
        let installCmd: string;
        let pm: string;
        if (hasPnpmLock) { pm = "pnpm"; installCmd = "pnpm install --frozen-lockfile 2>&1"; }
        else if (hasBunLock) { pm = "bun"; installCmd = "bun install --frozen-lockfile 2>&1"; }
        else { pm = "npm"; installCmd = "npm ci 2>&1"; }
        try {
          const { execSync } = await import("node:child_process");
          execSync(installCmd, { cwd: worktreePath, timeout: 120_000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
          return { installed: true, packageManager: pm };
        } catch (e: any) {
          return { installed: false, packageManager: pm, error: e?.message?.slice(0, 200) };
        }
      });
    }

    // Compute workDir: worktree root + relative subpath to the actual project
    // e.g. /tmp/agent-loop/{loopId}/packages/system-bus
    const workDir = await step.run("resolve-workdir", async () => {
      const gitRoot = (await $`cd ${project} && git rev-parse --show-toplevel`.quiet()).text().trim();
      const relPath = project.startsWith(gitRoot) ? project.slice(gitRoot.length + 1) : "";
      return relPath ? join(worktreePath, relPath) : worktreePath;
    });

    // Step 1: Read or generate PRD
    // ADR-0012: If goal is provided, generate PRD from goal + context files
    const prd = await step.run("read-prd", async () => {
      if (!isStartEvent) {
        return readPrd(workDir, prdPath, loopId);
      }

      if (goal) {
        // Generate PRD from goal (reads project structure from worktree)
        const generated = await generatePrd(goal, workDir, contextFiles, maxStories ?? 6);

        // Write to worktree for tool access + canonical project for human review
        const worktreePrdPath = join(workDir, prdPath ?? "prd.json");
        await Bun.write(worktreePrdPath, JSON.stringify(generated, null, 2) + "\n");
        const diskPath = join(project, prdPath ?? "prd.json");
        await Bun.write(diskPath, JSON.stringify(generated, null, 2) + "\n");

        await appendProgress(loopId, [
          `## PRD Generated from Goal`,
          `Goal: ${goal}`,
          `Context: ${contextFiles?.join(", ") ?? "none"}`,
          `Stories: ${generated.stories.length}`,
          ...generated.stories.map((s: any) => `- ${s.id}: ${s.title}`),
        ].join("\n"));

        // Seed to Redis
        return seedPrdFromData(loopId, generated, {
          project,
          workDir: eventWorkDir,
        });
      }

      // Default: read from worktree disk
      return seedPrd(loopId, workDir, prdPath, {
        project,
        workDir: eventWorkDir,
      });
    });

    // Count attempted stories (passed + skipped) for maxIterations enforcement
    const attemptedStories = prd.stories.filter(
      (s) => s.passes || (s as any).skipped
    ).length;

    const remaining = prd.stories
      .filter((s) => !s.passes && !(s as any).skipped)
      .sort((a, b) => a.priority - b.priority);

    // Step 2: Check maxIterations limit
    if (attemptedStories >= maxIterations) {
      const completed = prd.stories.filter((s) => s.passes).length;
      const skipped = prd.stories.filter((s) => (s as any).skipped).length;
      await step.sendEvent("emit-complete-max-iterations", {
        name: "agent/loop.completed",
        data: {
          loopId,
          project,
          workDir,
          summary: `max_iterations_reached (${maxIterations}). ${completed} completed, ${skipped} skipped.`,
          storiesCompleted: completed,
          storiesFailed: skipped,
          cancelled: false,
          branchName,
        },
      });
      return {
        status: "max_iterations_reached",
        loopId,
        maxIterations,
        attemptedStories,
        storiesCompleted: completed,
      };
    }

    // Step 3: If no stories remain, recheck skipped stories before complete
    if (remaining.length === 0) {
      const skippedStories = prd.stories.filter((s) => (s as any).skipped);
      const recheckResults: { storyId: string; status: "passed" | "still-failing" }[] = [];

      for (const skippedStory of skippedStories) {
        const checks = await step.run(`recheck-suite-${skippedStory.id}`, () =>
          runRecheckSuite(workDir)
        );

        if (checks.passed) {
          await step.run(`recheck-pass-${skippedStory.id}`, async () => {
            await markStoryRechecked(workDir, prdPath, skippedStory.id, loopId);
            await appendProgress(
              loopId,
              [
                `**Story ${skippedStory.id}: ${skippedStory.title}** — RECHECK PASS`,
                "- Recheck result: typecheck + tests now pass",
                "- Action: unskipped and marked passes=true",
              ].join("\n")
            );
          });
          recheckResults.push({ storyId: skippedStory.id, status: "passed" });
        } else {
          await step.run(`recheck-still-failing-${skippedStory.id}`, async () => {
            await appendProgress(
              loopId,
              [
                `**Story ${skippedStory.id}: ${skippedStory.title}** — RECHECK STILL FAILING`,
                "- Recheck result: still failing typecheck/tests",
              ].join("\n")
            );
          });
          recheckResults.push({ storyId: skippedStory.id, status: "still-failing" });
        }
      }

      const finalPrd = await step.run("read-prd-post-recheck", () =>
        readPrd(workDir, prdPath, loopId)
      );
      const completed = finalPrd.stories.filter((s) => s.passes).length;
      const failed = finalPrd.stories.filter((s) => (s as any).skipped).length;
      const recovered = recheckResults.filter((r) => r.status === "passed").length;
      const stillFailing = recheckResults.filter(
        (r) => r.status === "still-failing"
      ).length;

      await step.sendEvent("emit-complete", {
        name: "agent/loop.completed",
        data: {
          loopId,
          project,
          workDir,
          summary: `All stories processed. ${completed} completed, ${failed} skipped. Recheck: ${recovered} recovered, ${stillFailing} still failing.`,
          storiesCompleted: completed,
          storiesFailed: failed,
          cancelled: false,
          branchName,
        },
      });
      return {
        status: "complete",
        loopId,
        storiesCompleted: completed,
        recheckResults,
      };
    }

    // Step 4: Dispatch next story
    const next = remaining[0];
    if (!next) {
      throw new Error("No remaining story to dispatch");
    }
    const story = {
      id: next.id,
      title: next.title,
      description: next.description,
      acceptance_criteria: next.acceptance_criteria,
    };

    // Determine tool assignment
    const toolAssignments =
      event.name === "agent/loop.started"
        ? event.data.toolAssignments
        : undefined;

    const assignment = toolAssignments?.[next.id];
    const implTool = assignment?.implementor ?? "codex";
    const maxRetries =
      event.name === "agent/loop.started"
        ? event.data.maxRetries ?? 2
        : (event.data as any).maxRetries ?? 2;

    const runToken = await step.run("derive-run-token", () => {
      const eventId = (event as { id?: string }).id;
      return eventId ? `event:${eventId}` : crypto.randomUUID();
    });

    const claimedRunToken = await step.run("claim-story", () =>
      claimStory(loopId, next.id, runToken)
    );

    if (!claimedRunToken) {
      console.warn(
        `[agent-loop-plan] story already claimed, skipping dispatch loopId=${loopId} storyId=${next.id}`
      );
      return {
        status: "already-claimed",
        loopId,
        storyId: next.id,
        remaining: remaining.length,
        maxIterations,
      };
    }

    await step.sendEvent("emit-test", {
      name: "agent/loop.story.dispatched",
      data: {
        loopId,
        project,
        workDir,
        storyId: next.id,
        tool: implTool,
        attempt: 1,
        story,
        maxRetries,
        maxIterations,
        retryLadder,
        runToken: claimedRunToken,
      },
    });

    return {
      status: "dispatched",
      loopId,
      storyId: next.id,
      tool: implTool,
      remaining: remaining.length,
      maxIterations,
    };
  }
);
