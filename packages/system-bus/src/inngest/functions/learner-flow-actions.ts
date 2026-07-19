import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MESSAGE_ACTION_REQUESTED,
  MessageActionRequestedEvent,
  type MessageActionRequestedEventType,
} from "@joelclaw/message-contract";
import {
  clickHouseClientLayer,
  messageJournalQueryLayer,
  resolveMessageJournalConnection,
  traceMessage,
} from "@joelclaw/message-journal";
import { Effect, Layer, Schema } from "effect";
import { NonRetriableError } from "inngest";
import { getRedisClient } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const AIH_SUPPORT_ROOT =
  process.env.AIH_SUPPORT_ROOT?.trim() || "/Users/joel/Code/badass-courses/aihero-support";
const PULSE_LOG_PATH = join(AIH_SUPPORT_ROOT, ".brain/data/campaign-pulse/pulse-log.jsonl");
const DAILY_FLOW_RUNBOOK = join(
  AIH_SUPPORT_ROOT,
  ".brain/projects/learner-flow-ops/asset-daily-flow-agent-runbook.svx",
);
const INVESTIGATOR_RUNBOOK = join(
  AIH_SUPPORT_ROOT,
  ".brain/projects/campaign-pulse/asset-pulse-investigator-runbook.svx",
);

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ActionDeclaration {
  readonly correlationId: string;
  readonly actionIds: readonly string[];
}

interface LearnerFlowActionDependencies {
  readonly logPath: string;
  readonly cwd: string;
  readonly runCommand: (args: readonly string[], cwd: string) => Promise<CommandResult>;
  readonly resolveDeclaration: (flowId: string) => Promise<ActionDeclaration | undefined>;
  readonly emit: (input: Parameters<typeof emitOtelEvent>[0]) => Promise<unknown>;
  readonly now: () => Date;
}

type ActionData = MessageActionRequestedEventType["data"];

async function runCommand(args: readonly string[], cwd: string): Promise<CommandResult> {
  const captureDir = await mkdtemp(join(tmpdir(), "learner-flow-action-"));
  const stdoutPath = join(captureDir, "stdout.txt");
  const stderrPath = join(captureDir, "stderr.txt");
  try {
    const proc = Bun.spawn([...args], {
      cwd,
      env: process.env,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8").catch(() => ""),
      readFile(stderrPath, "utf8").catch(() => ""),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandJson(result: CommandResult, label: string): Record<string, unknown> {
  if (result.exitCode !== 0) {
    throw new Error(`${label} exited ${result.exitCode}: ${result.stderr || "no stderr"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned non-JSON output`);
  }
  if (!isRecord(parsed) || parsed.ok !== true) {
    throw new Error(`${label} did not return ok: true`);
  }
  return parsed;
}

function scheduleId(value: Record<string, unknown>): string | undefined {
  const result = value.result;
  if (!isRecord(result) || !isRecord(result.schedule)) return undefined;
  return typeof result.schedule.scheduleId === "string" ? result.schedule.scheduleId : undefined;
}

function eventId(value: Record<string, unknown>): string | undefined {
  const result = value.result;
  return isRecord(result) && typeof result.eventId === "string" ? result.eventId : undefined;
}

function terminalReceiptConfirmed(value: Record<string, unknown>): boolean {
  const result = value.result;
  return isRecord(result)
    && result.deliveryState === "confirmed"
    && typeof result.platformMessageId === "string"
    && result.platformMessageId.length > 0;
}

function scheduleIsListed(value: Record<string, unknown>, expectedId: string): boolean {
  const result = value.result;
  if (!isRecord(result) || !Array.isArray(result.schedules)) return false;
  return result.schedules.some((entry) =>
    isRecord(entry) && entry.scheduleId === expectedId
  );
}

function decodeDeclaration(value: unknown): ActionDeclaration | undefined {
  if (!isRecord(value) || typeof value.correlationId !== "string") return undefined;
  if (!Array.isArray(value.declaredActions)) return undefined;
  const actionIds = value.declaredActions.flatMap((entry) => {
    const action = isRecord(entry) ? entry : undefined;
    return typeof action?.id === "string" ? [action.id] : [];
  });
  return actionIds.length > 0
    ? { correlationId: value.correlationId, actionIds }
    : undefined;
}

async function resolveDeclaration(flowId: string): Promise<ActionDeclaration | undefined> {
  const redisValue = await getRedisClient().get(
    `joelclaw:message-contract:actions:${flowId}`,
  ).catch(() => null);
  if (redisValue) {
    try {
      const declaration = decodeDeclaration(JSON.parse(redisValue));
      if (declaration) return declaration;
    } catch {
      // Fall through to the canonical private journal.
    }
  }

  const connection = await Effect.runPromise(resolveMessageJournalConnection("reader"));
  const queryLayer = messageJournalQueryLayer(connection).pipe(
    Layer.provide(clickHouseClientLayer(connection)),
  );
  const trace = await Effect.runPromise(
    traceMessage(flowId).pipe(Effect.provide(queryLayer)),
  );
  if (trace.kind !== "trace") return undefined;
  for (const row of [...trace.events].reverse()) {
    if (row.event_type !== "message.outbound.confirmed") continue;
    try {
      const declaration = decodeDeclaration(JSON.parse(row.metadata_json));
      if (declaration) return declaration;
    } catch {
      // Try an older confirmed row if present.
    }
  }
  return undefined;
}

function commonMetadata(action: ActionData): Record<string, unknown> {
  return {
    flowId: action.flowId,
    rawEventId: action.rawEventId,
    platform: action.platform,
    actionId: action.actionId,
  };
}

export function learnerFlowReceiptEventId(action: ActionData): string {
  const hex = createHash("sha256")
    .update(`learner-flow-action:${action.rawEventId}:${action.actionId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function appendPulseAckOnce(
  dependencies: LearnerFlowActionDependencies,
  action: ActionData,
): Promise<boolean> {
  const current = await readFile(dependencies.logPath, "utf8").catch(() => "");
  const duplicate = current.split("\n").some((line) => {
    if (!line.trim()) return false;
    try {
      const row = JSON.parse(line) as { rawEventId?: unknown };
      return row.rawEventId === action.rawEventId;
    } catch {
      return false;
    }
  });
  if (duplicate) return false;

  const row = {
    kind: "ack",
    source: MESSAGE_ACTION_REQUESTED,
    flowId: action.flowId,
    actionId: action.actionId,
    at: action.at,
    handledAt: dependencies.now().toISOString(),
    rawEventId: action.rawEventId,
  };
  await mkdir(dirname(dependencies.logPath), { recursive: true });
  await appendFile(dependencies.logPath, `${JSON.stringify(row)}\n`, "utf8");
  return true;
}

async function sendReceipt(
  dependencies: LearnerFlowActionDependencies,
  message: string,
  notificationEventId: string,
): Promise<void> {
  const sendResult = commandJson(
    await dependencies.runCommand(
      [
        "joelclaw",
        "notify",
        "send",
        "--kind",
        "alert",
        "--priority",
        "high",
        "--source",
        "learner-flow-action",
        "--event-id",
        notificationEventId,
        message,
      ],
      dependencies.cwd,
    ),
    "joelclaw notify send",
  );
  if (eventId(sendResult) !== notificationEventId) {
    throw new Error("joelclaw notify send returned the wrong eventId");
  }
}

async function verifyReceipt(
  dependencies: LearnerFlowActionDependencies,
  action: ActionData,
  notificationEventId: string,
): Promise<void> {
  const waitResult = commandJson(
    await dependencies.runCommand(
      [
        "joelclaw",
        "notify",
        "wait",
        notificationEventId,
        "--source",
        "learner-flow-action",
        "--timeout",
        "15s",
      ],
      dependencies.cwd,
    ),
    "joelclaw notify wait",
  );
  if (!terminalReceiptConfirmed(waitResult)) {
    throw new Error("joelclaw notify wait did not confirm a platform message");
  }
  await dependencies.emit({
    level: "info",
    source: "worker",
    component: "learner-flow-action",
    action: "learner_flow.action.receipt_confirmed",
    success: true,
    metadata: { ...commonMetadata(action), notificationEventId },
  });
}

async function createSchedule(
  dependencies: LearnerFlowActionDependencies,
  input: { readonly brief: string; readonly prompt: string; readonly label: string },
): Promise<string> {
  const scheduled = commandJson(
    await dependencies.runCommand(
      [
        "joelclaw",
        "wake",
        "in",
        "1m",
        "--verb",
        "spawn",
        "--brief",
        input.brief,
        "--prompt",
        input.prompt,
        "--format",
        "json",
      ],
      dependencies.cwd,
    ),
    `joelclaw wake (${input.label})`,
  );
  const id = scheduleId(scheduled);
  if (!id) throw new Error(`joelclaw wake (${input.label}) returned no scheduleId`);
  return id;
}

async function verifySchedule(
  dependencies: LearnerFlowActionDependencies,
  action: ActionData,
  id: string,
  label: string,
): Promise<void> {
  const list = commandJson(
    await dependencies.runCommand(
      ["joelclaw", "wake", "list", "--format", "json"],
      dependencies.cwd,
    ),
    "joelclaw wake list",
  );
  if (!scheduleIsListed(list, id)) {
    throw new Error(`joelclaw wake list did not confirm schedule ${id}`);
  }
  await dependencies.emit({
    level: "info",
    source: "worker",
    component: "learner-flow-action",
    action: "learner_flow.action.spawn_confirmed",
    success: true,
    metadata: { ...commonMetadata(action), spawnKind: label, scheduleId: id },
  });
}

const defaults: LearnerFlowActionDependencies = {
  logPath: PULSE_LOG_PATH,
  cwd: AIH_SUPPORT_ROOT,
  runCommand,
  resolveDeclaration,
  emit: emitOtelEvent,
  now: () => new Date(),
};

export function createLearnerFlowActionFunction(
  overrides: Partial<LearnerFlowActionDependencies> = {},
) {
  const dependencies = { ...defaults, ...overrides };
  return inngest.createFunction(
    {
      id: "learner-flow/action",
      name: "Learner Flow Action",
      idempotency: "event.data.rawEventId",
      concurrency: { limit: 1, key: '"learner-flow-action"' },
    },
    { event: MESSAGE_ACTION_REQUESTED },
    async ({ event, step }) => {
      let action: ActionData;
      try {
        action = Schema.decodeUnknownSync(MessageActionRequestedEvent)({
          name: MESSAGE_ACTION_REQUESTED,
          data: event.data,
        }).data;
      } catch (error) {
        throw new NonRetriableError(
          error instanceof Error ? error.message : "Invalid message action request",
        );
      }

      const declaration = await step.run("verify-declared-action", async () => {
        const resolved = await dependencies.resolveDeclaration(action.flowId);
        const declared = resolved?.actionIds.includes(action.actionId) === true;
        await dependencies.emit({
          level: declared ? "info" : "warn",
          source: "worker",
          component: "learner-flow-action",
          action: declared
            ? "learner_flow.action.declaration_verified"
            : "learner_flow.action.rejected",
          success: declared,
          metadata: {
            ...commonMetadata(action),
            ...(declared ? {} : { reason: "action-not-declared" }),
          },
        });
        return resolved && declared ? resolved : undefined;
      });
      if (!declaration) {
        throw new NonRetriableError(
          `Action ${action.actionId} was not declared for ${action.flowId}`,
        );
      }

      if (action.actionId === "learner-flow.ack") {
        const recorded = declaration.correlationId.startsWith("campaign-pulse:")
          ? await step.run("append-pulse-ack", () =>
              appendPulseAckOnce(dependencies, action),
            )
          : false;
        await step.run("record-ack-completion", () =>
          dependencies.emit({
            level: "info",
            source: "worker",
            component: "learner-flow-action",
            action: "learner_flow.action.acknowledged",
            success: true,
            metadata: { ...commonMetadata(action), recorded },
          }),
        );
        return { status: "acknowledged", flowId: action.flowId, recorded };
      }

      if (action.actionId === "learner-flow.run") {
        const id = await step.run("create-flow-agent-schedule", () =>
          createSchedule(dependencies, {
            brief: DAILY_FLOW_RUNBOOK,
            label: "daily-flow-agent",
            prompt:
              "Run the Daily Flow Agent runbook now. Joel requested an early run. Use live evidence and the approved action envelope, send one DM, file the dated receipt, rotate memory if needed, and verify without duplicating the existing successor schedule.",
          }),
        );
        await step.run("verify-flow-agent-schedule", () =>
          verifySchedule(dependencies, action, id, "daily-flow-agent"),
        );
        const notificationEventId = learnerFlowReceiptEventId(action);
        await step.run("send-flow-agent-receipt", () =>
          sendReceipt(dependencies, "Flow agent spawning.", notificationEventId),
        );
        await step.run("verify-flow-agent-receipt", () =>
          verifyReceipt(dependencies, action, notificationEventId),
        );
        return {
          status: "scheduled",
          kind: "flow-agent",
          scheduleId: id,
          flowId: action.flowId,
        };
      }

      const id = await step.run("create-investigator-schedule", () =>
        createSchedule(dependencies, {
          brief: INVESTIGATOR_RUNBOOK,
          label: "pulse-investigator",
          prompt:
            "Run the Campaign Pulse investigator runbook for the latest persisted pulse. Read only the named diagnostics, make no fixes, and DM the aggregate findings.",
        }),
      );
      await step.run("verify-investigator-schedule", () =>
        verifySchedule(dependencies, action, id, "pulse-investigator"),
      );
      const notificationEventId = learnerFlowReceiptEventId(action);
      await step.run("send-investigator-receipt", () =>
        sendReceipt(
          dependencies,
          "Investigator spawning. It will DM findings.",
          notificationEventId,
        ),
      );
      await step.run("verify-investigator-receipt", () =>
        verifyReceipt(dependencies, action, notificationEventId),
      );
      return {
        status: "scheduled",
        kind: "investigate",
        scheduleId: id,
        flowId: action.flowId,
      };
    },
  );
}

export const learnerFlowAction = createLearnerFlowActionFunction();
