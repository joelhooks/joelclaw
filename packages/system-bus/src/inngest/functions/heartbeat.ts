/**
 * System heartbeat — pure fan-out dispatcher.
 * ADR-0062: Heartbeat-Driven Task Triage
 *
 * Every 15 minutes, emits events for independent check functions.
 * Each check function owns its own cooldown, retries, and gateway notification.
 * The heartbeat itself does NO work — it just says "time to check everything."
 *
 * The final step pushes cron.heartbeat to the gateway, which triggers
 * the HEARTBEAT.md checklist in the gateway session.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import Redis from "ioredis";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HEARTBEAT_EVENTS = [
  { name: "tasks/triage.requested" as const, data: {} },
  { name: "sessions/prune.requested" as const, data: {} },
  { name: "triggers/audit.requested" as const, data: {} },
  { name: "system/health.requested" as const, data: {} },
  { name: "memory/review.check" as const, data: {} },
  { name: "vault/sync.check" as const, data: {} },
  { name: "granola/check.requested" as const, data: {} },
  { name: "email/triage.requested" as const, data: {} },
  { name: "calendar/daily.check" as const, data: {} },
  { name: "loops/stale.check" as const, data: {} },
];

const DAILY_DIGEST_FANOUT_KEY_PREFIX = "heartbeat:digest:fanout";
const DAILY_DIGEST_TTL_SECONDS = 24 * 60 * 60;

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

function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || "/Users/joel";
}

function losAngelesDateParts(now = new Date()): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";

  return {
    date: `${getPart("year")}-${getPart("month")}-${getPart("day")}`,
    hour: parseInt(getPart("hour"), 10),
    minute: parseInt(getPart("minute"), 10),
  };
}

function isDailyDigestWindow(hour: number, minute: number): boolean {
  // Heartbeat runs every 15m; this window catches the 23:45 run.
  return hour === 23 && minute >= 45;
}

export const heartbeatCron = inngest.createFunction(
  { id: "system-heartbeat" },
  [{ cron: "*/15 * * * *" }],
  async ({ step }) => {
    // Fan out all checks as independent events
    await step.sendEvent("fan-out-checks", HEARTBEAT_EVENTS);

    // Daily-only fan-out: request digest if today's digest has not been generated yet.
    const shouldRequestDigest = await step.run("maybe-request-daily-digest", async () => {
      const { date, hour, minute } = losAngelesDateParts();
      if (!isDailyDigestWindow(hour, minute)) return false;

      const digestPath = join(getHomeDirectory(), "Vault", "Daily", "digests", `${date}-digest.md`);
      if (existsSync(digestPath)) return false;

      const redis = getRedis();
      const dedupeKey = `${DAILY_DIGEST_FANOUT_KEY_PREFIX}:${date}`;
      const firstForDay = await redis.set(dedupeKey, "1", "EX", DAILY_DIGEST_TTL_SECONDS, "NX");
      return firstForDay === "OK";
    });

    if (shouldRequestDigest) {
      await step.sendEvent("fan-out-daily-digest", {
        name: "memory/digest.requested",
        data: {},
      });
    }

    // Push cron.heartbeat to gateway — triggers HEARTBEAT.md checklist
    await step.run("push-gateway-heartbeat", async () => {
      await pushGatewayEvent({
        type: "cron.heartbeat",
        source: "inngest",
        payload: {},
      });
    });
  }
);

export const heartbeatWake = inngest.createFunction(
  { id: "system-heartbeat-wake" },
  [{ event: "system/heartbeat.wake" }],
  async ({ step }) => {
    // Same fan-out on manual wake
    await step.sendEvent("fan-out-checks", HEARTBEAT_EVENTS);

    const shouldRequestDigest = await step.run("maybe-request-daily-digest", async () => {
      const { date, hour, minute } = losAngelesDateParts();
      if (!isDailyDigestWindow(hour, minute)) return false;

      const digestPath = join(getHomeDirectory(), "Vault", "Daily", "digests", `${date}-digest.md`);
      if (existsSync(digestPath)) return false;

      const redis = getRedis();
      const dedupeKey = `${DAILY_DIGEST_FANOUT_KEY_PREFIX}:${date}`;
      const firstForDay = await redis.set(dedupeKey, "1", "EX", DAILY_DIGEST_TTL_SECONDS, "NX");
      return firstForDay === "OK";
    });

    if (shouldRequestDigest) {
      await step.sendEvent("fan-out-daily-digest", {
        name: "memory/digest.requested",
        data: {},
      });
    }

    await step.run("push-gateway-heartbeat", async () => {
      await pushGatewayEvent({
        type: "cron.heartbeat",
        source: "inngest",
        payload: {},
      });
    });
  }
);
