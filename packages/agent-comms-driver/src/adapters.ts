import { appendFile } from "node:fs/promises";
import {
  createMessageEventLogClient,
  GATEWAY_MESSAGE_EVENT_CONSUMER,
  type MessageEventDocument,
} from "@joelclaw/message-event-log";
import Redis from "ioredis";

import type { AggregateDeadline, DriverPorts, DriverReceipt } from "./driver";

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
  "cd /Users/joel/Code/joelhooks/joelclaw && claude --model sonnet --effort low --plugin-dir prototypes/agent-comms-gateway/claude-plugin --agent joelclaw-gateway";

/**
 * herdr-native successor spawn shared by the driver and the kill drill: if a
 * pane already carries the target label it IS the pending successor;
 * otherwise open a pane, label it, and boot the gateway command in it.
 */
export async function spawnGatewaySuccessorPane(
  runCommand: (argv: string[]) => Promise<{ stdout: string; stderr: string }>,
  opts: { target: string; herdrWorkspace?: string; successorCommand?: string },
): Promise<{ spawned: boolean; paneId: string }> {
  const paneResult = await runCommand(["herdr", "pane", "list"]);
  const panes = resultList(paneResult.stdout, "panes");
  const existing = panes.find((entry) => matchesTarget(entry, opts.target));
  if (existing && typeof existing.pane_id === "string") {
    return { spawned: false, paneId: existing.pane_id };
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
    opts.successorCommand ?? DEFAULT_SUCCESSOR_COMMAND,
  ]);
  return { spawned: true, paneId };
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
  const successorIdentity = options.successorIdentity ?? `agent-comms-driver:${options.target}`;
  const successorMarker = `[driver-spawn:${successorIdentity}]`;
  const successorPrompt = `${successorMarker} Gateway session missing or retired. Start its successor from authoritative stream replay.`;

  const recordReceipt = async (receipt: DriverReceipt) => {
    const line = `${JSON.stringify(receipt)}\n`;
    process.stdout.write(line);
    if (options.receiptPath) await appendFile(options.receiptPath, line, "utf8");
  };

  // The target may be a stable pane label that outlives respawns; herdr's
  // prompt command wants a pane id or agent name, so resolve per call.
  const resolveCliTarget = async (): Promise<string> => {
    const paneResult = await runCommand(["herdr", "pane", "list"]);
    const panes = resultList(paneResult.stdout, "panes");
    const pane = panes.find((entry) => matchesTarget(entry, options.target));
    return typeof pane?.pane_id === "string" ? pane.pane_id : options.target;
  };

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
    requestSuccessor: async () => {
      // herdr-native spawn (Joel, cutover sitting 2026-07-21): the driver opens
      // the successor pane directly instead of routing through the wake
      // registry — one hop, observable, no pipeline dependency.
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
