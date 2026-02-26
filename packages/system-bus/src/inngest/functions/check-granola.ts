import { getRedisPort } from "../../lib/redis";
/**
 * Granola new meeting check — detect meetings since last check.
 * ADR-0055. Uses granola-cli via mcporter MCP.
 * Invokes meeting analysis sequentially for each new meeting found.
 * Only notifies gateway if new meetings detected.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import { meetingAnalyze } from "./meeting-analyze";
import { getCurrentTasks, hasTaskMatching } from "../../tasks";
import Redis from "ioredis";

const PROCESSED_SET = "granola:processed";

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

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

type GranolaMeeting = { id: string; title: string; date?: string; participants?: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object";
}

function throwIfGranolaRateLimited(rawText: string, context: string): void {
  if (!rawText.toLowerCase().includes("rate limit")) return;
  throw new Error(
    `Granola rate limited (~1 hour window) during ${context}; retrying: ${rawText.slice(0, 500)}`
  );
}

/**
 * Granola MCP transcript/list endpoints are aggressively rate-limited (~1 hour window).
 * Keep this function account-scoped at concurrency 1 and throw on "rate limit" so Inngest retries.
 */
export const checkGranola = inngest.createFunction(
  {
    id: "check/granola-meetings",
    concurrency: { scope: "account", key: "granola-mcp", limit: 1 },
    throttle: { limit: 1, period: "10m" },
    retries: 2,
  },
  { event: "granola/check.requested" },
  async ({ step }) => {
    // Step 1: List recent meetings via granola-cli
    const meetings = await step.run("list-recent-meetings", async (): Promise<GranolaMeeting[]> => {
      const proc = Bun.spawn(["granola", "meetings", "--range", "today"], {
        env: { ...process.env, TERM: "dumb" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]);

      throwIfGranolaRateLimited(`${stdout}\n${stderr}`, "list-recent-meetings");

      if (exitCode !== 0 || !stdout.trim()) return [];

      try {
        const parsed = JSON.parse(stdout.trim());
        if (!isRecord(parsed)) return [];
        if (parsed.ok !== true) {
          throwIfGranolaRateLimited(JSON.stringify(parsed), "list-recent-meetings");
          return [];
        }
        const result = parsed.result;
        const items = isRecord(result) && Array.isArray(result.meetings)
          ? result.meetings
          : Array.isArray(result) ? result : [];
        return items
          .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.id === "string")
          .map((m) => ({
            id: String(m.id),
            title: String(m.title ?? "Untitled"),
            date: typeof m.date === "string" ? m.date : undefined,
            participants: Array.isArray(m.participants) ? m.participants.filter((p): p is string => typeof p === "string") : undefined,
          }));
      } catch {
        return [];
      }
    });

    // NOOP: no meetings today or granola-cli not working
    if (meetings.length === 0) {
      return { status: "noop", reason: "no meetings found" };
    }

    // Step 2: Filter out already-processed meetings
    const newMeetings = await step.run("filter-processed", async (): Promise<GranolaMeeting[]> => {
      const redis = getRedis();
      const results: GranolaMeeting[] = [];
      for (const m of meetings) {
        const processed = await redis.sismember(PROCESSED_SET, m.id);
        if (!processed) results.push(m);
      }
      return results;
    });

    // NOOP: all meetings already processed
    if (newMeetings.length === 0) {
      return { status: "noop", reason: "all meetings already processed", totalChecked: meetings.length };
    }

    const untrackedMeetings = await step.run("filter-meetings-against-tasks", async (): Promise<GranolaMeeting[]> => {
      const tasks = await getCurrentTasks();
      return newMeetings.filter((meeting) => !hasTaskMatching(tasks, meeting.title));
    });

    if (untrackedMeetings.length === 0) {
      return { status: "noop", reason: "already tracked in tasks", totalChecked: meetings.length };
    }

    // Step 3: Analyze meetings sequentially to avoid Granola transcript rate-limit bursts
    for (let i = 0; i < untrackedMeetings.length; i++) {
      const m = untrackedMeetings[i]!;

      await step.invoke(`analyze-meeting-${i}`, {
        function: meetingAnalyze,
        data: {
          meetingId: m.id,
          title: m.title,
          date: m.date,
          participants: m.participants,
          source: "heartbeat" as const,
        },
      });

      if (i < untrackedMeetings.length - 1) {
        await step.sleep(`cooldown-${i}`, "3m");
      }
    }

    // Step 4: Notify gateway about new meetings (actionable)
    await step.run("notify-new-meetings", async () => {
      const list = untrackedMeetings.map((m) => `- **${m.title}**${m.date ? ` (${m.date})` : ""}`).join("\n");
      await pushGatewayEvent({
        type: "granola.new.meetings",
        source: "inngest/check-granola",
        payload: {
          prompt: `## 📝 ${untrackedMeetings.length} New Meeting${untrackedMeetings.length > 1 ? "s" : ""} Detected\n\n${list}\n\nMeeting analysis pipeline triggered automatically.`,
        },
      });
    });

    return { status: "new-meetings", count: untrackedMeetings.length, meetings: untrackedMeetings.map((m) => m.title) };
  }
);

/**
 * Dedicated Granola scheduler.
 * Heartbeat runs broad system checks; this cron keeps Granola polling explicit.
 */
export const granolaCheckCron = inngest.createFunction(
  {
    id: "granola-check-cron",
    name: "Granola Check Cron",
  },
  [{ cron: "7 * * * *" }],
  async ({ step }) => {
    await step.sendEvent("request-granola-check", {
      name: "granola/check.requested",
      data: {},
    });

    return {
      scheduled: true,
      cadence: "hourly",
    };
  }
);
