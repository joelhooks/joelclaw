import { getRedisPort } from "../../lib/redis";

/**
 * Task triage — Sonnet reviews the human-facing Todoist surface via TaskPort.
 * ADR-0045: TaskPort hexagonal interface.
 * ADR-0062: Heartbeat-Driven Task Triage.
 *
 * Uses TaskPort (not todoist-cli directly) so the triage is provider-agnostic.
 * Sonnet 4.6 for judgment — task prioritization has real consequences.
 * Only notifies gateway when actionable items found. 2h cooldown.
 */

import Redis from "ioredis";
import { infer } from "../../lib/inference";
import { checkCircuit, recordFailure, recordSuccess } from "../../lib/inference-circuit";
import { emitOtelEvent } from "../../observability/emit";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";
import type { Project, Task } from "../../tasks/port";
import { inngest } from "../client";
import { parseClaudeOutput, pushGatewayEvent } from "./agent-loop/utils";

const TRIAGE_NOTIFIED_KEY = "tasks:triage:last-notified";
const TRIAGE_HASH_KEY = "tasks:triage:last-hash";
const TRIAGE_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const TRIAGE_HASH_TTL_SECONDS = 4 * 60 * 60; // 4 hours

const TRIAGE_SYSTEM_PROMPT = `You review Todoist tasks for Joel Hooks' personal AI system (joelclaw).

The agent runs on a Mac Mini with access to: file system, git, CLI tools (todoist-cli, granola, slog, gog, etc), Inngest event bus, Redis, Typesense, Vault (Obsidian notes), web search, code execution (TypeScript/Python/Bash), GitHub API, email (Front + Gmail via EmailPort), SSH to NAS, Kubernetes cluster.

Review only the human-facing task surface provided to you. Machine backlog and system bookkeeping have already been filtered out upstream.

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

type TriageParseReason = "null_output" | "schema_invalid" | "missing_ids" | "duplicate_ids";

type TriageParseResult =
  | { ok: true; triage: TriageItem[]; insights: string[] }
  | { ok: false; triage: TriageItem[]; insights: string[]; reason: TriageParseReason };

function parseTriageResult(raw: string, expectedTaskIds: Set<string>): TriageParseResult {
  const parsed = parseClaudeOutput(raw);
  if (!isRecord(parsed)) {
    return { ok: false, reason: "null_output", triage: [], insights: [] };
  }

  if (!Array.isArray(parsed.triage)) {
    return { ok: false, reason: "schema_invalid", triage: [], insights: [] };
  }

  const triage: TriageItem[] = [];
  for (const item of parsed.triage) {
    if (!isRecord(item)) {
      return { ok: false, reason: "schema_invalid", triage: [], insights: [] };
    }

    const id = String(item.id ?? "").trim();
    const category = normalizeCategory(item.category);
    const reason = String(item.reason ?? "").trim();
    if (!id || !category || !reason) {
      return { ok: false, reason: "schema_invalid", triage: [], insights: [] };
    }

    triage.push({
      id,
      category,
      reason,
      suggestedAction: typeof item.suggestedAction === "string" ? item.suggestedAction.trim() : undefined,
    });
  }

  const uniqueIds = new Set(triage.map((item) => item.id));
  if (uniqueIds.size !== triage.length) {
    return { ok: false, reason: "duplicate_ids", triage: [], insights: [] };
  }

  for (const taskId of expectedTaskIds) {
    if (!uniqueIds.has(taskId)) {
      return { ok: false, reason: "missing_ids", triage: [], insights: [] };
    }
  }

  const insights = Array.isArray(parsed.insights)
    ? parsed.insights.filter((i): i is string => typeof i === "string")
    : [];

  return { ok: true, triage, insights };
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

const HUMAN_FACING_TASK_PROJECTS = new Set(["joel's tasks", "questions for joel"]);

type HumanFacingTaskSelection = {
  visibleTasks: Task[];
  excludedTasks: Task[];
  projectNames: Map<string, string>;
};

function normalizeProjectName(value: string): string {
  return value.trim().toLowerCase();
}

function buildProjectNameMap(projects: Project[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const project of projects) {
    names.set(project.id, project.name);
    names.set(project.name, project.name);
  }
  return names;
}

function resolveTaskProjectName(task: Task, projectNames: Map<string, string>): string | null {
  const raw = task.projectId?.trim();
  if (!raw) return null;
  return projectNames.get(raw) ?? raw;
}

function selectHumanFacingTasks(tasks: Task[], projects: Project[]): HumanFacingTaskSelection {
  const projectNames = buildProjectNameMap(projects);
  const visibleTasks: Task[] = [];
  const excludedTasks: Task[] = [];

  for (const task of tasks) {
    const projectName = resolveTaskProjectName(task, projectNames);
    if (projectName && HUMAN_FACING_TASK_PROJECTS.has(normalizeProjectName(projectName))) {
      visibleTasks.push(task);
      continue;
    }
    excludedTasks.push(task);
  }

  return { visibleTasks, excludedTasks, projectNames };
}

function formatTaskForLLM(task: Task, projectNames: Map<string, string>): string {
  const parts = [
    `ID: ${task.id}`,
    `Content: ${task.content}`,
  ];
  if (task.description) parts.push(`Description: ${task.description}`);
  parts.push(`Priority: P${task.priority}`);
  if (task.labels.length) parts.push(`Labels: ${task.labels.join(", ")}`);
  if (task.dueString) parts.push(`Due: ${task.dueString}`);
  const projectName = resolveTaskProjectName(task, projectNames);
  if (projectName) parts.push(`Project: ${projectName}`);
  return parts.join("\n");
}

export const taskTriage = inngest.createFunction(
  {
    id: "tasks/triage",
    name: "Task Triage — Sonnet reviews human-facing tasks via TaskPort",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "tasks/triage.requested" },
  async ({ step }) => {
    // Step 1: Fetch open tasks, then scope to the human-facing task surface.
    const selection = await (async (): Promise<HumanFacingTaskSelection> => {
      const adapter = new TodoistTaskAdapter();
      const [tasks, projects] = await Promise.all([adapter.listTasks(), adapter.listProjects()]);
      return selectHumanFacingTasks(tasks, projects);
    })();

    const tasks = selection.visibleTasks;
    const totalTaskCount = selection.visibleTasks.length + selection.excludedTasks.length;
    const excludedTaskCount = selection.excludedTasks.length;

    if (tasks.length === 0) {
      return {
        status: "noop",
        reason: totalTaskCount === 0 ? "no tasks" : "no human-facing tasks",
        totalTaskCount,
        excludedTaskCount,
      };
    }

    // Step 2: Check if task list changed (content + labels, not just IDs)
    const shouldTriage = await step.run("check-hash", async () => {
      const redis = getRedis();
      const currentHash = hashTasks(tasks);
      const previousHash = await redis.get(TRIAGE_HASH_KEY);
      return { changed: previousHash !== currentHash, currentHash };
    });

    if (!shouldTriage.changed) {
      return { status: "noop", reason: "task list unchanged", taskCount: tasks.length, totalTaskCount, excludedTaskCount };
    }

    // Step 3: Check cooldown
    const onCooldown = await step.run("check-cooldown", async () => {
      const redis = getRedis();
      return !!(await redis.get(TRIAGE_NOTIFIED_KEY));
    });

    if (onCooldown) {
      return { status: "noop", reason: "cooldown active (2h)", taskCount: tasks.length, totalTaskCount, excludedTaskCount };
    }

    // Step 4: Check inference circuit before Sonnet classification
    const circuitState = await step.run("check-circuit", async () =>
      checkCircuit("task-triage", "tasks.triage.classify")
    );

    if (circuitState.skip) {
      await emitOtelEvent({
        level: "warn",
        source: "system-bus",
        component: "task-triage",
        action: "tasks.triage.circuit_skip",
        success: false,
        metadata: {
          taskCount: tasks.length,
          totalTaskCount,
          excludedTaskCount,
          circuitState: circuitState.state,
          circuitReason: circuitState.reason,
        },
      });

      return { status: "degraded", reason: "circuit_open", circuitState, taskCount: tasks.length, totalTaskCount, excludedTaskCount };
    }

    // Step 5: Sonnet reviews the human-facing task surface with strict output contract
    const triageResult = await step.run("sonnet-triage", async () => {
      const taskBlocks = tasks.map((task) => formatTaskForLLM(task, selection.projectNames));
      const expectedTaskIds = new Set(tasks.map((task) => task.id));
      const basePrompt = [
        `Review these ${tasks.length} tasks. Return one triage entry per task ID.`,
        "",
        taskBlocks.join("\n\n---\n\n"),
      ].join("\n");

      const attemptClassify = async (prompt: string, stage: "primary" | "repair") => {
        try {
          const { text } = await infer(prompt, {
            agent: "triage",
            system: TRIAGE_SYSTEM_PROMPT,
            component: "task-triage",
            action: "tasks.triage.classify",
            timeout: 300_000,
            json: true,
            requireJson: true,
            requireTextOutput: true,
            metadata: {
              taskCount: tasks.length,
              totalTaskCount,
              excludedTaskCount,
              classificationStage: stage,
            },
          });

          const parsed = parseTriageResult(text, expectedTaskIds);
          if (parsed.ok) return { ok: true as const, triage: parsed.triage, insights: parsed.insights };
          return { ok: false as const, reason: parsed.reason };
        } catch (error) {
          const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
          const reason: TriageParseReason =
            message.includes("json") || message.includes("output_empty") ? "null_output" : "schema_invalid";
          return { ok: false as const, reason };
        }
      };

      const primary = await attemptClassify(basePrompt, "primary");
      if (primary.ok) {
        recordSuccess("task-triage", "tasks.triage.classify");
        return {
          classificationValid: true,
          triage: primary.triage,
          insights: primary.insights,
          fallbackUsed: false,
          failureReason: null,
        };
      }

      const repairPrompt = [
        basePrompt,
        "",
        "Your previous response failed schema validation.",
        "Return ONLY strict JSON with this exact shape:",
        '{"triage":[{"id":"task-id","category":"agent-can-do-now|needs-human-decision|blocked|human-only|stale","reason":"required","suggestedAction":"optional"}],"insights":["optional"]}',
        "Every task ID must appear exactly once.",
      ].join("\n");

      const repair = await attemptClassify(repairPrompt, "repair");
      if (repair.ok) {
        recordSuccess("task-triage", "tasks.triage.classify");
        return {
          classificationValid: true,
          triage: repair.triage,
          insights: repair.insights,
          fallbackUsed: true,
          failureReason: null,
        };
      }

      recordFailure("task-triage", "tasks.triage.classify");

      return {
        classificationValid: false,
        triage: [] as TriageItem[],
        insights: [] as string[],
        fallbackUsed: true,
        failureReason: repair.reason,
      };
    });

    if (!triageResult.classificationValid) {
      await emitOtelEvent({
        level: "warn",
        source: "system-bus",
        component: "task-triage",
        action: "tasks.triage.degraded",
        success: false,
        metadata: {
          taskCount: tasks.length,
          totalTaskCount,
          excludedTaskCount,
          classificationValid: false,
          outputFailureReason: triageResult.failureReason,
          fallbackUsed: triageResult.fallbackUsed,
          circuitState: circuitState.state,
        },
      });

      return {
        status: "degraded",
        taskCount: tasks.length,
        totalTaskCount,
        excludedTaskCount,
        classificationValid: false,
        triageItemsCount: 0,
        actionableCount: 0,
        outputFailureReason: triageResult.failureReason,
        fallbackUsed: triageResult.fallbackUsed,
      };
    }

    // Step 6: Persist hash only after successful classification
    await step.run("persist-hash", async () => {
      const redis = getRedis();
      await redis.set(TRIAGE_HASH_KEY, shouldTriage.currentHash, "EX", TRIAGE_HASH_TTL_SECONDS);
      return { persisted: true };
    });

    // Step 7: Build gateway notification — only if actionable
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

      // NOOP: classification valid, but nothing actionable
      if (canDo.length === 0 && needsDecision.length === 0 && stale.length === 0 && triageResult.insights.length === 0) {
        return {
          pushed: false,
          actionableCount: 0,
          totalTasks: rows.length,
          totalOpenTasks: totalTaskCount,
          excludedTaskCount,
          staleCount: 0,
          triageItemsCount: triageResult.triage.length,
        };
      }

      const sections: string[] = [`## 📋 Task Review (${tasks.length} human-facing, ${totalTaskCount} total open)`, ""];

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

      // Set cooldown only when a notification is actually pushed.
      const redis = getRedis();
      await redis.set(TRIAGE_NOTIFIED_KEY, new Date().toISOString(), "EX", TRIAGE_TTL_SECONDS);

      return {
        pushed: true,
        actionableCount: canDo.length + needsDecision.length,
        totalTasks: rows.length,
        totalOpenTasks: totalTaskCount,
        excludedTaskCount,
        staleCount: stale.length,
        triageItemsCount: triageResult.triage.length,
      };
    });

    await emitOtelEvent({
      level: "info",
      source: "system-bus",
      component: "task-triage",
      action: "tasks.triage.completed",
      success: true,
      metadata: {
        taskCount: tasks.length,
        totalTaskCount,
        excludedTaskCount,
        classificationValid: true,
        triageItemsCount: result.triageItemsCount,
        actionableCount: result.actionableCount,
        staleCount: result.staleCount,
        pushed: result.pushed,
        circuitState: circuitState.state,
      },
    });

    return {
      status: result.pushed ? "notified" : "noop",
      classificationValid: true,
      outputFailureReason: null,
      fallbackUsed: triageResult.fallbackUsed,
      ...result,
    };
  }
);

export const __taskTriageTestUtils = {
  parseTriageResult,
  selectHumanFacingTasks,
};
