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

import { spawnSync } from "node:child_process";
import Redis from "ioredis";
import { cacheWrap } from "../../lib/cache";
import { infer } from "../../lib/inference";
import { prefetchMemoryContext } from "../../memory/context-prefetch";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

const REDIS_KEY_PROCESSED = "granola:processed";
const REDIS_TTL_DAYS = 90;

type MeetingActionItem = {
  task: string;
  owner: string;
  deadline?: string;
  context: string;
};

type MeetingAnalysis = {
  action_items: MeetingActionItem[];
  decisions: Array<{ decision: string; rationale: string }>;
  follow_ups: Array<{ item: string; frequency?: string }>;
  people: Array<{ name: string; email?: string; role?: string; relationship?: string }>;
};

function emptyMeetingAnalysis(): MeetingAnalysis {
  return { action_items: [], decisions: [], follow_ups: [], people: [] };
}

function isGranolaRateLimited(rawText: string): boolean {
  const text = rawText.toLowerCase();
  return text.includes("rate limit")
    || text.includes("please slow down requests")
    || text.includes("too many requests")
    || text.includes("429");
}

function throwIfGranolaRateLimited(rawText: string, context: string): void {
  if (!isGranolaRateLimited(rawText)) return;
  throw new Error(
    `Granola rate limited (~1 hour window) during ${context}; retrying: ${rawText.slice(0, 500)}`
  );
}

function granolaCli(args: string[]): { ok: boolean; data?: any; raw?: string; error?: string } {
  const proc = spawnSync("granola", args, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = (proc.stdout ?? "").trim();
  const stderr = (proc.stderr ?? "").trim();
  throwIfGranolaRateLimited(`${stdout}\n${stderr}`, `granolaCli:${args.join(" ")}`);

  if (!stdout) {
    return { ok: false, error: stderr || "no output" };
  }

  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.ok !== true) {
      throwIfGranolaRateLimited(JSON.stringify(parsed), `granolaCli:${args.join(" ")}`);
    }
    return { ok: parsed.ok === true, data: parsed.result, raw: stdout };
  } catch {
    return { ok: false, raw: stdout, error: "invalid JSON" };
  }
}

async function analyzeMeeting(
  details: string,
  transcript: string,
  memoryContext = ""
): Promise<MeetingAnalysis> {
  const prompt = `Analyze this meeting and extract structured data.

## Meeting Details
${details}

## Transcript
${transcript}

${memoryContext ? `## Related Memory\n${memoryContext}\n` : ""}

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

  try {
    const inference = await infer(prompt, {
      task: "json",
      model: "anthropic/claude-sonnet-4-6",
      print: true,
      system: "You extract structured meeting intelligence. Respond with ONLY valid JSON.",
      component: "meeting-analyze",
      action: "meeting.analyze",
      timeout: 120_000,
      json: true,
    });

    const parsed = normalizeMeetingAnalysis(inference.data);
    if (parsed) return parsed;

    const parsedText = parseMeetingTextResponse(inference.text);
    if (parsedText) return parsedText;
  } catch (error) {
    console.error(
      "[meeting-analyze] Meeting analysis inference failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  return emptyMeetingAnalysis();
}

function parseMeetingTextResponse(rawText: string): MeetingAnalysis | null {
  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0
      && !line.startsWith("[gateway]")
      && !line.startsWith("Failed to load")
      && !line.startsWith("Extension error")
      && !line.startsWith("```")
    );
  const cleaned = lines.join("\n").trim();

  if (!cleaned) return null;

  const parseBraced = (value: string): unknown | null => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  let parsed = parseBraced(cleaned);
  const braceStart = cleaned.indexOf("{");
  const braceEnd = cleaned.lastIndexOf("}");
  if (!parsed && braceStart !== -1 && braceEnd > braceStart) {
    parsed = parseBraced(cleaned.slice(braceStart, braceEnd + 1));
  }

  return normalizeMeetingAnalysis(parsed);
}

function normalizeMeetingAnalysis(payload: unknown): MeetingAnalysis | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const raw = payload as {
    action_items?: unknown;
    decisions?: unknown;
    follow_ups?: unknown;
    people?: unknown;
  };

  const actionItems = Array.isArray(raw.action_items)
    ? raw.action_items
      .map((item: unknown) => {
        if (!item || typeof item !== "object") return null;
        const value = item as Record<string, unknown>;
        const task = typeof value.task === "string" ? value.task : "";
        const owner = typeof value.owner === "string" ? value.owner : "";
        if (!task || !owner) return null;
        return {
          task,
          owner,
          deadline: typeof value.deadline === "string" ? value.deadline : "",
          context: typeof value.context === "string" ? value.context : "",
        };
      })
      .filter((entry): entry is { task: string; owner: string; deadline: string; context: string } => Boolean(entry))
    : [];

  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions
      .map((item: unknown) => {
        if (!item || typeof item !== "object") return null;
        const value = item as Record<string, unknown>;
        const decision = typeof value.decision === "string" ? value.decision : "";
        if (!decision) return null;
        return {
          decision,
          rationale: typeof value.rationale === "string" ? value.rationale : "",
        };
      })
      .filter((entry): entry is { decision: string; rationale: string } => Boolean(entry))
    : [];

  const followUps = Array.isArray(raw.follow_ups)
    ? raw.follow_ups
      .map((item: unknown) => {
        if (!item || typeof item !== "object") return null;
        const value = item as Record<string, unknown>;
        const followUp = typeof value.item === "string" ? value.item : "";
        if (!followUp) return null;
        return {
          item: followUp,
          frequency: typeof value.frequency === "string" ? value.frequency : "",
        };
      })
      .filter((entry): entry is { item: string; frequency: string } => Boolean(entry))
    : [];

  const people = Array.isArray(raw.people)
    ? raw.people
      .map((item: unknown) => {
        if (!item || typeof item !== "object") return null;
        const value = item as Record<string, unknown>;
        const name = typeof value.name === "string" ? value.name : "";
        if (!name) return null;
        return {
          name,
          email: typeof value.email === "string" ? value.email : "",
          role: typeof value.role === "string" ? value.role : "",
          relationship: typeof value.relationship === "string" ? value.relationship : "",
        };
      })
      .filter(
        (entry): entry is { name: string; email: string; role: string; relationship: string } => Boolean(entry)
      )
    : [];

  return {
    action_items: actionItems,
    decisions,
    follow_ups: followUps,
    people,
  };
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

/**
 * Granola MCP transcript/list endpoints are aggressively rate-limited (~1 hour window).
 * Keep this function account-scoped at concurrency 1 and throw on "rate limit" so Inngest retries.
 */
export const meetingAnalyze = inngest.createFunction(
  {
    id: "meeting-analyze",
    name: "Meeting → Analyze & Extract Intelligence",
    concurrency: { scope: "account", key: "granola-mcp", limit: 1 },
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
    const details = await step.run("pull-details", async (): Promise<{ details: string; date?: string }> => {
      return cacheWrap(
        `meeting:${meetingId}:details`,
        {
          namespace: "granola",
          tier: "hot",
          hotTtlSeconds: 1800,
        },
        async () => {
          const result = granolaCli(["meeting", meetingId]);
          if (!result.ok) {
            throwIfGranolaRateLimited(result.error ?? "", "pull-details");
            throw new Error(`Failed to pull details: ${result.error}`);
          }
          const data = result.data ?? {};
          return {
            details: typeof data === "string" ? data : JSON.stringify(data, null, 2),
            date:
              typeof data?.date === "string"
                ? data.date
                : typeof data?.created_at === "string"
                  ? data.created_at
                  : undefined,
          };
        }
      );
    });

    // Step 3: Pull transcript (throws on rate limit → Inngest retries with backoff)
    const transcript = await step.run("pull-transcript", async (): Promise<string> => {
      return cacheWrap(
        `meeting:${meetingId}:transcript`,
        {
          namespace: "granola",
          tier: "warm",
          hotTtlSeconds: 1800,
          warmTtlSeconds: 7 * 24 * 60 * 60,
        },
        async () => {
          const result = granolaCli(["meeting", meetingId, "--transcript"]);
          if (!result.ok) {
            throwIfGranolaRateLimited(result.error ?? "", "pull-transcript");
            throw new Error(`Failed to pull transcript: ${result.error}`);
          }
          const data = result.data ?? {};
          const raw = data?.transcript ?? data;
          const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);

          throwIfGranolaRateLimited(text, "pull-transcript");
          return text;
        }
      );
    });

    await step.sendEvent("emit-meeting-transcript-fetched", {
      name: "meeting/transcript.fetched",
      data: {
        meetingId,
        title: meetingTitle,
        date: details.date ?? event.data?.date,
        participants: Array.isArray(event.data?.participants)
          ? event.data.participants
          : [],
        source: event.data?.source,
        sourceUrl: `https://notes.granola.ai/d/${meetingId}`,
        // Keep payload bounded; the indexer can hydrate from shared cache by meetingId.
        ...(transcript.length <= 120_000 ? { transcript } : {}),
      },
    });

    const memoryContext = await step.run("prefetch-memory", async () => {
      const participants = Array.isArray(event.data?.participants)
        ? (event.data?.participants as unknown[])
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join(", ")
        : "";
      const query = [meetingTitle, participants].filter(Boolean).join(" ");
      return prefetchMemoryContext(query, { limit: 5 });
    });

    // Step 4: LLM analysis
    const analysis = await step.run("analyze", async () => {
      // Context protection: cap transcript for LLM
      const cappedTranscript = transcript.length > 30_000
        ? transcript.slice(0, 30_000) + "\n...(truncated)"
        : transcript;

      return await analyzeMeeting(details.details, cappedTranscript, memoryContext);
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
