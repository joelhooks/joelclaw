import { getRedisPort } from "../../lib/redis";

/**
 * System heartbeat — periodic fan-out dispatcher with a report-only session scan.
 * ADR-0062: Heartbeat-Driven Task Triage
 *
 * Every 15 minutes, emits events for independent check functions.
 * Each check function owns its own cooldown, retries, and gateway notification.
 * Session retention reports bounded counts and never removes harness files.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";
import { pruneOldSessionFiles } from "../../lib/session-prune";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const HEARTBEAT_EVENTS = [
  { name: "tasks/triage.requested" as const, data: {} },
  { name: "sessions/prune.requested" as const, data: {} },
  { name: "triggers/audit.requested" as const, data: {} },
  {
    name: "system/health.requested" as const,
    data: { mode: "core" as const, source: "heartbeat-15m" as const },
  },
  { name: "gateway/health.check.requested" as const, data: {} },
  { name: "memory/review.check" as const, data: {} },
  { name: "vault/sync.check" as const, data: {} },
  { name: "email/triage.requested" as const, data: {} },
  { name: "calendar/daily.check" as const, data: {} },
  { name: "loops/stale.check" as const, data: {} },
];

const DAILY_DIGEST_FANOUT_KEY_PREFIX = "heartbeat:digest:fanout";
const DAILY_DIGEST_TTL_SECONDS = 24 * 60 * 60;
const ADR_PITCH_LAST_FIRED_KEY = "adr:pitch:last-fired";
const ADR_PITCH_TTL_SECONDS = 20 * 60 * 60;
const USER_VISIBLE_HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
const HEARTBEAT_LAST_RUN_KEY = "heartbeat:last_run";
const HEARTBEAT_GATE_INTERVAL_MS = 10 * 60 * 1000;

let redisClient: Redis | null = null;
let lastUserVisibleHeartbeatAt = 0;

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

function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || "/Users/joel";
}

function losAngelesDateParts(now = new Date(Date.now())): {
  date: string;
  hour: number;
  minute: number;
} {
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

function isAdrPitchWindow(hour: number): boolean {
  return hour >= 8 && hour < 10;
}

function shouldEmitUserVisibleHeartbeat(now = Date.now()): boolean {
  if (now - lastUserVisibleHeartbeatAt < USER_VISIBLE_HEARTBEAT_INTERVAL_MS) {
    return false;
  }
  lastUserVisibleHeartbeatAt = now;
  return true;
}

async function maybeEmitUserVisibleHeartbeat(source: "cron" | "wake"): Promise<boolean> {
  if (!shouldEmitUserVisibleHeartbeat()) return false;

  await pushGatewayEvent({
    type: "cron.heartbeat",
    source: `inngest/heartbeat.${source}`,
    payload: {
      status: "HEARTBEAT_OK",
      quiet: true,
      userVisibleIntervalMs: USER_VISIBLE_HEARTBEAT_INTERVAL_MS,
    },
  });

  return true;
}

export const heartbeatCron = inngest.createFunction(
  { id: "system-heartbeat" },
  [{ cron: "7-59/15 * * * *" }],
  async ({ step }) => {
    const gate = await step.run("check-if-needed", async () => {
      const redis = getRedis();
      const now = Date.now();
      const lastRunRaw = await redis.get(HEARTBEAT_LAST_RUN_KEY);
      const lastRunTimestamp = Number(lastRunRaw);

      if (
        Number.isFinite(lastRunTimestamp) &&
        lastRunTimestamp > 0 &&
        now - lastRunTimestamp < HEARTBEAT_GATE_INTERVAL_MS
      ) {
        return { shouldRun: false as const, reason: "last run <10min ago" as const };
      }

      return { shouldRun: true as const };
    });

    if (!gate.shouldRun) {
      return { status: "skipped" as const, reason: gate.reason };
    }

    const sessionPrune = await step.run("report-old-sessions", () => pruneOldSessionFiles());

    // Fan out all checks as independent events
    await step.sendEvent("fan-out-checks", HEARTBEAT_EVENTS);

    const shouldRequestAdrPitch = await step.run("maybe-request-adr-pitch", async () => {
      const { hour } = losAngelesDateParts();
      if (!isAdrPitchWindow(hour)) return false;

      const redis = getRedis();
      const lastFired = await redis.get(ADR_PITCH_LAST_FIRED_KEY);
      return !lastFired;
    });

    if (shouldRequestAdrPitch) {
      await step.sendEvent("fan-out-adr-pitch", {
        name: "adr/pitch.requested",
        data: {},
      });

      await step.run("record-adr-pitch-fired", async () => {
        const redis = getRedis();
        await redis.set(
          ADR_PITCH_LAST_FIRED_KEY,
          new Date(Date.now()).toISOString(),
          "EX",
          ADR_PITCH_TTL_SECONDS,
        );
        return {
          key: ADR_PITCH_LAST_FIRED_KEY,
          ttlSeconds: ADR_PITCH_TTL_SECONDS,
        };
      });
    }

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
    await step.run("otel-heartbeat-cron", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "heartbeat",
        action: "heartbeat.cron.fanout",
        success: true,
        metadata: {
          fanoutCount: HEARTBEAT_EVENTS.length,
          adrPitchRequested: shouldRequestAdrPitch,
          digestRequested: shouldRequestDigest,
          sessionPrune,
        },
      });
    });

    // Quiet mode: only emit a green heartbeat marker once per hour.
    // Degradation notifications are emitted by check/* functions directly.
    await step.run("maybe-emit-user-visible-heartbeat", async () =>
      maybeEmitUserVisibleHeartbeat("cron"),
    );

    await step.run("record-last-run", async () => {
      const redis = getRedis();
      await redis.set(HEARTBEAT_LAST_RUN_KEY, Date.now().toString());
      return { key: HEARTBEAT_LAST_RUN_KEY };
    });
  },
);

export const heartbeatWake = inngest.createFunction(
  { id: "system-heartbeat-wake" },
  [{ event: "system/heartbeat.wake" }],
  async ({ step }) => {
    const sessionPrune = await step.run("report-old-sessions", () => pruneOldSessionFiles());

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
    await step.run("otel-heartbeat-wake", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "heartbeat",
        action: "heartbeat.wake.fanout",
        success: true,
        metadata: {
          fanoutCount: HEARTBEAT_EVENTS.length,
          digestRequested: shouldRequestDigest,
          sessionPrune,
        },
      });
    });

    await step.run("maybe-emit-user-visible-heartbeat", async () =>
      maybeEmitUserVisibleHeartbeat("wake"),
    );
  },
);
