/**
 * Granola backfill — one-time batch job to process all historical meetings.
 *
 * Triggered by: granola/backfill.requested
 * ADR-0055: Granola Meeting Intelligence Pipeline
 *
 * Pages through all meetings in time ranges, filters out already-processed
 * ones, and fans out meeting/noted events for the analyze pipeline.
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { spawnSync } from "node:child_process";
import Redis from "ioredis";

const REDIS_KEY_PROCESSED = "granola:processed";

// Time ranges to backfill, in order (most recent first)
const BACKFILL_RANGES = [
  { range: "this_week", label: "this week" },
  { range: "last_week", label: "last week" },
  { range: "last_30_days", label: "last 30 days" },
  // Extend with custom ranges if needed:
  // { range: "custom", start: "2025-01-01", end: "2025-12-31", label: "2025" },
];

interface MeetingSummary {
  id: string;
  title: string;
  date: string;
  participants: string[];
}

function listMeetings(range: string, start?: string, end?: string): MeetingSummary[] {
  const args = ["meetings", "--range", range];
  if (range === "custom" && start && end) {
    args.push("--start", start, "--end", end);
  }

  const proc = spawnSync("granola", args, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = (proc.stdout ?? "").trim();
  if (!stdout) return [];

  try {
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) return [];
    return parsed.result?.meetings ?? [];
  } catch {
    return [];
  }
}

async function getAlreadyProcessed(): Promise<Set<string>> {
  const redis = new Redis({ host: "localhost", port: 6379, commandTimeout: 5000 });
  try {
    const members = await redis.smembers(REDIS_KEY_PROCESSED);
    return new Set(members);
  } catch {
    return new Set();
  } finally {
    redis.disconnect();
  }
}

// ── Main function ───────────────────────────────────────────────────

export const granolaBackfill = inngest.createFunction(
  {
    id: "granola-backfill",
    name: "Granola → Backfill All Meetings",
    concurrency: [{ limit: 1 }], // only one backfill at a time
  },
  { event: "granola/backfill.requested" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const dryRun = event.data?.dryRun ?? false;

    // Custom ranges from event data (for deeper backfill)
    const customRanges: Array<{ range: string; start?: string; end?: string; label: string }> =
      event.data?.customRanges ?? [];

    const allRanges = [...BACKFILL_RANGES, ...customRanges];

    // Step 1: Get already processed IDs
    const processed = await step.run("get-processed", async (): Promise<string[]> => {
      const redis = new Redis({ host: "localhost", port: 6379, commandTimeout: 5000 });
      try {
        return await redis.smembers(REDIS_KEY_PROCESSED);
      } catch {
        return [];
      } finally {
        redis.disconnect();
      }
    });
    const processedSet = new Set(processed);

    // Step 2: Collect all meetings across time ranges
    const allMeetings: MeetingSummary[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < allRanges.length; i++) {
      const r = allRanges[i]!;
      const meetings = await step.run(`list-${r.range}-${i}`, (): MeetingSummary[] => {
        return listMeetings(r.range, (r as any).start, (r as any).end);
      });

      for (const m of meetings) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          allMeetings.push(m);
        }
      }
    }

    // Step 3: Filter out already processed
    const newMeetings = allMeetings.filter((m) => !processedSet.has(m.id));

    // Step 4: Fan out meeting/noted events
    if (!dryRun && newMeetings.length > 0) {
      await step.run("fan-out-events", async () => {
        const events = newMeetings.map((m) => ({
          name: "meeting/noted" as const,
          data: {
            meetingId: m.id,
            title: m.title,
            date: m.date,
            participants: m.participants,
            source: "backfill" as const,
          },
        }));

        // Send in batches of 10 to avoid overwhelming Inngest
        for (let i = 0; i < events.length; i += 10) {
          const batch = events.slice(i, i + 10);
          await inngest.send(batch);
        }

        return { sent: events.length };
      });
    }

    // Step 5: Notify
    await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false };

      return await gateway.notify("granola.backfill", {
        prompt: [
          `## 🥣 Granola Backfill ${dryRun ? "(DRY RUN)" : "Started"}`,
          "",
          `**Total meetings found**: ${allMeetings.length}`,
          `**Already processed**: ${allMeetings.length - newMeetings.length}`,
          `**New to analyze**: ${newMeetings.length}`,
          "",
          ...newMeetings.slice(0, 10).map((m) => `- ${m.date}: ${m.title}`),
          ...(newMeetings.length > 10 ? [`- ...and ${newMeetings.length - 10} more`] : []),
        ].join("\n"),
      });
    });

    return {
      dryRun,
      totalFound: allMeetings.length,
      alreadyProcessed: allMeetings.length - newMeetings.length,
      newToAnalyze: newMeetings.length,
      meetings: newMeetings.map((m) => ({ id: m.id, title: m.title, date: m.date })),
    };
  },
);
