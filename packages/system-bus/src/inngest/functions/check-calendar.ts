/**
 * Calendar check — surface today's events for context.
 * Uses gog CLI for Google Calendar.
 * Only notifies gateway once per 4 hours with today's schedule.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import Redis from "ioredis";

const COOLDOWN_KEY = "calendar:check:last-run";
const COOLDOWN_TTL = 4 * 60 * 60; // 4 hours

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

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object";
}

function isDaytime(): boolean {
  const hour = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false });
  const h = parseInt(hour, 10);
  return h >= 7 && h < 22;
}

export const checkCalendar = inngest.createFunction(
  {
    id: "check/calendar-today",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "calendar/daily.check" },
  async ({ step }) => {
    // NOOP: nighttime
    if (!isDaytime()) {
      return { status: "noop", reason: "nighttime" };
    }

    // NOOP: cooldown
    const cooled = await step.run("check-cooldown", async () => {
      const redis = getRedis();
      return !!(await redis.get(COOLDOWN_KEY));
    });

    if (cooled) {
      return { status: "noop", reason: "cooldown active (4h)" };
    }

    // Fetch today's events
    const events = await step.run("fetch-calendar", async () => {
      const proc = Bun.spawn(["gog", "cal", "today", "--json"], {
        env: { ...process.env, TERM: "dumb" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, , exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]);

      if (exitCode !== 0 || !stdout.trim()) return [];

      try {
        const parsed = JSON.parse(stdout.trim());
        const items = Array.isArray(parsed)
          ? parsed
          : isRecord(parsed) && Array.isArray(parsed.events)
            ? parsed.events
            : [];
        return items.filter(isRecord).map((e) => ({
          title: String(e.summary ?? e.title ?? "Untitled"),
          start: String(e.start ?? e.startTime ?? ""),
          end: String(e.end ?? e.endTime ?? ""),
          location: typeof e.location === "string" ? e.location : undefined,
        }));
      } catch {
        return [];
      }
    });

    // Set cooldown
    await step.run("set-cooldown", async () => {
      const redis = getRedis();
      await redis.set(COOLDOWN_KEY, new Date().toISOString(), "EX", COOLDOWN_TTL);
    });

    // NOOP: no events today
    if (events.length === 0) {
      return { status: "noop", reason: "no events today" };
    }

    // Notify gateway with today's schedule
    await step.run("notify-gateway", async () => {
      const list = events.map((e) => {
        const time = e.start ? e.start.slice(11, 16) : "all-day";
        const loc = e.location ? ` 📍 ${e.location}` : "";
        return `- **${time}** ${e.title}${loc}`;
      }).join("\n");

      await pushGatewayEvent({
        type: "calendar.today",
        source: "inngest/check-calendar",
        payload: {
          prompt: `## 📅 Today's Schedule (${events.length} event${events.length > 1 ? "s" : ""})\n\n${list}`,
        },
      });
    });

    return { status: "notified", eventCount: events.length };
  }
);
