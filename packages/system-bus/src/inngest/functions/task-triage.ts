/**
 * Task triage Inngest function.
 * ADR-0062: Heartbeat-Driven Task Triage
 *
 * Triggered by tasks/triage.requested (from heartbeat or manual).
 * Fetches @agent-labeled Todoist tasks, LLM-triages via pi CLI,
 * and pushes a structured prompt to the gateway when actionable work found.
 */

import { inngest } from "../client";
import { parseClaudeOutput, pushGatewayEvent } from "./agent-loop/utils";
import Redis from "ioredis";

const TRIAGE_NOTIFIED_KEY = "tasks:triage:last-notified";
const TRIAGE_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const TRIAGE_MODEL = "anthropic/claude-haiku-4-5";

const TRIAGE_SYSTEM_PROMPT = `You triage Todoist tasks for an AI agent running on a Mac Mini (joelclaw system).

The agent has access to: file system, git, CLI tools (todoist-cli, granola, slog, gog, etc), Inngest event bus, Redis, Qdrant, Vault (Obsidian notes), web search, code execution (TypeScript/Python/Bash), GitHub API, email (gog/Front), SSH to NAS.

Classify each task into exactly one category:
- agent-can-do-now: the agent can execute this immediately with available tools. Low risk, reversible, or clearly scoped.
- needs-human-decision: the agent could act but the task is ambiguous, high-stakes, or has multiple valid approaches. State the specific decision needed.
- blocked: waiting on external dependency, access, credential, or prerequisite the agent can't resolve.
- human-only: requires physical action, browser login, social interaction, or human judgment.

Respond ONLY with valid JSON:
{
  "triage": [
    {
      "id": "task-id",
      "category": "agent-can-do-now|needs-human-decision|blocked|human-only",
      "reason": "1-2 sentence explanation"
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
  return {
    id,
    content: String(input.content ?? "").trim(),
    description: String(input.description ?? "").trim(),
    labels: Array.isArray(input.labels)
      ? input.labels.filter((l): l is string => typeof l === "string")
      : [],
    project: String(input.project ?? input.project_name ?? input.project_id ?? "").trim(),
  };
}

function normalizeTriageCategory(input: unknown): TriageCategory | null {
  if (input === "agent-can-do-now") return "agent-can-do-now";
  if (input === "needs-human-decision") return "needs-human-decision";
  if (input === "blocked") return "blocked";
  if (input === "human-only") return "human-only";
  return null;
}

function parseTriageResult(raw: string): TriageItem[] {
  const parsed = parseClaudeOutput(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.triage)) return [];

  return parsed.triage
    .map((item): TriageItem | null => {
      if (!isRecord(item)) return null;
      const id = String(item.id ?? "").trim();
      const category = normalizeTriageCategory(item.category);
      if (!id || !category) return null;
      return { id, category, reason: String(item.reason ?? "").trim() };
    })
    .filter((item): item is TriageItem => item !== null);
}

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

async function readProcessStream(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

export const taskTriage = inngest.createFunction(
  {
    id: "tasks/triage",
    name: "Task Triage — LLM categorization of @agent tasks",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "tasks/triage.requested" },
  async ({ step }) => {
    // Step 1: Fetch @agent tasks from Todoist
    const tasks = await step.run("fetch-agent-tasks", async (): Promise<AgentTask[]> => {
      const proc = Bun.spawn(["todoist-cli", "list", "--label", "agent"], {
        env: { ...process.env, TERM: "dumb" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        readProcessStream(proc.stdout),
        readProcessStream(proc.stderr),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(`todoist-cli list --label agent failed (${exitCode}): ${stderr.trim() || "unknown"}`);
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
        throw new Error(`todoist-cli error: ${String(parsed.error ?? "unknown")}`);
      }

      const result = isRecord(parsed) ? parsed.result : undefined;
      return extractTodoistTaskArray(result)
        .map(toAgentTask)
        .filter((t): t is AgentTask => t !== null);
    });

    if (tasks.length === 0) {
      return { status: "skipped", reason: "no @agent tasks", totalTasks: 0 };
    }

    // Step 2: Check cooldown — don't re-notify within 2h
    const shouldNotify = await step.run("check-cooldown", async () => {
      const redis = getRedis();
      const lastNotified = await redis.get(TRIAGE_NOTIFIED_KEY);
      return !lastNotified;
    });

    if (!shouldNotify) {
      return { status: "skipped", reason: "cooldown active (2h)", totalTasks: tasks.length };
    }

    // Step 3: LLM triage via pi CLI
    const triageItems = await step.run("llm-triage", async (): Promise<TriageItem[]> => {
      const taskLines = tasks.map((task) => {
        return [
          `ID: ${task.id}`,
          `Content: ${task.content || "(empty)"}`,
          `Description: ${task.description || "(none)"}`,
          `Labels: ${task.labels.length > 0 ? task.labels.join(", ") : "(none)"}`,
          `Project: ${task.project || "(none)"}`,
        ].join("\n");
      });

      const userPrompt = [
        "Triage these Todoist tasks. Return one entry per task ID.",
        "",
        taskLines.join("\n\n---\n\n"),
      ].join("\n");

      const proc = Bun.spawn(
        ["pi", "-p", "--no-session", "--no-extensions", "--model", TRIAGE_MODEL, "--system-prompt", TRIAGE_SYSTEM_PROMPT, userPrompt],
        {
          env: { ...process.env, TERM: "dumb" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const [stdout, stderr, exitCode] = await Promise.all([
        readProcessStream(proc.stdout),
        readProcessStream(proc.stderr),
        proc.exited,
      ]);

      if (exitCode !== 0 && !stdout.trim()) {
        throw new Error(`pi triage failed (${exitCode}): ${stderr.trim() || "unknown"}`);
      }

      return parseTriageResult(stdout);
    });

    // Step 4: Build gateway prompt and notify
    const result = await step.run("notify-gateway", async () => {
      const triageById = new Map(triageItems.map((item) => [item.id, item] as const));

      const rows = tasks.map((task) => {
        const classification = triageById.get(task.id);
        return {
          task,
          category: classification?.category ?? ("human-only" as TriageCategory),
          reason: classification?.reason ?? "No classifier output; defaulted to human-only.",
        };
      });

      const canDo = rows.filter((r) => r.category === "agent-can-do-now");
      const needsDecision = rows.filter((r) => r.category === "needs-human-decision");
      const blocked = rows.filter((r) => r.category === "blocked");

      if (canDo.length === 0 && needsDecision.length === 0 && blocked.length === 0) {
        return { pushed: false, actionableCount: 0, totalTasks: rows.length };
      }

      const sections: string[] = ["## 📋 Task Triage", ""];

      if (canDo.length > 0) {
        sections.push("**Ready to execute (just say go):**");
        for (const row of canDo) {
          sections.push(`- "**${row.task.content}**" — ${row.reason}`);
        }
        sections.push("");
      }

      if (needsDecision.length > 0) {
        sections.push("**Need your call:**");
        for (const row of needsDecision) {
          sections.push(`- "**${row.task.content}**" — ${row.reason}`);
        }
        sections.push("");
      }

      if (blocked.length > 0) {
        sections.push("**Blocked:**");
        for (const row of blocked) {
          sections.push(`- "**${row.task.content}**" — ${row.reason}`);
        }
        sections.push("");
      }

      const prompt = sections.join("\n");

      await pushGatewayEvent({
        type: "todoist.task.triage",
        source: "inngest/task-triage",
        payload: {
          prompt,
          actionableCount: canDo.length + needsDecision.length,
          totalTasks: rows.length,
          triage: rows.map((r) => ({
            id: r.task.id,
            content: r.task.content,
            category: r.category,
            reason: r.reason,
          })),
        },
      });

      // Set cooldown
      const redis = getRedis();
      await redis.set(TRIAGE_NOTIFIED_KEY, new Date().toISOString(), "EX", TRIAGE_TTL_SECONDS);

      return {
        pushed: true,
        actionableCount: canDo.length + needsDecision.length,
        totalTasks: rows.length,
      };
    });

    return {
      status: result.pushed ? "notified" : "no-actionable",
      totalTasks: result.totalTasks,
      actionableCount: result.actionableCount,
    };
  }
);
