import { getRedisPort } from "../../lib/redis";
/**
 * Task triage — Sonnet reviews ALL open tasks via TaskPort.
 * ADR-0045: TaskPort hexagonal interface.
 * ADR-0062: Heartbeat-Driven Task Triage.
 *
 * Uses TaskPort (not todoist-cli directly) so the triage is provider-agnostic.
 * Sonnet 4.6 for judgment — task prioritization has real consequences.
 * Only notifies gateway when actionable items found. 2h cooldown.
 */

import { inngest } from "../client";
import { parseClaudeOutput, pushGatewayEvent } from "./agent-loop/utils";
import { infer } from "../../lib/inference";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import type { Task } from "../../tasks/port";
import Redis from "ioredis";

const TRIAGE_NOTIFIED_KEY = "tasks:triage:last-notified";
const TRIAGE_HASH_KEY = "tasks:triage:last-hash";
const TRIAGE_TTL_SECONDS = 2 * 60 * 60; // 2 hours

const TRIAGE_SYSTEM_PROMPT = `You review Todoist tasks for Joel Hooks' personal AI system (joelclaw).

The agent runs on a Mac Mini with access to: file system, git, CLI tools (todoist-cli, granola, slog, gog, etc), Inngest event bus, Redis, Typesense, Vault (Obsidian notes), web search, code execution (TypeScript/Python/Bash), GitHub API, email (Front + Gmail via EmailPort), SSH to NAS, Kubernetes cluster.

Review ALL tasks — not just @agent labeled ones. Joel's entire task list is context for what matters.

For each task, classify into exactly one category:
- agent-can-do-now: the agent can execute this immediately with available tools. Low risk, reversible, or clearly scoped. State what the agent would do.
- needs-human-decision: the agent could act but the task is ambiguous, high-stakes, or has multiple valid approaches. State the SPECIFIC decision Joel needs to make.
- blocked: waiting on external dependency, access, credential, or prerequisite. State what's blocking.
- human-only: requires physical action, in-person, social interaction, or judgment only Joel can make.
- stale: task has been sitting untouched, may no longer be relevant. Suggest archiving or updating.

Also identify:
- Tasks that relate to each other (dependencies, duplicates, sequences)
- Tasks that could be broken down into smaller agent-executable steps
- Tasks whose priority seems wrong given what else is on the list

Respond ONLY with valid JSON:
{
  "triage": [
    {
      "id": "task-id",
      "category": "agent-can-do-now|needs-human-decision|blocked|human-only|stale",
      "reason": "1-2 sentence explanation",
      "suggestedAction": "optional: what the agent would do, or what decision is needed"
    }
  ],
  "insights": [
    "optional: cross-task observations, priority suggestions, dependency chains"
  ]
}`;

type TriageCategory = "agent-can-do-now" | "needs-human-decision" | "blocked" | "human-only" | "stale";

type TriageItem = {
  id: string;
  category: TriageCategory;
  reason: string;
  suggestedAction?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object";
}

function normalizeCategory(v: unknown): TriageCategory | null {
  const valid: TriageCategory[] = ["agent-can-do-now", "needs-human-decision", "blocked", "human-only", "stale"];
  return typeof v === "string" && valid.includes(v as TriageCategory) ? (v as TriageCategory) : null;
}

function parseTriageResult(raw: string): { triage: TriageItem[]; insights: string[] } {
  const parsed = parseClaudeOutput(raw);
  if (!isRecord(parsed)) return { triage: [], insights: [] };

  const triage = Array.isArray(parsed.triage)
    ? parsed.triage
        .map((item): TriageItem | null => {
          if (!isRecord(item)) return null;
          const id = String(item.id ?? "").trim();
          const category = normalizeCategory(item.category);
          if (!id || !category) return null;
          return {
            id,
            category,
            reason: String(item.reason ?? "").trim(),
            suggestedAction: typeof item.suggestedAction === "string" ? item.suggestedAction : undefined,
          };
        })
        .filter((item): item is TriageItem => item !== null)
    : [];

  const insights = Array.isArray(parsed.insights)
    ? parsed.insights.filter((i): i is string => typeof i === "string")
    : [];

  return { triage, insights };
}

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

function hashTasks(tasks: Task[]): string {
  const { createHash } = require("node:crypto");
  const canonical = tasks.map((t) => `${t.id}:${t.content}:${t.labels.join(",")}`).sort().join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function formatTaskForLLM(task: Task): string {
  const parts = [
    `ID: ${task.id}`,
    `Content: ${task.content}`,
  ];
  if (task.description) parts.push(`Description: ${task.description}`);
  parts.push(`Priority: P${task.priority}`);
  if (task.labels.length) parts.push(`Labels: ${task.labels.join(", ")}`);
  if (task.dueString) parts.push(`Due: ${task.dueString}`);
  if (task.projectId) parts.push(`Project: ${task.projectId}`);
  return parts.join("\n");
}

export const taskTriage = inngest.createFunction(
  {
    id: "tasks/triage",
    name: "Task Triage — Sonnet reviews all open tasks via TaskPort",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "tasks/triage.requested" },
  async ({ step }) => {
    // Step 1: Fetch ALL open tasks via TaskPort
    const tasks = await (async (): Promise<Task[]> => {
      const adapter = new TodoistTaskAdapter();
      return adapter.listTasks();
    })();

    if (tasks.length === 0) {
      return { status: "noop", reason: "no tasks" };
    }

    // Step 2: Check if task list changed (content + labels, not just IDs)
    const shouldTriage = await step.run("check-hash", async () => {
      const redis = getRedis();
      const currentHash = hashTasks(tasks);
      const previousHash = await redis.get(TRIAGE_HASH_KEY);
      if (previousHash === currentHash) return false;
      await redis.set(TRIAGE_HASH_KEY, currentHash, "EX", 4 * 60 * 60);
      return true;
    });

    if (!shouldTriage) {
      return { status: "noop", reason: "task list unchanged", taskCount: tasks.length };
    }

    // Step 3: Check cooldown
    const onCooldown = await step.run("check-cooldown", async () => {
      const redis = getRedis();
      return !!(await redis.get(TRIAGE_NOTIFIED_KEY));
    });

    if (onCooldown) {
      return { status: "noop", reason: "cooldown active (2h)", taskCount: tasks.length };
    }

    // Step 4: Sonnet reviews ALL tasks
    const triageResult = await step.run("sonnet-triage", async () => {
      const taskBlocks = tasks.map(formatTaskForLLM);
      const userPrompt = [
        `Review these ${tasks.length} tasks. Return one triage entry per task ID.`,
        "",
        taskBlocks.join("\n\n---\n\n"),
      ].join("\n");

      const { text } = await infer(userPrompt, {
        agent: "triage",
        system: TRIAGE_SYSTEM_PROMPT,
        component: "task-triage",
        action: "tasks.triage.classify",
        json: true,
      });

      const triage = parseTriageResult(text);
      return triage;
    });

    // Step 5: Build gateway notification — only if actionable
    const result = await step.run("notify-gateway", async () => {
      const triageById = new Map(triageResult.triage.map((t) => [t.id, t]));

      const rows = tasks.map((task) => {
        const t = triageById.get(task.id);
        return {
          task,
          category: t?.category ?? ("human-only" as TriageCategory),
          reason: t?.reason ?? "No classification",
          suggestedAction: t?.suggestedAction,
        };
      });

      const canDo = rows.filter((r) => r.category === "agent-can-do-now");
      const needsDecision = rows.filter((r) => r.category === "needs-human-decision");
      const stale = rows.filter((r) => r.category === "stale");

      // NOOP: nothing actionable
      if (canDo.length === 0 && needsDecision.length === 0 && stale.length === 0 && triageResult.insights.length === 0) {
        return { pushed: false, actionableCount: 0, totalTasks: rows.length };
      }

      const sections: string[] = [`## 📋 Task Review (${tasks.length} total)`, ""];

      if (canDo.length > 0) {
        sections.push("**Ready to execute (say go):**");
        for (const r of canDo) {
          const action = r.suggestedAction ? ` → _${r.suggestedAction}_` : "";
          sections.push(`- **${r.task.content}** [P${r.task.priority}]${action}`);
        }
        sections.push("");
      }

      if (needsDecision.length > 0) {
        sections.push("**Need your call:**");
        for (const r of needsDecision) {
          sections.push(`- **${r.task.content}** — ${r.reason}`);
        }
        sections.push("");
      }

      if (stale.length > 0) {
        sections.push("**Possibly stale (archive?):**");
        for (const r of stale) {
          sections.push(`- ~~${r.task.content}~~ — ${r.reason}`);
        }
        sections.push("");
      }

      if (triageResult.insights.length > 0) {
        sections.push("**Insights:**");
        for (const insight of triageResult.insights) {
          sections.push(`- ${insight}`);
        }
        sections.push("");
      }

      await pushGatewayEvent({
        type: "todoist.task.triage",
        source: "inngest/task-triage",
        payload: { prompt: sections.join("\n") },
      });

      // Set cooldown
      const redis = getRedis();
      await redis.set(TRIAGE_NOTIFIED_KEY, new Date().toISOString(), "EX", TRIAGE_TTL_SECONDS);

      return {
        pushed: true,
        actionableCount: canDo.length + needsDecision.length,
        totalTasks: rows.length,
        staleCount: stale.length,
      };
    });

    return {
      status: result.pushed ? "notified" : "noop",
      ...result,
    };
  }
);
