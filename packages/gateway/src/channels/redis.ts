import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import Redis from "ioredis";

export type EnqueueFn = (source: string, prompt: string, metadata?: Record<string, unknown>) => void;

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

    // Check if any event has an originSession — route response back to that channel
    const originSession = events.find(
      (e) => typeof e.payload?.originSession === "string" && e.payload.originSession
    )?.payload?.originSession as string | undefined;

    // Use originSession as source if it's a channel (telegram:*, etc.)
    // so the response routes back to the originating channel, not console
    const source = originSession?.includes(":") ? originSession : SESSION_ID;

    const prompt = await buildPrompt(events);
    enqueuePrompt(source, prompt, {
      eventCount: events.length,
      eventIds: events.map((event) => event.id),
      originSession,
    });
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

export async function start(enqueue: EnqueueFn): Promise<void> {
  if (started) return;

  enqueuePrompt = enqueue;
  sub = new Redis(redisOpts);
  cmd = new Redis(redisOpts);

  sub.on("error", (error: unknown) => {
    console.error("[gateway:redis] subscriber error", { error });
  });
  cmd.on("error", (error: unknown) => {
    console.error("[gateway:redis] command client error", { error });
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

export async function shutdown(): Promise<void> {
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
