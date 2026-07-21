import type {
  DeliveryReceiptEnvelope,
  FlowIdType,
  MessageActionType,
  MessagePlatformType,
  MessageRouteType,
  OutboundIntent,
  RoutingTable,
} from "@joelclaw/message-contract";
import {
  createDeliveryReceipt,
  decodeOutboundIntent,
  LEARNER_FLOW_ACTION_IDS,
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
import type { AdapterPostableMessage } from "chat";
import {
  type JournalPersistenceReceipt,
  journalMessage,
  rememberTelegramMessageFlow,
  resolveMessageActionDeclarationFromJournal,
} from "../message-journal";
import {
  normalizeTelegramBulletLines,
  type PreparedTelegramMarkdown,
  prepareTelegramMarkdown,
} from "../telegram-markdown";
import {
  routeTelegramOutbound,
  telegramConversationReplyExemption,
} from "../telegram-outbound-policy";
import { type ChatSdkRuntime, getChatSdkRuntime } from "./instance";
import {
  isTelegramActionMessage,
  type TelegramActionMessage,
} from "./telegram-adapter";

export interface SdkSentMessage {
  readonly id: string;
  readonly threadId: string;
  readonly raw?: unknown;
}

export type SdkPostableMessage = AdapterPostableMessage | TelegramActionMessage;

export interface SdkDeliveryAdapter {
  readonly openDM: (userId: string) => Promise<string>;
  readonly postMessage: (
    threadId: string,
    message: SdkPostableMessage,
  ) => Promise<SdkSentMessage>;
}

export interface OutboundFlowAnchor {
  readonly flowId: FlowIdType;
  readonly platform: MessagePlatformType;
  readonly platformMessageId: string;
  readonly threadId: string;
  readonly correlationId?: string;
  readonly declaredActions?: ReadonlyArray<MessageActionType>;
}

export interface OutboundTerminalReceipt {
  readonly flowId: FlowIdType;
  readonly correlationId: string;
  readonly platform: MessagePlatformType;
  readonly platformMessageId: string | null;
  readonly deliveryState: "confirmed" | "failed" | "digested";
  readonly declaredActions: ReadonlyArray<MessageActionType>;
  readonly confirmedAt: string | null;
}

export interface OutboundActionDeclaration {
  readonly flowId: FlowIdType;
  readonly correlationId: string;
  readonly platform: MessagePlatformType;
  readonly platformMessageId: string;
  readonly declaredActions: ReadonlyArray<MessageActionType>;
}

export interface OutboundJournalPort {
  readonly record: (
    input: JournalEventInput,
  ) => Promise<JournalPersistenceReceipt>;
  readonly remember: (anchor: OutboundFlowAnchor) => Promise<void>;
  readonly resolve: (
    flowId: FlowIdType,
    platform: MessagePlatformType,
  ) => Promise<OutboundFlowAnchor | undefined>;
  readonly rememberTerminal?: (receipt: OutboundTerminalReceipt) => Promise<void>;
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
  readonly prepareTelegramMarkdown?: (markdown: string) => PreparedTelegramMarkdown;
}

const flowAnchors = new Map<string, OutboundFlowAnchor>();
const flowByPlatformMessage = new Map<string, FlowIdType>();
const actionDeclarations = new Map<string, OutboundActionDeclaration>();
const MESSAGE_PROJECTION_TTL_SECONDS = 7 * 24 * 60 * 60;

function flowKey(flowId: FlowIdType, platform: MessagePlatformType): string {
  return `${platform}:${flowId}`;
}

async function redisSet(
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<void> {
  try {
    const { getRedisClient } = await import("../channels/redis");
    const redis = getRedisClient();
    if (!redis) return;
    if (ttlSeconds === undefined) {
      await redis.set(key, value);
    } else {
      await redis.set(key, value, "EX", ttlSeconds);
    }
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
    const writes = [
      redisSet(`joelclaw:message-contract:flow:${key}`, JSON.stringify(anchor)),
      redisSet(`joelclaw:message-contract:message:${messageKey}`, anchor.flowId),
    ];
    if (
      anchor.correlationId
      && anchor.declaredActions
      && anchor.declaredActions.length > 0
    ) {
      const declaration: OutboundActionDeclaration = {
        flowId: anchor.flowId,
        correlationId: anchor.correlationId,
        platform: anchor.platform,
        platformMessageId: anchor.platformMessageId,
        declaredActions: anchor.declaredActions,
      };
      actionDeclarations.set(anchor.flowId, declaration);
      writes.push(redisSet(
        `joelclaw:message-contract:actions:${anchor.flowId}`,
        JSON.stringify(declaration),
        MESSAGE_PROJECTION_TTL_SECONDS,
      ));
    }
    await Promise.all(writes);

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
  async rememberTerminal(receipt): Promise<void> {
    await redisSet(
      `joelclaw:message-contract:correlation:${receipt.correlationId}`,
      JSON.stringify(receipt),
      MESSAGE_PROJECTION_TTL_SECONDS,
    );
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
      route: `${route.delivery}:${route.formatting}`,
      ...(Number.isSafeInteger(inReplyToMessageId) ? { inReplyToMessageId } : {}),
    });
    return routeTelegramOutbound({
      chatId,
      content: intent.content,
      audit,
      contentKind: intent.kind,
      transportText: intent.content,
      contractDelivery: route.delivery,
      policy: {
        sourceEventType: `message-contract/${intent.kind}`,
        sourceClassification: intent.kind,
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

function telegramPostable(
  intent: OutboundIntent,
  formatting: MessageRouteType["formatting"],
  prepare: (markdown: string) => PreparedTelegramMarkdown,
): SdkPostableMessage {
  const prepared = prepare(intent.content);
  if (!intent.actions) {
    return formatting === "plain"
      ? { raw: normalizeTelegramBulletLines(intent.content) }
      : prepared.postable;
  }

  return {
    telegramActionMessage: true,
    markdownV2: formatting === "markdown" ? prepared.markdownV2 : null,
    plainText: formatting === "markdown"
      ? prepared.plainText
      : normalizeTelegramBulletLines(intent.content),
    actions: intent.actions,
  };
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
  readonly platformReceipt?: Record<string, unknown>;
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
    route: `${input.route.delivery}:${input.route.formatting}`,
    telegramChatId: input.threadId ? telegramChatId(input.threadId) : 0,
    telegramMessageId: Number.isSafeInteger(messageId) ? messageId : null,
    text: input.intent.content,
    transportText: input.intent.content,
    deliveryState: input.deliveryState,
    errorCode: input.errorCode,
    metadata: {
      contractVersion: input.intent.contractVersion,
      correlationId: input.intent.correlationId,
      declaredActions: input.intent.actions?.map((action) => ({
        id: action.id,
        label: action.label,
      })) ?? [],
      platform: input.route.platform,
      platformMessageId: input.platformMessageId ?? null,
      platformReceipt: input.platformReceipt ?? null,
      threadId: input.threadId ?? null,
      replyToFlowId: input.intent.replyTo ?? null,
      replyToPlatformMessageId: input.replyAnchor?.platformMessageId ?? null,
    },
  };
}

function platformReceiptMetadata(
  platform: MessagePlatformType,
  sent: SdkSentMessage,
): Record<string, unknown> | undefined {
  if (platform !== "telegram" || !sent.raw || typeof sent.raw !== "object") {
    return undefined;
  }
  const raw = sent.raw as Record<string, unknown>;
  const chat = raw.chat && typeof raw.chat === "object"
    ? (raw.chat as Record<string, unknown>)
    : undefined;
  return {
    messageId: typeof raw.message_id === "number" ? raw.message_id : null,
    date: typeof raw.date === "number" ? raw.date : null,
    chatId: typeof chat?.id === "number" ? chat.id : null,
    chatType: typeof chat?.type === "string" ? chat.type : null,
  };
}

export async function resolvePlatformMessageFlow(
  platform: MessagePlatformType,
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
    const cached = flowByPlatformMessage.get(key);
    if (cached) return cached;
    const persisted = await redisGet(`joelclaw:message-contract:message:${key}`);
    if (!persisted) continue;
    flowByPlatformMessage.set(key, persisted as FlowIdType);
    return persisted as FlowIdType;
  }
  return undefined;
}

function parseActionDeclaration(value: unknown): OutboundActionDeclaration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.flowId !== "string"
    || typeof record.correlationId !== "string"
    || record.platform !== "telegram"
    || typeof record.platformMessageId !== "string"
    || !Array.isArray(record.declaredActions)
  ) {
    return undefined;
  }
  const declaredActions = record.declaredActions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const action = value as Record<string, unknown>;
    if (
      action.kind !== "callback"
      || typeof action.id !== "string"
      || !LEARNER_FLOW_ACTION_IDS.includes(
        action.id as (typeof LEARNER_FLOW_ACTION_IDS)[number],
      )
      || typeof action.label !== "string"
    ) {
      return [];
    }
    return [{
      kind: "callback" as const,
      id: action.id as MessageActionType["id"],
      label: action.label,
    }];
  });
  if (declaredActions.length === 0) return undefined;
  return {
    flowId: record.flowId as FlowIdType,
    correlationId: record.correlationId,
    platform: "telegram",
    platformMessageId: record.platformMessageId,
    declaredActions,
  };
}

export async function resolveDeclaredMessageActions(
  flowId: FlowIdType,
): Promise<OutboundActionDeclaration | undefined> {
  const cached = actionDeclarations.get(flowId);
  if (cached) return cached;
  const persisted = await redisGet(`joelclaw:message-contract:actions:${flowId}`);
  if (persisted) {
    try {
      const declaration = parseActionDeclaration(JSON.parse(persisted));
      if (declaration?.flowId === flowId) {
        actionDeclarations.set(flowId, declaration);
        return declaration;
      }
    } catch {
      // Fall through to the canonical private journal.
    }
  }
  const journal = await resolveMessageActionDeclarationFromJournal(flowId);
  if (!journal) return undefined;
  const declaration = parseActionDeclaration({
    flowId,
    correlationId: journal.correlationId,
    platform: "telegram",
    platformMessageId: journal.platformMessageId,
    declaredActions: journal.declaredActions.map((action) => ({
      kind: "callback",
      id: action.id,
      label: action.label,
    })),
  });
  if (!declaration) return undefined;
  actionDeclarations.set(flowId, declaration);
  return declaration;
}

export function createSdkDeliveryAdapters(
  runtime: ChatSdkRuntime,
): Partial<Record<MessagePlatformType, SdkDeliveryAdapter>> {
  return {
    ...(runtime.adapters.telegram
      ? {
          telegram: {
            openDM: (userId: string) => runtime.adapters.telegram!.openDM(userId),
            postMessage: (threadId: string, message: SdkPostableMessage) =>
              isTelegramActionMessage(message)
                ? runtime.adapters.telegram!.postActionMessage(threadId, message)
                : runtime.adapters.telegram!.postMessage(threadId, message),
          },
        }
      : {}),
    ...(runtime.adapters.slack
      ? {
          slack: {
            openDM: (userId: string) => runtime.adapters.slack!.openDM(userId),
            postMessage: (threadId: string, message: SdkPostableMessage) =>
              runtime.adapters.slack!.postMessage(
                threadId,
                message as AdapterPostableMessage,
              ),
          },
        }
      : {}),
    ...(runtime.adapters.discord
      ? {
          discord: {
            openDM: (userId: string) => runtime.adapters.discord!.openDM(userId),
            postMessage: (threadId: string, message: SdkPostableMessage) =>
              runtime.adapters.discord!.postMessage(
                threadId,
                message as AdapterPostableMessage,
              ),
          },
        }
      : {}),
  };
}

async function rememberTerminal(
  journal: OutboundJournalPort,
  receipt: OutboundTerminalReceipt,
): Promise<void> {
  await journal.rememberTerminal?.(receipt);
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
      const failureJournal = await dependencies.journal.record(journalInput({
        intent,
        flowId,
        route,
        requestedAt,
        eventType: "message.outbound.failed",
        deliveryState: "failed",
        errorCode: "MESSAGE_ADAPTER_UNAVAILABLE",
      }));
      if (failureJournal.persisted) {
        await rememberTerminal(dependencies.journal, {
          flowId,
          correlationId: intent.correlationId,
          platform: route.platform,
          platformMessageId: null,
          deliveryState: "failed",
          declaredActions: intent.actions ?? [],
          confirmedAt: null,
        });
      }
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
      const failureJournal = await dependencies.journal.record(journalInput({
        intent,
        flowId,
        route,
        requestedAt,
        eventType: "message.outbound.failed",
        deliveryState: "failed",
        errorCode: "MESSAGE_TARGET_MISSING",
      }));
      if (failureJournal.persisted) {
        await rememberTerminal(dependencies.journal, {
          flowId,
          correlationId: intent.correlationId,
          platform: route.platform,
          platformMessageId: null,
          deliveryState: "failed",
          declaredActions: intent.actions ?? [],
          confirmedAt: null,
        });
      }
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
        const failureJournal = await dependencies.journal.record(journalInput({
          intent,
          flowId,
          route,
          requestedAt,
          occurredAt: failedAt,
          eventType: "message.outbound.failed",
          deliveryState: "failed",
          errorCode: "REPLY_ANCHOR_NOT_FOUND",
        }));
        if (failureJournal.persisted) {
          await rememberTerminal(dependencies.journal, {
            flowId,
            correlationId: intent.correlationId,
            platform: route.platform,
            platformMessageId: null,
            deliveryState: "failed",
            declaredActions: intent.actions ?? [],
            confirmedAt: null,
          });
        }
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
      if (intent.actions && route.platform !== "telegram") {
        throw new Error(
          `Message actions are not implemented for ${route.platform}`,
        );
      }
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
        if (decision.disposition === "digest" && route.delivery === "batch") {
          const terminalAt = now().toISOString();
          const deliveryState = "digested" as const;
          const terminalJournal = await dependencies.journal.record(journalInput({
            intent,
            flowId,
            route,
            requestedAt,
            occurredAt: terminalAt,
            eventType: `message.outbound.${decision.disposition}`,
            deliveryState,
          }));
          if (!terminalJournal.persisted) {
            throw new Error(
              `${route.platform} digest was queued but its terminal receipt was not durably journaled`,
            );
          }
          await rememberTerminal(dependencies.journal, {
            flowId,
            correlationId: intent.correlationId,
            platform: route.platform,
            platformMessageId: null,
            deliveryState,
            declaredActions: intent.actions ?? [],
            confirmedAt: null,
          });
          return createDeliveryReceipt({
            flowId,
            correlationId: intent.correlationId,
            requestedAt,
            confirmedAt: null,
            deliveryState,
            platform: route.platform,
            platformMessageId: null,
            threadId: null,
            route: {
              delivery: route.delivery,
              formatting: route.formatting,
            },
          });
        }
      }

      const threadId = replyAnchor ? replyThreadId(replyAnchor) : await adapter.openDM(target);
      const postable: SdkPostableMessage = route.platform === "telegram"
        ? telegramPostable(
            intent,
            route.formatting,
            dependencies.prepareTelegramMarkdown ?? prepareTelegramMarkdown,
          )
        : { markdown: intent.content };
      const sent = await adapter.postMessage(threadId, postable);
      const platformMessageId = sent.id.trim();
      if (!platformMessageId) {
        throw new Error(`${route.platform} adapter returned no platform message id`);
      }
      const anchor: OutboundFlowAnchor = {
        flowId,
        platform: route.platform,
        platformMessageId,
        threadId: sent.threadId.trim() || threadId,
        correlationId: intent.correlationId,
        declaredActions: intent.actions ?? [],
      };
      const confirmedAt = now().toISOString();
      const journalReceipt = await dependencies.journal.record(journalInput({
        intent,
        flowId,
        route,
        requestedAt,
        occurredAt: confirmedAt,
        eventType: "message.outbound.confirmed",
        deliveryState: "confirmed",
        threadId: anchor.threadId,
        platformMessageId: anchor.platformMessageId,
        platformReceipt: platformReceiptMetadata(route.platform, sent),
        replyAnchor,
      }));
      if (!journalReceipt.persisted) {
        throw new Error(
          `${route.platform} platform message ${anchor.platformMessageId} was not durably journaled`,
        );
      }
      await dependencies.journal.remember(anchor);
      await rememberTerminal(dependencies.journal, {
        flowId,
        correlationId: intent.correlationId,
        platform: route.platform,
        platformMessageId: anchor.platformMessageId,
        deliveryState: "confirmed",
        declaredActions: intent.actions ?? [],
        confirmedAt,
      });

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
          delivery: route.delivery,
          formatting: route.formatting,
        },
      });
    } catch (cause) {
      const failedAt = now().toISOString();
      const failureJournal = await dependencies.journal.record(journalInput({
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
      if (failureJournal.persisted) {
        await rememberTerminal(dependencies.journal, {
          flowId,
          correlationId: intent.correlationId,
          platform: route.platform,
          platformMessageId: null,
          deliveryState: "failed",
          declaredActions: intent.actions ?? [],
          confirmedAt: null,
        });
      }
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
    actionDeclarations.clear();
  },
};
