import { inngest } from "../../client";
import { $ } from "bun";
import { join } from "node:path";
import { appendProgress, claimStory, isCancelled, readPrd, seedPrd, seedPrdFromData, markStoryRechecked, parseClaudeOutput } from "./utils";

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

  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "json"],
    { cwd: project, stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`PRD generation failed (exit ${proc.exitCode}): ${stderr.slice(0, 500)}`);
  }

  const parsed = parseClaudeOutput(stdout) as any;
  if (!parsed) {
    throw new Error(`Failed to parse PRD JSON from claude output: ${stdout.slice(0, 500)}`);
  }

  // Validate shape
  if (!parsed.stories || !Array.isArray(parsed.stories) || parsed.stories.length === 0) {
    throw new Error(`Generated PRD has no stories: ${JSON.stringify(parsed).slice(0, 500)}`);
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
    concurrency: {
      key: "event.data.project",
      limit: 1,
    },
    retries: 1,
  },
  [{ event: "agent/loop.started" }, { event: "agent/loop.story.passed" }, { event: "agent/loop.story.failed" }],
  async ({ event, step }) => {
    const { loopId, project } = event.data;
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

    // Branch lifecycle: create on start, verify on re-entry
    const branchName = `agent-loop/${loopId}`;
    const isStartEvent = event.name === "agent/loop.started";

    if (isStartEvent) {
      // Create and checkout feature branch
      await step.run("create-branch", async () => {
        await $`cd ${project} && git checkout -b ${branchName}`.quiet();
      });
    } else {
      // Re-entry: verify branch is checked out
      await step.run("verify-branch", async () => {
        const currentBranch = (await $`cd ${project} && git rev-parse --abbrev-ref HEAD`.quiet()).text().trim();
        if (currentBranch !== branchName) {
          await $`cd ${project} && git checkout ${branchName}`.quiet();
        }
      });
    }

    // Step 0: Check cancellation
    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId };

    // Step 1: Read or generate PRD
    // ADR-0012: If goal is provided, generate PRD from goal + context files
    const prd = await step.run("read-prd", async () => {
      if (!isStartEvent) {
        return readPrd(project, prdPath, loopId);
      }

      if (goal) {
        // Generate PRD from goal
        const generated = await generatePrd(goal, project, contextFiles, maxStories ?? 6);

        // Write to disk for human review
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
        return seedPrdFromData(loopId, generated);
      }

      // Default: read from disk
      return seedPrd(loopId, project, prdPath);
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
      await step.run("emit-complete-max-iterations", async () => {
        await inngest.send({
          name: "agent/loop.completed",
          data: {
            loopId,
            project,
            summary: `max_iterations_reached (${maxIterations}). ${completed} completed, ${skipped} skipped.`,
            storiesCompleted: completed,
            storiesFailed: skipped,
            cancelled: false,
            branchName,
          },
        });
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
          runRecheckSuite(project)
        );

        if (checks.passed) {
          await step.run(`recheck-pass-${skippedStory.id}`, async () => {
            await markStoryRechecked(project, prdPath, skippedStory.id, loopId);
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
        readPrd(project, prdPath, loopId)
      );
      const completed = finalPrd.stories.filter((s) => s.passes).length;
      const failed = finalPrd.stories.filter((s) => (s as any).skipped).length;
      const recovered = recheckResults.filter((r) => r.status === "passed").length;
      const stillFailing = recheckResults.filter(
        (r) => r.status === "still-failing"
      ).length;

      await step.run("emit-complete", async () => {
        await inngest.send({
          name: "agent/loop.completed",
          data: {
            loopId,
            project,
            summary: `All stories processed. ${completed} completed, ${failed} skipped. Recheck: ${recovered} recovered, ${stillFailing} still failing.`,
            storiesCompleted: completed,
            storiesFailed: failed,
            cancelled: false,
            branchName,
          },
        });
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

    await step.run("emit-test", async () => {
      await inngest.send({
        name: "agent/loop.story.dispatched",
        data: {
          loopId,
          project,
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
