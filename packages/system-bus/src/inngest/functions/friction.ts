import { QdrantClient } from "@qdrant/js-client-rest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import { inngest } from "../client";
import {
  FRICTION_SYSTEM_PROMPT,
  FRICTION_USER_PROMPT,
  type FrictionObservationGroup,
} from "./friction-prompt";

const QDRANT_COLLECTION = "memory_observations";
const MINIMUM_POINTS = 100;
const SCROLL_LIMIT = 256;
const MAX_MEMORY_CHARS = 12_000;
const MAX_AGENTS_CHARS = 12_000;

type ObservationPointPayload = {
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

function getQdrantClient(): QdrantClient {
  return new QdrantClient({
    host: process.env.QDRANT_HOST ?? "localhost",
    port: Number.parseInt(process.env.QDRANT_PORT ?? "6333", 10),
  });
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

function getSevenDaysAgoIso(now = new Date()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString();
}

function normalizeObservationRecord(payload: ObservationPointPayload): ObservationRecord | null {
  const observation =
    typeof payload.observation === "string" ? payload.observation.trim() : "";
  if (observation.length === 0) return null;

  const timestamp =
    typeof payload.timestamp === "string" && payload.timestamp.trim().length > 0
      ? payload.timestamp
      : new Date().toISOString();

  return {
    timestamp,
    date: isoDateFromTimestamp(timestamp),
    observation,
    observationType:
      typeof payload.observation_type === "string" ? payload.observation_type : "observation_text",
    sessionId: typeof payload.session_id === "string" ? payload.session_id : "unknown",
  };
}

async function fetchRecentObservations(
  qdrant: QdrantClient,
  sinceIso: string
): Promise<ObservationRecord[]> {
  const observations: ObservationRecord[] = [];
  let offset: unknown = undefined;

  while (true) {
    const response = (await qdrant.scroll(QDRANT_COLLECTION, {
      limit: SCROLL_LIMIT,
      offset,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          {
            key: "timestamp",
            range: {
              gte: sinceIso,
            },
          },
        ],
      },
    })) as {
      points?: Array<{ payload?: ObservationPointPayload }>;
      next_page_offset?: unknown;
    };

    const points = Array.isArray(response.points) ? response.points : [];
    for (const point of points) {
      const record = normalizeObservationRecord(point.payload ?? {});
      if (record) observations.push(record);
    }

    if (!response.next_page_offset) {
      break;
    }
    offset = response.next_page_offset;
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
  const proc = Bun.spawn(
    [
      "pi",
      "-p",
      "--no-session",
      "--no-extensions",
      "--model",
      "anthropic/claude-sonnet-4-6",
      "--system-prompt",
      FRICTION_SYSTEM_PROMPT,
      prompt,
    ],
    {
      env: { ...process.env, TERM: "dumb" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Friction subprocess failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ""}`
    );
  }

  return stdout.trim();
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

export const friction = inngest.createFunction(
  {
    id: "memory/friction-analysis",
    name: "Analyze Memory Friction",
    concurrency: 1,
  },
  { cron: "0 7 * * *" },
  async ({ step }) => {
    const gate = await step.run("gate-minimum-points", async () => {
      try {
        const qdrant = getQdrantClient();
        const countResult = await qdrant.count(QDRANT_COLLECTION, { exact: true });
        const totalPoints = Number(countResult?.count ?? 0);
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
        reason: "insufficient-qdrant-points",
        totalPoints: gate.totalPoints,
        threshold: MINIMUM_POINTS,
        error: gate.error,
      };
    }

    const observations = await step.run("query-qdrant-observations", async () => {
      const sinceIso = getSevenDaysAgoIso();
      const qdrant = getQdrantClient();
      const records = await fetchRecentObservations(qdrant, sinceIso);
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
        };
      }

      const adapter = new TodoistTaskAdapter();
      const taskIds: string[] = [];
      for (const pattern of parsed.patterns) {
        const descriptionLines = [
          `Summary: ${pattern.summary}`,
          `Suggestion: ${pattern.suggestion}`,
        ];
        if (pattern.evidence.length > 0) {
          descriptionLines.push("Evidence:");
          descriptionLines.push(...pattern.evidence.map((item) => `- ${item}`));
        }

        const task = await adapter.createTask({
          content: `Friction: ${truncateForTaskContent(pattern.title, 80)}`,
          description: descriptionLines.join("\n"),
          labels: ["memory-review", "agent", "friction"],
          projectId: "Agent Work",
        });
        taskIds.push(task.id);
      }

      return {
        created: taskIds.length,
        taskIds,
      };
    });

    return {
      status: "ok",
      totalPoints: gate.totalPoints,
      observationsQueried: observations.count,
      groupedBuckets: observations.grouped.length,
      patternsDetected: parsed.count,
      tasksCreated: tasks.created,
      taskIds: tasks.taskIds,
    };
  }
);
