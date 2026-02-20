import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import Redis from "ioredis";

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
const HEARTBEAT_PATH = `${homedir()}/Vault/HEARTBEAT.md`;
const DEDUP_MAX = 500;

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

async function readHeartbeatChecklist(): Promise<string> {
  try {
    return await readFile(HEARTBEAT_PATH, "utf8");
  } catch {
    return "# Heartbeat\n\n_No HEARTBEAT.md found at ~/Vault/HEARTBEAT.md_";
  }
}

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

async function buildPrompt(events: SystemEvent[]): Promise<string> {
  const firstEvent = events[0];
  const isHeartbeatOnly = events.length === 1 && firstEvent?.type === "cron.heartbeat";
  const eventBlock = formatEvents(events);
  const ts = new Date().toISOString();

  if (!isHeartbeatOnly) {
    return [
      `## 🔔 Gateway — ${ts}`,
      "",
      `${events.length} event(s):`,
      eventBlock,
      "",
      "Take action on anything that needs it, otherwise acknowledge briefly.",
    ].join("\n");
  }

  const heartbeat = await readHeartbeatChecklist();
  return [
    `## 🔔 Heartbeat — ${ts}`,
    "",
    eventBlock,
    "",
    heartbeat,
  ].join("\n");
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
      // media.processed — removed: gateway.notify() uses this type and it was being suppressed
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

    // Nothing immediate? Clear the queue and wait
    if (actionable.length === 0) {
      await cmd.del(EVENT_LIST);
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
    await enqueuePrompt(source, prompt, {
      eventCount: actionable.length,
      eventIds: actionable.map((event) => event.id),
      originSession,
    });

    if (wokeFromTelegram) {
      await wakeGateway({ flushDigest: false });
      console.log("[redis] sleep mode wake triggered by telegram.message.received");
    }

    await cmd.del(EVENT_LIST);
  } catch (error) {
    console.error("[gateway:redis] failed to drain events", { error });
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
  });
  cmd.on("error", (error: unknown) => {
    console.error("[gateway:redis] command client error", { error });
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

  const ts = new Date().toISOString();
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
