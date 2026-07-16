import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  type ChannelAuditSeed,
  emitGatewayOtel,
  summarizeChannelError,
} from "@joelclaw/telemetry";
import { enrichPromptWithVaultContext } from "@joelclaw/vault-reader";
import Redis from "ioredis";
import {
  NotifyCompatDeliveryError,
  notifyCompatTelemetry,
  routeNotifySendCompat,
} from "../chat-sdk/notify-acting";
import { send as sendChatSdk } from "../chat-sdk/outbound";
import {
  buildSignalDigestPrompt,
  buildSignalRelayGuidance,
  classifyOperatorSignal,
  type OperatorSignalBucket,
} from "../operator-relay";
import type { OutboundEnvelope } from "../outbound/envelope";
import { describeError, ErrorEmissionBudget, type ErrorSummary } from "./error-emission-budget";
import { type InlineButton, send as sendTelegram } from "./telegram";

export type EnqueueFn = (
  source: string,
  prompt: string,
  metadata?: Record<string, unknown>,
) => void | Promise<void>;

type SystemEvent = {
  id: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  ts: number;
};

const SESSION_ID = "gateway";
const SESSIONS_SET = "joelclaw:gateway:sessions";
const EVENT_LIST = "joelclaw:events:gateway";
const LEGACY_EVENT_LIST = "joelclaw:events:main";
const NOTIFY_CHANNEL = "joelclaw:notify:gateway";
const LEGACY_NOTIFY_CHANNEL = "joelclaw:notify:main";
const BATCH_LIST = "joelclaw:events:batch";
const MODE_KEY = "joelclaw:mode";
// HEARTBEAT_PATH removed — gateway no longer processes HEARTBEAT.md (ADR-0103)
const DEDUP_MAX = 500;
const ONE_HOUR_MS = 60 * 60 * 1000;
const REDIS_ERROR_WINDOW_MS = 60_000;
const REDIS_ERROR_MAX_DISTINCT_PER_WINDOW = 3;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID
  ? parseInt(process.env.TELEGRAM_USER_ID, 10)
  : undefined;

const redisOpts = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
  lazyConnect: true,
  // Long-lived daemon clients should not flush command queues into
  // MaxRetriesPerRequestError floods during transient reconnect churn.
  maxRetriesPerRequest: null,
  retryStrategy: (times: number) => Math.min(times * 500, 30_000),
};

let sub: Redis | undefined;
let cmd: Redis | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let started = false;
let draining = false;
let lastUserVisibleHeartbeatAt = 0;
const seenIds = new Set<string>();

type GatewayMode = "active" | "sleep";
export type GatewayRuntimeMode = "normal" | "redis_degraded";

export type RedisRuntimeState = {
  mode: GatewayRuntimeMode;
  healthy: boolean;
  reason: string;
  lastTransitionAt: number;
  reconnectAttempts: number;
  lastError?: string;
  subscriberStatus: string;
  commandStatus: string;
};

let runtimeState: RedisRuntimeState = {
  mode: "redis_degraded",
  healthy: false,
  reason: "startup_pending",
  lastTransitionAt: Date.now(),
  reconnectAttempts: 0,
  subscriberStatus: "idle",
  commandStatus: "idle",
};

const redisErrorBudgets = {
  subscriber: new ErrorEmissionBudget({
    windowMs: REDIS_ERROR_WINDOW_MS,
    maxDistinctPerWindow: REDIS_ERROR_MAX_DISTINCT_PER_WINDOW,
  }),
  command: new ErrorEmissionBudget({
    windowMs: REDIS_ERROR_WINDOW_MS,
    maxDistinctPerWindow: REDIS_ERROR_MAX_DISTINCT_PER_WINDOW,
  }),
};

type RedisClientKind = keyof typeof redisErrorBudgets;

function emitRedisErrorSummary(kind: RedisClientKind, summary: ErrorSummary): void {
  console.warn(`[gateway:redis] ${kind} errors suppressed`, {
    count: summary.suppressed,
    windowMs: summary.windowEndedAt - summary.windowStartedAt,
  });
  void emitGatewayOtel({
    level: "warn",
    component: "redis-channel",
    action: `redis.${kind}.error.summary`,
    success: false,
    error: `${summary.suppressed} repeated Redis ${kind} errors suppressed`,
    metadata: {
      emitted: summary.emitted,
      suppressed: summary.suppressed,
      suppressedSignatures: summary.suppressedSignatures,
      windowStartedAt: new Date(summary.windowStartedAt).toISOString(),
      windowEndedAt: new Date(summary.windowEndedAt).toISOString(),
    },
  });
}

function emitRedisClientError(kind: RedisClientKind, error: unknown): void {
  const description = describeError(error);
  const decision = redisErrorBudgets[kind].record(description.signature);
  if (decision.summary) emitRedisErrorSummary(kind, decision.summary);
  if (!decision.emit) return;

  console.error(`[gateway:redis] ${kind} error`, { error });
  void emitGatewayOtel({
    level: "error",
    component: "redis-channel",
    action: `redis.${kind}.error`,
    success: false,
    error: description.message,
    metadata: {
      errorName: description.name,
      ...(description.code ? { errorCode: description.code } : {}),
      causes: description.causes,
    },
  });
}

function flushRedisErrorSummary(kind: RedisClientKind): void {
  const summary = redisErrorBudgets[kind].flush();
  if (summary) emitRedisErrorSummary(kind, summary);
}

function disposeRedisClients(expectedSub = sub, expectedCmd = cmd): void {
  if (expectedSub) {
    expectedSub.removeAllListeners();
    expectedSub.disconnect(false);
    if (sub === expectedSub) sub = undefined;
  }
  if (expectedCmd) {
    expectedCmd.removeAllListeners();
    expectedCmd.disconnect(false);
    if (cmd === expectedCmd) cmd = undefined;
  }
}

function currentRedisClientStatus(client: Redis | undefined): string {
  return client?.status ?? "idle";
}

function updateRuntimeState(
  mode: GatewayRuntimeMode,
  reason: string,
  options?: { lastError?: string; reconnectAttempts?: number },
): void {
  const previous = runtimeState;
  const next: RedisRuntimeState = {
    mode,
    healthy: mode === "normal" && isHealthy(),
    reason,
    lastTransitionAt: previous.mode === mode && previous.reason === reason
      ? previous.lastTransitionAt
      : Date.now(),
    reconnectAttempts: options?.reconnectAttempts ?? previous.reconnectAttempts,
    subscriberStatus: currentRedisClientStatus(sub),
    commandStatus: currentRedisClientStatus(cmd),
    ...(options?.lastError ? { lastError: options.lastError } : previous.lastError ? { lastError: previous.lastError } : {}),
  };

  const changed = previous.mode !== next.mode || previous.reason !== next.reason;
  runtimeState = next;

  if (!changed) return;

  void emitGatewayOtel({
    level: mode === "normal" ? "info" : "warn",
    component: "redis-channel",
    action: "runtime.mode.changed",
    success: mode === "normal",
    ...(options?.lastError ? { error: options.lastError } : {}),
    metadata: {
      from: previous.mode,
      to: next.mode,
      reason,
      reconnectAttempts: next.reconnectAttempts,
      subscriberStatus: next.subscriberStatus,
      commandStatus: next.commandStatus,
      transitionedAt: new Date(next.lastTransitionAt).toISOString(),
    },
  });
}

export function getRuntimeState(): RedisRuntimeState {
  return {
    ...runtimeState,
    healthy: isHealthy(),
    subscriberStatus: currentRedisClientStatus(sub),
    commandStatus: currentRedisClientStatus(cmd),
  };
}

function pruneSeenIds(): void {
  if (seenIds.size <= DEDUP_MAX) return;
  const entries = Array.from(seenIds);
  for (let i = 0; i < entries.length - DEDUP_MAX; i += 1) {
    const entry = entries[i];
    if (entry) {
      seenIds.delete(entry);
    }
  }
}

function normalizeMode(mode: string | null | undefined): GatewayMode {
  return mode === "sleep" ? "sleep" : "active";
}

export async function getGatewayMode(): Promise<GatewayMode> {
  if (!cmd) return "active";
  try {
    const mode = await cmd.get(MODE_KEY);
    return normalizeMode(mode);
  } catch (error) {
    console.warn("[redis] mode read failed — defaulting to active", { error: String(error) });
    void emitGatewayOtel({
      level: "warn",
      component: "redis-channel",
      action: "mode.read.failed",
      success: false,
      error: String(error),
    });
    return "active";
  }
}

async function setGatewayMode(mode: GatewayMode): Promise<void> {
  if (!cmd) return;
  try {
    await cmd.set(MODE_KEY, mode);
  } catch (error) {
    console.warn("[redis] mode write failed", {
      mode,
      error: String(error),
    });
    void emitGatewayOtel({
      level: "warn",
      component: "redis-channel",
      action: "mode.write.failed",
      success: false,
      error: String(error),
      metadata: { mode },
    });
  }
}

async function appendToBatch(events: SystemEvent[], reason: string): Promise<void> {
  if (!cmd || events.length === 0) return;
  for (const event of events) {
    await cmd.rpush(BATCH_LIST, JSON.stringify(event));
  }
  console.log(`[redis] batched ${events.length} event(s) (${reason}): ${events.map((e) => e.type).join(", ")}`);
  void emitGatewayOtel({
    level: "debug",
    component: "redis-channel",
    action: "batch.appended",
    success: true,
    metadata: {
      reason,
      count: events.length,
      eventTypes: events.map((event) => event.type),
    },
  });
}

export async function sleepGateway(): Promise<void> {
  await setGatewayMode("sleep");
  console.log("[redis] gateway mode set to sleep");
}

export async function wakeGateway(options?: { flushDigest?: boolean }): Promise<void> {
  await setGatewayMode("active");
  console.log("[redis] gateway mode set to active");
  if (options?.flushDigest ?? true) {
    const flushed = await flushBatchDigest();
    if (flushed > 0) {
      console.log(`[redis] wake flush delivered ${flushed} batched event(s)`);
    }
  }
}

// readHeartbeatChecklist removed — gateway no longer processes HEARTBEAT.md (ADR-0103)

function formatEvents(events: SystemEvent[]): string {
  if (events.length === 0) return "_No pending events._";

  return events
    .map((event) => {
      const time = new Date(event.ts).toLocaleTimeString("en-US", { hour12: false });
      const payload = Object.keys(event.payload).length > 0 ? `\n  ${JSON.stringify(event.payload)}` : "";
      return `- **[${time}] ${event.type}** (${event.source})${payload}`;
    })
    .join("\n");
}

type RecallHit = {
  score?: unknown;
  observation?: unknown;
  type?: unknown;
  source?: unknown;
};

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizePrompt(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function extractLastHumanMessage(events: SystemEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    const payload = event.payload ?? {};
    const prompt = normalizePrompt(payload.prompt);
    if (!prompt) continue;

    if (/^(telegram|imessage|slack)\.message\.received$/u.test(event.type)) {
      return prompt.slice(0, 500);
    }
  }

  return null;
}

function buildRecallSectionFromMessage(message: string): string {
  try {
    const result = spawnSync(
      "joelclaw",
      ["recall", message, "--limit", "3", "--json"],
      {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      throw new Error(stderr || `recall exited with code ${result.status ?? "unknown"}`);
    }

    const raw = (result.stdout ?? "").trim();
    if (!raw) return "";

    const parsed = JSON.parse(raw) as {
      result?: { hits?: RecallHit[] };
    };

    const hits = Array.isArray(parsed.result?.hits) ? parsed.result?.hits : [];
    if (!hits || hits.length === 0) return "";

    const lines = hits.slice(0, 3).flatMap((hit, index) => {
      const observation = typeof hit.observation === "string" ? hit.observation.trim() : "";
      if (!observation) return [];
      const score = asFiniteNumber(hit.score);
      const type = typeof hit.type === "string" ? hit.type : "memory";
      const source = typeof hit.source === "string" ? hit.source : "unknown";
      const prefix = score != null ? `(${score.toFixed(2)}) ` : "";
      return [`${index + 1}. ${prefix}[${type}/${source}] ${observation}`];
    });

    if (lines.length === 0) return "";
    return ["Relevant memory:", ...lines].join("\n");
  } catch (error) {
    void emitGatewayOtel({
      level: "warn",
      component: "redis-channel",
      action: "memory.recall.failed",
      success: false,
      error: String(error),
      metadata: {
        queryPreview: message.slice(0, 120),
      },
    });
    return "";
  }
}

async function buildPrompt(events: SystemEvent[]): Promise<string> {
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).replace(" ", "T") + " PST";

  // cron.heartbeat no longer triggers HEARTBEAT.md checklist in the gateway.
  // Health checks run as Inngest check/* functions and push here only when actionable.
  // Filter out stale cron.heartbeat events if they somehow arrive.
  events = events.filter((event) => event.type !== "cron.heartbeat");
  if (events.length === 0) return ""; // nothing actionable

  const footer = buildSignalRelayGuidance(events);

  const promptEvents = events.filter(
    (event) => typeof event.payload?.prompt === "string" && event.payload.prompt
  );
  const genericEvents = events.filter((event) => !(typeof event.payload?.prompt === "string" && event.payload.prompt));

  const parts: string[] = [
    `## 🔔 Gateway — ${ts}`,
    "",
    `${events.length} event(s):`,
  ];

  if (promptEvents.length > 0) {
    const resolvedPrompts = await Promise.all(
      promptEvents.map(async (event) => {
        const prompt = event.payload.prompt as string;
        return enrichPromptWithVaultContext(prompt);
      })
    );

    parts.push(resolvedPrompts.join("\n\n---\n\n"));

    if (genericEvents.length > 0) {
      const eventBlock = formatEvents(genericEvents);
      parts.push("", "---", "", `${genericEvents.length} additional event(s):`, eventBlock);
    }
  } else {
    const eventBlock = formatEvents(events);
    parts.push(eventBlock);
  }

  const lastHumanMessage = extractLastHumanMessage(events);
  if (lastHumanMessage) {
    const recallSection = buildRecallSectionFromMessage(lastHumanMessage);
    if (recallSection) {
      parts.push("", recallSection);
    }
  }

  parts.push("", footer);
  return parts.join("\n");
}

function parseEvent(raw: string): SystemEvent | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<SystemEvent>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.type !== "string" ||
      typeof parsed.source !== "string" ||
      typeof parsed.ts !== "number" ||
      typeof parsed.payload !== "object" ||
      parsed.payload === null
    ) {
      return undefined;
    }

    return parsed as SystemEvent;
  } catch {
    return undefined;
  }
}

function signalPriority(
  payload: Record<string, unknown>,
): "low" | "normal" | "high" | "urgent" | undefined {
  const value = payload.priority;
  return value === "low" || value === "normal" || value === "high" || value === "urgent"
    ? value
    : undefined;
}

function signalLevel(
  payload: Record<string, unknown>,
): "debug" | "info" | "warn" | "error" | "fatal" | undefined {
  const value = payload.level;
  return value === "debug" || value === "info" || value === "warn" || value === "error" || value === "fatal"
    ? value
    : undefined;
}

const SIGNAL_PRIORITY_RANK = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
} as const;

const SIGNAL_LEVEL_RANK = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
} as const;

function policyEventRank(event: SystemEvent): number {
  const priority = signalPriority(event.payload);
  const level = signalLevel(event.payload);
  const relayScore = classifyOperatorSignal(event).score;
  return (priority ? SIGNAL_PRIORITY_RANK[priority] * 100 : 0)
    + (level ? SIGNAL_LEVEL_RANK[level] * 10 : 0)
    + relayScore;
}

function selectPolicySourceEventType(events: SystemEvent[]): string | undefined {
  return [...events]
    .sort((left, right) => {
      const rankDifference = policyEventRank(right) - policyEventRank(left);
      return rankDifference !== 0 ? rankDifference : left.type.localeCompare(right.type);
    })[0]?.type;
}

function isImmediateTelegramEvent(event: SystemEvent): boolean {
  const payload = event.payload as Record<string, unknown>;
  const priority = signalPriority(payload);
  return (
    event.type === "system.fatal" ||
    payload.immediateTelegram === true ||
    payload.level === "fatal" ||
    priority === "high" ||
    priority === "urgent"
  );
}

function isTelegramOnlyImmediateEvent(event: SystemEvent): boolean {
  if (!isImmediateTelegramEvent(event)) return false;
  const payload = event.payload as Record<string, unknown>;
  return payload.telegramOnly === true;
}

function isHeartbeatOkEvent(event: SystemEvent): boolean {
  if (event.type === "cron.heartbeat") return true;
  const payload = event.payload as Record<string, unknown>;
  const status = typeof payload.status === "string" ? payload.status.trim() : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  return status === "HEARTBEAT_OK" || prompt === "HEARTBEAT_OK";
}

function isInteractiveEvent(event: SystemEvent): boolean {
  return event.type === "telegram.message.received"
    || event.type === "imessage.message.received"
    || event.type === "slack.message.received"
    || event.type === "discord.message.received"
    || event.type === "approval.requested"
    || event.type === "approval.resolved"
    || event.type === "gateway/sleep"
    || event.type === "gateway/wake";
}

function isLowSignalDigestEvent(event: SystemEvent): boolean {
  if (event.type === "cron.heartbeat" || event.type === "test.gateway-e2e") {
    return true;
  }

  if (event.type === "notify.message" && event.source.trim().toLowerCase().startsWith("restate/")) {
    const payload = event.payload as Record<string, unknown>;
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    return prompt.startsWith("✅ DAG \"queue-dispatch:");
  }

  return false;
}

/**
 * ADR-0211: Quiet hours (11 PM – 7 AM PST).
 * During quiet hours, batch ALL non-interactive events to prevent
 * token burn and fallback thrash while nobody is watching.
 * Only human-originated messages (telegram, imessage, slack, discord)
 * get immediate processing.
 */
function isQuietHours(): boolean {
  const pstString = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const pstHour = new Date(pstString).getHours();
  return pstHour >= 23 || pstHour < 7;
}

function isHumanInboundMessageEvent(event: SystemEvent): boolean {
  return event.type.endsWith(".message.received");
}

type TriageBucket = OperatorSignalBucket;

function incrementCount(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function summarizeTypeCounts(events: SystemEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    incrementCount(counts, event.type);
  }
  return counts;
}

function getSourceKind(source: string): "channel" | "internal" {
  return source.includes(":") ? "channel" : "internal";
}

function isInlineButton(value: unknown): value is InlineButton {
  if (!value || typeof value !== "object") return false;
  const button = value as Record<string, unknown>;
  if (typeof button.text !== "string" || button.text.trim().length === 0) return false;
  if (button.url != null && typeof button.url !== "string") return false;
  if (button.action != null && typeof button.action !== "string") return false;
  return true;
}

function parseInlineButtons(value: unknown): InlineButton[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: InlineButton[][] = [];
  for (const rowValue of value) {
    if (!Array.isArray(rowValue)) continue;
    const row = rowValue.filter(isInlineButton).map((button) => ({
      text: button.text,
      ...(button.action ? { action: button.action } : {}),
      ...(button.url ? { url: button.url } : {}),
    }));
    if (row.length > 0) rows.push(row);
  }
  return rows.length > 0 ? rows : undefined;
}

function parseEnvelopeFormat(value: unknown): OutboundEnvelope["format"] | undefined {
  if (value === "html" || value === "markdown" || value === "plain") return value;
  return undefined;
}

function parseChannelAudit(value: unknown): ChannelAuditSeed | undefined {
  if (!value || typeof value !== "object") return undefined;
  const audit = value as Record<string, unknown>;
  if (typeof audit.flowId !== "string" || audit.flowId.trim().length === 0) return undefined;

  return {
    flowId: audit.flowId,
    ...(typeof audit.producer === "string" ? { producer: audit.producer } : {}),
    ...(typeof audit.originSystemId === "string" ? { originSystemId: audit.originSystemId } : {}),
    ...(typeof audit.eventId === "string" ? { eventId: audit.eventId } : {}),
    ...(typeof audit.requestedAtMs === "number" ? { requestedAtMs: audit.requestedAtMs } : {}),
    ...(typeof audit.queuedAtMs === "number" ? { queuedAtMs: audit.queuedAtMs } : {}),
    ...(typeof audit.route === "string" ? { route: audit.route } : {}),
    ...(typeof audit.inReplyToMessageId === "number"
      ? { inReplyToMessageId: audit.inReplyToMessageId }
      : {}),
  };
}

async function sendImmediateTelegramEscalation(
  events: SystemEvent[],
  triageDecisions: ReadonlyMap<string, { classification: TriageBucket; reason: string }>,
): Promise<void> {
  if (!TELEGRAM_USER_ID || events.length === 0) return;

  const legacyEvents: SystemEvent[] = [];

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const directMessage = typeof payload.telegramMessage === "string"
      ? payload.telegramMessage.trim()
      : "";

    if (!directMessage) {
      legacyEvents.push(event);
      continue;
    }

    await sendTelegram(TELEGRAM_USER_ID, {
      text: directMessage,
      format: parseEnvelopeFormat(payload.telegramFormat),
      buttons: parseInlineButtons(payload.telegramButtons),
    }, {
      audit: parseChannelAudit(payload.audit) ?? {
        flowId: `gateway-event:${event.id}`,
        producer: event.source,
        eventId: event.id,
        requestedAtMs: event.ts,
        route: "redis-immediate",
      },
      outboundPolicy: {
        sourceEventType: event.type,
        sourceClassification: triageDecisions.get(event.id)?.classification,
        sourceReason: triageDecisions.get(event.id)?.reason,
        ...(signalPriority(payload) ? { priority: signalPriority(payload) } : {}),
        ...(signalLevel(payload) ? { level: signalLevel(payload) } : {}),
      },
    });
  }

  if (legacyEvents.length === 0) return;

  // The visible text is the message itself — attribution (producer, event
  // type, flowId) travels in the audit and journal, never as a preface.
  for (const event of legacyEvents.slice(0, 5)) {
    const payload = event.payload as Record<string, unknown>;
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    const text = prompt
      || message
      || `${event.source} raised ${event.type} without message text — joelclaw messages trace gateway-event:${event.id}`;

    await sendTelegram(TELEGRAM_USER_ID, text, {
      audit: parseChannelAudit(payload.audit) ?? {
        flowId: `gateway-event:${event.id}`,
        producer: event.source,
        eventId: event.id,
        requestedAtMs: event.ts,
        route: "redis-immediate",
      },
      outboundPolicy: {
        sourceEventType: event.type,
        sourceClassification: triageDecisions.get(event.id)?.classification,
        sourceReason: triageDecisions.get(event.id)?.reason,
        ...(signalPriority(payload) ? { priority: signalPriority(payload) } : {}),
        ...(signalLevel(payload) ? { level: signalLevel(payload) } : {}),
      },
    });
  }

  if (legacyEvents.length > 5) {
    await sendTelegram(
      TELEGRAM_USER_ID,
      `${legacyEvents.length - 5} more urgent events landed in the same window — joelclaw messages audit --since 1h`,
      {
        audit: {
          producer: "gateway-immediate-batch",
          route: "redis-immediate",
        },
        outboundPolicy: {
          sourceEventType: "gateway.immediate.batch",
          sourceClassification: "immediate",
          sourceReason: "immediate.gateway-batch-overflow",
        },
      },
    );
  }
}

async function drainEvents(): Promise<void> {
  if (draining || !cmd || !enqueuePrompt) return;
  draining = true;

  try {
    const raw = await cmd.lrange(EVENT_LIST, 0, -1);
    if (raw.length === 0) return;

    let events: SystemEvent[] = [];
    for (const item of raw.reverse()) {
      const event = parseEvent(item);
      if (!event) continue;
      if (seenIds.has(event.id)) continue;
      seenIds.add(event.id);
      events.push(event);
    }

    pruneSeenIds();

    if (events.length === 0) {
      await cmd.del(EVENT_LIST);
      return;
    }

    const compatHandledIds = new Set<string>();
    for (const event of events) {
      try {
        const result = await routeNotifySendCompat(event, {
          send: sendChatSdk,
        });
        if (!result.handled) continue;
        compatHandledIds.add(event.id);
        const telemetry = notifyCompatTelemetry(result.disposition);
        void emitGatewayOtel({
          ...telemetry,
          component: "redis-channel",
          metadata: {
            eventId: event.id,
            flowId: result.receipt.data.flowId,
            platform: result.receipt.data.platform,
            deliveryState: result.receipt.data.deliveryState,
            platformMessageId: result.receipt.data.platformMessageId,
          },
        });
      } catch (error) {
        if (error instanceof NotifyCompatDeliveryError) {
          // The SDK may have delivered before a later journal/index failure.
          // Never create a duplicate by falling through to legacy.
          compatHandledIds.add(event.id);
        }
        void emitGatewayOtel({
          level: "error",
          component: "redis-channel",
          action: "notify.compat_v2.failed",
          success: false,
          error: summarizeChannelError(error),
          metadata: { eventId: event.id },
        });
      }
    }
    if (compatHandledIds.size > 0) {
      events = events.filter((event) => !compatHandledIds.has(event.id));
    }
    if (events.length === 0) {
      await cmd.del(EVENT_LIST);
      return;
    }

    // ── Three-tier event triage (bias-to-action triangle) ────────
    //
    // 🔺 IMMEDIATE — forward to agent now (actionable, needs response)
    // 🔸 BATCHED   — accumulate in Redis, flush as correlated signal digest
    // 🟪 INGESTED  — keep for relay bookkeeping/context without operator delivery
    // ⬛ SUPPRESSED — drop silently (echoes, telemetry, noise)
    //
    const suppressed: SystemEvent[] = [];
    const ingested: SystemEvent[] = [];
    const batched: SystemEvent[] = [];
    const immediate: SystemEvent[] = [];
    const triageReasonCounts: Record<TriageBucket, Record<string, number>> = {
      immediate: {},
      batched: {},
      ingested: {},
      suppressed: {},
    };
    const triageDecisions = new Map<
      string,
      { classification: TriageBucket; reason: string }
    >();

    const assign = (bucket: TriageBucket, event: SystemEvent, reason: string) => {
      if (bucket === "immediate") immediate.push(event);
      if (bucket === "batched") batched.push(event);
      if (bucket === "ingested") ingested.push(event);
      if (bucket === "suppressed") suppressed.push(event);
      triageDecisions.set(event.id, { classification: bucket, reason });
      incrementCount(triageReasonCounts[bucket], reason);
    };

    for (const e of events) {
      if (isHeartbeatOkEvent(e)) {
        if (Date.now() - lastUserVisibleHeartbeatAt < ONE_HOUR_MS) {
          assign("suppressed", e, "suppressed.heartbeat-ok-within-hour");
        } else {
          lastUserVisibleHeartbeatAt = Date.now();
          assign("batched", e, "batched.heartbeat-ok-hourly-window");
        }
        continue;
      }

      const decision = classifyOperatorSignal(e, { quietHours: isQuietHours() });
      assign(decision.bucket, e, decision.reason);
    }

    // Stash batched events in Redis for hourly digest
    await appendToBatch(batched, "triage");

    if (suppressed.length > 0) {
      console.log(`[redis] suppressed ${suppressed.length} noise event(s): ${suppressed.map(e => e.type).join(", ")}`);
    }
    if (ingested.length > 0) {
      console.log(`[redis] ingested ${ingested.length} context-only event(s): ${ingested.map((event) => event.type).join(", ")}`);
    }
    void emitGatewayOtel({
      level: "debug",
      component: "redis-channel",
      action: "events.triaged",
      success: true,
      metadata: {
        total: events.length,
        immediate: immediate.length,
        batched: batched.length,
        ingested: ingested.length,
        suppressed: suppressed.length,
        reasons: triageReasonCounts,
        immediateTypes: summarizeTypeCounts(immediate),
        batchedTypes: summarizeTypeCounts(batched),
        ingestedTypes: summarizeTypeCounts(ingested),
        suppressedTypes: summarizeTypeCounts(suppressed),
      },
    });

    let actionable = immediate;
    const modeEvents = actionable.filter((event) => event.type === "gateway/sleep" || event.type === "gateway/wake");
    if (modeEvents.length > 0) {
      for (const event of modeEvents) {
        if (event.type === "gateway/sleep") {
          await sleepGateway();
        } else if (event.type === "gateway/wake") {
          await wakeGateway();
        }
      }
      actionable = actionable.filter((event) => event.type !== "gateway/sleep" && event.type !== "gateway/wake");
    }

    const mode = await getGatewayMode();
    let wokeFromTelegram = false;

    if (mode === "sleep" && actionable.length > 0) {
      const heartbeatWhileSleep = actionable.filter((event) => event.type === "cron.heartbeat");
      const telegramWhileSleep = actionable.filter((event) => event.type === "telegram.message.received");
      const immediateWhileSleep = actionable.filter(
        (event) => event.type !== "cron.heartbeat" && event.type !== "telegram.message.received"
      );

      if (heartbeatWhileSleep.length > 0) {
        console.log(
          `[redis] sleep mode: ignored ${heartbeatWhileSleep.length} heartbeat event(s): ${heartbeatWhileSleep
            .map((event) => event.id)
            .join(", ")}`
        );
      }

      await appendToBatch(immediateWhileSleep, "sleep-mode immediate deferral");

      actionable = telegramWhileSleep;
      wokeFromTelegram = telegramWhileSleep.length > 0;
    }

    const immediateTelegramEvents = actionable.filter(isImmediateTelegramEvent);
    if (immediateTelegramEvents.length > 0) {
      try {
        await sendImmediateTelegramEscalation(immediateTelegramEvents, triageDecisions);
        void emitGatewayOtel({
          level: "info",
          component: "redis-channel",
          action: "events.immediate_telegram",
          success: true,
          metadata: {
            count: immediateTelegramEvents.length,
            eventTypes: immediateTelegramEvents.map((event) => event.type),
          },
        });
      } catch (error) {
        console.error("[gateway:redis] immediate telegram escalation failed", { error });
        void emitGatewayOtel({
          level: "error",
          component: "redis-channel",
          action: "events.immediate_telegram",
          success: false,
          error: summarizeChannelError(error),
          metadata: {
            count: immediateTelegramEvents.length,
            eventTypes: immediateTelegramEvents.map((event) => event.type),
          },
        });
      }
    }

    const immediateTelegramOnlyCount = actionable.filter(isTelegramOnlyImmediateEvent).length;
    if (immediateTelegramOnlyCount > 0) {
      actionable = actionable.filter((event) => !isTelegramOnlyImmediateEvent(event));
      void emitGatewayOtel({
        level: "debug",
        component: "redis-channel",
        action: "events.immediate_telegram_only",
        success: true,
        metadata: {
          count: immediateTelegramOnlyCount,
        },
      });
    }

    // Nothing immediate? Clear the queue and wait
    if (actionable.length === 0) {
      await cmd.del(EVENT_LIST);
      void emitGatewayOtel({
        level: "debug",
        component: "redis-channel",
        action: "events.noop",
        success: true,
      });
      return;
    }

    // Check if any event has an originSession — route response back to that channel
    const originSession = actionable.find(
      (e) => typeof e.payload?.originSession === "string" && e.payload.originSession
    )?.payload?.originSession as string | undefined;

    // Use originSession as source if it's a channel (telegram:*, etc.)
    // so the response routes back to the originating channel, not console
    const source = originSession?.includes(":") ? originSession : SESSION_ID;

    const prompt = await buildPrompt(actionable);
    if (!prompt) {
      // All events filtered (e.g. stale cron.heartbeat) — nothing to enqueue
      return;
    }
    const hasInteractiveEvent = actionable.some((event) => isInteractiveEvent(event));
    const hasHumanMessageEvent = actionable.some((event) => isHumanInboundMessageEvent(event));
    const backgroundOnly = !hasInteractiveEvent && !hasHumanMessageEvent;
    const eventTypes = Array.from(new Set(actionable.map((event) => event.type)));
    const onlyActionable = actionable.length === 1 ? actionable[0] : undefined;
    const eventSources = Array.from(new Set(actionable.map((event) => event.source)));
    const policySourceEventType = selectPolicySourceEventType(actionable);
    const policySourceEvent = actionable.find((event) => event.type === policySourceEventType);
    const sourceTriageDecision = policySourceEvent
      ? triageDecisions.get(policySourceEvent.id)
      : undefined;
    const channelAudit: ChannelAuditSeed | undefined = onlyActionable
      ? parseChannelAudit(onlyActionable.payload.audit) ?? {
          flowId: `gateway-event:${onlyActionable.id}`,
          producer: onlyActionable.source,
          eventId: onlyActionable.id,
          requestedAtMs: onlyActionable.ts,
          route: "redis-prompt",
        }
      : actionable[0]
        ? {
            flowId: `gateway-event-batch:${actionable[0].id}:${actionable.length}`,
            producer: eventSources.length === 1
              ? eventSources[0]
              : `gateway-event-batch:${eventSources.join(",")}`,
            requestedAtMs: Math.min(...actionable.map((event) => event.ts)),
            route: "redis-prompt-batch",
          }
        : undefined;

    await enqueuePrompt(source, prompt, {
      eventCount: actionable.length,
      eventIds: actionable.map((event) => event.id),
      eventTypes,
      eventSources,
      policySourceEventType,
      signalClassification: sourceTriageDecision?.classification,
      signalReason: sourceTriageDecision?.reason,
      eventPriorities: actionable
        .map((event) => signalPriority(event.payload))
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
      eventLevels: actionable
        .map((event) => signalLevel(event.payload))
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
      originSession,
      backgroundOnly,
      sourceKind: getSourceKind(source),
      ...(channelAudit ? { channelAudit } : {}),
    });
    void emitGatewayOtel({
      level: "info",
      component: "redis-channel",
      action: "events.dispatched",
      success: true,
      metadata: {
        source,
        sourceKind: getSourceKind(source),
        originSession,
        eventCount: actionable.length,
        eventTypes,
        hasInteractiveEvent,
        hasHumanMessageEvent,
        backgroundOnly,
      },
    });

    if (backgroundOnly) {
      void emitGatewayOtel({
        level: "debug",
        component: "redis-channel",
        action: "events.dispatched.background_only",
        success: true,
        metadata: {
          source,
          sourceKind: getSourceKind(source),
          eventCount: actionable.length,
          eventTypes,
          originSession,
        },
      });
    }

    if (wokeFromTelegram) {
      await wakeGateway({ flushDigest: false });
      console.log("[redis] sleep mode wake triggered by telegram.message.received");
    }

    await cmd.del(EVENT_LIST);
  } catch (error) {
    console.error("[gateway:redis] failed to drain events", { error });
    void emitGatewayOtel({
      level: "error",
      component: "redis-channel",
      action: "events.drain.failed",
      success: false,
      error: String(error),
    });
  } finally {
    draining = false;
  }
}

async function migrateLegacyEvents(): Promise<void> {
  if (!cmd) return;

  const legacyRaw = await cmd.lrange(LEGACY_EVENT_LIST, 0, -1);
  if (legacyRaw.length === 0) return;

  for (const item of legacyRaw) {
    await cmd.lpush(EVENT_LIST, item);
  }

  await cmd.del(LEGACY_EVENT_LIST);
  console.log("[gateway:redis] migrated legacy events", { count: legacyRaw.length });
}

// ── Self-healing: retry start on Redis failure ───────
type RedisRecoveredFn = (client: Redis) => void | Promise<void>;

let _startEnqueue: EnqueueFn | undefined;
let _onRecovered: RedisRecoveredFn | undefined;
let _needsRecoveryRebind = false;
let _retryTimer: ReturnType<typeof setTimeout> | undefined;
const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
let _retryCount = 0;

function scheduleRetry(): void {
  if (_retryTimer || !_startEnqueue) return;
  const delay = Math.min(RETRY_DELAY_MS * Math.pow(2, _retryCount), MAX_RETRY_DELAY_MS);
  _retryCount++;
  updateRuntimeState("redis_degraded", "reconnect_scheduled", {
    reconnectAttempts: _retryCount,
  });
  console.log(`[gateway:redis] scheduling reconnect in ${delay}ms (attempt ${_retryCount})`);
  _retryTimer = setTimeout(async () => {
    _retryTimer = undefined;
    if (started) return; // recovered via ioredis retry
    try {
      await doStart(_startEnqueue!);
    } catch (error) {
      console.error("[gateway:redis] reconnect failed", { error });
      scheduleRetry();
    }
  }, delay);
}

async function doStart(enqueue: EnqueueFn): Promise<void> {
  enqueuePrompt = enqueue;
  const needsRecoveryRebind = _needsRecoveryRebind;

  // Manual retry replaces the pair. Dispose the previous ioredis clients first;
  // otherwise every failed attempt keeps its own retry loop and error listeners.
  disposeRedisClients();
  const nextSub = new Redis(redisOpts);
  const nextCmd = new Redis(redisOpts);
  sub = nextSub;
  cmd = nextCmd;

  let subReady = false;
  let cmdReady = false;
  const markRecovered = () => {
    if (!subReady || !cmdReady) return;
    _retryCount = 0;
    flushRedisErrorSummary("subscriber");
    flushRedisErrorSummary("command");
  };
  nextSub.on("ready", () => { subReady = true; markRecovered(); });
  nextCmd.on("ready", () => { cmdReady = true; markRecovered(); });

  nextSub.on("error", (error: unknown) => {
    emitRedisClientError("subscriber", error);
  });
  nextCmd.on("error", (error: unknown) => {
    emitRedisClientError("command", error);
  });

  // On disconnect, mark as not started and schedule reconnect.
  nextSub.on("close", () => {
    subReady = false;
    if (started) {
      console.warn("[gateway:redis] subscriber disconnected — will reconnect");
      started = false;
      _needsRecoveryRebind = true;
      scheduleRetry();
    }
  });
  nextCmd.on("close", () => {
    cmdReady = false;
    if (started) {
      console.warn("[gateway:redis] command client disconnected — will reconnect");
      started = false;
      _needsRecoveryRebind = true;
      scheduleRetry();
    }
  });

  try {
    await nextSub.connect();
    await nextCmd.connect();

    await nextCmd.sadd(SESSIONS_SET, SESSION_ID);
    await nextSub.subscribe(NOTIFY_CHANNEL);
    await nextSub.subscribe(LEGACY_NOTIFY_CHANNEL);
  } catch (error) {
    // A failed pair must not survive into the next manual retry. Leaving it
    // alive creates one ioredis retry loop per attempt and an exponential
    // telemetry storm during a long Redis outage.
    disposeRedisClients(nextSub, nextCmd);
    throw error;
  }

  nextSub.on("message", () => {
    void drainEvents();
  });

  await migrateLegacyEvents();
  await drainEvents();

  started = true;
  updateRuntimeState("normal", "redis_connected", {
    reconnectAttempts: _retryCount,
  });
  console.log("[gateway:redis] started", {
    sessionId: SESSION_ID,
    channels: [NOTIFY_CHANNEL, LEGACY_NOTIFY_CHANNEL],
    list: EVENT_LIST,
  });
  void emitGatewayOtel({
    level: "info",
    component: "redis-channel",
    action: "redis.channel.started",
    success: true,
    metadata: {
      sessionId: SESSION_ID,
    },
  });

  if (needsRecoveryRebind && _onRecovered) {
    try {
      await _onRecovered(nextCmd);
      if (cmd === nextCmd) _needsRecoveryRebind = false;
    } catch (error) {
      console.error("[gateway:redis] recovery rebind failed", { error });
      void emitGatewayOtel({
        level: "error",
        component: "redis-channel",
        action: "redis.recovery.rebind.failed",
        success: false,
        error: String(error),
      });
    }
  } else if (needsRecoveryRebind) {
    _needsRecoveryRebind = false;
  }
}

export async function start(
  enqueue: EnqueueFn,
  options?: { onRecovered?: RedisRecoveredFn },
): Promise<void> {
  if (started) return;
  _startEnqueue = enqueue;
  _onRecovered = options?.onRecovered;
  try {
    await doStart(enqueue);
  } catch (error) {
    const lastError = String(error);
    _needsRecoveryRebind = true;
    console.error("[gateway:redis] initial connect failed — will retry", { error });
    updateRuntimeState("redis_degraded", "initial_connect_failed", {
      lastError,
      reconnectAttempts: _retryCount,
    });
    scheduleRetry();
  }
}

/**
 * Flush batched events as a single digest prompt.
 * Called by heartbeat runner on hourly cadence.
 * Returns the number of events flushed.
 */
export async function flushBatchDigest(): Promise<number> {
  if (!cmd || !enqueuePrompt) return 0;

  const mode = await getGatewayMode();
  if (mode === "sleep") {
    console.log("[redis] batch digest skipped (sleep mode)");
    return 0;
  }

  // ADR-0211: Skip digest flush during quiet hours to prevent
  // unnecessary prompts that cause fallback thrash on bloated sessions.
  // Batched events accumulate and flush on next wake-hours digest.
  if (isQuietHours()) {
    console.log("[redis] batch digest deferred (quiet hours)");
    return 0;
  }

  const raw = await cmd.lrange(BATCH_LIST, 0, -1);
  if (raw.length === 0) return 0;

  await cmd.del(BATCH_LIST);

  const events: SystemEvent[] = [];
  for (const item of raw) {
    const event = parseEvent(item);
    if (event) events.push(event);
  }

  if (events.length === 0) return 0;

  if (events.every(isLowSignalDigestEvent)) {
    console.log("[redis] batch digest suppressed (low-signal only)", {
      count: events.length,
      eventTypes: events.map((event) => event.type),
    });
    return 0;
  }

  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }

  const prompt = buildSignalDigestPrompt(events);
  if (!prompt) return 0;

  await enqueuePrompt(SESSION_ID, prompt, {
    eventCount: events.length,
    digestTypes: Object.fromEntries(counts),
  });

  console.log(`[redis] flushed batch digest: ${events.length} events across ${counts.size} types`);
  void emitGatewayOtel({
    level: "info",
    component: "redis-channel",
    action: "batch.flushed",
    success: true,
    metadata: {
      count: events.length,
      kinds: counts.size,
    },
  });
  return events.length;
}

export const __redisTestUtils = {
  isImmediateTelegramEvent,
  selectPolicySourceEventType,
};

/** Is the Redis channel healthy and connected? */
export function isHealthy(): boolean {
  return started && sub?.status === "ready" && cmd?.status === "ready";
}

export function getRedisClient(): Redis | undefined {
  return cmd;
}

export async function pushGatewayEvent(input: {
  type: string;
  source: string;
  payload: Record<string, unknown>;
}): Promise<SystemEvent | null> {
  if (!cmd) return null;

  const event: SystemEvent = {
    id: crypto.randomUUID(),
    type: input.type,
    source: input.source,
    payload: input.payload,
    ts: Date.now(),
  };

  const json = JSON.stringify(event);
  const notification = JSON.stringify({ eventId: event.id, type: event.type });

  await cmd.lpush(EVENT_LIST, json);
  await cmd.publish(NOTIFY_CHANNEL, notification);
  return event;
}

export async function shutdown(): Promise<void> {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = undefined;
  }
  _startEnqueue = undefined;
  _onRecovered = undefined;
  _needsRecoveryRebind = false;
  flushRedisErrorSummary("subscriber");
  flushRedisErrorSummary("command");

  try {
    const cleanupClient = cmd;
    if (cleanupClient?.status === "ready") {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([
          cleanupClient.srem(SESSIONS_SET, SESSION_ID),
          cleanupClient.del(EVENT_LIST),
        ]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 2_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
  } catch (error) {
    console.error("[gateway:redis] cleanup failed", { error });
  } finally {
    // Process shutdown does not need a Redis round trip to unsubscribe. A
    // direct disconnect is bounded even while Redis is unavailable.
    if (sub) {
      sub.disconnect();
      sub = undefined;
    }

    if (cmd) {
      cmd.disconnect();
      cmd = undefined;
    }

    started = false;
    updateRuntimeState("redis_degraded", "shutdown", {
      reconnectAttempts: 0,
    });
  }
}
