import { getRedisPort } from "../../lib/redis";

/**
 * Memory review check — nudge gateway when proposals need Joel's attention.
 * ADR-0021 Todoist-as-review-surface refinement.
 * Only notifies once per 24h if proposals are pending.
 */

import Redis from "ioredis";
import { TodoistTaskAdapter, getCurrentTasks, hasTaskMatching, tasksWithLabel } from "../../tasks";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const REVIEW_PENDING_KEY = "memory:review:pending";
const NUDGE_COOLDOWN_KEY = "memory:review:nudge-sent";
const NUDGE_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MEMORY_REVIEW_LABEL = "memory-review";

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: getRedisPort(),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

export const checkMemoryReview = inngest.createFunction(
  { id: "check/memory-review", concurrency: { limit: 1 }, retries: 1 },
  { event: "memory/review.check" },
  async ({ step }) => {
    const state = await step.run("check-pending-proposals", async () => {
      const redis = getRedis();
      const pending = await redis.lrange(REVIEW_PENDING_KEY, 0, -1);
      const alreadyNudged = await redis.get(NUDGE_COOLDOWN_KEY);

      // Check for proposals nearing expiry (created > 5 days ago)
      const expiringSoon: string[] = [];
      const now = Date.now();
      const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
      for (const id of pending.slice(0, 20)) {
        const capturedAt = await redis.hget(`memory:review:proposal:${id}`, "capturedAt");
        if (capturedAt && now - new Date(capturedAt).getTime() > FIVE_DAYS_MS) {
          expiringSoon.push(id);
        }
      }

      return { count: pending.length, ids: pending.slice(0, 10), expiringSoon, alreadyNudged: !!alreadyNudged };
    });

    if (state.count === 0) {
      return { status: "noop", pendingCount: state.count, reason: "no proposals" };
    }

    const taskState = await step.run("load-memory-review-tasks", async () => {
      const tasks = await getCurrentTasks();
      const memoryReviewTasks = tasksWithLabel(tasks, MEMORY_REVIEW_LABEL);

      return {
        alreadyTracked:
          memoryReviewTasks.length > 0
          || hasTaskMatching(tasks, "memory")
          || hasTaskMatching(tasks, "proposal"),
        memoryReviewTaskIds: memoryReviewTasks.map((task) => task.id),
      };
    });

    let prioritizedCount = 0;

    if (taskState.memoryReviewTaskIds.length > 0) {
      prioritizedCount = await step.run("prioritize-memory-review-tasks", async () => {
        const adapter = new TodoistTaskAdapter();
        let updated = 0;

        for (const taskId of taskState.memoryReviewTaskIds) {
          await adapter.updateTask(taskId, {
            priority: 4,
            dueString: "today",
          });
          updated += 1;
        }

        return updated;
      });
    }

    if (taskState.alreadyTracked) {
      return {
        status: prioritizedCount > 0 ? "prioritized" : "noop",
        pendingCount: state.count,
        prioritizedCount,
        reason: prioritizedCount > 0 ? "memory review tasks prioritized" : "already tracked in tasks",
      };
    }

    if (state.alreadyNudged) {
      return { status: "noop", pendingCount: state.count, prioritizedCount, reason: "nudge cooldown" };
    }

    // Proposals pending and haven't nudged in 24h
    await step.run("nudge-gateway", async () => {
      await pushGatewayEvent({
        type: "memory.review.pending",
        source: "inngest/check-memory-review",
        payload: {
          prompt: [
            `## 📋 ${state.count} Memory Proposal${state.count > 1 ? "s" : ""} Pending`,
            "",
            `Review with: \`todoist-cli list --label memory-review\``,
            "",
            "**Complete** in Todoist → approve → writes to MEMORY.md",
            "**Delete** or add `@rejected` label → reject",
            "**Ignore** → auto-expires after 7 days",
            ...(state.expiringSoon.length > 0
              ? ["", `⏳ **${state.expiringSoon.length} expiring soon** (>5 days old, auto-expire at 7): ${state.expiringSoon.join(", ")}`]
              : []),
          ].join("\n"),
        },
      });

      const redis = getRedis();
      await redis.set(NUDGE_COOLDOWN_KEY, new Date().toISOString(), "EX", NUDGE_TTL_SECONDS);
    });

    return { status: "nudged", pendingCount: state.count };
  }
);
