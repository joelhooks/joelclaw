import { mkdir, rm, writeFile } from "node:fs/promises";
import type { FlowIdType } from "@joelclaw/message-contract";
import {
  getMessageEventLogClient,
  type MessagePlatform,
} from "@joelclaw/message-event-log";
import Redis from "ioredis";
import {
  getChatSdkRuntime,
  startChatSdkRuntime,
} from "./chat-sdk/instance";
import {
  routeNotifySendToSlimTransport,
  type SlimNotifyGatewayEvent,
  SlimNotifyIngressError,
} from "./chat-sdk/notify-stream";
import { registerChatSdkActingInbound } from "./chat-sdk-inbound/acting";
import { createStreamInboundPublisher } from "./chat-sdk-inbound/publish";

const SESSION_ID = "gateway";
const SESSIONS_SET = "joelclaw:gateway:sessions";
const EVENT_LIST = "joelclaw:events:gateway";
const LEGACY_EVENT_LIST = "joelclaw:events:main";
const NOTIFY_CHANNEL = "joelclaw:notify:gateway";
const LEGACY_NOTIFY_CHANNEL = "joelclaw:notify:main";
const PID_DIR = "/tmp/joelclaw";
const PID_FILE = `${PID_DIR}/gateway.pid`;

function redisOptions() {
  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt: number) => Math.min(attempt * 500, 30_000),
  } as const;
}

function parseEvent(raw: string): SlimNotifyGatewayEvent | undefined {
  try {
    const value = JSON.parse(raw) as Partial<SlimNotifyGatewayEvent>;
    if (
      typeof value.id !== "string"
      || typeof value.type !== "string"
      || typeof value.source !== "string"
      || !value.payload
      || typeof value.payload !== "object"
    ) {
      return undefined;
    }
    return {
      id: value.id,
      type: value.type,
      source: value.source,
      payload: value.payload,
      ts: typeof value.ts === "number" ? value.ts : Date.now(),
    };
  } catch {
    return undefined;
  }
}

async function resolveFlowId(
  redis: Redis,
  platform: MessagePlatform,
  platformMessageId: string,
  conversationId?: string,
): Promise<FlowIdType | undefined> {
  const candidates = [
    `${platform}:${platformMessageId}`,
    ...(conversationId
      ? [`${platform}:${conversationId}:${platformMessageId}`]
      : []),
  ];
  for (const key of candidates) {
    const flowId = await redis.get(`joelclaw:message-contract:message:${key}`);
    if (flowId) return flowId as FlowIdType;
  }
  return undefined;
}

export async function startSlimTransportDaemon(): Promise<void> {
  if (process.env.GATEWAY_TRANSPORT_SLIM_DOWN !== "1") {
    throw new Error("Slim transport requires GATEWAY_TRANSPORT_SLIM_DOWN=1");
  }

  const command = new Redis(redisOptions());
  const subscriber = new Redis(redisOptions());
  await Promise.all([command.connect(), subscriber.connect()]);

  const runtime = getChatSdkRuntime({
    telegramEnabled: Boolean(process.env.TELEGRAM_USER_ID?.trim()),
    slackEnabled: Boolean(process.env.SLACK_ALLOWED_USER_ID?.trim()),
    discordEnabled: Boolean(process.env.DISCORD_ALLOWED_USER_ID?.trim()),
  });
  const eventLog = getMessageEventLogClient();
  const resolveInboundFlow = (
    platform: MessagePlatform,
    platformMessageId: string,
    conversationId?: string,
  ) => resolveFlowId(command, platform, platformMessageId, conversationId);

  registerChatSdkActingInbound(runtime, {
    enqueue: async () => {
      throw new Error("Slim transport cannot enqueue the retired gateway agent");
    },
    publisher: createStreamInboundPublisher({
      eventLog,
      resolveFlowId: resolveInboundFlow,
    }),
    transportOnly: true,
    resolveFlowId: resolveInboundFlow,
    publishReaction: async () => {},
    allowedActorIds: {
      ...(process.env.TELEGRAM_USER_ID?.trim()
        ? { telegram: process.env.TELEGRAM_USER_ID.trim() }
        : {}),
      ...(process.env.SLACK_ALLOWED_USER_ID?.trim()
        ? { slack: process.env.SLACK_ALLOWED_USER_ID.trim() }
        : {}),
      ...(process.env.DISCORD_ALLOWED_USER_ID?.trim()
        ? { discord: process.env.DISCORD_ALLOWED_USER_ID.trim() }
        : {}),
    },
    onError: (error, phase, event) => {
      console.error("[gateway:transport] inbound append failed", {
        phase,
        eventId: event.eventId,
        error: String(error),
      });
    },
  });

  await startChatSdkRuntime();
  await command.sadd(SESSIONS_SET, SESSION_ID);
  await subscriber.subscribe(NOTIFY_CHANNEL, LEGACY_NOTIFY_CHANNEL);
  await mkdir(PID_DIR, { recursive: true });
  await writeFile(PID_FILE, `${process.pid}\n`, "utf8");

  let draining = false;
  let drainPending = false;
  const drain = async (): Promise<void> => {
    if (draining) {
      drainPending = true;
      return;
    }
    draining = true;
    try {
      do {
        drainPending = false;
        for (const list of [EVENT_LIST, LEGACY_EVENT_LIST]) {
          const rawEvents = await command.lrange(list, 0, -1);
          for (const raw of rawEvents.reverse()) {
            const event = parseEvent(raw);
            if (!event) {
              console.error("[gateway:transport] removing malformed queue row", { list });
              await command.lrem(list, 1, raw);
              continue;
            }
            try {
              const result = await routeNotifySendToSlimTransport(event, {
                eventLog,
                heartbeatExists: async () =>
                  (await command.exists("gateway:agent:heartbeat")) === 1,
              });
              if (!result.handled) {
                console.log("[gateway:transport] removing non-message queue row", {
                  eventId: event.id,
                  type: event.type,
                });
              }
              await command.lrem(list, 1, raw);
            } catch (error) {
              if (error instanceof SlimNotifyIngressError && error.handled) {
                // A fallback send may already have crossed Telegram. Remove the
                // queue row and leave reconciliation to the stream consumer.
                await command.lrem(list, 1, raw);
                continue;
              }
              throw error;
            }
          }
        }
      } while (drainPending);
    } finally {
      draining = false;
    }
  };

  subscriber.on("message", () => {
    void drain().catch((error) => {
      console.error("[gateway:transport] notify drain failed", { error: String(error) });
    });
  });
  await drain();

  const shutdown = async (signal: string): Promise<void> => {
    console.log("[gateway:transport] shutting down", { signal });
    await Promise.allSettled([
      runtime.stop(),
      command.srem(SESSIONS_SET, SESSION_ID),
      subscriber.quit(),
      command.quit(),
    ]);
    await rm(PID_FILE, { force: true });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  console.log("[gateway:transport] slim transport ready", {
    fallbackChannel: process.env.FALLBACK_CHANNEL?.trim() || "telegram",
    configured: runtime.configured,
  });
}

if (import.meta.main) {
  await startSlimTransportDaemon();
}
