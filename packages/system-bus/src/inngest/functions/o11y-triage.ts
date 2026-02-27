import { execSync } from "node:child_process";
import * as typesense from "../../lib/typesense";
import { prefetchMemoryContext } from "../../memory/context-prefetch";
import { AUTO_FIX_HANDLERS, resolveAutoFixHandlerName } from "../../observability/auto-fixes";
import { emitOtelEvent } from "../../observability/emit";
import type { OtelEvent } from "../../observability/otel-event";
import {
  buildRunbookRecoverCommand,
  type ResolvedRunbookPlan,
  resolveRunbookPlanForEvent,
} from "../../observability/recovery-runbooks";
import {
  type ClassifiedEvent,
  classifyWithLLM,
  scanRecentFailures,
  triageFailures,
} from "../../observability/triage";
import { classifyEvent, dedupKey } from "../../observability/triage-patterns";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { buildGatewaySignalMeta } from "../middleware/gateway-signal";
import { pushGatewayEvent } from "./agent-loop/utils";

const AGENT_WORK_PROJECT_ID = "6g3VPph7cFfm8GjJ";
const TRIAGE_CATEGORY = "o11y-triage";
const TRIAGE_PATTERN_PROPOSAL_CATEGORY = "o11y-pattern-proposal";
const TRIAGE_LABELS = "o11y,escalation";
const ESCALATION_CODEX_MODEL = "gpt-5.3-codex";
const ESCALATION_CODEX_CWD = "/Users/joel/Code/joelhooks/joelclaw";
const OTEL_COLLECTION = "otel_events";
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const TELEGRAM_ESCALATION_MAX_PER_HOUR = 3;
const TELEGRAM_ESCALATION_WINDOW_MS = 60 * 60 * 1000;
const TELEGRAM_SNOOZE_HOURS = 4;
const localTelegramEscalationSentAt: number[] = [];

type TodoistTaskResult = {
  id?: string;
  url?: string;
};

type GatewayInlineButton = {
  text: string;
  action?: string;
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

function resolveRunbookForEvent(
  event: OtelEvent,
  phase: "diagnose" | "fix" | "verify" | "rollback",
  preferredCode?: string
): ResolvedRunbookPlan | null {
  return resolveRunbookPlanForEvent({
    id: event.id,
    component: event.component,
    action: event.action,
    error: event.error,
    metadata: event.metadata,
  }, phase, preferredCode);
}

function runbookRecoverCommand(plan: ResolvedRunbookPlan | null): string | null {
  if (!plan) return null;
  return buildRunbookRecoverCommand(plan);
}

function buildPreliminaryTaskDescription(
  event: OtelEvent,
  llmReasoning: string | undefined,
  candidateFiles: string[],
  gitLog: string,
  runbookPlan: ResolvedRunbookPlan | null
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
  ];

  if (runbookPlan) {
    lines.push("");
    lines.push("Deterministic recovery runbook");
    lines.push(`- Code: ${runbookPlan.code}`);
    lines.push(`- Phase: ${runbookPlan.phase}`);
    lines.push(`- Recover command: ${runbookRecoverCommand(runbookPlan)}`);
    lines.push("- Runbook commands:");
    for (const command of runbookPlan.commands) {
      lines.push(`  - ${command.command}`);
    }
  }

  lines.push("");
  lines.push("Candidate files");
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
  gitLog: string,
  runbookPlan: ResolvedRunbookPlan | null
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
    runbookPlan ? `Runbook code: ${runbookPlan.code}` : "Runbook code: none",
    runbookPlan ? `Recover command: ${runbookRecoverCommand(runbookPlan)}` : "Recover command: n/a",
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

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function pruneLocalTelegramEscalations(now = Date.now()): void {
  const cutoff = now - TELEGRAM_ESCALATION_WINDOW_MS;
  while (localTelegramEscalationSentAt.length > 0 && (localTelegramEscalationSentAt[0] ?? 0) < cutoff) {
    localTelegramEscalationSentAt.shift();
  }
}

function getLocalTelegramEscalationCount(now = Date.now()): number {
  pruneLocalTelegramEscalations(now);
  return localTelegramEscalationSentAt.length;
}

function recordLocalTelegramEscalation(now = Date.now()): void {
  pruneLocalTelegramEscalations(now);
  localTelegramEscalationSentAt.push(now);
}

async function countRecentTelegramEscalations(): Promise<number> {
  const cutoff = Date.now() - TELEGRAM_ESCALATION_WINDOW_MS;
  const localCount = getLocalTelegramEscalationCount();

  try {
    const result = await typesense.search({
      collection: OTEL_COLLECTION,
      q: "*",
      query_by: OTEL_QUERY_BY,
      per_page: 1,
      include_fields: "id",
      filter_by: `timestamp:>=${Math.floor(cutoff)} && component:=\`o11y-triage\` && action:=triage.telegram_sent && success:=true`,
    });
    const remoteCount = typeof result.found === "number" ? result.found : 0;
    return Math.max(remoteCount, localCount);
  } catch {
    return localCount;
  }
}

async function isSnoozedDedupKey(key: string): Promise<boolean> {
  const cutoff = Date.now() - TELEGRAM_SNOOZE_HOURS * 60 * 60 * 1000;

  try {
    const result = await typesense.search({
      collection: OTEL_COLLECTION,
      q: key,
      query_by: OTEL_QUERY_BY,
      per_page: 1,
      include_fields: "id",
      filter_by: `timestamp:>=${Math.floor(cutoff)} && component:=\`o11y-triage\` && action:=triage.snoozed && success:=true`,
    });
    return (result.found ?? 0) > 0;
  } catch {
    return false;
  }
}

function encodeDedupKeyForSnoozeCallback(key: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(key)) return key.slice(0, 40);
  return Buffer.from(key, "hex").toString("base64url");
}

function buildSnoozeCallbackData(key: string): string {
  return `s4h:${encodeDedupKeyForSnoozeCallback(key)}`;
}

function buildTelegramButtons(
  taskUrl: string | undefined,
  key: string
): GatewayInlineButton[][] {
  const rows: GatewayInlineButton[][] = [];
  if (taskUrl) {
    rows.push([{ text: "View Task", url: taskUrl }]);
  }
  rows.push([{ text: "Snooze 4h", action: buildSnoozeCallbackData(key) }]);
  return rows;
}

function buildTelegramText(
  event: OtelEvent,
  llmReasoning: string | undefined,
  runbookPlan: ResolvedRunbookPlan | null
): string {
  const reasoning = llmReasoning?.trim().length
    ? llmReasoning.trim()
    : "No additional classification reasoning returned by Haiku.";

  return [
    "⚠️ <b>O11y Escalation</b>",
    "",
    `<b>Component:</b> ${escapeTelegramHtml(event.component)}`,
    `<b>Action:</b> ${escapeTelegramHtml(event.action)}`,
    `<b>Error:</b> ${escapeTelegramHtml(event.error ?? "operation_failed")}`,
    runbookPlan
      ? `<b>Recover:</b> <code>${escapeTelegramHtml(runbookRecoverCommand(runbookPlan) ?? "")}</code>`
      : "<b>Recover:</b> n/a",
    "",
    `<b>Haiku says:</b> ${escapeTelegramHtml(compact(reasoning, 280))}`,
    "",
    "📋 Task created, codex investigating.",
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
  [
    { cron: "TZ=America/Los_Angeles */15 * * * *" },
    { event: "check/o11y-triage.requested" },
  ],
  async ({ step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;

    const events = await step.run("scan", async () => scanRecentFailures(15));

    const triaged = await step.run("classify", async () => triageFailures(events));
    const historicalFixesContext = await step.run("prefetch-memory", async () => {
      if (triaged.unmatchedTier2.length === 0) return "";
      const query = triaged.unmatchedTier2
        .slice(0, 8)
        .map((item) => [item.component, item.action, item.error ?? ""].filter(Boolean).join(" "))
        .join(" | ");
      const memory = await prefetchMemoryContext(query, { limit: 5 });
      if (!memory) return "";
      return `Previous fixes for similar issues:\n${memory}`;
    });

    const reclassifiedUnknowns = await step.run(
      "classify-unknown-tier2-with-llm",
      async () => classifyWithLLM(triaged.unmatchedTier2, historicalFixesContext)
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

      await step.sendEvent("emit-pattern-observations", {
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

    const tier1Result = await step.run("handle-tier1", async () => {
      const promoted: OtelEvent[] = [];
      const missingHandlerWarnings = new Set<string>();

      for (const event of finalBuckets.tier1) {
        const classified = classifyEvent(event);
        const rawHandlerName = classified.pattern?.handler;
        const handlerName = resolveAutoFixHandlerName(rawHandlerName);
        const handlerDef = handlerName ? AUTO_FIX_HANDLERS[handlerName] : undefined;
        const runbookPlan = handlerDef
          ? resolveRunbookForEvent(event, handlerDef.runbookPhase, handlerDef.runbookCode)
          : null;

        if (!rawHandlerName) {
          promoted.push(event);
          continue;
        }

        if (!handlerDef) {
          const missingHandlerName = String(rawHandlerName);
          const isInternalTriageEvent = event.component === "o11y-triage";
          if (!missingHandlerWarnings.has(missingHandlerName) && !isInternalTriageEvent) {
            missingHandlerWarnings.add(missingHandlerName);
            await emitOtelEvent({
              level: "warn",
              source: "worker",
              component: "o11y-triage",
              action: "triage.auto_fix_handler_missing",
              success: true,
              metadata: {
                handler: missingHandlerName,
                event_action: event.action,
                event_component: event.component,
              },
            });
          }
          promoted.push(event);
          continue;
        }

        let result: { fixed: boolean; detail: string };
        try {
          result = await handlerDef.handler(event);
        } catch (error) {
          result = {
            fixed: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }

        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "o11y-triage",
          action: "auto_fix.applied",
          success: result.fixed,
          error: result.fixed ? undefined : result.detail,
          metadata: {
            handler: handlerName ?? null,
            runbookCode: handlerDef?.runbookCode ?? null,
            runbookPhase: handlerDef?.runbookPhase ?? null,
            recoverCommand: runbookRecoverCommand(runbookPlan),
            runbookCommands: runbookPlan?.commands ?? [],
            event_action: event.action,
            detail: result.detail,
          },
        });

        if (!result.fixed) {
          promoted.push(event);
        }
      }
      return { handled: finalBuckets.tier1.length, promoted };
    });

    const tier2Events: OtelEvent[] = [...finalBuckets.tier2];
    for (const event of tier1Result.promoted) {
      if (!tier2Events.some((candidate) => candidate.id === event.id)) {
        tier2Events.push(event);
      }
    }

    await step.run("handle-tier2", async () => {
      if (tier2Events.length === 0) {
        return { handled: 0, queuedObservation: false };
      }

      await step.sendEvent("emit-tier2-observations", {
        name: "session/observation.noted",
        data: {
          observations: tier2Events.map((event) => {
            const llm = reclassifiedByDedupKey.get(dedupKey(event));
            const tier2Classification = classifyEvent(event);
            const tier2HandlerName = resolveAutoFixHandlerName(tier2Classification.pattern?.handler);
            const tier2HandlerDef = tier2HandlerName ? AUTO_FIX_HANDLERS[tier2HandlerName] : undefined;
            const runbookPlan = resolveRunbookForEvent(
              event,
              "diagnose",
              tier2HandlerDef?.runbookCode
            );

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
                runbookCode: runbookPlan?.code ?? null,
                runbookPhase: runbookPlan?.phase ?? null,
                recoverCommand: runbookRecoverCommand(runbookPlan),
                runbookCommands: runbookPlan?.commands ?? [],
              },
            };
          }),
        },
      });

      return { handled: tier2Events.length, queuedObservation: true };
    });

    await step.run("handle-tier3", async () => {
      let sentTelegramInWindow = await countRecentTelegramEscalations();

      for (const event of finalBuckets.tier3) {
        const eventDedupKey = dedupKey(event);
        const llmReasoning = reclassifiedByDedupKey.get(eventDedupKey)?.reasoning;
        const tier3Classification = classifyEvent(event);
        const tier3HandlerName = resolveAutoFixHandlerName(tier3Classification.pattern?.handler);
        const tier3HandlerDef = tier3HandlerName ? AUTO_FIX_HANDLERS[tier3HandlerName] : undefined;
        const runbookPlan = resolveRunbookForEvent(
          event,
          "diagnose",
          tier3HandlerDef?.runbookCode
        );

        if (await isSnoozedDedupKey(eventDedupKey)) {
          await emitOtelEvent({
            level: "info",
            source: "worker",
            component: "o11y-triage",
            action: "triage.snooze_suppressed",
            success: true,
            metadata: {
              dedupKey: eventDedupKey,
              snoozeHours: TELEGRAM_SNOOZE_HOURS,
              runbookCode: runbookPlan?.code ?? null,
              runbookPhase: runbookPlan?.phase ?? null,
              recoverCommand: runbookRecoverCommand(runbookPlan),
              event: {
                id: event.id,
                component: event.component,
                action: event.action,
                error: event.error ?? null,
                level: event.level,
              },
            },
          });
          continue;
        }

        const candidateFiles = collectCandidateFiles(event);
        const gitLog = collectGitLog(candidateFiles);
        const preliminaryDescription = buildPreliminaryTaskDescription(
          event,
          llmReasoning,
          candidateFiles,
          gitLog,
          runbookPlan
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
            gitLog,
            runbookPlan
          );

          try {
            await step.sendEvent(`dispatch-codex-${eventDedupKey}`, {
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

        const text = buildTelegramText(event, llmReasoning, runbookPlan);
        const buttons = buildTelegramButtons(taskUrl, eventDedupKey);
        const canSendTelegram = sentTelegramInWindow < TELEGRAM_ESCALATION_MAX_PER_HOUR;
        let telegramSent = false;
        let telegramRateLimited = false;

        if (canSendTelegram) {
          const telegramPayload = {
            immediateTelegram: true,
            telegramOnly: true,
            channel: "telegram",
            ...buildGatewaySignalMeta("o11y.triage", "error"),
            taskId: taskId ?? null,
            taskUrl: taskUrl ?? null,
            dedupKey: eventDedupKey,
            runbookCode: runbookPlan?.code ?? null,
            runbookPhase: runbookPlan?.phase ?? null,
            recoverCommand: runbookRecoverCommand(runbookPlan),
            telegramMessage: text,
            telegramFormat: "html" as const,
            telegramButtons: buttons,
          };

          if (gateway) {
            await gateway.alert(text, telegramPayload);
          } else {
            await pushGatewayEvent({
              type: "alert",
              source: "inngest/check/o11y-triage",
              payload: {
                message: text,
                ...telegramPayload,
              },
            });
          }

          telegramSent = true;
          sentTelegramInWindow += 1;
          recordLocalTelegramEscalation();

          await emitOtelEvent({
            level: "info",
            source: "worker",
            component: "o11y-triage",
            action: "triage.telegram_sent",
            success: true,
            metadata: {
              dedupKey: eventDedupKey,
              taskId: taskId ?? null,
              taskUrl: taskUrl ?? null,
              runbookCode: runbookPlan?.code ?? null,
              runbookPhase: runbookPlan?.phase ?? null,
              recoverCommand: runbookRecoverCommand(runbookPlan),
              sentInLastHour: sentTelegramInWindow,
              hourlyCap: TELEGRAM_ESCALATION_MAX_PER_HOUR,
              hasButtons: buttons.length > 0,
            },
          });
        } else {
          telegramRateLimited = true;
          await emitOtelEvent({
            level: "warn",
            source: "worker",
            component: "o11y-triage",
            action: "triage.telegram_rate_limited",
            success: false,
            error: "hourly_limit_reached",
            metadata: {
              dedupKey: eventDedupKey,
              taskId: taskId ?? null,
              taskUrl: taskUrl ?? null,
              runbookCode: runbookPlan?.code ?? null,
              runbookPhase: runbookPlan?.phase ?? null,
              recoverCommand: runbookRecoverCommand(runbookPlan),
              sentInLastHour: sentTelegramInWindow,
              hourlyCap: TELEGRAM_ESCALATION_MAX_PER_HOUR,
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
            runbookCode: runbookPlan?.code ?? null,
            runbookPhase: runbookPlan?.phase ?? null,
            recoverCommand: runbookRecoverCommand(runbookPlan),
            runbookCommands: runbookPlan?.commands ?? [],
            candidateFiles,
            gitLogSample: gitLog.trim().length > 0
              ? gitLog.split("\n").slice(0, 3)
              : [],
            codexDispatched,
            codexRequestId: codexRequestId ?? null,
            codexDispatchError: codexDispatchError ?? null,
            dedupKey: eventDedupKey,
            telegramSent,
            telegramRateLimited,
            telegramButtons: buttons.length > 0,
          },
        });
      }
      return { handled: finalBuckets.tier3.length };
    });

    return {
      scanned: events.length,
      tier1: finalBuckets.tier1.length,
      tier2: tier2Events.length,
      tier3: finalBuckets.tier3.length,
      unknownTier2: triaged.unmatchedTier2.length,
      llmReclassified: reclassifiedUnknowns.length,
    };
  }
);
