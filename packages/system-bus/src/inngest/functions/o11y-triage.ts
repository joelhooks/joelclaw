import { execSync } from "node:child_process";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { pushGatewayEvent } from "./agent-loop/utils";
import { emitOtelEvent } from "../../observability/emit";
import type { OtelEvent } from "../../observability/otel-event";
import {
  classifyWithLLM,
  scanRecentFailures,
  triageFailures,
  type ClassifiedEvent,
} from "../../observability/triage";
import { dedupKey } from "../../observability/triage-patterns";

const AGENT_WORK_PROJECT_ID = "6g3VPph7cFfm8GjJ";
const TRIAGE_CATEGORY = "o11y-triage";
const TRIAGE_PATTERN_PROPOSAL_CATEGORY = "o11y-pattern-proposal";
const TRIAGE_LABELS = "o11y,escalation";
const ESCALATION_CODEX_MODEL = "gpt-5.3-codex";
const ESCALATION_CODEX_CWD = "/Users/joel/Code/joelhooks/joelclaw";

type TodoistTaskResult = {
  id?: string;
  url?: string;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  error?: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readShellText(output: Buffer | Uint8Array | string | undefined): string {
  if (!output) return "";
  if (typeof output === "string") return output;
  return Buffer.from(output).toString("utf-8");
}

function runCommand(command: string, timeout = 10_000): CommandResult {
  try {
    const stdout = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    }).trim();
    return { ok: true, stdout };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? readShellText((error as { stderr?: Buffer | Uint8Array | string }).stderr).trim()
      : "";
    return {
      ok: false,
      stdout: "",
      error: stderr || message,
    };
  }
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

function buildTaskTitle(event: OtelEvent): string {
  return compact(`[O11y] ${event.component}.${event.action}: ${event.error ?? "operation_failed"}`, 120);
}

function buildPreliminaryTaskDescription(
  event: OtelEvent,
  llmReasoning: string | undefined,
  candidateFiles: string[],
  gitLog: string
): string {
  const reasoning = llmReasoning && llmReasoning.trim().length > 0
    ? llmReasoning.trim()
    : "No additional classification reasoning returned by Haiku.";
  const candidateList = candidateFiles.length > 0 ? candidateFiles : ["none detected"];
  const gitPreview = gitLog.trim().length > 0
    ? gitLog.split("\n").slice(0, 5)
    : ["(no recent git history sample available)"];

  const lines = [
    "What broke",
    `- Component: ${event.component}`,
    `- Action: ${event.action}`,
    `- Error: ${event.error ?? "operation_failed"}`,
    `- Timestamp: ${new Date(event.timestamp).toISOString()}`,
    `- Event ID: ${event.id}`,
    `- Dedup key: ${dedupKey(event)}`,
    "",
    "Impact",
    `- ${inferImpact(event)}`,
    "",
    "Haiku classification (suspects)",
    `- ${reasoning}`,
    "",
    "Candidate files",
  ];

  for (const file of candidateList) {
    lines.push(`- ${file}`);
  }

  lines.push("");
  lines.push("Recent git log (sample)");
  for (const entry of gitPreview) {
    lines.push(`- ${entry}`);
  }
  lines.push("");
  lines.push("Investigation status");
  lines.push("- Codex investigation dispatched — task will be updated with findings.");

  return lines.join("\n");
}

function buildCodexRequestId(event: OtelEvent, taskId: string): string {
  const eventId = event.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
  const todoistId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-16);
  return `o11y-tier3-${eventId}-${todoistId}-${Date.now()}`;
}

function buildCodexInvestigationTask(
  event: OtelEvent,
  taskId: string,
  llmReasoning: string | undefined,
  candidateFiles: string[],
  gitLog: string
): string {
  const reasoning = llmReasoning && llmReasoning.trim().length > 0
    ? llmReasoning.trim()
    : "No additional classification reasoning returned by Haiku.";
  const candidateFileList = candidateFiles.length > 0 ? candidateFiles.join(", ") : "none detected";
  const gitTarget = candidateFiles.length > 0
    ? candidateFiles.map((file) => shellQuote(file)).join(" ")
    : "packages/system-bus/src";
  const gitPreview = gitLog.trim().length > 0
    ? gitLog.split("\n").slice(0, 8).join("\n")
    : "(no recent git history sample available)";

  return [
    `Investigate o11y failure and update Todoist task ${taskId}.`,
    "",
    "## Failure Details",
    `Component: ${event.component}`,
    `Action: ${event.action}`,
    `Error: ${event.error ?? "operation_failed"}`,
    `Level: ${event.level}`,
    `Haiku's analysis: ${reasoning}`,
    `Candidate files: ${candidateFileList}`,
    "",
    "Recent git log sample:",
    "```",
    gitPreview,
    "```",
    "",
    "## Instructions",
    "1. Read the candidate source files",
    `2. Check git log for recent changes: git log --oneline -10 -- ${gitTarget}`,
    "3. Determine the root cause",
    "4. Write a fix (or describe the fix precisely)",
    "5. Update the Todoist task with your findings:",
    `   todoist-cli update ${taskId} --description "..."`,
    "   Include: root cause, proposed fix with file paths, codex prompt to apply the fix, rollback plan",
    "6. If you can fix it directly and it's safe, fix it, commit, and mark the task complete:",
    `   todoist-cli complete ${taskId}`,
  ].join("\n");
}

function parseTodoistTaskResult(raw: string): TodoistTaskResult {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const payload = parsed.result && typeof parsed.result === "object"
      ? (parsed.result as Record<string, unknown>)
      : parsed;
    return {
      id: payload.id != null ? String(payload.id) : undefined,
      url: typeof payload.url === "string" ? payload.url : undefined,
    };
  } catch {
    return {};
  }
}

function createTodoistEscalationTask(event: OtelEvent, description: string): TodoistTaskResult {
  const title = buildTaskTitle(event);
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
  const result = runCommand(command, 15_000);
  if (!result.ok) return {};
  return parseTodoistTaskResult(result.stdout);
}

function updateTodoistTaskDescription(taskId: string, description: string): boolean {
  const args = ["update", taskId, "--description", description];
  const command = `todoist-cli ${args.map(shellQuote).join(" ")}`;
  const result = runCommand(command, 15_000);
  if (!result.ok) return false;

  if (!result.stdout) return true;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (parsed.ok === false) return false;
    return true;
  } catch {
    return true;
  }
}

function buildTelegramText(
  event: OtelEvent,
  taskUrl: string | undefined,
  codexDispatched: boolean,
  codexDispatchError?: string
): string {
  const summary = summarizeIssue(event);
  const impact = inferImpact(event);
  return [
    `O11y triage escalation: ${summary}`,
    `Impact: ${impact}`,
    taskUrl ? `Task: ${taskUrl}` : "Task created in Agent Work.",
    codexDispatched
      ? "Codex investigation dispatched."
      : `Codex dispatch failed: ${compact(codexDispatchError ?? "unknown_error", 180)}`,
  ].join("\n");
}

function collectCandidateFiles(event: OtelEvent): string[] {
  const candidates = new Set<string>();
  const terms = [event.component, event.action]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  for (const term of terms) {
    const command = [
      "rg",
      "-F",
      "-l",
      shellQuote(term),
      "packages/system-bus/src",
      "packages/cli/src",
      "apps/web/app/api",
      "2>/dev/null",
      "|",
      "head -n 10",
    ].join(" ");

    const result = runCommand(command, 8_000);
    if (!result.ok || !result.stdout) continue;
    for (const line of result.stdout.split("\n")) {
      const file = line.trim();
      if (file.length === 0) continue;
      candidates.add(file);
      if (candidates.size >= 10) break;
    }
    if (candidates.size >= 10) break;
  }

  return [...candidates].slice(0, 10);
}

function collectGitLog(candidateFiles: string[]): string {
  const target = candidateFiles.length > 0
    ? candidateFiles.map(shellQuote).join(" ")
    : "packages/system-bus/src";
  const command = `git log -n 12 --date=iso --pretty=format:'%h %ad %an %s' -- ${target}`;
  const result = runCommand(command, 10_000);
  return result.ok ? result.stdout : "";
}

function mergeReclassifiedBuckets(
  initial: Awaited<ReturnType<typeof triageFailures>>,
  reclassified: ClassifiedEvent[]
): {
  tier1: OtelEvent[];
  tier2: OtelEvent[];
  tier3: OtelEvent[];
} {
  const unknownKeys = new Set(initial.unmatchedTier2.map((event) => dedupKey(event)));
  const tier1 = [...initial.tier1];
  const tier2 = initial.tier2.filter((event) => !unknownKeys.has(dedupKey(event)));
  const tier3 = [...initial.tier3];

  for (const classified of reclassified) {
    if (classified.tier === 1) tier1.push(classified.event);
    if (classified.tier === 2) tier2.push(classified.event);
    if (classified.tier === 3) tier3.push(classified.event);
  }

  return { tier1, tier2, tier3 };
}

export const o11yTriage = inngest.createFunction(
  { id: "check/o11y-triage", concurrency: { limit: 1 }, retries: 1 },
  [{ cron: "TZ=America/Los_Angeles */15 * * * *" }],
  async ({ step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;

    const events = await step.run("scan", async () => scanRecentFailures(15));

    const triaged = await step.run("classify", async () => triageFailures(events));

    const reclassifiedUnknowns = await step.run(
      "classify-unknown-tier2-with-llm",
      async () => classifyWithLLM(triaged.unmatchedTier2)
    );

    const finalBuckets = mergeReclassifiedBuckets(triaged, reclassifiedUnknowns);
    const reclassifiedByDedupKey = new Map<string, ClassifiedEvent>(
      reclassifiedUnknowns.map((classified) => [dedupKey(classified.event), classified])
    );

    await step.run("emit-llm-reclass-summary", async () => {
      const tier1 = reclassifiedUnknowns.filter((item) => item.tier === 1).length;
      const tier2 = reclassifiedUnknowns.filter((item) => item.tier === 2).length;
      const tier3 = reclassifiedUnknowns.filter((item) => item.tier === 3).length;
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "o11y-triage",
        action: "triage.llm_resorted",
        success: true,
        metadata: {
          unknownCount: triaged.unmatchedTier2.length,
          reclassified: reclassifiedUnknowns.length,
          promotedToTier1: tier1,
          remainedTier2: tier2,
          promotedToTier3: tier3,
          finalTier1: finalBuckets.tier1.length,
          finalTier2: finalBuckets.tier2.length,
          finalTier3: finalBuckets.tier3.length,
        },
      });
      return {
        unknownCount: triaged.unmatchedTier2.length,
        reclassified: reclassifiedUnknowns.length,
        promotedToTier1: tier1,
        remainedTier2: tier2,
        promotedToTier3: tier3,
      };
    });

    await step.run("emit-pattern-proposals", async () => {
      const proposed = reclassifiedUnknowns.filter((item) => item.proposed_pattern != null);
      if (proposed.length === 0) {
        return { queued: false, count: 0 };
      }

      await inngest.send({
        name: "session/observation.noted",
        data: {
          observations: proposed.map((item) => ({
            category: TRIAGE_PATTERN_PROPOSAL_CATEGORY,
            summary: `Pattern proposal for ${item.event.component}.${item.event.action} -> tier ${item.proposed_pattern?.tier ?? item.tier}`,
            metadata: {
              eventId: item.event.id,
              dedupKey: dedupKey(item.event),
              reasoning: item.reasoning,
              proposedPattern: item.proposed_pattern,
              error: item.event.error ?? null,
            },
          })),
        },
      });

      return { queued: true, count: proposed.length };
    });

    await step.run("handle-tier1", async () => {
      for (const event of finalBuckets.tier1) {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "o11y-triage",
          action: "auto_fix.applied",
          success: true,
          metadata: {
            phase: "phase-1.5",
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
      return { handled: finalBuckets.tier1.length };
    });

    await step.run("handle-tier2", async () => {
      if (finalBuckets.tier2.length === 0) {
        return { handled: 0, queuedObservation: false };
      }

      await inngest.send({
        name: "session/observation.noted",
        data: {
          observations: finalBuckets.tier2.map((event) => {
            const llm = reclassifiedByDedupKey.get(dedupKey(event));
            return {
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
                llmReasoning: llm?.reasoning ?? null,
              },
            };
          }),
        },
      });

      return { handled: finalBuckets.tier2.length, queuedObservation: true };
    });

    await step.run("handle-tier3", async () => {
      for (const event of finalBuckets.tier3) {
        const llmReasoning = reclassifiedByDedupKey.get(dedupKey(event))?.reasoning;
        const candidateFiles = collectCandidateFiles(event);
        const gitLog = collectGitLog(candidateFiles);
        const preliminaryDescription = buildPreliminaryTaskDescription(
          event,
          llmReasoning,
          candidateFiles,
          gitLog
        );
        const task = createTodoistEscalationTask(event, preliminaryDescription);
        const taskId = task.id;
        const taskUrl = task.url;

        let codexDispatched = false;
        let codexRequestId: string | undefined;
        let codexDispatchError: string | undefined;

        if (taskId) {
          codexRequestId = buildCodexRequestId(event, taskId);
          const codexTask = buildCodexInvestigationTask(
            event,
            taskId,
            llmReasoning,
            candidateFiles,
            gitLog
          );

          try {
            await inngest.send({
              name: "system/agent.requested",
              data: {
                requestId: codexRequestId,
                task: codexTask,
                tool: "codex",
                cwd: ESCALATION_CODEX_CWD,
                model: ESCALATION_CODEX_MODEL,
                sandbox: "workspace-write",
              },
            });
            codexDispatched = true;
          } catch (error) {
            codexDispatchError = error instanceof Error ? error.message : String(error);
            const failureDescription = [
              preliminaryDescription,
              "",
              "Dispatch status",
              `- Codex dispatch failed: ${compact(codexDispatchError, 220)}`,
              "- Re-dispatch manually after system/agent.requested is healthy.",
            ].join("\n");
            updateTodoistTaskDescription(taskId, failureDescription);
          }
        } else {
          codexDispatchError = "Todoist task creation failed to return a task ID; codex dispatch skipped.";
        }

        const text = buildTelegramText(event, taskUrl, codexDispatched, codexDispatchError);
        if (gateway) {
          await gateway.alert(text, {
            channel: "telegram",
            taskId: taskId ?? null,
            taskUrl: taskUrl ?? null,
            dedupKey: dedupKey(event),
          });
        } else {
          await pushGatewayEvent({
            type: "alert",
            source: "inngest/check/o11y-triage",
            payload: {
              message: text,
              channel: "telegram",
              taskId: taskId ?? null,
              taskUrl: taskUrl ?? null,
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
            llmReasoning: llmReasoning ?? null,
            taskId: taskId ?? null,
            taskUrl: taskUrl ?? null,
            candidateFiles,
            gitLogSample: gitLog.trim().length > 0
              ? gitLog.split("\n").slice(0, 3)
              : [],
            codexDispatched,
            codexRequestId: codexRequestId ?? null,
            codexDispatchError: codexDispatchError ?? null,
            dedupKey: dedupKey(event),
          },
        });
      }
      return { handled: finalBuckets.tier3.length };
    });

    return {
      scanned: events.length,
      tier1: finalBuckets.tier1.length,
      tier2: finalBuckets.tier2.length,
      tier3: finalBuckets.tier3.length,
      unknownTier2: triaged.unmatchedTier2.length,
      llmReclassified: reclassifiedUnknowns.length,
    };
  }
);
