import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import Redis from "ioredis";
import { enrichPromptWithVaultContext } from "@joelclaw/vault-reader";
import { send as sendTelegram, type InlineButton } from "./telegram";
import type { OutboundEnvelope } from "../outbound/envelope";
import { emitGatewayOtel } from "../observability";

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
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID
  ? parseInt(process.env.TELEGRAM_USER_ID, 10)
  : undefined;

const redisOpts = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
  lazyConnect: true,
  retryStrategy: (times: number) => Math.min(times * 500, 30_000),
};

let sub: Redis | undefined;
let cmd: Redis | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let started = false;
let draining = false;
const seenIds = new Set<string>();

type GatewayMode = "active" | "sleep";

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
  const mode = await cmd.get(MODE_KEY);
  return normalizeMode(mode);
}

async function setGatewayMode(mode: GatewayMode): Promise<void> {
  if (!cmd) return;
  await cmd.set(MODE_KEY, mode);
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
  const footer = "Take action on anything that needs it, otherwise acknowledge briefly.";
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).replace(" ", "T") + " PST";

  // cron.heartbeat no longer triggers HEARTBEAT.md checklist in the gateway.
  // Health checks run as Inngest check/* functions and push here only when actionable.
  // Filter out stale cron.heartbeat events if they somehow arrive.
  events = events.filter((event) => event.type !== "cron.heartbeat");
  if (events.length === 0) return ""; // nothing actionable

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

function isImmediateTelegramEvent(event: SystemEvent): boolean {
  const payload = event.payload as Record<string, unknown>;
  return (
    event.type === "system.fatal" ||
    payload.immediateTelegram === true ||
    payload.level === "fatal"
  );
}

function isTelegramOnlyImmediateEvent(event: SystemEvent): boolean {
  if (!isImmediateTelegramEvent(event)) return false;
  const payload = event.payload as Record<string, unknown>;
  return payload.telegramOnly === true;
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

async function sendImmediateTelegramEscalation(events: SystemEvent[]): Promise<void> {
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
    });
  }

  if (legacyEvents.length === 0) return;

  const lines = [
    "## Immediate Escalation",
    "",
    ...legacyEvents.slice(0, 5).map((event) => {
      const prompt = typeof event.payload.prompt === "string" ? event.payload.prompt : "";
      const detail = prompt ? `\n${prompt}` : "";
      return `- ${event.type} (${event.source})${detail}`;
    }),
  ];

  await sendTelegram(TELEGRAM_USER_ID, lines.join("\n"));
}

async function drainEvents(): Promise<void> {
  if (draining || !cmd || !enqueuePrompt) return;
  draining = true;

  try {
    const raw = await cmd.lrange(EVENT_LIST, 0, -1);
    if (raw.length === 0) return;

    const events: SystemEvent[] = [];
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

    // ── Three-tier event triage (bias-to-action triangle) ────────
    //
    // 🔺 IMMEDIATE — forward to agent now (actionable, needs response)
    // 🔸 BATCHED   — accumulate in Redis, flush as hourly digest
    // ⬛ SUPPRESSED — drop silently (echoes, telemetry, noise)
    //
    const SUPPRESSED_TYPES = new Set([
      "todoist.task.completed",  // echo from agent's own closes
      "memory.observed",         // telemetry confirmation
      "content.synced",          // vault sync confirmation
      "media/received",          // media pipeline progress - fires 5+ times per image, no agent action needed
      "progress",                // inngest step progress events — noisy, not actionable
    ]);

    const BATCHED_TYPES = new Set([
      "todoist.task.created",      // agent-created task echo
      "todoist.task.deleted",      // no action needed
      "front.message.received",    // inbound email — triage runs on schedule
      "front.message.sent",        // outbound email echo
      "front.assignee.changed",    // low signal assignment change
      "vercel.deploy.succeeded",   // success is default
      "vercel.deploy.created",     // deploy started, nothing to do
      "vercel.deploy.canceled",    // rare, no action
      "discovery.captured",        // captured for later
      "meeting.analyzed",          // Granola meeting summaries
    ]);

    const suppressed: SystemEvent[] = [];
    const batched: SystemEvent[] = [];
    const immediate: SystemEvent[] = [];

    for (const e of events) {
      if (SUPPRESSED_TYPES.has(e.type)) {
        suppressed.push(e);
      } else if (BATCHED_TYPES.has(e.type)) {
        batched.push(e);
      } else {
        immediate.push(e);
      }
    }

    // Stash batched events in Redis for hourly digest
    await appendToBatch(batched, "triage");

    if (suppressed.length > 0) {
      console.log(`[redis] suppressed ${suppressed.length} noise event(s): ${suppressed.map(e => e.type).join(", ")}`);
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
        suppressed: suppressed.length,
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
      await sendImmediateTelegramEscalation(immediateTelegramEvents).catch((error) => {
        console.error("[gateway:redis] immediate telegram escalation failed", { error });
      });
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
    await enqueuePrompt(source, prompt, {
      eventCount: actionable.length,
      eventIds: actionable.map((event) => event.id),
      eventTypes: Array.from(new Set(actionable.map((event) => event.type))),
      originSession,
    });
    void emitGatewayOtel({
      level: "info",
      component: "redis-channel",
      action: "events.dispatched",
      success: true,
      metadata: {
        source,
        eventCount: actionable.length,
      },
    });

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
let _startEnqueue: EnqueueFn | undefined;
let _retryTimer: ReturnType<typeof setTimeout> | undefined;
const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
let _retryCount = 0;

function scheduleRetry(): void {
  if (_retryTimer || !_startEnqueue) return;
  const delay = Math.min(RETRY_DELAY_MS * Math.pow(2, _retryCount), MAX_RETRY_DELAY_MS);
  _retryCount++;
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
  sub = new Redis(redisOpts);
  cmd = new Redis(redisOpts);

  // Track ready state for health checks
  let subReady = false;
  let cmdReady = false;
  sub.on("ready", () => { subReady = true; _retryCount = 0; });
  cmd.on("ready", () => { cmdReady = true; _retryCount = 0; });

  sub.on("error", (error: unknown) => {
    console.error("[gateway:redis] subscriber error", { error });
    void emitGatewayOtel({
      level: "error",
      component: "redis-channel",
      action: "redis.subscriber.error",
      success: false,
      error: String(error),
    });
  });
  cmd.on("error", (error: unknown) => {
    console.error("[gateway:redis] command client error", { error });
    void emitGatewayOtel({
      level: "error",
      component: "redis-channel",
      action: "redis.command.error",
      success: false,
      error: String(error),
    });
  });

  // On disconnect, mark as not started and schedule reconnect
  sub.on("close", () => {
    if (started) {
      console.warn("[gateway:redis] subscriber disconnected — will reconnect");
      started = false;
      scheduleRetry();
    }
  });
  cmd.on("close", () => {
    if (started) {
      console.warn("[gateway:redis] command client disconnected — will reconnect");
      started = false;
      scheduleRetry();
    }
  });

  await sub.connect();
  await cmd.connect();

  await cmd.sadd(SESSIONS_SET, SESSION_ID);
  await sub.subscribe(NOTIFY_CHANNEL);
  await sub.subscribe(LEGACY_NOTIFY_CHANNEL);

  sub.on("message", () => {
    void drainEvents();
  });

  await migrateLegacyEvents();
  await drainEvents();

  started = true;
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
}

export async function start(enqueue: EnqueueFn): Promise<void> {
  if (started) return;
  _startEnqueue = enqueue;
  try {
    await doStart(enqueue);
  } catch (error) {
    console.error("[gateway:redis] initial connect failed — will retry", { error });
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

  const raw = await cmd.lrange(BATCH_LIST, 0, -1);
  if (raw.length === 0) return 0;

  await cmd.del(BATCH_LIST);

  const events: SystemEvent[] = [];
  for (const item of raw) {
    const event = parseEvent(item);
    if (event) events.push(event);
  }

  if (events.length === 0) return 0;

  // Group by type for a compact summary
  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }

  const lines = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `- ${type}: ${count}`);

  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).replace(" ", "T") + " PST";
  const prompt = [
    `## 📋 Batch Digest — ${ts}`,
    "",
    `${events.length} event(s) since last digest:`,
    ...lines,
    "",
    "Acknowledge briefly. Only flag if something looks wrong.",
  ].join("\n");

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

/** Is the Redis channel healthy and connected? */
export function isHealthy(): boolean {
  return started && sub?.status === "ready" && cmd?.status === "ready";
}

export function getRedisClient(): Redis | undefined {
  return cmd;
}

export async function shutdown(): Promise<void> {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = undefined;
  }
  _startEnqueue = undefined;

  try {
    if (cmd) {
      await cmd.srem(SESSIONS_SET, SESSION_ID);
      await cmd.del(EVENT_LIST);
    }
  } catch (error) {
    console.error("[gateway:redis] cleanup failed", { error });
  } finally {
    try {
      if (sub) {
        await sub.unsubscribe(NOTIFY_CHANNEL, LEGACY_NOTIFY_CHANNEL);
      }
    } catch {}

    if (sub) {
      sub.disconnect();
      sub = undefined;
    }

    if (cmd) {
      cmd.disconnect();
      cmd = undefined;
    }

    started = false;
  }
}
