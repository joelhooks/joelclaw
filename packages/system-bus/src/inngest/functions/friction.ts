import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { infer } from "../../lib/inference";
import { MODEL } from "../../lib/models";
import * as typesense from "../../lib/typesense";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import { inngest } from "../client";
import {
  FRICTION_SYSTEM_PROMPT,
  FRICTION_USER_PROMPT,
  type FrictionObservationGroup,
} from "./friction-prompt";

const OBSERVATIONS_COLLECTION = "memory_observations";
const MINIMUM_POINTS = 100;
const PAGE_SIZE = 250;
const MAX_MEMORY_CHARS = 12_000;
const MAX_AGENTS_CHARS = 12_000;

type ObservationDocument = {
  id?: unknown;
  timestamp?: unknown;
  observation?: unknown;
  observation_type?: unknown;
  session_id?: unknown;
};

type ObservationRecord = {
  timestamp: string;
  date: string;
  observation: string;
  observationType: string;
  sessionId: string;
};

export type FrictionPattern = {
  title: string;
  summary: string;
  suggestion: string;
  evidence: string[];
};

function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || "/Users/joel";
}

function getWorkspaceRoot(): string {
  return join(getHomeDirectory(), ".joelclaw", "workspace");
}

function readShellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function extractXmlTag(content: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(content);
  if (!match?.[1]) return null;
  return decodeXmlText(match[1]).trim();
}

function findUpFile(startDir: string, fileName: string, maxDepth = 8): string | null {
  let current = startDir;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = join(current, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function readFileIfExists(path: string | null): Promise<string> {
  if (!path) return "";
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return "";
    return file.text();
  } catch {
    return "";
  }
}

function isoDateFromTimestamp(timestamp: string): string {
  const date = timestamp.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) return date;
  return new Date().toISOString().slice(0, 10);
}

function getRecentWindowStartIso(now = new Date()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString();
}

function isoToUnixSeconds(iso: string): number {
  const millis = new Date(iso).getTime();
  if (!Number.isFinite(millis)) return Math.floor(Date.now() / 1000);
  return Math.floor(millis / 1000);
}

function normalizeObservationRecord(doc: ObservationDocument): ObservationRecord | null {
  const observation = typeof doc.observation === "string" ? doc.observation.trim() : "";
  if (observation.length === 0) return null;

  const timestampValue = doc.timestamp;
  let timestamp = new Date().toISOString();
  if (typeof timestampValue === "number" && Number.isFinite(timestampValue)) {
    timestamp = new Date(timestampValue * 1000).toISOString();
  } else if (typeof timestampValue === "string" && timestampValue.trim().length > 0) {
    timestamp = timestampValue;
  }

  return {
    timestamp,
    date: isoDateFromTimestamp(timestamp),
    observation,
    observationType:
      typeof doc.observation_type === "string" ? doc.observation_type : "observation_text",
    sessionId: typeof doc.session_id === "string" ? doc.session_id : "unknown",
  };
}

async function fetchRecentObservations(sinceIso: string): Promise<ObservationRecord[]> {
  const observations: ObservationRecord[] = [];
  let page = 1;
  const sinceUnix = isoToUnixSeconds(sinceIso);

  for (;;) {
    const response = await typesense.search({
      collection: OBSERVATIONS_COLLECTION,
      q: "*",
      query_by: "observation",
      filter_by: `timestamp:>=${sinceUnix}`,
      per_page: PAGE_SIZE,
      page,
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];
    for (const hit of hits) {
      const record = normalizeObservationRecord((hit.document ?? {}) as ObservationDocument);
      if (record) observations.push(record);
    }

    if (hits.length < PAGE_SIZE) break;
    page += 1;
  }

  return observations;
}

function groupObservationsByDate(records: ObservationRecord[]): FrictionObservationGroup[] {
  const groups = new Map<string, string[]>();

  for (const record of records) {
    const existing = groups.get(record.date);
    if (existing) {
      existing.push(record.observation);
    } else {
      groups.set(record.date, [record.observation]);
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, observations]) => ({ date, observations }));
}

async function runFrictionLLM(prompt: string): Promise<string> {
  const result = await infer(prompt, {
    task: "json",
    model: MODEL.SONNET,
    system: FRICTION_SYSTEM_PROMPT,
    component: "friction",
    action: "friction.patterns.generate",
    json: false,
    print: true,
    noTools: true,
    env: {
      ...process.env,
      TERM: "dumb",
    },
  });

  return result.text.trim();
}

export function parseFrictionPatterns(raw: string): FrictionPattern[] {
  const matches = raw.matchAll(/<pattern>([\s\S]*?)<\/pattern>/gi);
  const patterns: FrictionPattern[] = [];
  const seenTitles = new Set<string>();

  for (const match of matches) {
    const body = match[1] ?? "";
    const title = extractXmlTag(body, "title");
    const summary = extractXmlTag(body, "summary");
    const suggestion = extractXmlTag(body, "suggestion");
    if (!title || !summary || !suggestion) continue;

    const evidenceMatch = /<evidence>([\s\S]*?)<\/evidence>/i.exec(body);
    const evidenceItems = evidenceMatch?.[1]
      ? [...evidenceMatch[1].matchAll(/<item>([\s\S]*?)<\/item>/gi)]
          .map((evidence) => decodeXmlText((evidence[1] ?? "").trim()))
          .filter((evidence) => evidence.length > 0)
      : [];

    const normalizedTitle = title.toLowerCase();
    if (seenTitles.has(normalizedTitle)) continue;
    seenTitles.add(normalizedTitle);

    patterns.push({
      title,
      summary,
      suggestion,
      evidence: evidenceItems,
    });
  }

  return patterns;
}

function truncateForTaskContent(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function normalizedContentPrefix(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 50);
}

function hasSimilarContent(existingContents: string[], candidate: string): boolean {
  const candidatePrefix = normalizedContentPrefix(candidate);
  if (!candidatePrefix) return false;
  return existingContents.some((content) => {
    const existingPrefix = normalizedContentPrefix(content);
    if (!existingPrefix) return false;
    return (
      existingPrefix === candidatePrefix
      || existingPrefix.includes(candidatePrefix)
      || candidatePrefix.includes(existingPrefix)
    );
  });
}

export const friction = inngest.createFunction(
  {
    id: "memory/friction-analysis",
    name: "Analyze Memory Friction",
    concurrency: 1,
  },
  [{ cron: "0 7 * * *" }, { event: "memory/friction.requested" }],
  async ({ step, gateway }) => {
    const gate = await step.run("gate-minimum-points", async (): Promise<{
      canRun: boolean;
      totalPoints: number;
      error?: string;
    }> => {
      try {
        const countResult = await typesense.search({
          collection: OBSERVATIONS_COLLECTION,
          q: "*",
          query_by: "observation",
          per_page: 1,
        });
        const totalPoints = Number(countResult?.found ?? 0);
        return {
          canRun: totalPoints >= MINIMUM_POINTS,
          totalPoints,
        };
      } catch (error) {
        return {
          canRun: false,
          totalPoints: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    if (!gate.canRun) {
      return {
        status: "skipped",
        reason: "insufficient-observations",
        totalPoints: gate.totalPoints,
        threshold: MINIMUM_POINTS,
        error: gate.error,
      };
    }

    const observations = await step.run("query-typesense-observations", async () => {
      const sinceIso = getRecentWindowStartIso();
      const records = await fetchRecentObservations(sinceIso);
      const grouped = groupObservationsByDate(records);
      return {
        sinceIso,
        count: records.length,
        grouped,
      };
    });

    const context = await step.run("load-memory-and-agent-context", async () => {
      const workspaceRoot = getWorkspaceRoot();
      const memoryPath = join(workspaceRoot, "MEMORY.md");
      const cwdAgentsPath = findUpFile(process.cwd(), "AGENTS.md");
      const workspaceAgentsPath = join(workspaceRoot, "AGENTS.md");

      const [memoryRaw, cwdAgentsRaw, workspaceAgentsRaw] = await Promise.all([
        readFileIfExists(memoryPath),
        readFileIfExists(cwdAgentsPath),
        readFileIfExists(workspaceAgentsPath),
      ]);

      const memoryContent = truncateText(memoryRaw, MAX_MEMORY_CHARS);
      const agentsContent = truncateText(cwdAgentsRaw || workspaceAgentsRaw, MAX_AGENTS_CHARS);

      return {
        memoryContent,
        agentsContent,
        memoryPath,
        agentsPath: cwdAgentsRaw ? cwdAgentsPath : workspaceAgentsPath,
      };
    });

    const llmRaw = await step.run("call-friction-llm", async () => {
      const userPrompt = FRICTION_USER_PROMPT({
        sinceDate: observations.sinceIso.slice(0, 10),
        groupedObservations: observations.grouped,
        memoryContent: context.memoryContent,
        agentsContent: context.agentsContent,
      });
      return runFrictionLLM(userPrompt);
    });

    const parsed = await step.run("parse-friction-patterns", async () => {
      const patterns = parseFrictionPatterns(llmRaw);
      return {
        patterns,
        count: patterns.length,
      };
    });

    const tasks = await step.run("create-todoist-friction-tasks", async () => {
      if (parsed.patterns.length === 0) {
        return {
          created: 0,
          taskIds: [] as string[],
          createdPatterns: [] as FrictionPattern[],
        };
      }

      const adapter = new TodoistTaskAdapter();
      const existingFrictionTasks = await adapter.listTasks({ label: "friction" });
      const knownContents = existingFrictionTasks.map((task) => task.content);
      const taskIds: string[] = [];
      const createdPatterns: FrictionPattern[] = [];
      for (const pattern of parsed.patterns) {
        const taskContent = `Friction: ${truncateForTaskContent(pattern.title, 80)}`;
        if (hasSimilarContent(knownContents, taskContent)) {
          continue;
        }

        const descriptionLines = [
          `Summary: ${pattern.summary}`,
          `Suggestion: ${pattern.suggestion}`,
        ];
        if (pattern.evidence.length > 0) {
          descriptionLines.push("Evidence:");
          descriptionLines.push(...pattern.evidence.map((item) => `- ${item}`));
        }

        const task = await adapter.createTask({
          content: taskContent,
          description: descriptionLines.join("\n"),
          labels: ["agent", "friction"],
          projectId: "Agent Work",
        });
        taskIds.push(task.id);
        createdPatterns.push(pattern);
        knownContents.push(taskContent);
      }

      return {
        created: taskIds.length,
        taskIds,
        createdPatterns,
      };
    });

    const date = new Date().toISOString().slice(0, 10);
    const fixEvents = tasks.createdPatterns.map((pattern, index) => {
      const patternId = `friction-${date}-${String(index + 1).padStart(3, "0")}`;
      return {
        name: "memory/friction.fix.requested" as const,
        data: {
          patternId,
          title: pattern.title,
          summary: pattern.summary,
          suggestion: pattern.suggestion,
          evidence: pattern.evidence,
          todoistTaskId: tasks.taskIds[index],
        },
      };
    });
    const patternIds = fixEvents.map((event) => event.data.patternId);

    if (fixEvents.length > 0) {
      await step.sendEvent("dispatch-fix-events", fixEvents);
    }

    await step.run("notify-gateway", async () => {
      if (parsed.count === 0) {
        await gateway.notify("friction-analysis", {
          message: "Friction analysis ran — no patterns detected",
          observations: observations.count,
        });
      } else {
        await gateway.notify("friction-analysis", {
          message: `Friction analysis: ${parsed.count} patterns → ${tasks.created} Todoist tasks`,
          patterns: parsed.patterns,
          tasksCreated: tasks.created,
        });
      }
    });

    return {
      status: "ok",
      totalPoints: gate.totalPoints,
      observationsQueried: observations.count,
      groupedBuckets: observations.grouped.length,
      patternsDetected: parsed.count,
      tasksCreated: tasks.created,
      taskIds: tasks.taskIds,
      fixEventsDispatched: fixEvents.length,
      patternIds,
    };
  }
);
