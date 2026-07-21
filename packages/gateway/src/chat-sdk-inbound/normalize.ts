import { createHash } from "node:crypto";
import { DiscordAdapter } from "@chat-adapter/discord";
import { SlackAdapter } from "@chat-adapter/slack";
import { TelegramAdapter } from "@chat-adapter/telegram";
import {
  decodeInboundEvent,
  INBOUND_EVENT_CONTRACT_VERSION,
  type InboundActor,
  type InboundAuthorization,
  type InboundEvent,
  type InboundPlatform,
  type InboundRawAnchors,
} from "@joelclaw/message-contract";
import type {
  ActionEvent,
  Adapter,
  ChatInstance,
  Message,
  ReactionEvent,
  SlashCommandEvent,
} from "chat";

export interface RawInboundEnvelope {
  readonly platform: InboundPlatform;
  readonly kind: InboundEvent["type"];
  readonly transport: string;
  readonly rawEventType: string;
  readonly raw: unknown;
  readonly receivedAt: string;
  readonly allowedActorId: string;
  readonly botActorId?: string;
}

interface ChatSdkNormalizedBase {
  readonly kind: InboundEvent["type"];
  readonly platform: InboundPlatform;
  readonly actor: {
    readonly id: string;
    readonly userName?: string;
    readonly displayName?: string;
    readonly isBot: boolean | "unknown";
    readonly isMe: boolean;
  };
  readonly conversationId: string;
  readonly messageId?: string;
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly occurredAt: string;
  readonly rawEventId?: string;
  readonly anchors?: Partial<InboundRawAnchors>;
}

export interface ChatSdkNormalizedMessage extends ChatSdkNormalizedBase {
  readonly kind: "message";
  readonly text: string;
  readonly isMention: boolean;
  readonly attachmentCount: number;
}

export interface ChatSdkNormalizedCommand extends ChatSdkNormalizedBase {
  readonly kind: "command";
  readonly command: string;
  readonly argumentsText: string;
}

export interface ChatSdkNormalizedInteraction extends ChatSdkNormalizedBase {
  readonly kind: "interaction";
  readonly actionId: string;
  readonly value?: string;
}

export interface ChatSdkNormalizedReaction extends ChatSdkNormalizedBase {
  readonly kind: "reaction";
  readonly emoji: string;
  readonly rawEmoji: string;
  readonly added: boolean;
}

export type ChatSdkNormalizedInbound =
  | ChatSdkNormalizedMessage
  | ChatSdkNormalizedCommand
  | ChatSdkNormalizedInteraction
  | ChatSdkNormalizedReaction;

const replyTargetByInboundEventId = new Map<string, string>();

export function replyTargetForInboundEvent(eventId: string): string | undefined {
  return replyTargetByInboundEventId.get(eventId);
}

export interface ChatSdkProjectionContext {
  readonly platform: InboundPlatform;
  readonly conversationId: string;
  readonly workspaceId?: string;
  readonly occurredAt: string;
  readonly rawEventId?: string;
  readonly anchors?: Partial<InboundRawAnchors>;
}

function sdkActor(actor: {
  readonly userId: string;
  readonly userName: string;
  readonly fullName: string;
  readonly isBot: boolean | "unknown";
  readonly isMe: boolean;
}): ChatSdkNormalizedBase["actor"] {
  return {
    id: actor.userId,
    userName: actor.userName,
    displayName: actor.fullName,
    isBot: actor.isBot,
    isMe: actor.isMe,
  };
}

/** Project a message only after vercel/chat has parsed the platform payload. */
export function fromChatSdkMessage(
  message: Message,
  context: ChatSdkProjectionContext,
): ChatSdkNormalizedMessage {
  return {
    kind: "message",
    platform: context.platform,
    actor: sdkActor(message.author),
    conversationId: context.conversationId,
    messageId: message.id,
    threadId: message.threadId,
    workspaceId: context.workspaceId,
    occurredAt: message.metadata.dateSent.toISOString(),
    rawEventId: context.rawEventId,
    anchors: context.anchors,
    text: message.text,
    isMention: message.isMention ?? false,
    attachmentCount: message.attachments.length,
  };
}

/** Project a slash command emitted by vercel/chat's command handler. */
export function fromChatSdkCommand(
  event: SlashCommandEvent,
  context: ChatSdkProjectionContext,
): ChatSdkNormalizedCommand {
  return {
    kind: "command",
    platform: context.platform,
    actor: sdkActor(event.user),
    conversationId: context.conversationId,
    workspaceId: context.workspaceId,
    occurredAt: context.occurredAt,
    rawEventId: context.rawEventId,
    anchors: context.anchors,
    command: event.command,
    argumentsText: event.text,
  };
}

/** Project an action emitted by vercel/chat's action handler. */
export function fromChatSdkInteraction(
  event: ActionEvent,
  context: ChatSdkProjectionContext,
): ChatSdkNormalizedInteraction {
  return {
    kind: "interaction",
    platform: context.platform,
    actor: sdkActor(event.user),
    conversationId: context.conversationId,
    messageId: event.messageId,
    threadId: event.threadId,
    workspaceId: context.workspaceId,
    occurredAt: context.occurredAt,
    rawEventId: context.rawEventId,
    anchors: context.anchors,
    actionId: event.actionId,
    value: event.value,
  };
}

/** Project a reaction emitted by vercel/chat's reaction handler. */
export function fromChatSdkReaction(
  event: ReactionEvent,
  context: ChatSdkProjectionContext,
): ChatSdkNormalizedReaction {
  return {
    kind: "reaction",
    platform: context.platform,
    actor: sdkActor(event.user),
    conversationId: context.conversationId,
    messageId: event.messageId,
    threadId: event.threadId,
    workspaceId: context.workspaceId,
    occurredAt: context.occurredAt,
    rawEventId: context.rawEventId,
    anchors: context.anchors,
    emoji: event.emoji.name,
    rawEmoji: event.rawEmoji,
    added: event.added,
  };
}

/**
 * Adapter boundary around vercel/chat. The integration supplies the real SDK
 * adapter/handler normalization; this module never re-parses platform payloads.
 */
export type ChatSdkRawNormalizer = (
  envelope: RawInboundEnvelope,
) => Promise<ChatSdkNormalizedInbound | ReadonlyArray<ChatSdkNormalizedInbound>>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function deriveReplyTargetMessageId(envelope: RawInboundEnvelope): string | undefined {
  const raw = record(envelope.raw);
  const message = record(raw?.message) ?? record(raw?.edited_message) ?? raw;
  const telegramReply = record(message?.reply_to_message);
  const discordReference = record(message?.message_reference);
  const currentSlackTs = scalar(message?.ts) ?? scalar(raw?.ts);
  const slackThreadTs = scalar(message?.thread_ts) ?? scalar(raw?.thread_ts);
  return scalar(telegramReply?.message_id)
    ?? scalar(discordReference?.message_id)
    ?? (slackThreadTs && slackThreadTs !== currentSlackTs ? slackThreadTs : undefined);
}

function deriveRawAnchors(envelope: RawInboundEnvelope): InboundRawAnchors {
  const raw = record(envelope.raw);
  const message = record(raw?.message) ?? record(raw?.edited_message);
  const callback = record(raw?.callback_query)
    ?? (envelope.kind === "interaction" ? raw : undefined);
  const callbackMessage = record(callback?.message);
  const reaction = record(raw?.message_reaction);
  const item = record(raw?.item);
  const discordReaction = record(raw?.reaction);
  const discordReactionMessage = record(discordReaction?.message);
  const sourceMessage = message ?? callbackMessage ?? reaction;
  return {
    transportEventId:
      scalar(raw?.update_id)
      ?? scalar(callback?.id)
      ?? scalar(raw?.event_ts)
      ?? scalar(raw?.id)
      ?? null,
    updateId: scalar(raw?.update_id) ?? null,
    callbackQueryId: scalar(callback?.id) ?? null,
    sourceMessageId:
      scalar(sourceMessage?.message_id) ??
      scalar(item?.ts) ??
      scalar(discordReactionMessage?.id) ??
      scalar(raw?.messageId) ??
      null,
    sourceThreadId:
      scalar(sourceMessage?.message_thread_id) ??
      scalar(raw?.thread_ts) ??
      null,
  };
}

function captureContext(
  adapter: Pick<Adapter, "channelIdFromThreadId">,
  envelope: RawInboundEnvelope,
  threadOrChannelId: string,
  alreadyChannelId = false,
): ChatSdkProjectionContext {
  const anchors = deriveRawAnchors(envelope);
  return {
    platform: envelope.platform,
    conversationId: alreadyChannelId
      ? threadOrChannelId
      : adapter.channelIdFromThreadId(threadOrChannelId),
    occurredAt: envelope.receivedAt,
    rawEventId: anchors.transportEventId ?? undefined,
    anchors,
  };
}

function makeCaptureChat(
  adapter: Adapter,
  envelope: RawInboundEnvelope,
  events: ChatSdkNormalizedInbound[],
  tasks: Promise<unknown>[],
): ChatInstance {
  const pushMessage = (message: Message): void => {
    events.push(
      fromChatSdkMessage(
        message,
        captureContext(adapter, envelope, message.threadId),
      ),
    );
  };

  return {
    handleIncomingMessage: async (
      _adapter: Adapter,
      _threadId: string,
      message: Message,
    ): Promise<void> => {
      pushMessage(message);
    },
    processMessage: (
      _adapter: Adapter,
      _threadId: string,
      messageOrFactory: Message | (() => Promise<Message>),
    ): Promise<void> => {
      if (typeof messageOrFactory !== "function") {
        pushMessage(messageOrFactory);
        return Promise.resolve();
      }
      const task = messageOrFactory().then(pushMessage);
      tasks.push(task);
      return task;
    },
    processSlashCommand: (
      event: Parameters<ChatInstance["processSlashCommand"]>[0],
    ): void => {
      events.push(
        fromChatSdkCommand(
          {
            ...event,
            channel: {},
            openModal: async () => undefined,
          } as unknown as SlashCommandEvent,
          captureContext(adapter, envelope, event.channelId, true),
        ),
      );
    },
    processAction: async (
      event: Parameters<ChatInstance["processAction"]>[0],
    ): Promise<void> => {
      events.push(
        fromChatSdkInteraction(
          {
            ...event,
            thread: null,
            openModal: async () => undefined,
          } as unknown as ActionEvent,
          captureContext(adapter, envelope, event.threadId),
        ),
      );
    },
    processReaction: (
      event: Parameters<ChatInstance["processReaction"]>[0],
    ): void => {
      events.push(
        fromChatSdkReaction(
          {
            ...event,
            adapter,
            thread: {},
          } as unknown as ReactionEvent,
          captureContext(adapter, envelope, event.threadId),
        ),
      );
    },
  } as unknown as ChatInstance;
}

class TelegramInboundShadowAdapter extends TelegramAdapter {
  setShadowBotActorId(actorId: string | undefined): void {
    this._botUserId = actorId;
  }

  protected override async telegramFetch<TResult>(): Promise<TResult> {
    // processUpdate only uses this for typing/callback acknowledgements. Shadow
    // normalization must never call the platform.
    return true as TResult;
  }

  async capture(envelope: RawInboundEnvelope): Promise<ReadonlyArray<ChatSdkNormalizedInbound>> {
    const events: ChatSdkNormalizedInbound[] = [];
    const tasks: Promise<unknown>[] = [];
    this.chat = makeCaptureChat(this, envelope, events, tasks);
    this.processUpdate(envelope.raw as never, {
      waitUntil: (task) => tasks.push(Promise.resolve(task)),
    });
    await Promise.all(tasks);
    return events.filter((event) => event.kind === envelope.kind);
  }
}

class SlackInboundShadowAdapter extends SlackAdapter {
  async capture(envelope: RawInboundEnvelope): Promise<ReadonlyArray<ChatSdkNormalizedInbound>> {
    const events: ChatSdkNormalizedInbound[] = [];
    const tasks: Promise<unknown>[] = [];
    this.chat = makeCaptureChat(this, envelope, events, tasks);

    if (envelope.kind === "message") {
      const message = this.parseMessage(envelope.raw as never);
      events.push(
        fromChatSdkMessage(
          message,
          captureContext(this, envelope, message.threadId),
        ),
      );
    } else if (envelope.kind === "reaction") {
      await this.handleReactionEvent(envelope.raw as never, {
        waitUntil: (task) => tasks.push(Promise.resolve(task)),
      });
    } else {
      throw new Error(`Slack has no current raw ${envelope.kind} owner path`);
    }

    await Promise.all(tasks);
    return events.filter((event) => event.kind === envelope.kind);
  }
}

class DiscordInboundShadowAdapter extends DiscordAdapter {
  async capture(envelope: RawInboundEnvelope): Promise<ReadonlyArray<ChatSdkNormalizedInbound>> {
    const events: ChatSdkNormalizedInbound[] = [];
    const tasks: Promise<unknown>[] = [];
    this.chat = makeCaptureChat(this, envelope, events, tasks);

    if (envelope.kind === "message") {
      // Never let shadow normalization create a Discord thread. DMs and
      // existing-thread messages retain their real SDK normalization; a guild
      // mention remains anchored to its current channel until live cutover.
      await this.handleGatewayMessage(envelope.raw as never, false);
    } else if (envelope.kind === "command") {
      const context = this.getApplicationCommandContext(
        this.normalizeGatewaySlashCommandInteraction(envelope.raw as never),
      );
      this.handleApplicationCommandInteraction(context);
    } else if (envelope.kind === "reaction") {
      const raw = record(envelope.raw);
      await this.handleGatewayReaction(
        raw?.reaction as never,
        raw?.user as never,
        raw?.added !== false,
      );
    } else {
      throw new Error(`Discord has no current raw ${envelope.kind} owner path`);
    }

    await Promise.all(tasks);
    return events.filter((event) => event.kind === envelope.kind);
  }
}

export type TelegramSdkRawNormalizerOptions = NonNullable<
  ConstructorParameters<typeof TelegramAdapter>[0]
> & { readonly botActorId?: string };

export function createTelegramSdkRawNormalizer(
  options: TelegramSdkRawNormalizerOptions,
): ChatSdkRawNormalizer {
  const { botActorId, ...adapterOptions } = options;
  const adapter = new TelegramInboundShadowAdapter(adapterOptions);
  adapter.setShadowBotActorId(botActorId);
  return (envelope) => adapter.capture(envelope);
}

export type SlackSdkRawNormalizerOptions = NonNullable<
  ConstructorParameters<typeof SlackAdapter>[0]
>;

export function createSlackSdkRawNormalizer(
  options: SlackSdkRawNormalizerOptions,
): ChatSdkRawNormalizer {
  const adapter = new SlackInboundShadowAdapter(options);
  return (envelope) => adapter.capture(envelope);
}

export type DiscordSdkRawNormalizerOptions = NonNullable<
  ConstructorParameters<typeof DiscordAdapter>[0]
>;

export function createDiscordSdkRawNormalizer(
  options: DiscordSdkRawNormalizerOptions,
): ChatSdkRawNormalizer {
  const adapter = new DiscordInboundShadowAdapter(options);
  return (envelope) => adapter.capture(envelope);
}

export interface ChatSdkMessageRawNormalizerOptions {
  readonly adapter: Pick<Adapter, "parseMessage" | "channelIdFromThreadId">;
  readonly extractRawMessage: (rawEnvelope: unknown) => unknown;
  readonly context: (
    envelope: RawInboundEnvelope,
    message: Message,
  ) => Omit<ChatSdkProjectionContext, "platform" | "conversationId"> & {
    readonly conversationId?: string;
  };
}

/**
 * Side-effect-free message path used by the in-process tap. The current
 * listener keeps transport ownership; the pinned Chat SDK adapter only parses
 * the raw message already delivered to that owner.
 */
export function createChatSdkMessageRawNormalizer(
  options: ChatSdkMessageRawNormalizerOptions,
): ChatSdkRawNormalizer {
  return async (envelope) => {
    if (envelope.kind !== "message") {
      throw new Error(`Message normalizer cannot normalize ${envelope.kind}`);
    }
    const message = options.adapter.parseMessage(
      options.extractRawMessage(envelope.raw),
    );
    const context = options.context(envelope, message);
    return fromChatSdkMessage(message, {
      ...context,
      platform: envelope.platform,
      conversationId:
        context.conversationId ??
        options.adapter.channelIdFromThreadId(message.threadId),
    });
  };
}

export interface NormalizeInboundOptions {
  readonly sdkVersion: string;
  readonly now?: () => Date;
}

function stableId(parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function normalizeActor(input: ChatSdkNormalizedBase["actor"]): InboundActor {
  return {
    platformUserId: input.id,
    userName: input.userName ?? null,
    displayName: input.displayName ?? null,
    isBot: input.isBot,
    isSelf: input.isMe,
  };
}

export function authorizeSdkActor(
  actor: ChatSdkNormalizedBase["actor"],
  envelope: Pick<RawInboundEnvelope, "allowedActorId" | "botActorId">,
  kind: InboundEvent["type"],
): InboundAuthorization {
  const actualActorId = actor.id ?? "";
  const rejected = (
    reason: Exclude<InboundAuthorization["reason"], "authorized_joel">,
  ): InboundAuthorization => ({
    verdict: "rejected",
    reason,
    policyAction: "reject",
    expectedActorId: envelope.allowedActorId,
    actualActorId,
    canPublish: true,
    canExecute: false,
  });

  if (!actualActorId) return rejected("missing_actor");
  if (actor.isMe || actualActorId === envelope.botActorId) {
    return rejected("self_message");
  }
  if (actor.isBot === true) return rejected("bot_message");
  if (actualActorId !== envelope.allowedActorId) {
    return rejected("non_joel_actor");
  }

  return {
    verdict: "accepted",
    reason: "authorized_joel",
    policyAction: kind === "reaction" ? "observe" : "invoke",
    expectedActorId: envelope.allowedActorId,
    actualActorId,
    canPublish: true,
    canExecute: false,
  };
}

function eventIdentityParts(event: ChatSdkNormalizedInbound): ReadonlyArray<string> {
  switch (event.kind) {
    case "message":
      return [event.text, String(event.isMention), String(event.attachmentCount)];
    case "command":
      return [event.command, event.argumentsText];
    case "interaction":
      return [event.actionId, event.value ?? ""];
    case "reaction":
      return [event.emoji, event.rawEmoji, event.added ? "added" : "removed"];
  }
}

function rawAnchors(
  event: ChatSdkNormalizedInbound,
  envelope: RawInboundEnvelope,
): InboundRawAnchors {
  const derived = deriveRawAnchors(envelope);
  return {
    transportEventId:
      event.anchors?.transportEventId
      ?? event.rawEventId
      ?? derived.transportEventId
      ?? null,
    updateId: event.anchors?.updateId ?? derived.updateId ?? null,
    callbackQueryId:
      event.anchors?.callbackQueryId
      ?? derived.callbackQueryId
      ?? null,
    sourceMessageId:
      event.anchors?.sourceMessageId
      ?? derived.sourceMessageId
      ?? event.messageId
      ?? null,
    sourceThreadId:
      event.anchors?.sourceThreadId
      ?? derived.sourceThreadId
      ?? event.threadId
      ?? null,
  };
}

/**
 * Contract v2 exposes platform-native IDs. Chat SDK deliberately prefixes its
 * internal channel/thread handles (for example `telegram:7718912466`) so one
 * Chat instance can disambiguate adapters. Those handles belong in threadId;
 * they must not leak into platformIds or flow correlation keys.
 */
function platformNativeId(platform: InboundPlatform, value: string): string {
  const prefix = `${platform}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function platformMessageId(
  event: ChatSdkNormalizedInbound,
  anchors: InboundRawAnchors,
): string | null {
  const candidate = anchors.sourceMessageId ?? event.messageId;
  if (!candidate) return null;

  const native = platformNativeId(event.platform, candidate);
  return native.includes(":") ? (native.split(":").at(-1) ?? native) : native;
}

export function normalizeSdkInboundEvent(
  event: ChatSdkNormalizedInbound,
  envelope: RawInboundEnvelope,
  options: NormalizeInboundOptions,
): InboundEvent {
  if (event.platform !== envelope.platform || event.kind !== envelope.kind) {
    throw new Error(
      `Chat SDK normalized ${event.platform}/${event.kind} for ${envelope.platform}/${envelope.kind}`,
    );
  }

  const normalizedAt = (options.now ?? (() => new Date()))().toISOString();
  const authorization = authorizeSdkActor(event.actor, envelope, event.kind);
  const anchors = rawAnchors(event, envelope);
  const rawEventId = event.rawEventId
    ?? anchors.callbackQueryId
    ?? anchors.updateId
    ?? anchors.transportEventId;
  const lineageId = stableId([
    event.platform,
    event.kind,
    event.conversationId,
    event.threadId ?? "",
    rawEventId ?? "",
    event.messageId ?? "",
    event.actor.id,
    rawEventId ? "" : event.occurredAt,
    ...eventIdentityParts(event),
  ]);
  const common = {
    contractVersion: INBOUND_EVENT_CONTRACT_VERSION,
    eventId: `${event.platform}:${event.kind}:${lineageId}`,
    platform: event.platform,
    occurredAt: event.occurredAt,
    observedAt: envelope.receivedAt,
    shadow: true as const,
    actor: normalizeActor(event.actor),
    platformIds: {
      conversationId: platformNativeId(event.platform, event.conversationId),
      messageId: platformMessageId(event, anchors),
      threadId: event.threadId ?? null,
      actorId: event.actor.id,
      workspaceId: event.workspaceId ?? null,
    },
    rawAnchors: anchors,
    audit: {
      source: `gateway.${event.platform}.${envelope.rawEventType}`,
      transport: envelope.transport,
      sdkName: "vercel/chat" as const,
      sdkVersion: options.sdkVersion,
      normalizedAt,
      rawEventType: envelope.rawEventType,
      rawEventId: rawEventId ?? null,
      lineageId,
    },
    authorization,
  };

  const replyTargetMessageId = deriveReplyTargetMessageId(envelope);
  if (replyTargetMessageId) {
    replyTargetByInboundEventId.set(common.eventId, replyTargetMessageId);
    if (replyTargetByInboundEventId.size > 5_000) {
      const oldest = replyTargetByInboundEventId.keys().next().value;
      if (oldest) replyTargetByInboundEventId.delete(oldest);
    }
  }

  switch (event.kind) {
    case "message":
      return decodeInboundEvent({
        ...common,
        type: event.kind,
        text: event.text,
        isMention: event.isMention,
        attachmentCount: event.attachmentCount,
      });
    case "command":
      return decodeInboundEvent({
        ...common,
        type: event.kind,
        command: event.command,
        argumentsText: event.argumentsText,
      });
    case "interaction":
      return decodeInboundEvent({
        ...common,
        type: event.kind,
        actionId: event.actionId,
        value: event.value ?? null,
      });
    case "reaction":
      return decodeInboundEvent({
        ...common,
        type: event.kind,
        emoji: event.emoji,
        rawEmoji: event.rawEmoji,
        added: event.added,
      });
  }
}

export async function normalizeRawInbound(
  envelope: RawInboundEnvelope,
  sdkNormalize: ChatSdkRawNormalizer,
  options: NormalizeInboundOptions,
): Promise<ReadonlyArray<InboundEvent>> {
  const normalized = await sdkNormalize(envelope);
  const events = Array.isArray(normalized) ? normalized : [normalized];
  return events.map((event) => normalizeSdkInboundEvent(event, envelope, options));
}
