import {
  getMessageEventLogClient,
  type MessagePlatform,
} from "@joelclaw/message-event-log";
import type { AdapterPostableMessage } from "chat";
import Redis from "ioredis";
import { journalMessage } from "../message-journal";
import {
  type ExplicitTransportSendReceipt,
  type ExplicitTransportSendRequest,
  makeExplicitTransportSender,
  type SdkDeliveryAdapter,
  type SdkPostableMessage,
} from "../transport-slim";
import { getChatSdkRuntime } from "./instance";

let correlationRedis: Redis | undefined;

function getCorrelationRedis(): Redis {
  correlationRedis ??= new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
    maxRetriesPerRequest: 1,
  });
  return correlationRedis;
}

function makeAdapter(
  platform: Exclude<MessagePlatform, "imessage">,
): SdkDeliveryAdapter | undefined {
  const adapter = getChatSdkRuntime().adapters[platform];
  if (!adapter) return undefined;
  return {
    openDM: (userId) => adapter.openDM(userId),
    postMessage: (threadId, message: SdkPostableMessage) =>
      adapter.postMessage(threadId, message as AdapterPostableMessage),
  };
}

async function rememberExplicitFlow(
  receipt: ExplicitTransportSendReceipt,
): Promise<void> {
  const redis = getCorrelationRedis();
  const anchor = {
    flowId: receipt.flowId,
    platform: receipt.platform,
    platformMessageId: receipt.platformMessageId,
    threadId: receipt.threadId,
  };
  await Promise.all([
    redis.set(
      `joelclaw:message-contract:flow:${receipt.platform}:${receipt.flowId}`,
      JSON.stringify(anchor),
    ),
    redis.set(
      `joelclaw:message-contract:message:${receipt.platform}:${receipt.platformMessageId}`,
      receipt.flowId,
    ),
  ]);
}

export async function resolveExplicitPlatformMessageFlow(
  platform: MessagePlatform,
  platformMessageId: string,
  conversationId?: string,
): Promise<string | undefined> {
  const redis = getCorrelationRedis();
  const candidates = [
    `${platform}:${platformMessageId}`,
    ...(conversationId
      ? [`${platform}:${conversationId}:${platformMessageId}`]
      : []),
  ];
  for (const key of candidates) {
    const flowId = await redis.get(`joelclaw:message-contract:message:${key}`);
    if (flowId) return flowId;
  }
  return undefined;
}

/** Public zero-policy boundary used by the gateway agent/plugin. */
export async function sendExplicitTransport(
  request: ExplicitTransportSendRequest,
): Promise<ExplicitTransportSendReceipt> {
  const adapters = {
    telegram: makeAdapter("telegram"),
    slack: makeAdapter("slack"),
    discord: makeAdapter("discord"),
  };
  return makeExplicitTransportSender({
    adapters,
    journal: { record: journalMessage },
    eventLog: getMessageEventLogClient(),
    rememberFlow: rememberExplicitFlow,
  })(request);
}
