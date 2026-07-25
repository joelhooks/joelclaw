import { appendFile } from "node:fs/promises";
import {
  createMessageEventLogClient,
  GATEWAY_MESSAGE_EVENT_CONSUMER,
  type MessageEventDocument,
} from "@joelclaw/message-event-log";
import Redis from "ioredis";

import type { AggregateDeadline, DriverPorts, DriverReceipt, SessionHandoffInput } from "./driver";

const PANE_SCHEDULE_REGISTRY_KEY = "pane:schedules:pending";

export type LiveAdapterOptions = {
  target: string;
  successorBriefPath: string;
  redisUrl?: string;
  receiptPath?: string;
  spawnDelay?: string;
  successorIdentity?: string;
  /** herdr workspace that hosts the gateway session's pane (successor spawns land here). */
  herdrWorkspace?: string;
  /** Shell command that boots a gateway session inside a fresh pane. */
  successorCommand?: string;
};

export const DEFAULT_SUCCESSOR_COMMAND =
  "cd /Users/joel/Code/joelhooks/joelclaw && claude --model sonnet --effort medium --plugin-dir prototypes/agent-comms-gateway/claude-plugin --agent joelclaw-gateway";

export type SpawnGatewaySuccessorResult = {
  spawned: boolean;
  paneId: string;
  /** True when an existing labeled pane had no live agent and was relaunched in place. */
  relaunched?: boolean;
};

/**
 * herdr-native successor spawn shared by the driver and the kill drill.
 *
 * - No labeled pane → create one, label it, boot the gateway command.
 * - Labeled pane with a live agent session → treat as pending successor (no-op).
 * - Labeled pane with NO live agent (post-retire empty shell) → relaunch in place.
 *   Never open a second pane for the same target label.
 */
export async function spawnGatewaySuccessorPane(
  runCommand: (argv: string[]) => Promise<{ stdout: string; stderr: string }>,
  opts: { target: string; herdrWorkspace?: string; successorCommand?: string },
): Promise<SpawnGatewaySuccessorResult> {
  const command = opts.successorCommand ?? DEFAULT_SUCCESSOR_COMMAND;
  const paneResult = await runCommand(["herdr", "pane", "list"]);
  const panes = resultList(paneResult.stdout, "panes");
  const existing = panes.find((entry) => matchesTarget(entry, opts.target));
  if (existing && typeof existing.pane_id === "string") {
    const agentResult = await runCommand(["herdr", "agent", "list"]);
    const agents = resultList(agentResult.stdout, "agents");
    const live = agents.some((entry) => entry.pane_id === existing.pane_id);
    if (live) {
      return { spawned: false, paneId: existing.pane_id };
    }
    await runCommand(["herdr", "pane", "run", existing.pane_id, command]);
    return { spawned: true, paneId: existing.pane_id, relaunched: true };
  }
  const workspace = opts.herdrWorkspace?.trim();
  const createArgs = workspace
    ? ["herdr", "tab", "create", "--workspace", workspace, "--label", "📨 gateway loop"]
    : ["herdr", "workspace", "create", "--label", "[jc] gateway agent"];
  const created = object(JSON.parse((await runCommand(createArgs)).stdout));
  const result = object(created?.result);
  const rootPane = object(result?.root_pane);
  const paneId = typeof rootPane?.pane_id === "string" ? rootPane.pane_id : null;
  if (!paneId) throw new Error(`herdr spawn returned no root pane: ${JSON.stringify(created)}`);
  await runCommand(["herdr", "pane", "rename", paneId, opts.target]);
  await runCommand([
    "herdr",
    "pane",
    "run",
    paneId,
    command,
  ]);
  return { spawned: true, paneId };
}

/**
 * Stop the foreground agent process inside a pane without closing the pane.
 * Used for clean/degeneration retire so spawn can relaunch in place.
 */
export async function stopAgentInPane(
  runCommand: (argv: string[]) => Promise<{ stdout: string; stderr: string }>,
  paneId: string,
  killProcess: (pid: number, signal?: NodeJS.Signals) => void = (pid, signal) => {
    globalThis.process.kill(pid, signal ?? "SIGTERM");
  },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ stopped: boolean; pids: number[] }> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 200;
  const infoRaw = await runCommand(["herdr", "pane", "process-info", "--pane", paneId]);
  const infoEnvelope = object(JSON.parse(infoRaw.stdout));
  const infoResult = object(infoEnvelope?.result);
  const processInfo = object(infoResult?.process_info);
  const shellPid = typeof processInfo?.shell_pid === "number" ? processInfo.shell_pid : undefined;
  const foreground = Array.isArray(processInfo?.foreground_processes)
    ? processInfo.foreground_processes
    : [];
  const pids: number[] = [];
  for (const entry of foreground) {
    const record = object(entry);
    const pid = typeof record?.pid === "number" ? record.pid : undefined;
    if (pid === undefined || pid === shellPid) continue;
    try {
      killProcess(pid, "SIGTERM");
      pids.push(pid);
    } catch {
      // Already gone is fine.
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agentResult = await runCommand(["herdr", "agent", "list"]);
    const agents = resultList(agentResult.stdout, "agents");
    const live = agents.some((entry) => entry.pane_id === paneId);
    if (!live) return { stopped: true, pids };
    await wait(pollMs);
  }
  return { stopped: false, pids };
}

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (argv: string[]) => Promise<CommandResult>;
type StreamClient = ReturnType<typeof createMessageEventLogClient>;

type RedisDriverClient = {
  readonly status: string;
  connect(): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  disconnect(): void;
};

export type LiveAdapterDependencies = {
  runCommand?: CommandRunner;
  stream?: StreamClient;
  redis?: RedisDriverClient;
};

async function command(argv: string[]): Promise<CommandResult> {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function resultList(raw: string, key: string): Record<string, unknown>[] {
  const envelope = object(JSON.parse(raw));
  const result = object(envelope?.result);
  const value = result?.[key];
  if (!Array.isArray(value)) return [];
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = object(item);
    if (record) records.push(record);
  }
  return records;
}

function matchesTarget(entry: Record<string, unknown>, target: string): boolean {
  return ["pane_id", "name", "agent_name", "callsign", "label", "agent"].some(
    (key) => entry[key] === target,
  );
}

type AggregateDecision = {
  action: "open" | "join" | "extend" | "close-deliver";
  aggregateId: string;
  memberEventIds: string[];
  holdUntil?: number;
  follows?: string;
};

function aggregateDecision(event: MessageEventDocument): AggregateDecision | undefined {
  if (event.kind !== "gateway.decision.recorded") return undefined;
  const payload = object(event.payload);
  const decision = object(payload?.decision);
  if (decision?.verb !== "aggregate") return undefined;
  const action = decision.action;
  const aggregateId = decision.aggregateId;
  const memberEventIds = decision.memberEventIds;
  if (
    (action !== "open" && action !== "join" && action !== "extend" && action !== "close-deliver")
    || typeof aggregateId !== "string"
    || !Array.isArray(memberEventIds)
    || !memberEventIds.every((id) => typeof id === "string")
  ) {
    return undefined;
  }
  return {
    action,
    aggregateId,
    memberEventIds,
    ...(typeof decision.holdUntil === "number" ? { holdUntil: decision.holdUntil } : {}),
    ...(typeof decision.follows === "string" ? { follows: decision.follows } : {}),
  };
}

function firedDeadline(event: MessageEventDocument): string | undefined {
  if (event.kind !== "aggregate.deadline.reached") return undefined;
  const payload = object(event.payload);
  return typeof payload?.aggregateId === "string" && typeof payload.holdUntil === "number"
    ? `${payload.aggregateId}:${payload.holdUntil}`
    : undefined;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export function makeDeadlineIndex() {
  const active = new Map<string, AggregateDeadline>();
  const fired = new Set<string>();
  const seenAtWatermark = new Set<string>();
  let watermark = 0;

  const acceptAtWatermark = (event: MessageEventDocument): boolean => {
    if (event.recordedAt < watermark) return false;
    if (event.recordedAt > watermark) {
      watermark = event.recordedAt;
      seenAtWatermark.clear();
    }
    if (seenAtWatermark.has(event._id)) return false;
    seenAtWatermark.add(event._id);
    return true;
  };

  const ingest = (event: MessageEventDocument) => {
    if (!acceptAtWatermark(event)) return;
    const decision = aggregateDecision(event);
    if (decision?.action === "close-deliver") {
      active.delete(decision.aggregateId);
    } else if (decision) {
      const prior = active.get(decision.aggregateId);
      const holdUntil = decision.holdUntil ?? prior?.holdUntil;
      if (holdUntil !== undefined) {
        active.set(decision.aggregateId, {
          aggregateId: decision.aggregateId,
          memberEventIds: unique([...(prior?.memberEventIds ?? []), ...decision.memberEventIds]),
          holdUntil,
          ...(decision.follows ?? prior?.follows
            ? { follows: decision.follows ?? prior?.follows }
            : {}),
        });
      }
    }
    const firedKey = firedDeadline(event);
    if (firedKey) fired.add(firedKey);
  };

  return {
    get watermark(): number {
      return watermark;
    },
    ingest,
    due: (now: number): AggregateDeadline[] =>
      [...active.values()].filter(
        (deadline) =>
          deadline.holdUntil <= now
          && !fired.has(`${deadline.aggregateId}:${deadline.holdUntil}`),
      ),
    markFired: (deadline: AggregateDeadline) => {
      fired.add(`${deadline.aggregateId}:${deadline.holdUntil}`);
    },
  };
}

function makeDeadlineReader(client: StreamClient) {
  const index = makeDeadlineIndex();
  return {
    listDue: async (now: number): Promise<AggregateDeadline[]> => {
      const passWatermark = index.watermark;
      let cursor: string | null = null;
      do {
        const page = await client.readSince(passWatermark, 250, cursor);
        page.events.forEach(index.ingest);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return index.due(now);
    },
    markFired: index.markFired,
  };
}

function scheduleMatches(raw: string, briefPath: string, marker: string): boolean {
  try {
    const entry = object(JSON.parse(raw));
    return entry?.verb === "spawn"
      && entry.briefPath === briefPath
      && typeof entry.prompt === "string"
      && entry.prompt.includes(marker);
  } catch {
    return false;
  }
}

async function hasPendingSuccessor(
  redis: RedisDriverClient,
  briefPath: string,
  marker: string,
): Promise<boolean> {
  if (redis.status === "wait") await redis.connect();
  const schedules = await redis.hgetall(PANE_SCHEDULE_REGISTRY_KEY);
  return Object.values(schedules).some((raw) => scheduleMatches(raw, briefPath, marker));
}

export function makeLiveDriverPorts(
  options: LiveAdapterOptions,
  dependencies: LiveAdapterDependencies = {},
): DriverPorts & { close: () => Promise<void> } {
  const runCommand = dependencies.runCommand ?? command;
  const stream = dependencies.stream ?? createMessageEventLogClient();
  const deadlines = makeDeadlineReader(stream);
  const redis = dependencies.redis ?? new Redis(
    options.redisUrl ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    { lazyConnect: true, maxRetriesPerRequest: 1 },
  );
  const recordReceipt = async (receipt: DriverReceipt) => {
    const line = `${JSON.stringify(receipt)}\n`;
    process.stdout.write(line);
    if (options.receiptPath) await appendFile(options.receiptPath, line, "utf8");
  };

  // The target may be a stable pane label that outlives respawns; herdr's
  // prompt command wants a pane id or agent name, so resolve per call.
  const resolvePaneId = async (): Promise<string | undefined> => {
    const paneResult = await runCommand(["herdr", "pane", "list"]);
    const panes = resultList(paneResult.stdout, "panes");
    const pane = panes.find((entry) => matchesTarget(entry, options.target));
    return typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
  };

  const resolveCliTarget = async (): Promise<string> =>
    (await resolvePaneId()) ?? options.target;

  return {
    now: Date.now,
    inspectAgent: async () => {
      const [agentResult, paneResult] = await Promise.all([
        runCommand(["herdr", "agent", "list"]),
        runCommand(["herdr", "pane", "list"]),
      ]);
      const agents = resultList(agentResult.stdout, "agents");
      const panes = resultList(paneResult.stdout, "panes");
      // The target may be a pane label agents don't carry: resolve the pane
      // first, then find its occupant by pane id.
      const labeledPane = panes.find((entry) => matchesTarget(entry, options.target));
      const agent = agents.find((entry) => matchesTarget(entry, options.target))
        ?? (labeledPane && typeof labeledPane.pane_id === "string"
          ? agents.find((entry) => entry.pane_id === labeledPane.pane_id)
          : undefined);
      const pane = labeledPane
        ?? (agent && typeof agent.pane_id === "string"
          ? panes.find((entry) => entry.pane_id === agent.pane_id)
          : undefined);
      const status = agent?.agent_status;
      return {
        paneExists: pane !== undefined,
        sessionExists: agent !== undefined,
        idle: status === "idle" || status === "done",
      };
    },
    countUnhandled: async () =>
      (await stream.pendingForConsumer(GATEWAY_MESSAGE_EVENT_CONSUMER, 1)).length,
    readRecentOutput: async () => {
      try {
        const target = await resolveCliTarget();
        const result = await runCommand([
          "herdr",
          "agent",
          "read",
          target,
          "--source",
          "recent-unwrapped",
          "--lines",
          "80",
          "--format",
          "text",
        ]);
        // herdr wraps text; prefer raw stdout and let the detector scan it.
        return result.stdout;
      } catch {
        // No agent / read failure is not degeneration evidence.
        return "";
      }
    },
    promptAgent: async (text, timeoutMs) => {
      await runCommand([
        "herdr",
        "agent",
        "prompt",
        await resolveCliTarget(),
        text,
        "--wait",
        "--until",
        "idle",
        "--until",
        "done",
        "--timeout",
        String(timeoutMs),
      ]);
    },
    listDueDeadlines: deadlines.listDue,
    appendDeadline: async (deadline) => {
      await stream.append({
        semanticKey: `aggregate-deadline:${deadline.aggregateId}:${deadline.holdUntil}`,
        kind: "aggregate.deadline.reached",
        source: "agent-comms-driver",
        payload: deadline,
      });
      deadlines.markFired(deadline);
    },
    refreshHeartbeat: async (key, ttlMs, value) => {
      if (redis.status === "wait") await redis.connect();
      await redis.set(key, value, "PX", ttlMs);
    },
    writeHandoff: async (input: SessionHandoffInput) => {
      // Advisory only — SessionStart prefers stream replay over this note.
      await stream.append({
        semanticKey: `gateway-handoff:driver-retire:${input.reason}:${Date.now()}`,
        kind: "gateway.handoff",
        source: "agent-comms-driver",
        payload: {
          sessionId: `driver-retire:${options.target}`,
          promptRevision: `driver-retire/${input.reason}`,
          note: input.note.slice(0, 2000),
          lastSequence: 0,
        },
      });
    },
    stopSession: async () => {
      const paneId = await resolvePaneId();
      if (!paneId) return;
      const result = await stopAgentInPane(runCommand, paneId);
      if (!result.stopped && result.pids.length > 0) {
        throw new Error(`gateway session on ${paneId} still live after SIGTERM (pids ${result.pids.join(",")})`);
      }
    },
    requestSuccessor: async () => {
      // herdr-native spawn (Joel, cutover sitting 2026-07-21): the driver opens
      // the successor pane directly instead of routing through the wake
      // registry — one hop, observable, no pipeline dependency. Post-retire
      // empty labeled panes relaunch in place (see spawnGatewaySuccessorPane).
      await spawnGatewaySuccessorPane(runCommand, {
        target: options.target,
        ...(options.herdrWorkspace ? { herdrWorkspace: options.herdrWorkspace } : {}),
        ...(options.successorCommand ? { successorCommand: options.successorCommand } : {}),
      });
    },
    recordReceipt,
    close: async () => {
      if (redis.status !== "end") redis.disconnect();
    },
  };
}
