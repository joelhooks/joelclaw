import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { FlowIdType, InboundEvent } from "@joelclaw/message-contract";
import {
  getMessageEventLogClient,
  type MessagePlatform,
} from "@joelclaw/message-event-log";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import Redis from "ioredis";
import {
  sendExplicitSlackAsUser,
  sendExplicitTransport,
} from "./chat-sdk/explicit-send";
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
import { waitForDependencyReadiness } from "./dependency-readiness";
import { drainDeliverDecisions } from "./gateway-decision-executor";
import {
  createRetainedQueueDrainer,
  type RetainedQueueDrainer,
} from "./retained-queue-drainer";
import { SlackThreadSessionRegistry } from "./slack-thread-session";
import {
  createSlackUserWebClient,
  isSlackUserChannelReady,
  resolveSlackChannelNameWithUserFallback,
} from "./slack-user-token-fallback";
import { resolveSlackWorkRequest } from "./slack-work-request";
import {
  assertNoLiveSlimTransportOwner,
  claimSlimTransportOwnership,
} from "./slim-transport-ownership";
import {
  clearSlimTransportReadiness,
  publishSlimTransportReadiness,
  SLIM_TRANSPORT_READY_FILE,
  startChannelRuntimeWithLiveness,
} from "./slim-transport-readiness";
import {
  createHeartbeatGateState,
  makeRedisHeartbeatProbe,
} from "./transport-slim";

const SESSION_ID = "gateway";
const SESSIONS_SET = "joelclaw:gateway:sessions";
const EVENT_LIST = "joelclaw:events:gateway";
const LEGACY_EVENT_LIST = "joelclaw:events:main";
const NOTIFY_CHANNEL = "joelclaw:notify:gateway";
const LEGACY_NOTIFY_CHANNEL = "joelclaw:notify:main";
const PID_DIR = "/tmp/joelclaw";
const PID_FILE = `${PID_DIR}/gateway.pid`;
const HEARTBEAT_FILE = `${PID_DIR}/last-heartbeat.ts`;
const HEARTBEAT_INTERVAL_MS = 15 * 60_000;
const execFileAsync = promisify(execFile);

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

  const eventLog = getMessageEventLogClient();
  await assertNoLiveSlimTransportOwner({ pidFile: PID_FILE });
  const preflightStartedAt = Date.now();
  const preflight = await waitForDependencyReadiness({
    probe: () => eventLog.probe(5_000),
    initialRetryDelayMs: 1_000,
    maxRetryDelayMs: 30_000,
    onFailure: ({ attempt, error, retryInMs }) => {
      if (attempt === 1 || attempt % 10 === 0) {
        console.error("[gateway:transport] message event log preflight waiting", {
          attempt,
          retryInMs,
          error: error instanceof Error ? error.message : "message event log probe failed",
        });
      }
      void emitGatewayOtel({
        level: "warn",
        component: "transport-daemon",
        action: "transport.event_log.preflight_failed",
        success: false,
        error: error instanceof Error ? error.message : "message event log probe failed",
        metadata: { attempt, retryInMs },
      });
    },
  });
  void emitGatewayOtel({
    level: "info",
    component: "transport-daemon",
    action: "transport.event_log.preflight_ready",
    success: true,
    duration_ms: Date.now() - preflightStartedAt,
    metadata: { recoveredAfterAttempts: preflight.attempts },
  });

  const ownershipLease = await claimSlimTransportOwnership({ pidFile: PID_FILE });
  await ownershipLease.clearStaleEvidence([
    PID_FILE,
    HEARTBEAT_FILE,
    SLIM_TRANSPORT_READY_FILE,
  ]);

  const runtime = getChatSdkRuntime({
    telegramEnabled: Boolean(process.env.TELEGRAM_USER_ID?.trim()),
    slackEnabled: Boolean(process.env.SLACK_ALLOWED_USER_ID?.trim()),
    discordEnabled: Boolean(process.env.DISCORD_ALLOWED_USER_ID?.trim()),
  });
  const resolveInboundFlow = (
    platform: MessagePlatform,
    platformMessageId: string,
    conversationId?: string,
  ) => resolveFlowId(command, platform, platformMessageId, conversationId);
  const slackChannelNames = new Map<string, string>();
  const slackUserWebClient = createSlackUserWebClient();
  const slackThreadSessions = new SlackThreadSessionRegistry();
  const slackThreadReapIntervalMs = Number.parseInt(
    process.env.SLACK_SHITRAT_THREAD_REAP_INTERVAL_MS ?? "60000",
    10,
  );
  const requestSlackThreadReap = async (): Promise<void> => {
    const pluginServer = "/Users/joel/Code/joelhooks/joelclaw/prototypes/agent-comms-gateway/claude-plugin/server/slack-thread-reap.mjs";
    const result = await execFileAsync("bun", [pluginServer], {
      timeout: 30_000,
      env: process.env,
    });
    const retired = JSON.parse(result.stdout.trim() || "{\"retired\":[]}") as {
      readonly retired?: readonly string[];
    };
    if ((retired.retired?.length ?? 0) === 0) return;
    void emitGatewayOtel({
      level: "info",
      component: "slack-shitrat",
      action: "slack.shitrat.thread_sessions_retired",
      success: true,
      metadata: { count: retired.retired!.length, threadIds: retired.retired },
    });
  };
  const slackThreadReapTimer = setInterval(() => {
    void requestSlackThreadReap().catch((error) => {
      console.error("[gateway:transport] Slack thread session reap failed", {
        error: String(error),
      });
      void emitGatewayOtel({
        level: "error",
        component: "slack-shitrat",
        action: "slack.shitrat.thread_session_reap_failed",
        success: false,
        error: String(error),
      });
    });
  }, Number.isFinite(slackThreadReapIntervalMs)
    ? Math.max(5_000, slackThreadReapIntervalMs)
    : 60_000);
  slackThreadReapTimer.unref?.();
  const resolveSlackChannelName = async (channelId: string): Promise<string | undefined> => {
    const cached = slackChannelNames.get(channelId);
    if (cached) return cached;
    const name = await resolveSlackChannelNameWithUserFallback({
      channelId,
      botClient: runtime.adapters.slack?.webClient,
      userClient: slackUserWebClient,
    });
    if (name) slackChannelNames.set(channelId, name);
    return name;
  };
  const resolveWorkRequest = async (event: InboundEvent) => {
    const request = await resolveSlackWorkRequest({
      event,
      resolveChannelName: resolveSlackChannelName,
      hasActiveThreadSession: async (channelId, threadTs) => {
        const session = await slackThreadSessions.get(channelId, threadTs);
        return Boolean(session && session.status !== "retired");
      },
    });
    if (!request) return undefined;

    const userDeliveryReady = await isSlackUserChannelReady({
      channelId: request.channelId,
      userClient: slackUserWebClient,
    });
    const threadSession = userDeliveryReady
      ? request.activation === "follow-up"
        ? await slackThreadSessions.noteHumanReply(
            request.channelId,
            request.threadTs,
          )
        : await slackThreadSessions.activate({
            channelId: request.channelId,
            channelName: request.channelName,
            threadTs: request.threadTs,
          })
      : undefined;
    const threadMessages = slackUserWebClient?.conversations.replies
      ? await slackUserWebClient.conversations.replies({
          channel: request.channelId,
          ts: request.threadTs,
          limit: 100,
        }).then((value) => value.messages ?? []).catch(() => [])
      : [];
    const threadText = threadMessages
      .map((message) => message.text?.trim())
      .filter((text): text is string => Boolean(text))
      .slice(-24)
      .join("\n")
      .slice(-8_000);
    const resolved = {
      ...request,
      ...(threadSession?.binding ? { binding: threadSession.binding } : {}),
      ...(threadText ? { threadText } : {}),
      botDeliveryReady: false,
      userDeliveryReady,
    };
    void emitGatewayOtel({
      level: userDeliveryReady ? "info" : "error",
      component: "slack-shitrat",
      action: userDeliveryReady
        ? "slack.shitrat.work_requested"
        : "slack.shitrat.user_delivery_unavailable",
      success: userDeliveryReady,
      error: userDeliveryReady
        ? undefined
        : "Joel's Slack token cannot access the originating channel; work request failed closed",
      metadata: {
        channelId: request.channelId,
        channelName: request.channelName,
        threadTs: request.threadTs,
        actorId: event.actor.platformUserId,
        bound: Boolean(threadSession?.binding?.cwd || threadSession?.binding?.repo),
        activation: request.activation,
        threadSessionStatus: threadSession?.status,
      },
    });
    return resolved;
  };

  registerChatSdkActingInbound(runtime, {
    enqueue: async () => {
      throw new Error("Slim transport cannot enqueue the retired gateway agent");
    },
    publisher: createStreamInboundPublisher({
      eventLog,
      resolveFlowId: resolveInboundFlow,
      resolveWorkRequest,
      acknowledgeWorkRequest: async (request) => {
        if (request.userDeliveryReady !== true) return;
        if (!slackUserWebClient) throw new Error("SLACK_USER_TOKEN is unavailable");
        if (request.activation === "new") {
          try {
            await slackUserWebClient.reactions.add({
              channel: request.channelId,
              name: process.env.SLACK_SHITRAT_REACTION?.trim() || "shitrat",
              timestamp: request.messageTs,
            });
          } catch (error) {
            if (!String(error).includes("already_reacted")) throw error;
          }
        }
        void emitGatewayOtel({
          level: "info",
          component: "slack-shitrat",
          action: "slack.shitrat.acknowledged",
          success: true,
          metadata: {
            channelId: request.channelId,
            threadTs: request.threadTs,
            activation: request.activation,
          },
        });
      },
      onWorkRequestError: (error, phase, event) => {
        console.error("[gateway:transport] Slack ShitRat work request failed", {
          phase,
          eventId: event.eventId,
          error: String(error),
        });
        void emitGatewayOtel({
          level: "error",
          component: "slack-shitrat",
          action: `slack.shitrat.${phase}_failed`,
          success: false,
          error: String(error),
          metadata: {
            eventId: event.eventId,
            channelId: event.platformIds.conversationId,
            actorId: event.actor.platformUserId,
          },
        });
      },
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

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let executorTimer: ReturnType<typeof setInterval> | undefined;
  let queueDrainer: RetainedQueueDrainer | undefined;
  let shuttingDown = false;
  let readinessState: "starting" | "ready" | "degraded" = "starting";

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[gateway:transport] shutting down", { signal });
    queueDrainer?.stop();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (executorTimer) clearInterval(executorTimer);
    clearInterval(slackThreadReapTimer);
    await Promise.allSettled([
      runtime.stop(),
      command.srem(SESSIONS_SET, SESSION_ID),
      subscriber.quit(),
      command.quit(),
      clearSlimTransportReadiness(),
      rm(PID_FILE, { force: true }),
      rm(HEARTBEAT_FILE, { force: true }),
    ]);
    await ownershipLease.release();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  const writeHeartbeat = () =>
    writeFile(HEARTBEAT_FILE, `export const lastHeartbeatTs = ${Date.now()};\n`, "utf8");
  await startChannelRuntimeWithLiveness({
    startChannelRuntime: async () => {
      await startChatSdkRuntime();
    },
    publishPid: async () => {
      await mkdir(PID_DIR, { recursive: true });
      await writeFile(PID_FILE, `${process.pid}\n`, "utf8");
    },
    publishHeartbeat: writeHeartbeat,
  });
  await command.sadd(SESSIONS_SET, SESSION_ID);
  heartbeatTimer = setInterval(() => {
    void writeHeartbeat().catch((error) => {
      console.error("[gateway:transport] heartbeat write failed", { error: String(error) });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Process-local gate memory: blip rechecks + fallback outage batches.
  // Do NOT treat HEARTBEAT_FILE / PID_FILE as agent liveness — those are this
  // transport process, and trusting them would silence fallback during a dead loop.
  const heartbeatGateState = createHeartbeatGateState();
  const probeHeartbeat = makeRedisHeartbeatProbe(async (key) => command.get(key));
  const publishReadiness = async (): Promise<void> => {
    const [gateway, legacy] = await Promise.all([
      command.llen(EVENT_LIST),
      command.llen(LEGACY_EVENT_LIST),
    ]);
    await publishSlimTransportReadiness({
      pid: process.pid,
      readyAt: Date.now(),
      eventLogReady: true,
      initialDrainCompleted: true,
      queues: { gateway, legacy },
    });
  };

  queueDrainer = createRetainedQueueDrainer({
    client: command,
    lists: [EVENT_LIST, LEGACY_EVENT_LIST],
    processRow: async (list, raw) => {
      const event = parseEvent(raw);
      if (!event) {
        console.error("[gateway:transport] removing malformed queue row", { list });
        return;
      }
      try {
        const result = await routeNotifySendToSlimTransport(event, {
          eventLog,
          probeHeartbeat,
          gateState: heartbeatGateState,
        });
        if (!result.handled) {
          console.log("[gateway:transport] removing non-message queue row", {
            eventId: event.id,
            type: event.type,
          });
        }
      } catch (error) {
        if (error instanceof SlimNotifyIngressError && error.handled) {
          // A fallback send may already have crossed Telegram. Remove the
          // queue row and leave reconciliation to the stream consumer.
          return;
        }
        throw error;
      }
    },
    initialRetryDelayMs: 1_000,
    maxRetryDelayMs: 30_000,
    onFailure: async ({ attempt, error, retryInMs, stage, mayHaveRetainedRow }) => {
      const errorMessage = error instanceof Error ? error.message : "gateway drain failed";
      if (stage === "row" && readinessState === "ready") {
        await clearSlimTransportReadiness();
        readinessState = "degraded";
        void emitGatewayOtel({
          level: "error",
          component: "transport-daemon",
          action: "transport.readiness.degraded",
          success: false,
          error: errorMessage,
          metadata: { attempt, retryInMs, failureStage: stage },
        });
      }
      if (attempt === 1 || attempt % 10 === 0) {
        console.error(
          stage === "row"
            ? "[gateway:transport] notify drain failed; retry scheduled"
            : "[gateway:transport] readiness publication failed; retry scheduled",
          { attempt, retryInMs, failureStage: stage, mayHaveRetainedRow, error: errorMessage },
        );
      }
      void emitGatewayOtel({
        level: "warn",
        component: "transport-daemon",
        action: stage === "row"
          ? "transport.notify_drain.retry_scheduled"
          : "transport.readiness.publish_retry_scheduled",
        success: false,
        error: errorMessage,
        metadata: { attempt, retryInMs, failureStage: stage, mayHaveRetainedRow },
      });
    },
    onPass: async ({ recoveredAfterAttempts }) => {
      if (readinessState === "ready") return;
      const wasDegraded = readinessState === "degraded";
      await publishReadiness();
      readinessState = "ready";
      void emitGatewayOtel({
        level: "info",
        component: "transport-daemon",
        action: wasDegraded
          ? "transport.readiness.recovered"
          : "transport.readiness.ready",
        success: true,
        metadata: { recoveredAfterAttempts, preflightAttempts: preflight.attempts },
      });
    },
  });

  subscriber.on("message", () => queueDrainer?.request());
  await subscriber.subscribe(NOTIFY_CHANNEL, LEGACY_NOTIFY_CHANNEL);
  await queueDrainer.start();

  // Mechanical executor for recorded deliver decisions: the agent decides,
  // the transport executes the receipt. Decisions are appended by the MCP
  // plugin without a Redis notify, so this polls its own stream cursor.
  const executorRecipient = process.env.TELEGRAM_USER_ID?.trim() ?? "";
  let executorDraining = false;
  const drainExecutor = async (): Promise<void> => {
    if (executorDraining) return;
    executorDraining = true;
    try {
      await drainDeliverDecisions({
        eventLog,
        recipientId: executorRecipient,
        send: sendExplicitTransport,
        sendSlackWork: sendExplicitSlackAsUser,
        completeSlackWork: async ({ channelId, messageTs, reaction, taskId }) => {
          try {
            if (!slackUserWebClient) throw new Error("SLACK_USER_TOKEN is unavailable");
            await slackUserWebClient.reactions.add({
              channel: channelId,
              name: reaction,
              timestamp: messageTs,
            });
            void emitGatewayOtel({
              level: "info",
              component: "slack-shitrat",
              action: "slack.shitrat.completed",
              success: true,
              metadata: { channelId, messageTs, taskId, reaction },
            });
          } catch (error) {
            void emitGatewayOtel({
              level: "error",
              component: "slack-shitrat",
              action: "slack.shitrat.completion_reaction_failed",
              success: false,
              error: String(error),
              metadata: { channelId, messageTs, taskId, reaction },
            });
            throw error;
          }
        },
        log: (message, detail) => console.log(message, detail ?? {}),
      });
    } catch (error) {
      console.error("[gateway:executor] drain failed", { error: String(error) });
    } finally {
      executorDraining = false;
    }
  };
  executorTimer = setInterval(() => {
    void drainExecutor();
  }, 5_000);
  executorTimer.unref?.();
  await drainExecutor();

  console.log("[gateway:transport] slim transport ready", {
    fallbackChannel: process.env.FALLBACK_CHANNEL?.trim() || "telegram",
    configured: runtime.configured,
  });
}

if (import.meta.main) {
  await startSlimTransportDaemon();
}
