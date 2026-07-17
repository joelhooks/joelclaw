import {
  MESSAGE_REACTION_RECEIVED,
  MessageReactionReceivedEvent,
  type MessageReactionReceivedEventType,
} from "@joelclaw/message-contract";
import { mkdir, mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NonRetriableError } from "inngest";
import { Schema } from "effect";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const AIH_SUPPORT_ROOT =
  process.env.AIH_SUPPORT_ROOT?.trim() || "/Users/joel/Code/badass-courses/aihero-support";
const PULSE_STATE_PATH = join(AIH_SUPPORT_ROOT, ".brain/data/campaign-pulse/state.json");
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

interface CampaignPulseReactionDependencies {
  readonly statePath: string;
  readonly logPath: string;
  readonly cwd: string;
  readonly runCommand: (args: readonly string[], cwd: string) => Promise<CommandResult>;
  readonly emit: (input: Parameters<typeof emitOtelEvent>[0]) => Promise<unknown>;
  readonly now: () => Date;
}

interface PulseDmFlow {
  readonly flowId: string;
  readonly sentAt: string;
  readonly kind: string;
  readonly runId?: string;
}

interface PulseDmState {
  readonly dmFlows: readonly PulseDmFlow[];
  readonly lastDmFlowId?: string;
}

type ReactionData = MessageReactionReceivedEventType["data"];
type PulseReaction = "ack" | "flow-agent" | "investigate";

const reactionByEmoji: Readonly<Record<string, PulseReaction>> = {
  "👍": "ack",
  "🔧": "flow-agent",
  "🔎": "investigate",
};

async function runCommand(args: readonly string[], cwd: string): Promise<CommandResult> {
  const captureDir = await mkdtemp(join(tmpdir(), "campaign-pulse-reaction-"));
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

function decodeState(value: unknown): PulseDmState {
  if (!isRecord(value)) throw new Error("Campaign Pulse state is not an object");
  const dmFlows = Array.isArray(value.dmFlows)
    ? value.dmFlows.flatMap((entry): readonly PulseDmFlow[] => {
        if (
          !isRecord(entry) ||
          typeof entry.flowId !== "string" ||
          typeof entry.sentAt !== "string" ||
          typeof entry.kind !== "string"
        ) {
          return [];
        }
        return [
          {
            flowId: entry.flowId,
            sentAt: entry.sentAt,
            kind: entry.kind,
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
          },
        ];
      })
    : [];
  return {
    dmFlows,
    ...(typeof value.lastDmFlowId === "string" ? { lastDmFlowId: value.lastDmFlowId } : {}),
  };
}

function flowBelongsToPulse(state: PulseDmState, flowId: string): boolean {
  return (
    state.lastDmFlowId === flowId ||
    state.dmFlows.some((entry) => entry.kind === "campaign-pulse" && entry.flowId === flowId)
  );
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

function commonMetadata(reaction: ReactionData): Record<string, unknown> {
  return {
    flowId: reaction.flowId,
    rawEventId: reaction.rawEventId,
    platform: reaction.platform,
    emoji: reaction.emoji,
    action: reaction.action,
  };
}

async function queueReceiptDm(
  dependencies: CampaignPulseReactionDependencies,
  reaction: ReactionData,
  message: string,
): Promise<void> {
  try {
    const result = await dependencies.runCommand(
      [
        "joelclaw",
        "notify",
        "send",
        "--priority",
        "high",
        "--source",
        "campaign-pulse-reaction",
        message,
      ],
      dependencies.cwd,
    );
    commandJson(result, "joelclaw notify send");
    await dependencies.emit({
      level: "info",
      source: "worker",
      component: "campaign-pulse-reaction",
      action: "campaign_pulse.reaction.receipt_queued",
      success: true,
      metadata: { ...commonMetadata(reaction), message },
    });
  } catch (error) {
    await dependencies.emit({
      level: "error",
      source: "worker",
      component: "campaign-pulse-reaction",
      action: "campaign_pulse.reaction.receipt_queue_failed",
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: commonMetadata(reaction),
    });
    throw error;
  }
}

async function scheduleSpawn(
  dependencies: CampaignPulseReactionDependencies,
  reaction: ReactionData,
  input: { readonly brief: string; readonly prompt: string; readonly label: string },
): Promise<string> {
  try {
    const result = await dependencies.runCommand(
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
    );
    const parsed = commandJson(result, `joelclaw wake (${input.label})`);
    const id = scheduleId(parsed);
    if (!id) throw new Error(`joelclaw wake (${input.label}) returned no scheduleId`);
    await dependencies.emit({
      level: "info",
      source: "worker",
      component: "campaign-pulse-reaction",
      action: "campaign_pulse.reaction.spawn_scheduled",
      success: true,
      metadata: { ...commonMetadata(reaction), spawnKind: input.label, scheduleId: id },
    });
    return id;
  } catch (error) {
    await dependencies.emit({
      level: "error",
      source: "worker",
      component: "campaign-pulse-reaction",
      action: "campaign_pulse.reaction.spawn_schedule_failed",
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: { ...commonMetadata(reaction), spawnKind: input.label },
    });
    throw error;
  }
}

const defaults: CampaignPulseReactionDependencies = {
  statePath: PULSE_STATE_PATH,
  logPath: PULSE_LOG_PATH,
  cwd: AIH_SUPPORT_ROOT,
  runCommand,
  emit: emitOtelEvent,
  now: () => new Date(),
};

export function createCampaignPulseReactionFunction(
  overrides: Partial<CampaignPulseReactionDependencies> = {},
) {
  const dependencies = { ...defaults, ...overrides };
  return inngest.createFunction(
    {
      id: "campaign-pulse/reaction",
      name: "Campaign Pulse Reaction",
      idempotency: "event.data.rawEventId",
      concurrency: { limit: 1, key: '"campaign-pulse-reaction"' },
    },
    { event: MESSAGE_REACTION_RECEIVED },
    async ({ event, step }) => {
      let reaction: ReactionData;
      try {
        reaction = Schema.decodeUnknownSync(MessageReactionReceivedEvent)({
          name: MESSAGE_REACTION_RECEIVED,
          data: event.data,
        }).data;
      } catch (error) {
        throw new NonRetriableError(
          error instanceof Error ? error.message : "Invalid message reaction event",
        );
      }

      if (reaction.action !== "added") {
        await step.run("emit-removed-reaction-ignored", () =>
          dependencies.emit({
            level: "info",
            source: "worker",
            component: "campaign-pulse-reaction",
            action: "campaign_pulse.reaction.ignored",
            success: true,
            metadata: { ...commonMetadata(reaction), reason: "reaction-removed" },
          }),
        );
        return { status: "ignored", reason: "reaction-removed", flowId: reaction.flowId };
      }

      const requested = reactionByEmoji[reaction.emoji];
      if (!requested) {
        await step.run("emit-unmapped-reaction-ignored", () =>
          dependencies.emit({
            level: "info",
            source: "worker",
            component: "campaign-pulse-reaction",
            action: "campaign_pulse.reaction.ignored",
            success: true,
            metadata: { ...commonMetadata(reaction), reason: "emoji-unmapped" },
          }),
        );
        return { status: "ignored", reason: "emoji-unmapped", flowId: reaction.flowId };
      }

      const belongsToPulse = await step.run("match-pulse-flow", async () => {
        try {
          const state = decodeState(JSON.parse(await readFile(dependencies.statePath, "utf8")));
          const matched = flowBelongsToPulse(state, reaction.flowId);
          await dependencies.emit({
            level: "info",
            source: "worker",
            component: "campaign-pulse-reaction",
            action: matched
              ? "campaign_pulse.reaction.flow_matched"
              : "campaign_pulse.reaction.ignored",
            success: true,
            metadata: {
              ...commonMetadata(reaction),
              matched,
              ...(matched ? {} : { reason: "flow-not-campaign-pulse" }),
            },
          });
          return matched;
        } catch (error) {
          await dependencies.emit({
            level: "error",
            source: "worker",
            component: "campaign-pulse-reaction",
            action: "campaign_pulse.reaction.state_read_failed",
            success: false,
            error: error instanceof Error ? error.message : String(error),
            metadata: commonMetadata(reaction),
          });
          throw error;
        }
      });
      if (!belongsToPulse) {
        return { status: "ignored", reason: "flow-not-campaign-pulse", flowId: reaction.flowId };
      }

      if (requested === "ack") {
        await step.run("append-pulse-ack", async () => {
          try {
            const row = {
              kind: "ack",
              source: MESSAGE_REACTION_RECEIVED,
              flowId: reaction.flowId,
              emoji: reaction.emoji,
              at: reaction.at,
              handledAt: dependencies.now().toISOString(),
              rawEventId: reaction.rawEventId,
            };
            await mkdir(dirname(dependencies.logPath), { recursive: true });
            await appendFile(dependencies.logPath, `${JSON.stringify(row)}\n`, "utf8");
            await dependencies.emit({
              level: "info",
              source: "worker",
              component: "campaign-pulse-reaction",
              action: "campaign_pulse.reaction.acknowledged",
              success: true,
              metadata: commonMetadata(reaction),
            });
          } catch (error) {
            await dependencies.emit({
              level: "error",
              source: "worker",
              component: "campaign-pulse-reaction",
              action: "campaign_pulse.reaction.ack_append_failed",
              success: false,
              error: error instanceof Error ? error.message : String(error),
              metadata: commonMetadata(reaction),
            });
            throw error;
          }
        });
        await step.run("queue-ack-receipt", () =>
          queueReceiptDm(dependencies, reaction, "Seen. Next pulse stays scheduled."),
        );
        return { status: "acknowledged", flowId: reaction.flowId };
      }

      if (requested === "flow-agent") {
        const id = await step.run("schedule-flow-agent", () =>
          scheduleSpawn(dependencies, reaction, {
            brief: DAILY_FLOW_RUNBOOK,
            label: "daily-flow-agent",
            prompt:
              "Run the Daily Flow Agent runbook now. Reaction-triggered early run requested by Joel. Use live evidence and the approved action envelope, send one DM, file the dated receipt, rotate memory if needed, and verify without duplicating the existing successor schedule.",
          }),
        );
        await step.run("queue-flow-agent-receipt", () =>
          queueReceiptDm(dependencies, reaction, "Flow agent spawning."),
        );
        return { status: "scheduled", kind: requested, scheduleId: id, flowId: reaction.flowId };
      }

      const id = await step.run("schedule-investigator", () =>
        scheduleSpawn(dependencies, reaction, {
          brief: INVESTIGATOR_RUNBOOK,
          label: "pulse-investigator",
          prompt:
            "Run the Campaign Pulse investigator runbook for the latest persisted pulse. Read only the named diagnostics, make no fixes, and DM the aggregate findings.",
        }),
      );
      await step.run("queue-investigator-receipt", () =>
        queueReceiptDm(dependencies, reaction, "Investigator spawning, it will DM findings."),
      );
      return { status: "scheduled", kind: requested, scheduleId: id, flowId: reaction.flowId };
    },
  );
}

export const campaignPulseReaction = createCampaignPulseReactionFunction();
