import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createMessageEventLogClient,
  type MessageEventTraceResult,
} from "@joelclaw/message-event-log";
import {
  clickHouseClientLayer,
  messageJournalQueryLayer,
  resolveMessageJournalConnection,
  traceMessage,
} from "@joelclaw/message-journal";
import { Effect, Layer } from "effect";
import Redis from "ioredis";

import { DEFAULT_HEARTBEAT_KEY } from "./driver";
import {
  KILL_DRILL_SOURCE,
  type KillDrillPorts,
  type NotificationReceipt,
  type PlatformDeliveryReceipt,
} from "./kill-test";

export const WEEKLY_KILL_DRILL_BRIEF_PATH =
  ".brain/tasks/agent-comms-gateway-weekly-kill-drill.svx" as const;
export const WEEKLY_KILL_DRILL_MARKER = "[weekly-kill-drill]" as const;

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export type LiveKillDrillOptions = {
  agentTarget: string;
  successorBriefPath: string;
  redisUrl?: string;
  heartbeatKey?: string;
  receiptPath?: string;
  restartDelay?: string;
};

async function command(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseEnvelope(raw: string): Record<string, unknown> {
  const parsed = object(JSON.parse(raw));
  if (!parsed) throw new Error("command did not return a JSON object");
  if (parsed.ok === false) throw new Error(`command returned ok=false: ${raw}`);
  return parsed;
}

function findString(value: unknown, key: string): string | undefined {
  const record = object(value);
  if (record) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    for (const child of Object.values(record)) {
      const found = findString(child, key);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findString(child, key);
      if (found) return found;
    }
  }
  return undefined;
}

function containsSchedule(value: unknown, scheduleId: string): boolean {
  if (typeof value === "string") return value === scheduleId || value.includes(scheduleId);
  if (Array.isArray(value)) return value.some((item) => containsSchedule(item, scheduleId));
  const record = object(value);
  return record ? Object.values(record).some((item) => containsSchedule(item, scheduleId)) : false;
}

function findWeeklySchedule(value: unknown, briefPath: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWeeklySchedule(item, briefPath);
      if (found) return found;
    }
    return undefined;
  }
  const record = object(value);
  if (!record) return undefined;
  if (
    record.verb === "spawn"
    && record.briefPath === briefPath
    && typeof record.prompt === "string"
    && record.prompt.includes(WEEKLY_KILL_DRILL_MARKER)
  ) {
    return record;
  }
  for (const item of Object.values(record)) {
    const found = findWeeklySchedule(item, briefPath);
    if (found) return found;
  }
  return undefined;
}

async function resolvePaneId(runCommand: CommandRunner, target: string): Promise<string> {
  if (/^w[^:]+:p[^:]+$/u.test(target)) return target;
  const result = await runCommand(["herdr", "agent", "get", target]);
  const paneId = findString(parseEnvelope(result.stdout), "pane_id");
  if (!paneId) throw new Error(`Herdr agent ${target} has no pane_id`);
  return paneId;
}

export async function scheduleWeeklyKillDrill(
  repoRoot: string,
  runCommand: CommandRunner = command,
  delay = "7d",
): Promise<{ scheduleId: string; briefPath: string; at?: string }> {
  const briefPath = `${repoRoot.replace(/\/+$/u, "")}/${WEEKLY_KILL_DRILL_BRIEF_PATH}`;
  const before = parseEnvelope((await runCommand([
    "joelclaw",
    "wake",
    "list",
    "--format",
    "json",
  ])).stdout);
  const existing = findWeeklySchedule(before, briefPath);
  const existingScheduleId = existing ? findString(existing, "scheduleId") : undefined;
  if (existing && existingScheduleId) {
    return {
      scheduleId: existingScheduleId,
      briefPath,
      ...(typeof existing.at === "string" ? { at: existing.at } : {}),
    };
  }

  const created = parseEnvelope((await runCommand([
    "joelclaw",
    "wake",
    "in",
    delay,
    "--verb",
    "spawn",
    "--brief",
    briefPath,
    "--prompt",
    `${WEEKLY_KILL_DRILL_MARKER} Run the real weekly kill drill, then arm its successor only after all eight assertions pass.`,
    "--format",
    "json",
  ])).stdout);
  const scheduleId = findString(created, "scheduleId");
  if (!scheduleId) throw new Error("wake registry accepted no scheduleId");

  try {
    const listed = parseEnvelope((await runCommand([
      "joelclaw",
      "wake",
      "list",
      "--format",
      "json",
    ])).stdout);
    if (!containsSchedule(listed, scheduleId)) {
      throw new Error(`wake registry readback did not contain ${scheduleId}`);
    }
  } catch (error) {
    try {
      parseEnvelope((await runCommand([
        "joelclaw",
        "wake",
        "cancel",
        scheduleId,
        "--format",
        "json",
      ])).stdout);
      const afterCancel = parseEnvelope((await runCommand([
        "joelclaw",
        "wake",
        "list",
        "--format",
        "json",
      ])).stdout);
      if (containsSchedule(afterCancel, scheduleId)) {
        throw new Error(`wake registry still contains ${scheduleId} after cancellation`);
      }
    } catch (cancelError) {
      throw new Error(
        `weekly schedule ${scheduleId} could not be verified or cancelled: ${String(cancelError)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    scheduleId,
    briefPath,
    ...(findString(created, "at") ? { at: findString(created, "at") } : {}),
  };
}

export function makeKillDrillReceiptRecorder(path: string) {
  return async (receipt: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(receipt)}\n`, "utf8");
  };
}

async function traceJournal(flowId: string): Promise<PlatformDeliveryReceipt[]> {
  const connection = await Effect.runPromise(resolveMessageJournalConnection("reader"));
  const queryLayer = messageJournalQueryLayer(connection).pipe(
    Layer.provide(clickHouseClientLayer(connection)),
  );
  const result = await Effect.runPromise(traceMessage(flowId).pipe(Effect.provide(queryLayer)));
  if (result.kind !== "trace") return [];
  return result.events.map((event) => ({
    flowId: event.flow_id,
    platform: event.channel,
    platformMessageId: String(event.telegram_message_id || ""),
    eventType: event.event_type,
    deliveryState: event.delivery_state,
    transportText: event.transport_text,
  }));
}

function notificationReceipt(raw: string, requestedEventId: string): NotificationReceipt {
  const envelope = parseEnvelope(raw);
  const flowId = findString(envelope, "flowId") ?? `notify:${requestedEventId}`;
  const eventId = findString(envelope, "eventId") ?? requestedEventId;
  return { flowId, eventId };
}

export function makeLiveKillDrillPorts(
  options: LiveKillDrillOptions,
  dependencies: {
    runCommand?: CommandRunner;
    stream?: ReturnType<typeof createMessageEventLogClient>;
    redis?: Redis;
  } = {},
): KillDrillPorts & { close: () => Promise<void> } {
  const runCommand = dependencies.runCommand ?? command;
  const stream = dependencies.stream ?? createMessageEventLogClient();
  const redis = dependencies.redis ?? new Redis(
    options.redisUrl ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    { lazyConnect: true, maxRetriesPerRequest: 1 },
  );
  const heartbeatKey = options.heartbeatKey ?? DEFAULT_HEARTBEAT_KEY;

  const ensureRedis = async () => {
    if (redis.status === "wait") await redis.connect();
  };

  return {
    now: Date.now,
    wait: (milliseconds) => Bun.sleep(milliseconds),
    stopAgent: async () => {
      const paneId = await resolvePaneId(runCommand, options.agentTarget);
      const result = parseEnvelope((await runCommand(["herdr", "pane", "close", paneId])).stdout);
      return { paneId, herdr: result };
    },
    heartbeatExists: async () => {
      await ensureRedis();
      return (await redis.exists(heartbeatKey)) === 1;
    },
    sendAlert: async (text, eventId) => {
      const result = await runCommand([
        "joelclaw",
        "notify",
        "send",
        text,
        "--kind",
        "alert",
        "--source",
        KILL_DRILL_SOURCE,
        "--event-id",
        eventId,
      ]);
      return notificationReceipt(result.stdout, eventId);
    },
    traceStream: (flowId): Promise<MessageEventTraceResult> => stream.trace(flowId),
    tracePlatform: traceJournal,
    restartAgent: async () => {
      const result = parseEnvelope((await runCommand([
        "joelclaw",
        "wake",
        "in",
        options.restartDelay ?? "1s",
        "--verb",
        "spawn",
        "--brief",
        options.successorBriefPath,
        "--prompt",
        "[kill-drill-restart] Restart the gateway from authoritative stream replay after the supervised kill drill.",
        "--format",
        "json",
      ])).stdout);
      const scheduleId = findString(result, "scheduleId");
      if (!scheduleId) throw new Error("gateway restart SPAWN returned no scheduleId");
      return { scheduleId, wake: result };
    },
    recordReceipt: options.receiptPath
      ? makeKillDrillReceiptRecorder(options.receiptPath)
      : undefined,
    close: async () => {
      if (redis.status !== "end") redis.disconnect();
    },
  };
}
