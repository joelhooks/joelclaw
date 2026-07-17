import {
  type FlowIdType,
  type InboundEvent,
  type InboundPlatform,
  MESSAGE_CONTRACT_VERSION,
  MESSAGE_REACTION_RECEIVED,
} from "@joelclaw/message-contract";
import type {
  ActionEvent,
  Chat,
  Message,
  ReactionEvent,
  SlashCommandEvent,
  Thread,
} from "chat";
import type { ChatSdkRuntime } from "../chat-sdk/instance";
import {
  type ChatSdkNormalizedInbound,
  fromChatSdkCommand,
  fromChatSdkInteraction,
  fromChatSdkMessage,
  fromChatSdkReaction,
  normalizeSdkInboundEvent,
  type RawInboundEnvelope,
} from "./normalize";
import type {
  MessageReactionReceivedBusEnvelope,
  ObserveOnlyInboundPublisher,
} from "./publish";

export type ActingInboundEnqueue = (
  source: string,
  prompt: string,
  metadata?: Record<string, unknown>,
) => void | Promise<void>;

export interface ActingInboundDispatcherDependencies {
  readonly enqueue: ActingInboundEnqueue;
  readonly publisher: ObserveOnlyInboundPublisher;
  readonly resolveFlowId: (
    platform: InboundPlatform,
    platformMessageId: string,
    conversationId?: string,
  ) => Promise<FlowIdType | undefined>;
  readonly publishReaction: (
    event: MessageReactionReceivedBusEnvelope,
  ) => Promise<unknown>;
  readonly dispatchPlatformPolicy?: (
    event: InboundEvent,
    raw: unknown,
  ) => Promise<boolean>;
  readonly prepareInvoke?: (event: InboundEvent) => Promise<{
    readonly source?: string;
    readonly prompt?: string;
    readonly metadata?: Record<string, unknown>;
  }>;
  readonly onError?: (error: unknown, phase: string, event: InboundEvent) => void;
}

export type ActingInboundDispatchResult =
  | {
      readonly status:
        | "duplicate"
        | "rejected"
        | "observed"
        | "platform-policy";
    }
  | {
      readonly status: "enqueued";
      readonly source: string;
      readonly prompt: string;
    };

function sourceFor(event: InboundEvent): string {
  return `${event.platform}:${event.platformIds.conversationId}`;
}

function promptFor(event: InboundEvent): string {
  switch (event.type) {
    case "message":
      return event.text;
    case "command":
      return `${event.command}${event.argumentsText ? ` ${event.argumentsText}` : ""}`;
    case "interaction":
      return event.value
        ? `[interaction:${event.actionId}] ${event.value}`
        : `[interaction:${event.actionId}]`;
    case "reaction":
      return `[reaction:${event.added ? "added" : "removed"}] ${event.rawEmoji}`;
  }
}

function queueMetadata(event: InboundEvent): Record<string, unknown> {
  const messageId = event.platformIds.messageId ?? event.rawAnchors.sourceMessageId;
  const common: Record<string, unknown> = {
    chatSdkActing: true,
    chatSdkEventId: event.eventId,
    chatSdkEventType: event.type,
    chatSdkPlatform: event.platform,
    chatSdkConversationId: event.platformIds.conversationId,
    ...(event.platformIds.threadId
      ? { chatSdkThreadId: event.platformIds.threadId }
      : {}),
  };

  if (event.platform === "telegram") {
    const telegramMessageId = Number(messageId);
    return {
      ...common,
      ...(Number.isSafeInteger(telegramMessageId) ? { telegramMessageId } : {}),
    };
  }
  if (event.platform === "slack") {
    return {
      ...common,
      ...(messageId ? { slackTs: messageId } : {}),
      slackEventKind:
        event.type === "message" && event.isMention ? "mention" : event.type,
    };
  }
  return {
    ...common,
    ...(messageId ? { discordMessageId: messageId } : {}),
  };
}

function reactionEvent(
  event: Extract<InboundEvent, { readonly type: "reaction" }>,
  flowId: FlowIdType,
): MessageReactionReceivedBusEnvelope {
  const displayName = event.actor.displayName?.trim();
  const rawEventId = event.audit.rawEventId
    ?? event.rawAnchors.transportEventId
    ?? event.eventId;
  const platformMessageId = event.platformIds.messageId
    ?? event.rawAnchors.sourceMessageId;
  if (!platformMessageId) {
    throw new Error("Correlated reaction has no platform message id");
  }
  return {
    id: `${event.eventId}:flow:${flowId}`,
    name: MESSAGE_REACTION_RECEIVED,
    data: {
      contractVersion: MESSAGE_CONTRACT_VERSION,
      flowId,
      platform: event.platform,
      emoji: event.rawEmoji || event.emoji,
      action: event.added ? "added" : "removed",
      added: event.added,
      rawEventId,
      platformMessageId,
      correlationSource: "gateway-acting",
      actor: {
        id: event.actor.platformUserId,
        ...(displayName ? { displayName } : {}),
      },
      at: event.occurredAt,
    },
  };
}

export function createActingInboundDispatcher(
  dependencies: ActingInboundDispatcherDependencies,
) {
  const seenEventIds = new Set<string>();
  const seenEventOrder: string[] = [];
  const maxSeenEventIds = 5_000;

  const remember = (eventId: string): void => {
    seenEventIds.add(eventId);
    seenEventOrder.push(eventId);
    if (seenEventOrder.length > maxSeenEventIds) {
      const expired = seenEventOrder.shift();
      if (expired) seenEventIds.delete(expired);
    }
  };

  return async function dispatch(
    event: InboundEvent,
    context: { readonly raw?: unknown } = {},
  ): Promise<ActingInboundDispatchResult> {
    if (seenEventIds.has(event.eventId)) return { status: "duplicate" };

    try {
      await dependencies.publisher.publishEvent(event);
    } catch (error) {
      dependencies.onError?.(error, "publish", event);
    }

    if (dependencies.dispatchPlatformPolicy) {
      const handled = await dependencies.dispatchPlatformPolicy(
        event,
        context.raw,
      );
      if (handled) {
        remember(event.eventId);
        return { status: "platform-policy" };
      }
    }

    if (
      event.authorization.verdict !== "accepted" ||
      event.authorization.reason !== "authorized_joel"
    ) {
      remember(event.eventId);
      return { status: "rejected" };
    }

    if (event.type === "reaction") {
      const platformMessageId =
        event.platformIds.messageId ?? event.rawAnchors.sourceMessageId;
      if (platformMessageId) {
        try {
          const flowId = await dependencies.resolveFlowId(
            event.platform,
            platformMessageId,
            event.platformIds.conversationId,
          );
          if (flowId) {
            await dependencies.publishReaction(reactionEvent(event, flowId));
          }
        } catch (error) {
          dependencies.onError?.(error, "reaction-correlation", event);
        }
      }
      remember(event.eventId);
      return { status: "observed" };
    }

    if (event.authorization.policyAction !== "invoke") {
      remember(event.eventId);
      return { status: "observed" };
    }

    const prepared = await dependencies.prepareInvoke?.(event);
    const source = prepared?.source ?? sourceFor(event);
    const prompt = prepared?.prompt ?? promptFor(event);
    await dependencies.enqueue(source, prompt, {
      ...queueMetadata(event),
      ...prepared?.metadata,
    });
    remember(event.eventId);
    return { status: "enqueued", source, prompt };
  };
}

export interface RegisterActingInboundOptions
  extends ActingInboundDispatcherDependencies {
  readonly allowedActorIds: Partial<Record<InboundPlatform, string>>;
  readonly now?: () => Date;
}

const configuredChats = new WeakSet<object>();

function platformFromAdapter(name: string): InboundPlatform {
  if (name === "telegram" || name === "slack" || name === "discord") {
    return name;
  }
  throw new Error(`Unsupported Chat SDK acting adapter: ${name}`);
}

function rawEnvelope(
  platform: InboundPlatform,
  kind: InboundEvent["type"],
  raw: unknown,
  allowedActorId: string,
  botActorId: string | undefined,
  now: () => Date,
): RawInboundEnvelope {
  return {
    platform,
    kind,
    transport:
      platform === "telegram"
        ? "polling"
        : platform === "slack"
          ? "socket"
          : "gateway",
    rawEventType: `chat-sdk.${kind}`,
    raw,
    receivedAt: now().toISOString(),
    allowedActorId,
    botActorId,
  };
}

function normalizeActingEvent(
  projected: ChatSdkNormalizedInbound,
  envelope: RawInboundEnvelope,
  now: () => Date,
): InboundEvent {
  // The bus copy remains explicitly observe-only. The acting dispatcher above
  // is the only place allowed to turn an accepted invoke decision into queue
  // work. Chat SDK is the canonical transport owner; there is no legacy gate.
  return normalizeSdkInboundEvent(projected, envelope, {
    sdkVersion: "4.34.0",
    now,
  });
}

export function registerChatSdkActingInbound(
  runtime: ChatSdkRuntime,
  options: RegisterActingInboundOptions,
): void {
  const chat = runtime.chat as Chat<Record<string, never>>;
  if (configuredChats.has(chat)) return;
  configuredChats.add(chat);

  const now = options.now ?? (() => new Date());
  const dispatch = createActingInboundDispatcher(options);
  const project = async (
    normalized: ChatSdkNormalizedInbound,
    raw: unknown,
    botActorId?: string,
  ): Promise<void> => {
    const allowedActorId = options.allowedActorIds[normalized.platform] ?? "";
    const envelope = rawEnvelope(
      normalized.platform,
      normalized.kind,
      raw,
      allowedActorId,
      botActorId,
      now,
    );
    await dispatch(normalizeActingEvent(normalized, envelope, now), { raw });
  };

  const onMessage = async (thread: Thread, message: Message): Promise<void> => {
    const platform = platformFromAdapter(thread.adapter.name);
    await project(
      fromChatSdkMessage(message, {
        platform,
        conversationId: thread.channelId,
        occurredAt: message.metadata.dateSent.toISOString(),
        anchors: { sourceMessageId: message.id, sourceThreadId: thread.id },
      }),
      message.raw,
      thread.adapter.botUserId,
    );
  };

  chat.onDirectMessage(onMessage);
  chat.onNewMention(onMessage);
  chat.onNewMessage(/[\s\S]*/u, onMessage);

  chat.onSlashCommand(async (event: SlashCommandEvent): Promise<void> => {
    const platform = platformFromAdapter(event.adapter.name);
    await project(
      fromChatSdkCommand(event, {
        platform,
        conversationId: event.channel.id,
        occurredAt: now().toISOString(),
      }),
      event.raw,
      event.adapter.botUserId,
    );
  });

  chat.onAction(async (event: ActionEvent): Promise<void> => {
    const platform = platformFromAdapter(event.adapter.name);
    await project(
      fromChatSdkInteraction(event, {
        platform,
        conversationId: event.thread?.channelId ?? event.threadId,
        occurredAt: now().toISOString(),
        anchors: { sourceMessageId: event.messageId, sourceThreadId: event.threadId },
      }),
      event.raw,
      event.adapter.botUserId,
    );
  });

  chat.onReaction(async (event: ReactionEvent): Promise<void> => {
    const platform = platformFromAdapter(event.adapter.name);
    await project(
      fromChatSdkReaction(event, {
        platform,
        conversationId: event.thread.channelId,
        occurredAt: now().toISOString(),
        anchors: { sourceMessageId: event.messageId, sourceThreadId: event.threadId },
      }),
      event.raw,
      event.adapter.botUserId,
    );
  });
}
