import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SlackAdapter } from "@chat-adapter/slack";
import { type ChannelPermissionPolicy, type ChannelRole, createReplyGrantFromEvent, type ReplyGrant, recordGrantPublicReply, routeSlackMention, type SlackMentionEvent } from "@joelclaw/channel-routing";
import type { InboundEvent } from "@joelclaw/message-contract";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { type EnqueueFn, getRedisClient, pushGatewayEvent } from "./channels/redis";
import type {
  Channel,
  ChannelPlatform,
  MessageHandler,
  SendMediaPayload,
  SendOptions,
} from "./channels/types";
import { loadGatewayInngestEventConfig } from "./lib/inngest-event";

type SlackChannelMessage = {
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
  threadId?: string;
};

async function postChannelMessageEvent(
  msg: SlackChannelMessage,
  eventApi: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const response = await fetchFn(eventApi, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "channel/message.received",
      data: {
        channelType: "slack",
        channelId: msg.channelId,
        channelName: msg.channelName,
        userId: msg.userId,
        userName: msg.userName,
        text: msg.text,
        timestamp: msg.timestamp,
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Inngest event API returned HTTP ${response.status}`);
  }

  return response.status;
}

// ADR-0236: Emit channel/message.received to Inngest for realtime Typesense indexing.
async function emitChannelMessageEvent(msg: SlackChannelMessage): Promise<void> {
  const config = loadGatewayInngestEventConfig();
  if (!config) {
    const error = "Inngest event config missing";
    console.error("[gateway:slack] channel ingest handoff failed", { error });
    void emitGatewayOtel({
      level: "error",
      component: "slack-channel",
      action: "slack.channel_ingest.forward_failed",
      success: false,
      error,
      metadata: { reason: "missing_event_config", channelId: msg.channelId },
    });
    return;
  }

  try {
    const httpStatus = await postChannelMessageEvent(msg, config.eventApi);

    void emitGatewayOtel({
      level: "debug",
      component: "slack-channel",
      action: "slack.channel_ingest.forwarded",
      success: true,
      metadata: { channelId: msg.channelId, httpStatus },
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    console.error("[gateway:slack] channel ingest handoff failed", {
      channelId: msg.channelId,
      error,
    });
    void emitGatewayOtel({
      level: "error",
      component: "slack-channel",
      action: "slack.channel_ingest.forward_failed",
      success: false,
      error,
      metadata: { reason: "request_failed", channelId: msg.channelId },
    });
  }
}

function grantKey(channelId: string, threadTs: string): string {
  return `${REPLY_GRANT_KEY_PREFIX}:${channelId}:${threadTs}`;
}

function roleForSlackUser(userId: string, allowedUserId?: string): ChannelRole {
  if (allowedUserId && userId === allowedUserId) return "owner";
  if (SLACK_TRUSTED_USER_IDS.has(userId)) return "trusted-collaborator";
  return "observer";
}

function buildSlackPolicy(allowedUserId: string | undefined, importantChannelIds: string[]): ChannelPermissionPolicy {
  const principals: Record<string, ChannelRole> = {};
  if (allowedUserId) principals[allowedUserId] = "owner";
  for (const userId of SLACK_TRUSTED_USER_IDS) principals[userId] = "trusted-collaborator";
  return {
    principals,
    channelAllowlist: importantChannelIds,
  };
}

async function readReplyGrant(channelId: string, threadTs: string): Promise<ReplyGrant | undefined> {
  const redis = getRedisClient();
  if (!redis) return undefined;
  const raw = await redis.get(grantKey(channelId, threadTs));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ReplyGrant;
  } catch {
    return undefined;
  }
}

async function writeReplyGrant(grant: ReplyGrant): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  const ttlMs = Math.max(1_000, grant.absoluteExpiresAt - Date.now());
  await redis.psetex(grantKey(grant.channelId, grant.threadTs), ttlMs, JSON.stringify(grant));
}

function slackThreadUrl(channelId: string, threadTs: string): string {
  const compact = threadTs.replace(".", "");
  return `https://eggheadio.slack.com/archives/${channelId}/p${compact}?thread_ts=${threadTs}&channel=${channelId}`;
}

function extractMentionedUserIds(text: string): string[] {
  const matches = text.matchAll(/<@([A-Z0-9]+)>/gu);
  return [...new Set([...matches].map((match) => match[1]).filter((id): id is string => Boolean(id)))]
    .filter((id) => id !== botUserId && id !== allowedUserId);
}

async function pushSlackMentionTelegramAlert(input: {
  channelId: string;
  threadTs: string;
  messageTs?: string;
  userId?: string;
  userLabel: string;
  text: string;
  grantActive: boolean;
  reason: string;
}): Promise<void> {
  const redis = getRedisClient();
  const approvalId = crypto.randomUUID().slice(0, 12);
  if (redis) {
    await redis.setex(`replyGrantApproval:${approvalId}`, 2 * 60 * 60, JSON.stringify({
      platform: "slack",
      channelId: input.channelId,
      threadTs: input.threadTs,
      messageTs: input.messageTs ?? input.threadTs,
      userId: input.userId,
      userLabel: input.userLabel,
      text: input.text,
      createdAt: Date.now(),
    }));
  }
  const threadUrl = slackThreadUrl(input.channelId, input.threadTs);
  await pushGatewayEvent({

    type: "slack.mention.approval_requested",
    source: `slack:${input.channelId}:${input.threadTs}`,
    payload: {
      immediateTelegram: true,
      telegramOnly: true,
      telegramFormat: "plain",
      telegramMessage: [
        `Slack mention: ${input.userLabel}`,
        input.grantActive ? "Reply Grant: active" : "Reply Grant: inactive",
        `Reason: ${input.reason}`,
        "",
        input.text.length > 500 ? `${input.text.slice(0, 497)}...` : input.text,
        "",
        threadUrl,
      ].join("\n"),
      telegramButtons: [
        [
          { text: "Send suggested", action: `replygrant:send:${approvalId}` },
          { text: "Edit first", action: `replygrant:edit:${approvalId}` },
          { text: "Grant", action: `replygrant:grant:${approvalId}` },
        ],
        [
          { text: "Ignore", action: `replygrant:ignore:${approvalId}` },
        ],
        [
          { text: "Open thread", url: threadUrl },
        ],
      ],
    },
  });
}

const CHUNK_MAX = 4000;
const DEDUPE_MAX = 500;
const MEDIA_FETCH_TIMEOUT_MS = 15_000;
const CHANNEL_RESOLVE_TRANSIENT_COOLDOWN_MS = 10 * 60_000;
const CHANNEL_RESOLVE_PERMANENT_COOLDOWN_MS = 6 * 60 * 60_000;
const PERMANENT_CHANNEL_RESOLVE_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "missing_scope",
  "is_archived",
  "method_not_supported_for_channel_type",
]);
const REPLY_GRANT_KEY_PREFIX = "replyGrant:slack";
const SLACK_TRUSTED_USER_IDS = new Set(
  (process.env.SLACK_TRUSTED_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

export type SlackRuntimeOptions = {
  allowedUserId?: string;
  reactionAckEmoji?: string;
  importantChannelIds?: string[];
  importantChannelNames?: string[];
};

type SlackSendOptions = {
  threadTs?: string;
  reaction?: string;
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
};

type SlackSendMediaOptions = {
  threadTs?: string;
  filename?: string;
  title?: string;
};

type SlackMessageEvent = {
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
};

type SlackReactionEvent = {
  reaction?: string;
  user?: string;
  itemUser?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
};

type ParsedSlackTarget = {
  channelId: string;
  threadTs?: string;
};

type SlackContext = {
  source: string;
  prefix: string;
};

let adapter: SlackAdapter | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let initialized = false;
let botUserId: string | undefined;
let allowedUserId: string | undefined;
let reactionAckEmoji = "eyes";
let importantChannelIds = new Set<string>();
let importantChannelNames = new Set<string>();
let defaultInstance: SlackChannel | undefined;

const channelNameCache = new Map<string, string>();
const channelResolveCooldownUntil = new Map<string, number>();
const userNameCache = new Map<string, string>();
const seenEvents = new Set<string>();
const seenOrder: string[] = [];
const mentionThreads = new Set<string>();

function mapSendOptionsFromChannelSendOptions(options?: SendOptions): SlackSendOptions | undefined {
  if (!options) return undefined;
  const slackOptions = options as unknown as SlackSendOptions;
  return {
    ...slackOptions,
    threadTs: slackOptions.threadTs ?? options.threadId,
  };
}

function parseCsvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function optionListToSet(values: string[] | undefined, fallback: string | undefined): Set<string> {
  if (values && values.length > 0) {
    return new Set(values.map((item) => item.trim()).filter((item) => item.length > 0));
  }
  return parseCsvSet(fallback);
}

function isImportantSlackChannel(channelId: string, channelName: string | undefined): boolean {
  if (importantChannelIds.has(channelId)) return true;
  if (!channelName) return false;
  return importantChannelNames.has(channelName) || importantChannelNames.has(`#${channelName}`);
}

function chunkMessage(text: string): string[] {
  if (text.length <= CHUNK_MAX) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_MAX) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", CHUNK_MAX);
    if (splitAt < CHUNK_MAX * 0.5) splitAt = remaining.lastIndexOf(" ", CHUNK_MAX);
    if (splitAt < CHUNK_MAX * 0.3) splitAt = CHUNK_MAX;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

function rememberEvent(key: string): boolean {
  if (seenEvents.has(key)) return false;
  seenEvents.add(key);
  seenOrder.push(key);
  if (seenOrder.length <= DEDUPE_MAX) return true;

  const stale = seenOrder.shift();
  if (stale) seenEvents.delete(stale);
  return true;
}

function stripBotMention(text: string): string {
  if (!botUserId) return text.trim();
  const mentionPattern = new RegExp(`<@${botUserId}>`, "g");
  return text.replace(mentionPattern, "").trim();
}

function parseTarget(target: string, explicitThreadTs?: string): ParsedSlackTarget | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;

  const raw = trimmed.startsWith("slack:") ? trimmed.slice("slack:".length) : trimmed;
  if (!raw) return undefined;

  let channelId = raw;
  let threadTs = explicitThreadTs;

  if (!threadTs && raw.includes("|")) {
    const [channelPart, threadPart] = raw.split("|", 2);
    channelId = channelPart?.trim() ?? "";
    threadTs = threadPart?.trim() || undefined;
  } else if (!threadTs && raw.includes(":")) {
    const firstColon = raw.indexOf(":");
    channelId = raw.slice(0, firstColon).trim();
    threadTs = raw.slice(firstColon + 1).trim() || undefined;
  }

  if (!channelId) return undefined;
  return {
    channelId,
    ...(threadTs ? { threadTs } : {}),
  };
}

function parseMessageEvent(input: unknown): SlackMessageEvent | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  return {
    channel: typeof value.channel === "string" ? value.channel : undefined,
    channel_type: typeof value.channel_type === "string" ? value.channel_type : undefined,
    user: typeof value.user === "string" ? value.user : undefined,
    text: typeof value.text === "string" ? value.text : undefined,
    ts: typeof value.ts === "string" ? value.ts : undefined,
    thread_ts: typeof value.thread_ts === "string" ? value.thread_ts : undefined,
    subtype: typeof value.subtype === "string" ? value.subtype : undefined,
    bot_id: typeof value.bot_id === "string" ? value.bot_id : undefined,
  };
}

function parseReactionEvent(input: unknown): SlackReactionEvent | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const rawItem = value.item;
  const item =
    rawItem && typeof rawItem === "object"
      ? {
          type: typeof (rawItem as Record<string, unknown>).type === "string"
            ? (rawItem as Record<string, unknown>).type as string
            : undefined,
          channel: typeof (rawItem as Record<string, unknown>).channel === "string"
            ? (rawItem as Record<string, unknown>).channel as string
            : undefined,
          ts: typeof (rawItem as Record<string, unknown>).ts === "string"
            ? (rawItem as Record<string, unknown>).ts as string
            : undefined,
        }
      : undefined;

  return {
    reaction: typeof value.reaction === "string" ? value.reaction : undefined,
    user: typeof value.user === "string" ? value.user : undefined,
    itemUser: typeof value.item_user === "string" ? value.item_user : undefined,
    item,
  };
}

function readSlackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  const value = error as Record<string, unknown>;

  const data = value.data;
  if (data && typeof data === "object") {
    const code = (data as Record<string, unknown>).error;
    if (typeof code === "string" && code.trim().length > 0) {
      return code.trim();
    }
  }

  const message = typeof value.message === "string" ? value.message : String(error);
  const match = message.match(/:\s*([a-z_]+)\s*$/i);
  if (match?.[1]) {
    return match[1].toLowerCase();
  }

  if (typeof value.code === "string" && value.code.trim().length > 0) {
    return value.code.trim();
  }

  return undefined;
}

function isPermanentChannelResolveError(code: string | undefined): boolean {
  if (!code) return false;
  return PERMANENT_CHANNEL_RESOLVE_ERRORS.has(code.toLowerCase());
}

async function resolveChannelName(channelId: string): Promise<string | undefined> {
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;

  const blockedUntil = channelResolveCooldownUntil.get(channelId);
  if (blockedUntil && blockedUntil > Date.now()) return undefined;

  if (!adapter) return undefined;

  try {
    const response = await adapter.webClient.conversations.info({ channel: channelId });
    const name = response.channel?.name;
    if (!name) return undefined;
    channelResolveCooldownUntil.delete(channelId);
    channelNameCache.set(channelId, name);
    return name;
  } catch (error) {
    const errorText = String(error);
    const errorCode = readSlackErrorCode(error);
    const isPermanent = isPermanentChannelResolveError(errorCode);
    const cooldownMs = isPermanent
      ? CHANNEL_RESOLVE_PERMANENT_COOLDOWN_MS
      : CHANNEL_RESOLVE_TRANSIENT_COOLDOWN_MS;
    channelResolveCooldownUntil.set(channelId, Date.now() + cooldownMs);

    if (!isPermanent) {
      console.warn("[gateway:slack] failed to resolve channel name", {
        channelId,
        error: errorText,
        errorCode,
      });
    }

    void emitGatewayOtel({
      level: isPermanent ? "debug" : "warn",
      component: "slack-channel",
      action: isPermanent ? "slack.channel.resolve_unavailable" : "slack.channel.resolve_failed",
      success: false,
      error: errorText,
      metadata: {
        channelId,
        errorCode,
        cooldownMs,
      },
    });
    return undefined;
  }
}

async function resolveUserLabel(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  if (!adapter) return userId;

  try {
    const response = await adapter.webClient.users.info({ user: userId });
    const profile = response.user?.profile;
    const label = profile?.display_name?.trim()
      || profile?.real_name?.trim()
      || response.user?.real_name?.trim()
      || response.user?.name?.trim()
      || userId;
    userNameCache.set(userId, label);
    return label;
  } catch (error) {
    console.warn("[gateway:slack] failed to resolve user", { userId, error: String(error) });
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.user.resolve_failed",
      success: false,
      error: String(error),
      metadata: { userId },
    });
    return userId;
  }
}

async function resolveSlackContext(
  channelId: string,
  channelType: string | undefined,
  threadTs: string | undefined,
): Promise<SlackContext> {
  const threadSuffix = threadTs ? ` thread ${threadTs}` : "";
  const source = threadTs ? `slack:${channelId}:${threadTs}` : `slack:${channelId}`;
  const isDm = channelType === "im" || channelId.startsWith("D");
  if (isDm) {
    return { source, prefix: `[Slack DM${threadSuffix}]` };
  }

  const channelName = await resolveChannelName(channelId);
  if (!channelName) {
    return { source, prefix: `[Slack #${channelId}${threadSuffix}]` };
  }

  return {
    source,
    prefix: `[Slack #${channelName}${threadSuffix}]`,
  };
}

function extractThreadTs(message: SlackMessageEvent): string | undefined {
  if (!message.thread_ts) return undefined;
  if (message.thread_ts === message.ts) return undefined;
  return message.thread_ts;
}

async function handleIncomingMessage(
  rawMessage: unknown,
  kind: "message" | "mention",
  options: {
    readonly chatSdkEventId?: string;
  } = {},
): Promise<void> {
  if (!enqueuePrompt) return;
  botUserId = adapter?.botUserId ?? botUserId;

  const message = parseMessageEvent(rawMessage);
  if (!message?.channel || !message.user || !message.text || !message.ts) return;
  if (message.bot_id) return;
  if (message.subtype && message.subtype !== "thread_broadcast") return;
  if (botUserId && message.user === botUserId) return;

  const dedupeKey = `${message.channel}:${message.ts}`;
  if (!options.chatSdkEventId && !rememberEvent(dedupeKey)) return;

  const text = kind === "mention" ? stripBotMention(message.text) : message.text.trim();
  if (!text) return;

  const startedAt = Date.now();
  const threadTs = extractThreadTs(message);
  const effectiveThreadTs = threadTs ?? (kind === "mention" ? message.ts : undefined);
  const context = await resolveSlackContext(message.channel, message.channel_type, effectiveThreadTs);
  const isDm = message.channel_type === "im" || message.channel.startsWith("D");
  const channelName = isDm ? undefined : await resolveChannelName(message.channel);
  const isAllowedUser = allowedUserId ? message.user === allowedUserId : false;
  const isImportantChannel = !isDm && isImportantSlackChannel(message.channel, channelName);
  let replyGrantShouldPost = false;
  const isInvoke = () => (isDm && isAllowedUser)
    || replyGrantShouldPost
    || kind === "mention"
    || (threadTs && mentionThreads.has(threadTs));

  if (kind === "mention" && message.channel && message.ts) {
    const threadKey = effectiveThreadTs ?? message.ts;
    mentionThreads.add(threadKey);
    if (mentionThreads.size > 200) {
      const first = mentionThreads.values().next().value;
      if (first) mentionThreads.delete(first);
    }
  }

  const userLabel = await resolveUserLabel(message.user);

  const activeGrant = !isDm && effectiveThreadTs ? await readReplyGrant(message.channel, effectiveThreadTs) : undefined;

  if (!isDm && effectiveThreadTs && (kind === "mention" || activeGrant)) {
    const policy = buildSlackPolicy(allowedUserId, [
      ...importantChannelIds,
      ...(isImportantChannel ? [message.channel] : []),
    ]);
    const routingEvent: SlackMentionEvent = {
      platform: "slack",
      channelId: message.channel,
      threadTs: effectiveThreadTs,
      messageTs: message.ts,
      senderUserId: message.user,
      senderRole: roleForSlackUser(message.user, allowedUserId),
      text,
      botMentioned: kind === "mention",
      isJoelOriginated: isAllowedUser,
      now: Date.now(),
    };
    const intents = routeSlackMention({ event: routingEvent, policy, activeGrant });
    const shouldPost = intents.some((intent) => intent.type === "postPublicReply");

    if (!shouldPost) {
      await pushSlackMentionTelegramAlert({
        channelId: message.channel,
        threadTs: effectiveThreadTs,
        messageTs: message.ts,
        userId: message.user,
        userLabel,
        text,
        grantActive: Boolean(activeGrant),
        reason: intents.map((intent) => intent.type === "recordOtel" ? intent.action : `${intent.type}:${intent.reason}`).join(", "),
      });
      void emitGatewayOtel({
        level: "info",
        component: "slack-channel",
        action: "slack.mention.approval_requested",
        success: true,
        duration_ms: Date.now() - startedAt,
        metadata: {
          channelId: message.channel,
          threadTs: effectiveThreadTs,
          userId: message.user,
          intentTypes: intents.map((intent) => intent.type),
        },
      });
      return;
    }

    replyGrantShouldPost = true;

    if (intents.some((intent) => intent.type === "createGrant")) {
      const invokerUserIds = [...new Set([message.user, ...extractMentionedUserIds(message.text ?? "")])]
        .filter((userId) => userId !== allowedUserId && userId !== botUserId);
      await writeReplyGrant(createReplyGrantFromEvent(routingEvent, allowedUserId ?? message.user, invokerUserIds));
    }
  }

  // ADR-0131/0210 + ADR-0244: Slack routing.
  // Invoke: Joel DM, Joel-authorized @mentions, active Reply Grants, and tracked mention threads.
  // Passive intel: Joel-authored channel messages and messages from selected important channels.
  // Everything else stays quiet to avoid turning Slack into a firehose.
  if (isInvoke()) {
    const prompt = `${context.prefix} ${userLabel}: ${text}`;

    await enqueuePrompt(context.source, prompt, {
      slackChannelId: message.channel,
      slackThreadTs: effectiveThreadTs,
      slackUserId: message.user,
      slackTs: message.ts,
      slackEventKind: kind,
      ...(options.chatSdkEventId
        ? { chatSdkEventId: options.chatSdkEventId, chatSdkActing: true }
        : {}),
    });

    void emitGatewayOtel({
      level: "info",
      component: "slack-channel",
      action: "slack.message.received",
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: {
        kind,
        channelId: message.channel,
        threadTs: effectiveThreadTs,
        userId: message.user,
        length: text.length,
      },
    });

    // ADR-0236: Index to Typesense for gateway context gathering
    emitChannelMessageEvent({
      channelId: message.channel,
      channelName: context.source.replace("slack:", ""),
      userId: message.user,
      userName: userLabel,
      text,
      timestamp: Math.floor(Date.now() / 1000),
      threadId: effectiveThreadTs,
    });

    return;
  } else if (isAllowedUser || isImportantChannel) {
    const intelPrompt = `${context.prefix} ${userLabel}: ${text}`;
    const payload = {
      prompt: intelPrompt,
      slackChannelId: message.channel,
      slackChannelName: channelName,
      slackThreadTs: effectiveThreadTs,
      slackUserId: message.user,
      slackUserName: userLabel,
      slackTs: message.ts,
      slackEventKind: kind,
      passiveIntel: true,
      joelSignal: isAllowedUser,
      importantChannel: isImportantChannel,
      ...(options.chatSdkEventId
        ? { chatSdkEventId: options.chatSdkEventId, chatSdkActing: true }
        : {}),
    };

    const queuedEvent = await pushGatewayEvent({
      type: "slack.signal.received",
      source: `slack-intel:${message.channel}`,
      payload,
    });

    if (!queuedEvent && isAllowedUser) {
      await enqueuePrompt(`slack-intel:${message.channel}`, intelPrompt, payload);
    }

    void emitGatewayOtel({
      level: "debug",
      component: "slack-channel",
      action: "slack.message.passive_ingest",
      success: true,
      metadata: {
        channelId: message.channel,
        channelName,
        threadTs: effectiveThreadTs,
        userId: message.user,
        joelSignal: isAllowedUser,
        importantChannel: isImportantChannel,
        routedVia: queuedEvent
          ? "redis-event"
          : isAllowedUser
            ? "direct-enqueue-fallback"
            : "index-only-redis-unavailable",
      },
    });

    // ADR-0236: Index to Typesense for gateway context gathering
    emitChannelMessageEvent({
      channelId: message.channel,
      channelName: channelName ?? context.source.replace("slack-intel:", "").replace("slack:", ""),
      userId: message.user,
      userName: userLabel,
      text,
      timestamp: Math.floor(Date.now() / 1000),
      threadId: effectiveThreadTs,
    });

    return;
  }
}

/** Reuse the established Reply Grant/passive-intel policy after SDK normalization. */
export async function dispatchChatSdkMessagePolicy(
  rawMessage: unknown,
  kind: "message" | "mention",
  chatSdkEventId: string,
): Promise<void> {
  await handleIncomingMessage(rawMessage, kind, { chatSdkEventId });
}

async function maybeAcknowledgeReaction(channelId: string, timestamp: string): Promise<void> {
  if (!adapter || !reactionAckEmoji) return;
  try {
    await adapter.webClient.reactions.add({
      channel: channelId,
      name: reactionAckEmoji,
      timestamp,
    });
  } catch (error) {
    const errorText = String(error);
    if (errorText.includes("already_reacted")) return;
    console.warn("[gateway:slack] failed to add reaction ack", {
      channelId,
      timestamp,
      error: errorText,
    });
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.reaction.ack_failed",
      success: false,
      error: errorText,
      metadata: {
        channelId,
        timestamp,
        reaction: reactionAckEmoji,
      },
    });
  }
}

async function handleReactionAdded(rawEvent: unknown): Promise<void> {
  if (!enqueuePrompt) return;

  botUserId = adapter?.botUserId ?? botUserId;
  const event = parseReactionEvent(rawEvent);
  if (!event?.user || !event.item?.channel || !event.item.ts || !event.reaction) return;
  if (event.item.type !== "message") return;
  if (botUserId && event.user === botUserId) return;
  if (allowedUserId && event.user !== allowedUserId) return;

  const dedupeKey = `reaction:${event.user}:${event.item.channel}:${event.item.ts}:${event.reaction}`;
  if (!rememberEvent(dedupeKey)) return;

  const startedAt = Date.now();
  const context = await resolveSlackContext(event.item.channel, undefined, event.item.ts);
  const userLabel = await resolveUserLabel(event.user);

  if (event.reaction !== "joelclaw") {
    void emitGatewayOtel({
      level: "debug",
      component: "slack-channel",
      action: "slack.reaction.ignored",
      success: true,
      metadata: {
        channelId: event.item.channel,
        ts: event.item.ts,
        userId: event.user,
        reaction: event.reaction,
      },
    });
    return;
  }

  const grantEvent: SlackMentionEvent = {
    platform: "slack",
    channelId: event.item.channel,
    threadTs: event.item.ts,
    messageTs: event.item.ts,
    senderUserId: event.user,
    senderRole: roleForSlackUser(event.user, allowedUserId),
    text: `${context.prefix} ${userLabel} reacted :${event.reaction}:`,
    botMentioned: false,
    isJoelOriginated: true,
    now: Date.now(),
  };
  const invokerUserIds = event.itemUser && event.itemUser !== allowedUserId && event.itemUser !== botUserId
    ? [event.itemUser]
    : [];
  const grant = createReplyGrantFromEvent(grantEvent, allowedUserId ?? event.user, invokerUserIds);
  await writeReplyGrant(grant);
  await pushSlackMentionTelegramAlert({
    channelId: event.item.channel,
    threadTs: event.item.ts,
    messageTs: event.item.ts,
    userId: event.itemUser,
    userLabel,
    text: `:${event.reaction}: created Reply Grant for ${event.itemUser ?? "thread"}`,
    grantActive: true,
    reason: "reaction-created-grant",
  });

  void emitGatewayOtel({
    level: "info",
    component: "slack-channel",
    action: "slack.reply_grant.created_by_reaction",
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      channelId: event.item.channel,
      ts: event.item.ts,
      userId: event.user,
      itemUser: event.itemUser,
      reaction: event.reaction,
      invokerCount: invokerUserIds.length,
    },
  });

  await maybeAcknowledgeReaction(event.item.channel, event.item.ts);
}

export async function dispatchChatSdkReactionPolicy(
  rawEvent: unknown,
  event: InboundEvent,
): Promise<void> {
  if (event.platform !== "slack" || event.type !== "reaction" || !event.added) return;
  await handleReactionAdded(rawEvent);
}

function parseFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").pop()?.trim();
    if (filename) return filename;
  } catch {}
  return `attachment-${Date.now()}`;
}

export class SlackChannel implements Channel {
  readonly platform: ChannelPlatform = "slack";

  async start(..._args: unknown[]): Promise<void> {
    const [sdkAdapter, enqueue, options] = _args;
    await initialize(
      sdkAdapter as SlackAdapter,
      enqueue as EnqueueFn,
      options as SlackRuntimeOptions | undefined,
    );
  }

  async stop(): Promise<void> {
    await shutdownSlackRuntime();
  }

  async send(target: string, text: string, options?: SendOptions): Promise<void> {
    await this.sendWithLegacy(target, text, mapSendOptionsFromChannelSendOptions(options));
  }

  onMessage(_handler: MessageHandler): void {
    // The Slack channel wires directly to gateway queueing via start() instead of MessageHandler
    void _handler;
  }

  async sendWithLegacy(
    channelOrThread: string,
    text: string,
    options?: SlackSendOptions,
  ): Promise<void> {
    await sendSlackChannel(channelOrThread, text, options);
  }

  async sendMedia(
    channelOrThread: string,
    media: SendMediaPayload,
    options?: SendOptions,
  ): Promise<void> {
    await sendSlackMedia(channelOrThread, media, {
      threadTs: options?.threadId,
    });
  }
}

function getDefaultSlackChannel(): SlackChannel {
  if (!defaultInstance) {
    defaultInstance = new SlackChannel();
  }
  return defaultInstance;
}

export async function initialize(
  sdkAdapter: SlackAdapter,
  enqueue: EnqueueFn,
  options: SlackRuntimeOptions = {},
): Promise<void> {
  adapter = sdkAdapter;
  enqueuePrompt = enqueue;
  allowedUserId = options.allowedUserId ?? process.env.SLACK_ALLOWED_USER_ID;
  reactionAckEmoji = options.reactionAckEmoji ?? process.env.SLACK_REACTION_ACK_EMOJI ?? "eyes";
  importantChannelIds = optionListToSet(
    options.importantChannelIds,
    process.env.SLACK_IMPORTANT_CHANNEL_IDS,
  );
  importantChannelNames = optionListToSet(
    options.importantChannelNames,
    process.env.SLACK_IMPORTANT_CHANNEL_NAMES,
  );
  botUserId = sdkAdapter.botUserId;
  initialized = true;
  console.log("[gateway:slack] SDK policy initialized", {
    botUserId,
    allowedUserId,
    importantChannelIds: importantChannelIds.size,
    importantChannelNames: importantChannelNames.size,
  });
  void emitGatewayOtel({
    level: "info",
    component: "slack-runtime",
    action: "slack.runtime.initialized",
    success: true,
    metadata: {
      botUserId,
      allowedUserId,
      importantChannelIds: importantChannelIds.size,
      importantChannelNames: importantChannelNames.size,
    },
  });
}

async function sendSlackChannel(
  channelOrThread: string,
  text: string,
  options?: SlackSendOptions,
): Promise<void> {
  if (!adapter) {
    console.warn("[gateway:slack] app unavailable, skipping send");
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.send.skipped",
      success: false,
      error: "app_unavailable",
    });
    return;
  }

  const target = parseTarget(channelOrThread, options?.threadTs);
  if (!target) {
    console.warn("[gateway:slack] invalid target", { channelOrThread });
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.send.invalid_target",
      success: false,
      metadata: { channelOrThread },
    });
    return;
  }

  const chunks = chunkMessage(text);
  const startedAt = Date.now();
  let anchorTs: string | undefined;

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    try {
      const response = await adapter.webClient.chat.postMessage({
        channel: target.channelId,
        text: chunk,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
        ...(options?.unfurlLinks === false ? { unfurl_links: false } : {}),
        ...(options?.unfurlMedia === false ? { unfurl_media: false } : {}),
      });
      anchorTs = response.ts ?? response.message?.ts ?? anchorTs;
    } catch (error) {
      console.error("[gateway:slack] send failed", {
        channelId: target.channelId,
        threadTs: target.threadTs,
        error: String(error),
      });
      void emitGatewayOtel({
        level: "error",
        component: "slack-channel",
        action: "slack.send.failed",
        success: false,
        error: String(error),
        metadata: {
          channelId: target.channelId,
          threadTs: target.threadTs,
        },
      });
      return;
    }
  }

  if (options?.reaction && anchorTs) {
    try {
      await adapter.webClient.reactions.add({
        channel: target.channelId,
        name: options.reaction,
        timestamp: anchorTs,
      });
    } catch (error) {
      console.warn("[gateway:slack] send reaction failed", {
        channelId: target.channelId,
        reaction: options.reaction,
        error: String(error),
      });
      void emitGatewayOtel({
        level: "warn",
        component: "slack-channel",
        action: "slack.send.reaction_failed",
        success: false,
        error: String(error),
        metadata: {
          channelId: target.channelId,
          reaction: options.reaction,
        },
      });
    }
  }

  if (target.threadTs) {
    const grant = await readReplyGrant(target.channelId, target.threadTs);
    if (grant) {
      const updatedGrant = recordGrantPublicReply(grant, Date.now());
      await writeReplyGrant(updatedGrant);
      const threadUrl = slackThreadUrl(target.channelId, target.threadTs);
      await pushGatewayEvent({
        type: "slack.reply_grant.receipt",
        source: `slack:${target.channelId}:${target.threadTs}`,
        payload: {
          immediateTelegram: true,
          telegramOnly: true,
          telegramFormat: "plain",
          telegramMessage: [
            "Slack Reply Grant used",
            `${updatedGrant.repliesUsed}/${updatedGrant.maxReplies} replies used`,
            threadUrl,
          ].join("\n"),
          telegramButtons: [
            [
              { text: "Close Grant", action: `replygrant:close:${target.channelId}:${target.threadTs}` },
              { text: "Open thread", url: threadUrl },
            ],
          ],
        },
      });
    }
  }

  void emitGatewayOtel({
    level: "debug",
    component: "slack-channel",
    action: "slack.send.completed",
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      channelId: target.channelId,
      threadTs: target.threadTs,
      chunks: chunks.length,
      length: text.length,
    },
  });
}

export async function send(channelOrThread: string, text: string, options?: SlackSendOptions): Promise<void> {
  const instance = getDefaultSlackChannel();
  await instance.sendWithLegacy(channelOrThread, text, options);
}

async function sendSlackMedia(
  channelOrThread: string,
  media: SendMediaPayload,
  options?: SlackSendMediaOptions,
): Promise<void> {
  if (!adapter) {
    console.warn("[gateway:slack] app unavailable, skipping sendMedia");
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.send_media.skipped",
      success: false,
      error: "app_unavailable",
    });
    return;
  }

  const target = parseTarget(channelOrThread, options?.threadTs);
  if (!target) {
    console.warn("[gateway:slack] invalid media target", { channelOrThread });
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.send_media.invalid_target",
      success: false,
      metadata: { channelOrThread },
    });
    return;
  }

  const startedAt = Date.now();
  const filename = options?.filename
    ?? (media.url ? parseFilenameFromUrl(media.url) : media.path ? basename(media.path) : "upload");
  const caption = media.caption?.trim() ?? "";

  try {
    let fileBuffer: Buffer;
    if (media.url) {
      const response = await fetch(media.url, {
        signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`media fetch failed with ${response.status}`);
      }

      fileBuffer = Buffer.from(await response.arrayBuffer());
    } else if (media.path) {
      fileBuffer = await readFile(media.path);
    } else {
      throw new Error("media payload missing url/path");
    }

    const uploadArgs = {
      channel_id: target.channelId,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      ...(caption ? { initial_comment: caption } : {}),
      file: fileBuffer,
      filename,
      title: options?.title ?? filename,
    };
    await adapter.webClient.files.uploadV2(uploadArgs as never);

    void emitGatewayOtel({
      level: "info",
      component: "slack-channel",
      action: "slack.send_media.completed",
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: {
        channelId: target.channelId,
        threadTs: target.threadTs,
        mediaUrl: media.url,
        mediaPath: media.path,
        filename,
      },
    });
  } catch (error) {
    console.error("[gateway:slack] sendMedia failed, falling back to link", {
      channelId: target.channelId,
      threadTs: target.threadTs,
      mediaUrl: media.url,
      mediaPath: media.path,
      error: String(error),
    });
    void emitGatewayOtel({
      level: "error",
      component: "slack-channel",
      action: "slack.send_media.failed",
      success: false,
      error: String(error),
      metadata: {
        channelId: target.channelId,
        threadTs: target.threadTs,
        mediaUrl: media.url,
        mediaPath: media.path,
      },
    });

    const mediaRef = media.url ?? media.path ?? "[media]";
    const fallbackText = caption ? `${caption}\n${mediaRef}` : mediaRef;
    await send(`slack:${target.channelId}${target.threadTs ? `:${target.threadTs}` : ""}`, fallbackText);
  }
}

export async function sendMedia(
  channelOrThread: string,
  media: SendMediaPayload,
  options?: SendOptions,
): Promise<void> {
  const instance = getDefaultSlackChannel();
  await instance.sendMedia(channelOrThread, media, options);
}

async function shutdownSlackRuntime(): Promise<void> {
  initialized = false;
  adapter = undefined;
  enqueuePrompt = undefined;
  botUserId = undefined;
  allowedUserId = undefined;
  channelNameCache.clear();
  channelResolveCooldownUntil.clear();
  userNameCache.clear();
  seenEvents.clear();
  seenOrder.length = 0;
  mentionThreads.clear();
  console.log("[gateway:slack] SDK policy stopped");
}

export async function shutdown(): Promise<void> {
  await shutdownSlackRuntime();
}

export type SlackRuntimeState = {
  configured: boolean;
  initialized: boolean;
  botUserId: string | null;
  allowedUserId: string | null;
};

export function getRuntimeState(): SlackRuntimeState {
  botUserId = adapter?.botUserId ?? botUserId;
  return {
    configured: Boolean(allowedUserId && adapter),
    initialized,
    botUserId: botUserId ?? null,
    allowedUserId: allowedUserId ?? null,
  };
}

export const __slackTestUtils = { postChannelMessageEvent };
