/**
 * Meeting intelligence pipeline — per-meeting analysis.
 *
 * Triggered by: meeting/noted
 * ADR-0055: Granola Meeting Intelligence Pipeline
 * ADR-0056: Personal Relationship Management
 *
 * For each new meeting:
 *   1. Pull details via granola CLI
 *   2. Pull transcript via granola CLI
 *   3. LLM extract action items, decisions, follow-ups, people
 *   4. Create tasks via task port (ADR-0045)
 *   5. Mark processed in Redis
 *   6. Notify gateway
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { spawnSync } from "node:child_process";
import Redis from "ioredis";

const REDIS_KEY_PROCESSED = "granola:processed";
const REDIS_TTL_DAYS = 90;

function granolaCli(args: string[]): { ok: boolean; data?: any; raw?: string; error?: string } {
  const proc = spawnSync("granola", args, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = (proc.stdout ?? "").trim();
  if (!stdout) {
    return { ok: false, error: proc.stderr?.trim() || "no output" };
  }

  try {
    const parsed = JSON.parse(stdout);
    return { ok: parsed.ok === true, data: parsed.result, raw: stdout };
  } catch {
    return { ok: false, raw: stdout, error: "invalid JSON" };
  }
}

function analyzeMeeting(details: string, transcript: string): {
  action_items: Array<{ task: string; owner: string; deadline?: string; context: string }>;
  decisions: Array<{ decision: string; rationale: string }>;
  follow_ups: Array<{ item: string; frequency?: string }>;
  people: Array<{ name: string; email?: string; role?: string; relationship?: string }>;
} {
  const prompt = `Analyze this meeting and extract structured data.

## Meeting Details
${details}

## Transcript
${transcript}

Extract:
1. ACTION ITEMS — concrete next steps with owner and deadline if mentioned
2. DECISIONS — things that were decided or agreed upon
3. FOLLOW UPS — recurring or future check-ins mentioned
4. PEOPLE — everyone mentioned or participating, with role/relationship context if apparent

Respond with ONLY valid JSON, no markdown fencing:
{
  "action_items": [{"task": "...", "owner": "...", "deadline": "...", "context": "..."}],
  "decisions": [{"decision": "...", "rationale": "..."}],
  "follow_ups": [{"item": "...", "frequency": "..."}],
  "people": [{"name": "...", "email": "...", "role": "...", "relationship": "..."}]
}`;

  const proc = spawnSync(
    "pi",
    [
      "--print", "--no-session",
      "--provider", "anthropic", "--model", "sonnet",
      "--system-prompt", "You extract structured meeting intelligence. Respond with ONLY valid JSON.",
      prompt,
    ],
    {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const stdout = (proc.stdout ?? "").trim();
  const lines = stdout.split("\n").filter((l: string) => {
    const t = l.trim();
    return t.length > 0
      && !t.startsWith("[gateway]")
      && !t.startsWith("Failed to load")
      && !t.startsWith("Extension error")
      && !t.startsWith("```");
  });
  const cleaned = lines.join("\n").trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const braceStart = cleaned.indexOf("{");
  const braceEnd = cleaned.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(cleaned.slice(braceStart, braceEnd + 1));
    } catch {}
  }

  console.error("[meeting-analyze] Failed to parse LLM response:", stdout.slice(0, 500));
  return { action_items: [], decisions: [], follow_ups: [], people: [] };
}

function createTasks(
  meetingTitle: string,
  meetingId: string,
  meetingDate: string,
  items: Array<{ task: string; owner: string; deadline?: string; context: string }>,
): number {
  let created = 0;
  for (const item of items) {
    try {
      const description = [
        `From: "${meetingTitle}" (${meetingDate})`,
        item.owner ? `Owner: ${item.owner}` : null,
        `Link: https://notes.granola.ai/d/${meetingId}`,
        item.context ? `Context: ${item.context}` : null,
      ].filter(Boolean).join("\n");

      const args = ["add", `[Granola] ${item.task}`, "--description", description];
      if (item.deadline) args.push("--due", item.deadline);

      spawnSync("todoist-cli", args, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      created++;
    } catch {
      console.error("[meeting-analyze] Failed to create task:", item.task);
    }
  }
  return created;
}

// ── Main function ───────────────────────────────────────────────────

export const meetingAnalyze = inngest.createFunction(
  {
    id: "meeting-analyze",
    name: "Meeting → Analyze & Extract Intelligence",
    concurrency: [{ limit: 3 }],
    retries: 2,
  },
  { event: "meeting/noted" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const meetingId: string = event.data?.meetingId;
    const meetingTitle: string = event.data?.title ?? "untitled";

    if (!meetingId) {
      return { error: "missing meetingId in event data" };
    }

    // Step 1: Check if already processed
    const alreadyProcessed = await step.run("check-processed", async () => {
      const redis = new Redis({ host: "localhost", port: 6379, commandTimeout: 5000 });
      try {
        const exists = await redis.sismember(REDIS_KEY_PROCESSED, meetingId);
        return exists === 1;
      } finally {
        redis.disconnect();
      }
    });

    if (alreadyProcessed) {
      return { skipped: true, reason: "already processed", meetingId };
    }

    // Step 2: Pull meeting details
    const details = await step.run("pull-details", (): { details: string; date?: string } => {
      const result = granolaCli(["meeting", meetingId]);
      if (!result.ok) throw new Error(`Failed to pull details: ${result.error}`);
      const data = result.data ?? {};
      return {
        details: typeof data === "string" ? data : JSON.stringify(data, null, 2),
        date: data?.date ?? data?.created_at,
      };
    });

    // Step 3: Pull transcript
    const transcript = await step.run("pull-transcript", (): string => {
      const result = granolaCli(["meeting", meetingId, "--transcript"]);
      if (!result.ok) throw new Error(`Failed to pull transcript: ${result.error}`);
      const data = result.data ?? {};
      const raw = data?.transcript ?? data;
      return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    });

    // Step 4: LLM analysis
    const analysis = await step.run("analyze", () => {
      // Context protection: cap transcript for LLM
      const cappedTranscript = transcript.length > 30_000
        ? transcript.slice(0, 30_000) + "\n...(truncated)"
        : transcript;

      return analyzeMeeting(details.details, cappedTranscript);
    });

    // Step 5: Create tasks for action items
    const tasksCreated = await step.run("create-tasks", () => {
      if (analysis.action_items.length === 0) return 0;
      const meetingDate = details.date ?? "unknown";
      return createTasks(meetingTitle, meetingId, meetingDate, analysis.action_items);
    });

    // Step 6: Mark as processed
    await step.run("mark-processed", async () => {
      const redis = new Redis({ host: "localhost", port: 6379, commandTimeout: 5000 });
      try {
        await redis.sadd(REDIS_KEY_PROCESSED, meetingId);
        await redis.expire(REDIS_KEY_PROCESSED, REDIS_TTL_DAYS * 86400);
      } finally {
        redis.disconnect();
      }
    });

    // Step 7: Notify gateway
    await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false };

      const actionCount = analysis.action_items.length;
      const decisionCount = analysis.decisions.length;
      const peopleCount = analysis.people.length;

      return await gateway.notify("meeting.analyzed", {
        prompt: [
          `## 🥣 Meeting Analyzed: "${meetingTitle}"`,
          "",
          `**Action items**: ${actionCount} (${tasksCreated} tasks created)`,
          `**Decisions**: ${decisionCount}`,
          `**People**: ${peopleCount}`,
          "",
          ...(analysis.decisions.length > 0
            ? ["### Decisions", ...analysis.decisions.map((d) => `- ${d.decision}`), ""]
            : []),
          ...(analysis.action_items.length > 0
            ? ["### Action Items", ...analysis.action_items.map((a) => `- ${a.task} (${a.owner})`)]
            : []),
        ].join("\n"),
      });
    });

    return {
      meetingId,
      title: meetingTitle,
      actionItems: analysis.action_items.length,
      decisions: analysis.decisions.length,
      followUps: analysis.follow_ups.length,
      people: analysis.people.length,
      tasksCreated,
    };
  },
);
