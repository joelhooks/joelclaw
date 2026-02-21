import { execSync } from "node:child_process";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { pushGatewayEvent } from "./agent-loop/utils";
import { emitOtelEvent } from "../../observability/emit";
import type { OtelEvent } from "../../observability/otel-event";
import { scanRecentFailures, triageFailures } from "../../observability/triage";
import { dedupKey } from "../../observability/triage-patterns";

const AGENT_WORK_PROJECT_ID = "6g3VPph7cFfm8GjJ";
const TRIAGE_CATEGORY = "o11y-triage";
const TRIAGE_LABELS = "o11y,escalation";

type TodoistTaskResult = {
  id?: string;
  url?: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function compact(value: string, max = 140): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(max - 3, 1))}...`;
}

function summarizeIssue(event: OtelEvent): string {
  const error = compact(event.error ?? "operation_failed", 80);
  return `${event.component}.${event.action} - ${error}`;
}

function inferImpact(event: OtelEvent): string {
  return `Failure in ${event.component}.${event.action} can degrade automation reliability for ${event.source}.`;
}

function inferRootCause(event: OtelEvent): string {
  if (!event.error) {
    return "Unknown root cause. Triage should inspect recent deploys, logs, and config changes around this component.";
  }
  return `Likely tied to error "${compact(event.error, 180)}" in ${event.component}; validate runtime state and recent changes touching this path.`;
}

function buildCodexPrompt(event: OtelEvent): string {
  return [
    `Goal: Fix recurring failure in ${event.component}.${event.action}.`,
    "Context:",
    `- Event ID: ${event.id}`,
    `- Source: ${event.source}`,
    `- Level: ${event.level}`,
    `- Error: ${event.error ?? "operation_failed"}`,
    `- Timestamp: ${new Date(event.timestamp).toISOString()}`,
    "Constraints:",
    "- Preserve existing behavior except the failure path.",
    "- Keep OTEL structured logging for success and failure.",
    "Do:",
    "- Reproduce or reason from current logs and function path.",
    "- Implement the smallest reliable fix.",
    "- Add or update tests for the failure mode where feasible.",
    "Deliver:",
    "- Exact files changed.",
    "- Validation commands and observed results.",
    "- Rollback command/patch if regression appears.",
  ].join("\n");
}

function buildTaskTitle(event: OtelEvent): string {
  return compact(`[O11y] ${event.component}.${event.action}: ${event.error ?? "operation_failed"}`, 120);
}

function buildTaskDescription(event: OtelEvent): string {
  const codexPrompt = buildCodexPrompt(event);
  return [
    "What broke",
    `- Component: ${event.component}`,
    `- Action: ${event.action}`,
    `- Error: ${event.error ?? "operation_failed"}`,
    `- First occurrence in this window: ${new Date(event.timestamp).toISOString()}`,
    `- Dedup key: ${dedupKey(event)}`,
    "",
    "Impact",
    `- ${inferImpact(event)}`,
    "",
    "Root cause",
    `- ${inferRootCause(event)}`,
    "",
    "Proposed fix",
    `- Inspect the ${event.component} code path and failure branch for ${event.action}.`,
    "- Patch the failing path with explicit guardrails and retry-safe behavior.",
    "- Verify with TypeScript check and targeted function run evidence.",
    "",
    "Codex prompt",
    "```md",
    codexPrompt,
    "```",
    "",
    "Rollback",
    "- Revert the patch if new failures appear.",
    "- Disable the new behavior behind a flag or short-circuit to previous stable path.",
  ].join("\n");
}

function createTodoistEscalationTask(event: OtelEvent): TodoistTaskResult {
  const title = buildTaskTitle(event);
  const description = buildTaskDescription(event);
  const priority = event.level === "fatal" ? "4" : "3";

  const args = [
    "add",
    title,
    "--description",
    description,
    "--project",
    AGENT_WORK_PROJECT_ID,
    "--priority",
    priority,
    "--labels",
    TRIAGE_LABELS,
  ];

  const command = `todoist-cli ${args.map(shellQuote).join(" ")}`;
  const raw = execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();

  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as {
      result?: { id?: unknown; url?: unknown };
    };
    return {
      id: parsed.result?.id != null ? String(parsed.result.id) : undefined,
      url: typeof parsed.result?.url === "string" ? parsed.result.url : undefined,
    };
  } catch {
    return {};
  }
}

function buildTelegramText(event: OtelEvent, taskUrl?: string): string {
  const summary = summarizeIssue(event);
  const impact = inferImpact(event);
  return [
    `O11y triage escalation: ${summary}`,
    `Impact: ${impact}`,
    taskUrl ? `Task: ${taskUrl}` : "Task created in Agent Work.",
    "Task created, fix ready.",
  ].join("\n");
}

export const o11yTriage = inngest.createFunction(
  { id: "check/o11y-triage", concurrency: { limit: 1 }, retries: 1 },
  [{ cron: "TZ=America/Los_Angeles */15 * * * *" }],
  async ({ step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;

    const events = await step.run("scan", async () => scanRecentFailures(15));

    const triaged = await step.run("classify", async () => triageFailures(events));

    await step.run("handle-tier1", async () => {
      for (const event of triaged.tier1) {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "o11y-triage",
          action: "auto_fix.applied",
          success: true,
          metadata: {
            phase: "phase-1",
            strategy: "log-ignore",
            dedupKey: dedupKey(event),
            event: {
              id: event.id,
              component: event.component,
              action: event.action,
              error: event.error ?? null,
            },
          },
        });
      }
      return { handled: triaged.tier1.length };
    });

    await step.run("handle-tier2", async () => {
      if (triaged.tier2.length === 0) {
        return { handled: 0, queuedObservation: false };
      }

      await inngest.send({
        name: "session/observation.noted",
        data: {
          observations: triaged.tier2.map((event) => ({
            category: TRIAGE_CATEGORY,
            summary: summarizeIssue(event),
            metadata: {
              eventId: event.id,
              timestamp: event.timestamp,
              source: event.source,
              component: event.component,
              action: event.action,
              error: event.error ?? null,
              dedupKey: dedupKey(event),
            },
          })),
        },
      });

      return { handled: triaged.tier2.length, queuedObservation: true };
    });

    await step.run("handle-tier3", async () => {
      for (const event of triaged.tier3) {
        const task = createTodoistEscalationTask(event);
        const text = buildTelegramText(event, task.url);

        if (gateway) {
          await gateway.alert(text, {
            channel: "telegram",
            taskId: task.id ?? null,
            taskUrl: task.url ?? null,
            dedupKey: dedupKey(event),
          });
        } else {
          await pushGatewayEvent({
            type: "alert",
            source: "inngest/check/o11y-triage",
            payload: {
              message: text,
              channel: "telegram",
              taskId: task.id ?? null,
              taskUrl: task.url ?? null,
              dedupKey: dedupKey(event),
            },
          });
        }

        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "o11y-triage",
          action: "triage.escalated",
          success: true,
          metadata: {
            event: {
              id: event.id,
              component: event.component,
              action: event.action,
              error: event.error ?? null,
              level: event.level,
            },
            taskId: task.id ?? null,
            taskUrl: task.url ?? null,
            dedupKey: dedupKey(event),
          },
        });
      }
      return { handled: triaged.tier3.length };
    });

    return {
      scanned: events.length,
      tier1: triaged.tier1.length,
      tier2: triaged.tier2.length,
      tier3: triaged.tier3.length,
    };
  }
);
