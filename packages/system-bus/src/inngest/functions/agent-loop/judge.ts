import { inngest } from "../../client";
import { $ } from "bun";
import {
  isCancelled,
  updateStoryPass,
  markStorySkipped,
  appendProgress,
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

/**
 * JUDGE — Reads test results + feedback. Routes to next story or retry.
 *
 * PASS → update prd.json, append progress.txt, slog write, emit plan
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
    retries: 1,
  },
  [{ event: "agent/loop.judge" }],
  async ({ event, step }) => {
    const {
      loopId,
      project,
      prdPath,
      storyId,
      testResults,
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
    } = event.data;

    // Step 0: Check cancellation
    const cancelled = await step.run("check-cancel", () => isCancelled(loopId));
    if (cancelled) return { status: "cancelled", loopId, storyId };

    // Step 1: Make judgment
    const allPassed =
      testResults.typecheckOk &&
      testResults.lintOk &&
      testResults.testsFailed === 0;

    if (allPassed) {
      // ── PASS ─────────────────────────────────────────────────────

      // Update PRD (Redis + disk)
      await step.run("update-prd", () =>
        updateStoryPass(project, prdPath, storyId, loopId)
      );

      // Append progress.txt
      await step.run("append-progress", () =>
        appendProgress(project, [
          `**Story ${storyId}: ${story.title}** — PASSED (attempt ${attempt})`,
          `- Tool: ${tool}`,
          `- Tests passed: ${testResults.testsPassed}`,
          `- Typecheck: ✅ | Lint: ✅`,
        ].join("\n"))
      );

      // slog write
      await step.run("slog-pass", async () => {
        await $`slog write --action "story-pass" --tool "agent-loop" --detail "${story.title} (${storyId}) passed on attempt ${attempt}" --reason "All checks passed: ${testResults.testsPassed} tests, typecheck clean, lint clean"`.quiet();
      });

      // Emit story pass event with duration
      const durationMs = storyStartedAt ? Date.now() - storyStartedAt : 0;
      await step.run("emit-story-pass", async () => {
        await inngest.send({
          name: "agent/loop.story.pass",
          data: {
            loopId,
            storyId,
            commitSha: "", // could be passed through but not critical
            attempt,
            duration: durationMs,
          },
        });
      });

      // Emit plan for next story
      await step.run("emit-next-plan", async () => {
        await inngest.send({
          name: "agent/loop.plan",
          data: {
            loopId,
            project,
            prdPath,
            maxIterations,
          checks,
            maxRetries,
            retryLadder,
          },
        });
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

      await step.run("slog-retry", async () => {
        await $`slog write --action "story-retry" --tool "agent-loop" --detail "${story.title} (${storyId}) failed attempt ${attempt}, retrying" --reason "Tests failed: ${testResults.testsFailed}, typecheck: ${testResults.typecheckOk}, lint: ${testResults.lintOk}"`.quiet();
      });

      await step.run("emit-retry-implement", async () => {
        await inngest.send({
          name: "agent/loop.implement",
          data: {
            loopId,
            project,
            storyId,
            tool: retryTool,
            attempt: nextAttempt,
            feedback: typeof feedback === "string"
              ? feedback
              : `Tests failed: ${testResults.testsFailed}. ${testResults.details}`,
            story,
            maxRetries,
            maxIterations,
          checks,
            retryLadder,
            storyStartedAt,
            freshTests,
          },
        });
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

    // Mark story as skipped so planner doesn't re-pick it
    await step.run("mark-skipped", () =>
      markStorySkipped(project, prdPath, storyId, loopId)
    );

    await step.run("slog-skip", async () => {
      await $`slog write --action "story-skip" --tool "agent-loop" --detail "${story.title} (${storyId}) skipped after ${attempt} attempts — needs human review" --reason "Max retries exceeded. Last failure: ${testResults.details.slice(0, 200)}"`.quiet();
    });

    await step.run("append-progress-fail", () =>
      appendProgress(project, [
        `**Story ${storyId}: ${story.title}** — FAILED (skipped after ${attempt} attempts)`,
        `- Tool: ${tool}`,
        `- Last results: ${testResults.testsFailed} test failures, typecheck: ${testResults.typecheckOk ? "✅" : "❌"}, lint: ${testResults.lintOk ? "✅" : "❌"}`,
        `- ⚠️ NEEDS HUMAN REVIEW`,
      ].join("\n"))
    );

    // Emit story fail event with duration
    const failDurationMs = storyStartedAt ? Date.now() - storyStartedAt : 0;
    await step.run("emit-story-fail", async () => {
      await inngest.send({
        name: "agent/loop.story.fail",
        data: {
          loopId,
          storyId,
          reason: `Failed after ${attempt} attempts. ${testResults.details.slice(0, 500)}`,
          attempts: attempt,
          duration: failDurationMs,
        },
      });
    });

    // Continue to next story
    await step.run("emit-next-plan-after-fail", async () => {
      await inngest.send({
        name: "agent/loop.plan",
        data: {
          loopId,
          project,
          prdPath,
          maxIterations,
          checks,
          maxRetries,
          retryLadder,
        },
      });
    });

    return { status: "skipped", loopId, storyId, attempts: attempt };
  }
);
