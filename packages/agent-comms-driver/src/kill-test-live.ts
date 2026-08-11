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

import {
  DEFAULT_GATEWAY_HERDR_SESSION,
  scopeHerdrCommand,
} from "./adapters";
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
const DRIVER_LAUNCH_AGENT_LABEL = "com.joelclaw.agent-comms-driver";

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export type LiveKillDrillOptions = {
  agentTarget: string;
  successorBriefPath: string;
  redisUrl?: string;
  heartbeatKey?: string;
  receiptPath?: string;
  restartDelay?: string;
  herdrSession?: string;
};

function currentUserLaunchDomain(): string {
  if (typeof process.getuid !== "function") {
    throw new Error("gateway kill drill requires a Unix launchd user domain");
  }
  return `gui/${process.getuid()}`;
}

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
  // Pane labels outlive respawns; agents don't carry them, so check panes first.
  const paneList = parseEnvelope((await runCommand(["herdr", "pane", "list"])).stdout);
  const resultObject = (paneList as { result?: { panes?: unknown[] } }).result;
  const panes = Array.isArray(resultObject?.panes)
    ? (resultObject.panes as Record<string, unknown>[])
    : [];
  const labeled = panes.find((pane) => pane.label === target);
  if (labeled && typeof labeled.pane_id === "string") return labeled.pane_id;
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
  const baseRunCommand = dependencies.runCommand ?? command;
  const herdrSession =
    options.herdrSession?.trim() || DEFAULT_GATEWAY_HERDR_SESSION;
  const runCommand = (argv: string[]) =>
    baseRunCommand(scopeHerdrCommand(argv, herdrSession));
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
      // The kill must take down the whole agent side: session AND driver.
      // Boot out the KeepAlive LaunchAgent first. SIGTERM alone lets launchd
      // recreate the driver before the heartbeat TTL can prove fallback.
      const launchDomain = currentUserLaunchDomain();
      let driverStopped = false;
      try {
        await runCommand([
          "launchctl",
          "bootout",
          `${launchDomain}/${DRIVER_LAUNCH_AGENT_LABEL}`,
        ]);
        driverStopped = true;
      } catch (bootoutError) {
        // A failed bootout is safe to treat as manual mode only when launchd
        // proves no KeepAlive job remains loaded.
        let launchAgentLoaded = true;
        try {
          await runCommand([
            "launchctl",
            "print",
            `${launchDomain}/${DRIVER_LAUNCH_AGENT_LABEL}`,
          ]);
        } catch {
          launchAgentLoaded = false;
        }
        if (launchAgentLoaded) {
          throw new Error("driver LaunchAgent remained loaded after bootout", {
            cause: bootoutError,
          });
        }

        // Manual development runs have no loaded LaunchAgent. Stop only the
        // pidfile owner, never a broad process-name pattern.
        try {
          const pid = Number.parseInt(
            (await Bun.file("/tmp/joelclaw/agent-comms-driver.pid").text()).trim(),
            10,
          );
          if (Number.isSafeInteger(pid) && pid > 1) {
            process.kill(pid, "SIGTERM");
            driverStopped = true;
          }
        } catch {
          driverStopped = false;
        }
      }
      const paneId = await resolvePaneId(runCommand, options.agentTarget);
      const result = parseEnvelope((await runCommand(["herdr", "pane", "close", paneId])).stdout);
      return { paneId, herdr: result, driverStopped };
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
      // Restore the supervised driver. A detached replacement beside a
      // KeepAlive LaunchAgent can produce two owners after the drill.
      const workspace = process.env.GATEWAY_HERDR_WORKSPACE?.trim();
      const launchDomain = currentUserLaunchDomain();
      const launchAgentPlist =
        process.env.GATEWAY_DRIVER_LAUNCH_AGENT_PLIST?.trim()
        || `${process.env.HOME ?? "/Users/joel"}/Library/LaunchAgents/${DRIVER_LAUNCH_AGENT_LABEL}.plist`;
      let driverRestart: Record<string, unknown>;
      try {
        const bootstrap = await runCommand([
          "launchctl",
          "bootstrap",
          launchDomain,
          launchAgentPlist,
        ]);
        driverRestart = { launchAgent: DRIVER_LAUNCH_AGENT_LABEL, stdout: bootstrap.stdout.trim() };
      } catch {
        const kickstart = await runCommand([
          "launchctl",
          "kickstart",
          "-k",
          `${launchDomain}/${DRIVER_LAUNCH_AGENT_LABEL}`,
        ]);
        driverRestart = { launchAgent: DRIVER_LAUNCH_AGENT_LABEL, stdout: kickstart.stdout.trim() };
      }
      // The supervised driver is the single recovery owner. It will create or
      // reuse the gateway pane on its next pass. Spawning here as well races
      // two list-then-create operations and can produce duplicate gateways.
      return {
        herdr: { session: herdrSession, recoveryOwner: "agent-comms-driver" },
        driver: driverRestart,
        ...(workspace ? { workspace } : {}),
      };
    },
    recordReceipt: options.receiptPath
      ? makeKillDrillReceiptRecorder(options.receiptPath)
      : undefined,
    close: async () => {
      if (redis.status !== "end") redis.disconnect();
    },
  };
}
