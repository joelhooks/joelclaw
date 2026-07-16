import type {
  DeliveryReceiptEnvelope,
  FlowIdType,
  MessagePlatformType,
  MessageRouteType,
  OutboundIntent,
  RoutingTable,
} from "@joelclaw/message-contract";
import {
  createDeliveryReceipt,
  decodeOutboundIntent,
  MessageAdapterUnavailableError,
  MessageDeliveryError,
  MessageTargetMissingError,
  mintFlowId,
  ReplyAnchorNotFoundError,
  ROUTING_TABLE_V2,
  resolveMessageRoute,
} from "@joelclaw/message-contract";
import type { JournalEventInput } from "@joelclaw/message-journal";
import { createChannelDeliveryAudit } from "@joelclaw/telemetry";
import { journalMessage, rememberTelegramMessageFlow } from "../message-journal";
import {
  routeTelegramOutbound,
  telegramConversationReplyExemption,
} from "../telegram-outbound-policy";
import { type ChatSdkRuntime, getChatSdkRuntime } from "./instance";

export interface SdkSentMessage {
  readonly id: string;
  readonly threadId: string;
  readonly raw?: unknown;
}

export interface SdkDeliveryAdapter {
  readonly openDM: (userId: string) => Promise<string>;
  readonly postMessage: (threadId: string, content: string) => Promise<SdkSentMessage>;
}

export interface OutboundFlowAnchor {
  readonly flowId: FlowIdType;
  readonly platform: MessagePlatformType;
  readonly platformMessageId: string;
  readonly threadId: string;
}

export interface OutboundJournalPort {
  readonly record: (input: JournalEventInput) => Promise<void>;
  readonly remember: (anchor: OutboundFlowAnchor) => Promise<void>;
  readonly resolve: (
    flowId: FlowIdType,
    platform: MessagePlatformType,
  ) => Promise<OutboundFlowAnchor | undefined>;
}

export interface TelegramPolicyPort {
  readonly route: (input: {
    readonly chatId: number;
    readonly intent: OutboundIntent;
    readonly flowId: FlowIdType;
    readonly route: MessageRouteType;
    readonly replyAnchor?: OutboundFlowAnchor;
  }) => Promise<{ readonly disposition: "deliver" | "digest" | "suppress" | "investigate" }>;
}

export interface OutboundSenderDependencies {
  readonly adapters: Partial<Record<MessagePlatformType, SdkDeliveryAdapter>>;
  readonly journal: OutboundJournalPort;
  readonly now?: () => Date;
  readonly routingTable?: RoutingTable;
  readonly resolveTarget?: (platform: MessagePlatformType) => string | undefined;
  readonly mintFlowId?: () => FlowIdType;
  readonly telegramPolicy?: TelegramPolicyPort;
}

const flowAnchors = new Map<string, OutboundFlowAnchor>();
const flowByPlatformMessage = new Map<string, FlowIdType>();

function flowKey(flowId: FlowIdType, platform: MessagePlatformType): string {
  return `${platform}:${flowId}`;
}

async function redisSet(key: string, value: string): Promise<void> {
  try {
    const { getRedisClient } = await import("../channels/redis");
    await getRedisClient()?.set(key, value);
  } catch {
    // The exact journal row remains authoritative. Redis is a lookup index.
  }
}

async function redisGet(key: string): Promise<string | undefined> {
  try {
    const { getRedisClient } = await import("../channels/redis");
    return (await getRedisClient()?.get(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

export const gatewayOutboundJournal: OutboundJournalPort = {
  record: journalMessage,
  async remember(anchor): Promise<void> {
    const key = flowKey(anchor.flowId, anchor.platform);
    flowAnchors.set(key, anchor);
    if (flowAnchors.size > 2_000) {
      const oldest = flowAnchors.keys().next().value;
      if (oldest) flowAnchors.delete(oldest);
    }
    const messageKey = `${anchor.platform}:${anchor.platformMessageId}`;
    flowByPlatformMessage.set(messageKey, anchor.flowId);
    await Promise.all([
      redisSet(`joelclaw:message-contract:flow:${key}`, JSON.stringify(anchor)),
      redisSet(`joelclaw:message-contract:message:${messageKey}`, anchor.flowId),
    ]);

    if (anchor.platform === "telegram") {
      const chatId = Number(anchor.threadId.split(":")[1]);
      const messageId = Number(anchor.platformMessageId.split(":").at(-1));
      if (Number.isSafeInteger(chatId) && Number.isSafeInteger(messageId)) {
        await rememberTelegramMessageFlow(chatId, messageId, anchor.flowId);
      }
    }
  },
  async resolve(flowId, platform): Promise<OutboundFlowAnchor | undefined> {
    const key = flowKey(flowId, platform);
    const cached = flowAnchors.get(key);
    if (cached) return cached;
    const persisted = await redisGet(`joelclaw:message-contract:flow:${key}`);
    if (!persisted) return undefined;
    try {
      const parsed = JSON.parse(persisted) as OutboundFlowAnchor;
      if (
        parsed.flowId !== flowId
        || parsed.platform !== platform
        || typeof parsed.platformMessageId !== "string"
        || typeof parsed.threadId !== "string"
      ) {
        return undefined;
      }
      flowAnchors.set(key, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  },
};

function defaultResolveTarget(platform: MessagePlatformType): string | undefined {
  const envName: Record<MessagePlatformType, string> = {
    telegram: "TELEGRAM_USER_ID",
    slack: "SLACK_ALLOWED_USER_ID",
    discord: "DISCORD_ALLOWED_USER_ID",
  };
  const target = process.env[envName[platform]]?.trim();
  return target || undefined;
}

const defaultTelegramPolicy: TelegramPolicyPort = {
  async route({ chatId, intent, flowId, route, replyAnchor }) {
    const inReplyToMessageId = replyAnchor
      ? Number(replyAnchor.platformMessageId.split(":").at(-1))
      : undefined;
    const audit = createChannelDeliveryAudit(intent.content, {
      flowId,
      producer: "chat-sdk-outbound-v1",
      originSystemId: intent.correlationId,
      eventId: intent.correlationId,
      requestedAtMs: Date.now(),
      route: `${route.lane}:${route.urgency}:${route.formatting}`,
      ...(Number.isSafeInteger(inReplyToMessageId) ? { inReplyToMessageId } : {}),
    });
    return routeTelegramOutbound({
      chatId,
      content: intent.content,
      audit,
      contentKind: intent.kind,
      transportText: intent.content,
      policy: {
        sourceEventType: `message-contract/${intent.kind}`,
        sourceClassification: intent.kind,
        priority: route.urgency === "critical" ? "urgent" : route.urgency,
        level: route.urgency === "critical" ? "error" : "info",
        ...(replyAnchor ? { exemption: telegramConversationReplyExemption(chatId) } : {}),
      },
    });
  },
};

function replyThreadId(anchor: OutboundFlowAnchor): string {
  if (anchor.platform !== "slack") return anchor.threadId;
  const [, channelId] = anchor.threadId.split(":");
  return channelId ? `slack:${channelId}:${anchor.platformMessageId}` : anchor.threadId;
}

function telegramChatId(threadId: string): number {
  if (!threadId.startsWith("telegram:")) return 0;
  const parsed = Number(threadId.split(":")[1]);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function journalInput(input: {
  readonly intent: OutboundIntent;
  readonly flowId: FlowIdType;
  readonly route: MessageRouteType;
  readonly requestedAt: string;
  readonly occurredAt?: string;
  readonly eventType: string;
  readonly deliveryState: string;
  readonly threadId?: string;
  readonly platformMessageId?: string;
  readonly errorCode?: string;
  readonly replyAnchor?: OutboundFlowAnchor;
}): JournalEventInput {
  const messageId = input.platformMessageId && input.route.platform === "telegram"
    ? Number(input.platformMessageId.split(":").at(-1))
    : null;
  return {
    messageKey: input.platformMessageId
      ? `${input.route.platform}:${input.platformMessageId}`
      : `${input.route.platform}:${input.flowId}:${input.eventType}`,
    flowId: input.flowId,
    channel: input.route.platform,
    direction: "outbound",
    eventType: input.eventType,
    contentKind: input.intent.kind,
    occurredAt: input.occurredAt ?? input.requestedAt,
    producer: "chat-sdk-outbound-v1",
    originSystemId: input.intent.correlationId,
    sourceRef: input.intent.replyTo ?? "",
    route: `${input.route.lane}:${input.route.urgency}:${input.route.formatting}`,
    telegramChatId: input.threadId ? telegramChatId(input.threadId) : 0,
    telegramMessageId: Number.isSafeInteger(messageId) ? messageId : null,
    text: input.intent.content,
    transportText: input.intent.content,
    deliveryState: input.deliveryState,
    errorCode: input.errorCode,
    metadata: {
      contractVersion: input.intent.contractVersion,
      platform: input.route.platform,
      platformMessageId: input.platformMessageId ?? null,
      threadId: input.threadId ?? null,
      replyToFlowId: input.intent.replyTo ?? null,
      replyToPlatformMessageId: input.replyAnchor?.platformMessageId ?? null,
    },
  };
}

export async function resolvePlatformMessageFlow(
  platform: MessagePlatformType,
  platformMessageId: string,
): Promise<FlowIdType | undefined> {
  const key = `${platform}:${platformMessageId}`;
  const cached = flowByPlatformMessage.get(key);
  if (cached) return cached;
  const persisted = await redisGet(`joelclaw:message-contract:message:${key}`);
  if (!persisted) return undefined;
  flowByPlatformMessage.set(key, persisted as FlowIdType);
  return persisted as FlowIdType;
}

export function createSdkDeliveryAdapters(
  runtime: ChatSdkRuntime,
): Partial<Record<MessagePlatformType, SdkDeliveryAdapter>> {
  return {
    ...(runtime.adapters.telegram
      ? {
          telegram: {
            openDM: (userId: string) => runtime.adapters.telegram!.openDM(userId),
            postMessage: (threadId: string, content: string) =>
              runtime.adapters.telegram!.postMessage(threadId, { markdown: content }),
          },
        }
      : {}),
    ...(runtime.adapters.slack
      ? {
          slack: {
            openDM: (userId: string) => runtime.adapters.slack!.openDM(userId),
            postMessage: (threadId: string, content: string) =>
              runtime.adapters.slack!.postMessage(threadId, { markdown: content }),
          },
        }
      : {}),
    ...(runtime.adapters.discord
      ? {
          discord: {
            openDM: (userId: string) => runtime.adapters.discord!.openDM(userId),
            postMessage: (threadId: string, content: string) =>
              runtime.adapters.discord!.postMessage(threadId, { markdown: content }),
          },
        }
      : {}),
  };
}

export function makeOutboundSender(dependencies: OutboundSenderDependencies) {
  return async function send(input: unknown): Promise<DeliveryReceiptEnvelope> {
    const intent = decodeOutboundIntent(input);
    const route = resolveMessageRoute(intent.kind, dependencies.routingTable ?? ROUTING_TABLE_V2);
    const flowId = dependencies.mintFlowId?.() ?? mintFlowId();
    const now = dependencies.now ?? (() => new Date());
    const requestedAt = now().toISOString();

    await dependencies.journal.record(journalInput({
      intent,
      flowId,
      route,
      requestedAt,
      eventType: "message.outbound.requested",
      deliveryState: "requested",
    }));

    const adapter = dependencies.adapters[route.platform];
    if (!adapter) {
      await dependencies.journal.record(journalInput({
        intent,
        flowId,
        route,
        requestedAt,
        eventType: "message.outbound.failed",
        deliveryState: "failed",
        errorCode: "MESSAGE_ADAPTER_UNAVAILABLE",
      }));
      throw new MessageAdapterUnavailableError({
        operation: "message-contract.send",
        code: "MESSAGE_ADAPTER_UNAVAILABLE",
        platform: route.platform,
        fix: `Configure the ${route.platform} Chat SDK adapter before sending ${intent.kind}.`,
      });
    }

    const resolveTarget = dependencies.resolveTarget ?? defaultResolveTarget;
    const target = resolveTarget(route.platform);
    if (!target) {
      await dependencies.journal.record(journalInput({
        intent,
        flowId,
        route,
        requestedAt,
        eventType: "message.outbound.failed",
        deliveryState: "failed",
        errorCode: "MESSAGE_TARGET_MISSING",
      }));
      throw new MessageTargetMissingError({
        operation: "message-contract.resolve-target",
        code: "MESSAGE_TARGET_MISSING",
        platform: route.platform,
        fix: `Set the ${route.platform} operator target in the gateway environment.`,
      });
    }

    let replyAnchor: OutboundFlowAnchor | undefined;
    if (intent.replyTo) {
      replyAnchor = await dependencies.journal.resolve(intent.replyTo, route.platform);
      if (!replyAnchor) {
        const failedAt = now().toISOString();
        await dependencies.journal.record(journalInput({
          intent,
          flowId,
          route,
          requestedAt,
          occurredAt: failedAt,
          eventType: "message.outbound.failed",
          deliveryState: "failed",
          errorCode: "REPLY_ANCHOR_NOT_FOUND",
        }));
        throw new ReplyAnchorNotFoundError({
          operation: "message-contract.resolve-reply",
          code: "REPLY_ANCHOR_NOT_FOUND",
          flowId: intent.replyTo,
          platform: route.platform,
          fix: "Wait for the parent receipt to be confirmed and journaled before replying.",
        });
      }
    }

    try {
      if (route.platform === "telegram") {
        const chatId = Number(target);
        if (!Number.isSafeInteger(chatId)) {
          throw new MessageTargetMissingError({
            operation: "message-contract.resolve-target",
            code: "MESSAGE_TARGET_MISSING",
            platform: route.platform,
            fix: "Set TELEGRAM_USER_ID to a numeric operator chat id.",
          });
        }
        const policy = dependencies.telegramPolicy ?? defaultTelegramPolicy;
        const decision = await policy.route({ chatId, intent, flowId, route, replyAnchor });
        if (decision.disposition !== "deliver") {
          const terminalAt = now().toISOString();
          await dependencies.journal.record(journalInput({
            intent,
            flowId,
            route,
            requestedAt,
            occurredAt: terminalAt,
            eventType: `message.outbound.${decision.disposition}`,
            deliveryState: "suppressed",
          }));
          return createDeliveryReceipt({
            flowId,
            correlationId: intent.correlationId,
            requestedAt,
            confirmedAt: null,
            deliveryState: "suppressed",
            platform: route.platform,
            platformMessageId: null,
            threadId: null,
            route: {
              lane: route.lane,
              urgency: route.urgency,
              formatting: route.formatting,
            },
          });
        }
      }

      const threadId = replyAnchor ? replyThreadId(replyAnchor) : await adapter.openDM(target);
      const sent = await adapter.postMessage(threadId, intent.content);
      const anchor: OutboundFlowAnchor = {
        flowId,
        platform: route.platform,
        platformMessageId: sent.id,
        threadId: sent.threadId || threadId,
      };
      await dependencies.journal.remember(anchor);
      const confirmedAt = now().toISOString();
      await dependencies.journal.record(journalInput({
        intent,
        flowId,
        route,
        requestedAt,
        occurredAt: confirmedAt,
        eventType: "message.outbound.confirmed",
        deliveryState: "confirmed",
        threadId: anchor.threadId,
        platformMessageId: anchor.platformMessageId,
        replyAnchor,
      }));

      return createDeliveryReceipt({
        flowId,
        correlationId: intent.correlationId,
        requestedAt,
        confirmedAt,
        deliveryState: "confirmed",
        platform: route.platform,
        platformMessageId: anchor.platformMessageId,
        threadId: anchor.threadId,
        route: {
          lane: route.lane,
          urgency: route.urgency,
          formatting: route.formatting,
        },
      });
    } catch (cause) {
      const failedAt = now().toISOString();
      await dependencies.journal.record(journalInput({
        intent,
        flowId,
        route,
        requestedAt,
        occurredAt: failedAt,
        eventType: "message.outbound.failed",
        deliveryState: "failed",
        errorCode: "MESSAGE_DELIVERY_FAILED",
        replyAnchor,
      }));
      throw new MessageDeliveryError({
        operation: "message-contract.send",
        code: "MESSAGE_DELIVERY_FAILED",
        flowId,
        platform: route.platform,
        cause,
        fix: `Check the ${route.platform} Chat SDK adapter and inspect the journal before retrying to avoid a duplicate send.`,
      });
    }
  };
}

export async function send(input: unknown): Promise<DeliveryReceiptEnvelope> {
  const runtime = getChatSdkRuntime();
  return makeOutboundSender({
    adapters: createSdkDeliveryAdapters(runtime),
    journal: gatewayOutboundJournal,
  })(input);
}

export const __outboundTestUtils = {
  clearFlowAnchors(): void {
    flowAnchors.clear();
    flowByPlatformMessage.clear();
  },
};
