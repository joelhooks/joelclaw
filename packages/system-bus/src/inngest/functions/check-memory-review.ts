/**
 * Memory review check — nudge gateway when proposals need Joel's attention.
 * ADR-0021 Todoist-as-review-surface refinement.
 * Only notifies once per 24h if proposals are pending.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import Redis from "ioredis";

const REVIEW_PENDING_KEY = "memory:review:pending";
const NUDGE_COOLDOWN_KEY = "memory:review:nudge-sent";
const NUDGE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
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
      return { count: pending.length, ids: pending.slice(0, 10), alreadyNudged: !!alreadyNudged };
    });

    // NOOP: no proposals or already nudged today
    if (state.count === 0 || state.alreadyNudged) {
      return { status: "noop", pendingCount: state.count, reason: state.count === 0 ? "no proposals" : "nudge cooldown" };
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
            `Or check Redis: \`redis-cli lrange memory:review:pending 0 -1\``,
            "",
            "Complete tasks in Todoist to approve, delete to reject. Auto-expires after 7 days.",
          ].join("\n"),
        },
      });

      const redis = getRedis();
      await redis.set(NUDGE_COOLDOWN_KEY, new Date().toISOString(), "EX", NUDGE_TTL_SECONDS);
    });

    return { status: "nudged", pendingCount: state.count };
  }
);
