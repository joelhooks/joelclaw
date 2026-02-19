import { inngest } from "../client";
import { parseClaudeOutput, pushGatewayEvent } from "./agent-loop/utils";
import { auditTriggers } from "./trigger-audit";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import Redis from "ioredis";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TRIAGE_HASH_KEY = "tasks:triage:last-hash";
const TRIAGE_NOTIFIED_KEY = "tasks:triage:last-notified";
const TRIAGE_TTL_SECONDS = 2 * 60 * 60;
const TRIAGE_MODEL = "anthropic/claude-haiku-4-5";
const TRIAGE_SYSTEM_PROMPT = `You triage Todoist tasks for an AI agent.

Classify each task into exactly one category:
- agent-can-do-now
- needs-human-decision
- blocked
- human-only

Rules:
- agent-can-do-now: concrete task the agent can execute immediately with available tools.
- needs-human-decision: agent can proceed after a quick human choice/approval.
- blocked: waiting on external dependency, access, or prerequisite.
- human-only: task requires human judgment/actions the agent should not do.

Respond ONLY valid JSON:
{
  "triage": [
    {
      "id": "task-id",
      "category": "agent-can-do-now|needs-human-decision|blocked|human-only",
      "reason": "short reason"
    }
  ]
}`;

type TriageCategory = "agent-can-do-now" | "needs-human-decision" | "blocked" | "human-only";

type AgentTask = {
  id: string;
  content: string;
  description: string;
  labels: string[];
  project: string;
};

type TriageItem = {
  id: string;
  category: TriageCategory;
  reason: string;
};

type TriageResult = {
  triage: TriageItem[];
};

let triageRedisClient: Redis | null = null;

function getTriageRedisClient(): Redis {
  if (triageRedisClient) return triageRedisClient;
  const isTestEnv = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  triageRedisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    retryStrategy: isTestEnv ? () => null : undefined,
  });
  triageRedisClient.on("error", () => {});
  return triageRedisClient;
}

function getHomeDirectory(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

async function collectFilesRecursively(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;

  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function pruneOldFiles(paths: string[], olderThanMs: number): Promise<number> {
  const threshold = Date.now() - olderThanMs;
  let prunedCount = 0;

  for (const path of paths) {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(path);
    } catch {
      continue;
    }

    if (fileStat.mtimeMs >= threshold) {
      continue;
    }

    try {
      await rm(path, { force: true });
      prunedCount += 1;
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }

  return prunedCount;
}

async function pruneOldSessionFiles() {
  const home = getHomeDirectory();
  const sessionsDir = join(home, ".pi", "agent", "sessions");
  const claudeDebugDir = join(home, ".claude", "debug");

  const sessionFiles = await collectFilesRecursively(sessionsDir);
  const oldSessionJsonlPaths = sessionFiles.filter((filePath) => filePath.endsWith(".jsonl"));
  const debugFiles = await collectFilesRecursively(claudeDebugDir);

  const prunedSessionsCount = await pruneOldFiles(oldSessionJsonlPaths, THIRTY_DAYS_MS);
  const prunedDebugCount = await pruneOldFiles(debugFiles, THIRTY_DAYS_MS);
  const prunedCount = prunedSessionsCount + prunedDebugCount;

  console.log("[heartbeat] prune-old-sessions", {
    prunedCount,
    prunedSessionsCount,
    prunedDebugCount,
  });

  return { prunedCount, prunedSessionsCount, prunedDebugCount };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function extractTodoistTaskArray(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!isRecord(result)) return [];
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.tasks)) return result.tasks;
  if (Array.isArray(result.results)) return result.results;
  return [];
}

function toAgentTask(input: unknown): AgentTask | null {
  if (!isRecord(input)) return null;
  const id = String(input.id ?? "").trim();
  if (!id) return null;
  const labels = Array.isArray(input.labels)
    ? input.labels.filter((label): label is string => typeof label === "string")
    : [];
  return {
    id,
    content: String(input.content ?? "").trim(),
    description: String(input.description ?? "").trim(),
    labels,
    project: String(input.project ?? input.project_name ?? input.project_id ?? "").trim(),
  };
}

function hashTaskIds(taskIds: string[]): string {
  const canonical = [...taskIds].sort().join(",");
  return createHash("sha256").update(canonical).digest("hex");
}

async function listAgentTasksFromTodoistCli(): Promise<AgentTask[]> {
  const proc = Bun.spawn(["todoist-cli", "list", "--label", "agent"], {
    env: { ...process.env, TERM: "dumb" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`todoist-cli list --label agent failed (${exitCode}): ${stderr.trim() || "unknown error"}`);
  }

  const raw = stdout.trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`todoist-cli returned invalid JSON: ${raw.slice(0, 300)}`);
  }

  if (isRecord(parsed) && parsed.ok === false) {
    throw new Error(`todoist-cli error: ${String(parsed.error ?? "unknown error")}`);
  }

  // todoist-cli uses a HATEOAS envelope: { ok, result, error, links }
  const result = isRecord(parsed) ? parsed.result : undefined;
  const tasks = extractTodoistTaskArray(result);
  return tasks.map(toAgentTask).filter((task): task is AgentTask => task !== null);
}

function normalizeTriageCategory(input: unknown): TriageCategory | null {
  if (input === "agent-can-do-now") return "agent-can-do-now";
  if (input === "needs-human-decision") return "needs-human-decision";
  if (input === "blocked") return "blocked";
  if (input === "human-only") return "human-only";
  return null;
}

function parseTriageResult(raw: string): TriageResult {
  const parsed = parseClaudeOutput(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.triage)) {
    return { triage: [] };
  }

  const triage = parsed.triage
    .map((item): TriageItem | null => {
      if (!isRecord(item)) return null;
      const id = String(item.id ?? "").trim();
      const category = normalizeTriageCategory(item.category);
      if (!id || !category) return null;
      return {
        id,
        category,
        reason: String(item.reason ?? "").trim(),
      };
    })
    .filter((item): item is TriageItem => item !== null);

  return { triage };
}

function buildTriagePrompt(tasks: AgentTask[]): string {
  const taskLines = tasks.map((task) => {
    const labelText = task.labels.length > 0 ? task.labels.join(", ") : "(none)";
    const projectText = task.project || "(none)";
    const descriptionText = task.description || "(none)";
    return [
      `ID: ${task.id}`,
      `Content: ${task.content || "(empty)"}`,
      `Description: ${descriptionText}`,
      `Labels: ${labelText}`,
      `Project: ${projectText}`,
    ].join("\n");
  });

  return [
    "Triage these Todoist tasks.",
    "Return one triage entry for each task id.",
    "",
    taskLines.join("\n\n---\n\n"),
  ].join("\n");
}

async function triageAgentTasks(): Promise<{
  status: "ok" | "skipped" | "error";
  reason?: string;
  changed?: boolean;
  totalTasks?: number;
  actionableCount?: number;
}> {
  if (!process.env.TODOIST_API_TOKEN) {
    return {
      status: "skipped",
      reason: "TODOIST_API_TOKEN not configured",
    };
  }

  try {
    const tasks = await listAgentTasksFromTodoistCli();
    const currentHash = hashTaskIds(tasks.map((task) => task.id));
    const redis = getTriageRedisClient();
    const previousHash = await redis.get(TRIAGE_HASH_KEY);
    if (previousHash === currentHash) {
      return {
        status: "skipped",
        reason: "task hash unchanged",
        changed: false,
        totalTasks: tasks.length,
      };
    }

    const prompt = buildTriagePrompt(tasks);
    const llm = Bun.spawn(
      ["pi", "-p", "--no-session", "--model", TRIAGE_MODEL, "--system-prompt", TRIAGE_SYSTEM_PROMPT, prompt],
      {
        env: { ...process.env, TERM: "dumb" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(llm.stdout).text(),
      new Response(llm.stderr).text(),
      llm.exited,
    ]);

    if (exitCode !== 0 && !stdout.trim()) {
      throw new Error(`pi triage failed (${exitCode}): ${stderr.trim() || "unknown error"}`);
    }

    const triage = parseTriageResult(stdout);
    const triageById = new Map(triage.triage.map((item) => [item.id, item] as const));

    const rows = tasks.map((task) => {
      const classification = triageById.get(task.id);
      return {
        task,
        category: classification?.category ?? "human-only",
        reason: classification?.reason ?? "No classifier output; defaulted to human-only.",
      };
    });

    const actionable = rows.filter(
      (row) => row.category === "agent-can-do-now" || row.category === "needs-human-decision"
    );

    if (actionable.length > 0) {
      const markdown = [
        "## Todoist Task Triage",
        "",
        `Actionable tasks: ${actionable.length}/${rows.length}`,
        "",
        ...rows.map((row) => {
          const labels = row.task.labels.length > 0 ? row.task.labels.join(", ") : "(none)";
          const project = row.task.project || "(none)";
          return `- [${row.category}] ${row.task.content || "(empty)"} (\`${row.task.id}\`) | project: ${project} | labels: ${labels} | reason: ${row.reason}`;
        }),
      ].join("\n");

      await pushGatewayEvent({
        type: "todoist.task.triage",
        source: "inngest/heartbeat",
        payload: {
          prompt: markdown,
          actionableCount: actionable.length,
          totalTasks: rows.length,
          triage: rows.map((row) => ({
            id: row.task.id,
            content: row.task.content,
            category: row.category,
            reason: row.reason,
            labels: row.task.labels,
            project: row.task.project,
          })),
        },
      });
    }

    const now = new Date().toISOString();
    await redis.set(TRIAGE_HASH_KEY, currentHash, "EX", TRIAGE_TTL_SECONDS);
    await redis.set(TRIAGE_NOTIFIED_KEY, now, "EX", TRIAGE_TTL_SECONDS);

    return {
      status: "ok",
      changed: true,
      totalTasks: rows.length,
      actionableCount: actionable.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No such file or directory") || message.includes("command not found")) {
      return {
        status: "skipped",
        reason: "todoist-cli not installed",
      };
    }
    console.error("[heartbeat] task-triage error", error);
    return {
      status: "error",
      reason: message,
    };
  }
}

export const heartbeatCron = inngest.createFunction(
  {
    id: "system-heartbeat",
  },
  [{ cron: "*/15 * * * *" }],
  async ({ step }) => {
    await step.run("prune-old-sessions", pruneOldSessionFiles);
    await step.run("task-triage", triageAgentTasks);

    const triggerAudit = await step.run("audit-triggers", async () => {
      try {
        return await auditTriggers();
      } catch (err) {
        return { ok: true, checked: 0, drifted: [], missing: [], extra: [], error: String(err) };
      }
    });

    await step.run("push-gateway-event", async () => {
      const payload: Record<string, unknown> = {};

      // Alert on trigger drift — silent misregistration is how the promote
      // bug went undetected. See ADR-0021 Phase 3 postmortem.
      if (!triggerAudit.ok) {
        payload.triggerDrift = {
          drifted: triggerAudit.drifted,
          missing: triggerAudit.missing,
        };
      }

      await pushGatewayEvent({
        type: triggerAudit.ok ? "cron.heartbeat" : "cron.heartbeat.drift",
        source: "inngest",
        payload,
      });
    });
  }
);

export const heartbeatWake = inngest.createFunction(
  {
    id: "system-heartbeat-wake",
  },
  [{ event: "system/heartbeat.wake" }],
  async ({ step }) => {
    await step.run("prune-old-sessions", pruneOldSessionFiles);

    await step.run("push-gateway-event", async () => {
      await pushGatewayEvent({
        type: "cron.heartbeat",
        source: "inngest",
        payload: {},
      });
    });
  }
);
