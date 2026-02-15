import { inngest } from "../../client";
import { $ } from "bun";
import { join } from "node:path";
import { appendProgress, isCancelled, readPrd, seedPrd, markStoryRechecked } from "./utils";

const DEFAULT_RETRY_LADDER = ["codex", "claude", "codex"] as const;

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
 * PLANNER — Reads prd.json, finds next unpassed story, emits implement.
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
  [{ event: "agent/loop.start" }, { event: "agent/loop.plan" }],
  async ({ event, step }) => {
    const { loopId, project, prdPath } = event.data;

    // Read maxIterations from start event or re-entry plan event (default 100)
    const maxIterations =
      event.name === "agent/loop.start"
        ? event.data.maxIterations ?? 100
        : (event.data as any).maxIterations ?? 100;
    const retryLadder =
      event.name === "agent/loop.start"
        ? event.data.retryLadder ?? [...DEFAULT_RETRY_LADDER]
        : (event.data as any).retryLadder ?? [...DEFAULT_RETRY_LADDER];

    // Branch lifecycle: create on start, verify on re-entry
    const branchName = `agent-loop/${loopId}`;
    const isStartEvent = event.name === "agent/loop.start";

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

    // Step 1: Read PRD — seed to Redis on first run, read from Redis on re-entry
    const prd = await step.run("read-prd", () =>
      isStartEvent
        ? seedPrd(loopId, project, prdPath)
        : readPrd(project, prdPath, loopId)
    );

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
          name: "agent/loop.complete",
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
              project,
              [
                `**Story ${skippedStory.id}: ${skippedStory.title}** — RECHECK PASS`,
                "- Recheck result: typecheck + tests now pass",
                "- Action: unskipped and marked passes=true",
              ].join("\n")
            );
            await $`slog write --action "recheck-pass" --tool "agent-loop" --detail "${skippedStory.title} (${skippedStory.id}) passed on planner recheck" --reason "Previously skipped story now passes typecheck and bun test"`.quiet();
          });
          recheckResults.push({ storyId: skippedStory.id, status: "passed" });
        } else {
          await step.run(`recheck-still-failing-${skippedStory.id}`, async () => {
            await appendProgress(
              project,
              [
                `**Story ${skippedStory.id}: ${skippedStory.title}** — RECHECK STILL FAILING`,
                "- Recheck result: still failing typecheck/tests",
              ].join("\n")
            );
            await $`slog write --action "recheck-still-failing" --tool "agent-loop" --detail "${skippedStory.title} (${skippedStory.id}) still failing on planner recheck" --reason "Typecheck/test failures remain after all stories processed"`.quiet();
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
          name: "agent/loop.complete",
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
    const story = {
      id: next.id,
      title: next.title,
      description: next.description,
      acceptance_criteria: next.acceptance_criteria,
    };

    // Determine tool assignment
    const toolAssignments =
      event.name === "agent/loop.start"
        ? event.data.toolAssignments
        : undefined;

    const assignment = toolAssignments?.[next.id];
    const implTool = assignment?.implementor ?? "codex";
    const maxRetries =
      event.name === "agent/loop.start"
        ? event.data.maxRetries ?? 2
        : (event.data as any).maxRetries ?? 2;

    await step.run("emit-implement", async () => {
      await inngest.send({
        name: "agent/loop.implement",
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
