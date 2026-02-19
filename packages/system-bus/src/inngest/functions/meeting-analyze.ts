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

type MeetingActionItem = {
  task: string;
  owner: string;
  deadline?: string;
  context: string;
};

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
  action_items: MeetingActionItem[];
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
1. ACTION ITEMS — include ONLY if all are true:
   - specific and actionable (a concrete next step, not a vague idea)
   - assigned to Joel, his team, or clearly "we/us/our team"
   - time-bound OR clearly next-step oriented
   - not an observation, recap, or discussion point
   - when uncertain, omit it
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isJoelOrTeamOwner(owner: string): boolean {
  const normalizedOwner = normalizeWhitespace(owner).toLowerCase();
  if (!normalizedOwner) return false;
  return /(joel|we|us|our team|team|joelclaw)/u.test(normalizedOwner);
}

function isSpecificActionableTask(task: string): boolean {
  const normalizedTask = normalizeWhitespace(task);
  if (normalizedTask.length < 10) return false;
  if (/[?]/u.test(normalizedTask)) return false;
  const vaguePatterns = [
    /\bdiscuss\b/iu,
    /\btalk about\b/iu,
    /\bthink about\b/iu,
    /\bconsider\b/iu,
    /\bbrainstorm\b/iu,
    /\bmaybe\b/iu,
    /\bidea\b/iu,
    /\blater\b/iu,
  ];
  if (vaguePatterns.some((pattern) => pattern.test(normalizedTask))) return false;
  return true;
}

function isObservationOrDiscussion(item: MeetingActionItem): boolean {
  const combined = `${item.task} ${item.context}`.toLowerCase();
  return /(observation|noted that|mentioned that|discussion|recap|background)/u.test(combined);
}

function isTimeBoundOrNextStep(item: MeetingActionItem): boolean {
  if (typeof item.deadline === "string" && item.deadline.trim().length > 0) return true;
  const combined = normalizeWhitespace(`${item.task} ${item.context}`).toLowerCase();
  return /\b(next|follow up|by |before |after |today|tomorrow|this week|next week)\b/u.test(combined);
}

function qualityGateActionItems(items: MeetingActionItem[]): MeetingActionItem[] {
  return items.filter((item) => {
    if (!isSpecificActionableTask(item.task)) return false;
    if (!isJoelOrTeamOwner(item.owner)) return false;
    if (isObservationOrDiscussion(item)) return false;
    if (!isTimeBoundOrNextStep(item)) return false;
    return true;
  });
}

function createTasks(
  meetingTitle: string,
  meetingId: string,
  meetingDate: string,
  items: MeetingActionItem[],
): number {
  let created = 0;
  for (const item of items) {
    try {
      const description = [
        `From: "${meetingTitle}" (${meetingDate})`,
        "Source: granola",
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
    concurrency: [
      { limit: 1 }, // one meeting at a time (function-level)
      { scope: "account", key: '"granola-mcp"', limit: 1 }, // shared across all Granola functions
    ],
    retries: 5,
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

    // Step 3: Pull transcript (throws on rate limit → Inngest retries with backoff)
    const transcript = await step.run("pull-transcript", (): string => {
      const result = granolaCli(["meeting", meetingId, "--transcript"]);
      if (!result.ok) throw new Error(`Failed to pull transcript: ${result.error}`);
      const data = result.data ?? {};
      const raw = data?.transcript ?? data;
      const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);

      if (text.toLowerCase().includes("rate limit")) {
        throw new Error(`Granola rate limited — will retry: ${text}`);
      }
      return text;
    });

    // Step 4: LLM analysis
    const analysis = await step.run("analyze", () => {
      // Context protection: cap transcript for LLM
      const cappedTranscript = transcript.length > 30_000
        ? transcript.slice(0, 30_000) + "\n...(truncated)"
        : transcript;

      return analyzeMeeting(details.details, cappedTranscript);
    });

    const qualifiedActionItems = await step.run("quality-gate-action-items", () => {
      return qualityGateActionItems(analysis.action_items);
    });

    // Step 5: Create tasks for action items (skip for backfill — historical meetings
    // don't need todos, just knowledge capture. ADR-0045 task port pending.)
    const source = event.data?.source;
    const tasksCreated = await step.run("create-tasks", () => {
      if (source === "backfill") return 0; // historical — capture only
      if (qualifiedActionItems.length === 0) return 0;
      const meetingDate = details.date ?? "unknown";
      return createTasks(meetingTitle, meetingId, meetingDate, qualifiedActionItems);
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

    // Step 7: Write Vault meeting note
    await step.run("write-vault-note", () => {
      const vaultPath = process.env.VAULT_PATH ?? `${process.env.HOME}/Vault`;
      const meetingsDir = `${vaultPath}/Resources/meetings`;
      const fs = require("fs");

      fs.mkdirSync(meetingsDir, { recursive: true });

      const dateStr = details.date ?? event.data?.date ?? "unknown";
      // Parse date to YYYY-MM-DD for filename; fall back to raw if unparseable
      const parsed = new Date(dateStr);
      const isoDate = isNaN(parsed.getTime()) ? dateStr.slice(0, 10) : parsed.toISOString().slice(0, 10);
      const safeTitle = meetingTitle.replace(/[/\\:*?"<>|]/g, "-").slice(0, 80);
      const filename = `${isoDate}-${safeTitle}.md`;

      const people = analysis.people.map((p: any) =>
        [p.name, p.role].filter(Boolean).join(" — ")
      );

      const note = [
        "---",
        `type: meeting`,
        `title: "${meetingTitle.replace(/"/g, '\\"')}"`,
        `date: ${isoDate}`,
        `source: granola`,
        `granola_id: ${meetingId}`,
        `granola_url: https://notes.granola.ai/d/${meetingId}`,
        `tags: [meeting, granola]`,
        `people: [${people.map((p: string) => `"${p.replace(/"/g, '\\"')}"`).join(", ")}]`,
        "---",
        "",
        `# ${meetingTitle}`,
        "",
        `**Date**: ${dateStr}`,
        `**Source**: [Granola](https://notes.granola.ai/d/${meetingId})`,
        people.length > 0 ? `**People**: ${people.join(", ")}` : null,
        "",
        ...(analysis.decisions.length > 0
          ? ["## Decisions", ...analysis.decisions.map((d: any) => `- **${d.decision}**${d.rationale ? ` — ${d.rationale}` : ""}`), ""]
          : []),
        ...(qualifiedActionItems.length > 0
          ? ["## Action Items", ...qualifiedActionItems.map((a: any) =>
              `- [ ] ${a.task}${a.owner ? ` *(${a.owner})*` : ""}${a.deadline ? ` — due ${a.deadline}` : ""}${a.context ? `\n  > ${a.context}` : ""}`
            ), ""]
          : []),
        ...(analysis.follow_ups.length > 0
          ? ["## Follow-ups", ...analysis.follow_ups.map((f: any) => `- ${f.item}${f.frequency ? ` (${f.frequency})` : ""}`), ""]
          : []),
      ].filter((l) => l !== null).join("\n");

      fs.writeFileSync(`${meetingsDir}/${filename}`, note, "utf-8");
      return { wrote: filename };
    });

    // Step 8: Notify gateway
    await step.run("notify-gateway", async () => {
      if (!gateway) return { pushed: false };

      const actionCount = qualifiedActionItems.length;
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
          ...(qualifiedActionItems.length > 0
            ? ["### Action Items", ...qualifiedActionItems.map((a) => `- ${a.task} (${a.owner})`)]
            : []),
        ].join("\n"),
      });
    });

    return {
      meetingId,
      title: meetingTitle,
      actionItems: qualifiedActionItems.length,
      decisions: analysis.decisions.length,
      followUps: analysis.follow_ups.length,
      people: analysis.people.length,
      tasksCreated,
    };
  },
);
