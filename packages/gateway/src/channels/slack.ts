import { execSync } from "node:child_process";
import type { EnqueueFn } from "./redis";
import { emitGatewayOtel } from "../observability";

const CHUNK_MAX = 4000;
const DEDUPE_MAX = 500;
const MEDIA_FETCH_TIMEOUT_MS = 15_000;

type SlackStartOptions = {
  botToken?: string;
  appToken?: string;
  allowedUserId?: string;
  reactionAckEmoji?: string;
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

type SlackAuthTestResponse = {
  user_id?: string;
};

type SlackConversationsInfoResponse = {
  channel?: {
    name?: string;
    is_im?: boolean;
  };
};

type SlackUsersInfoResponse = {
  user?: {
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
};

type SlackPostMessageResponse = {
  ts?: string;
  message?: {
    ts?: string;
  };
};

type SlackWebClientLike = {
  auth: {
    test: () => Promise<SlackAuthTestResponse>;
  };
  chat: {
    postMessage: (args: Record<string, unknown>) => Promise<SlackPostMessageResponse>;
  };
  files: {
    uploadV2: (args: Record<string, unknown>) => Promise<unknown>;
  };
  conversations: {
    info: (args: Record<string, unknown>) => Promise<SlackConversationsInfoResponse>;
  };
  users: {
    info: (args: Record<string, unknown>) => Promise<SlackUsersInfoResponse>;
  };
  reactions: {
    add: (args: Record<string, unknown>) => Promise<unknown>;
  };
};

type SlackAppLike = {
  client: SlackWebClientLike;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  message: (handler: (args: Record<string, unknown>) => Promise<void>) => void;
  event: (eventName: string, handler: (args: Record<string, unknown>) => Promise<void>) => void;
  error?: (handler: (error: Error) => void) => void;
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

type SlackBoltModule = {
  App: new (options: Record<string, unknown>) => SlackAppLike;
};

let app: SlackAppLike | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let started = false;
let botUserId: string | undefined;
let allowedUserId: string | undefined;
let reactionAckEmoji = "eyes";

const channelNameCache = new Map<string, string>();
const userNameCache = new Map<string, string>();
const seenEvents = new Set<string>();
const seenOrder: string[] = [];

function leaseSecret(name: string): string {
  return execSync(`secrets lease ${name} --ttl 4h`, { encoding: "utf8" }).trim();
}

function leaseSecretSafe(name: string): string | undefined {
  try {
    const secret = leaseSecret(name).trim();
    if (!secret) return undefined;
    return secret;
  } catch (error) {
    console.warn("[gateway:slack] failed to lease secret", { name, error: String(error) });
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.secret.lease_failed",
      success: false,
      error: String(error),
      metadata: { name },
    });
    return undefined;
  }
}

async function loadSlackBolt(): Promise<SlackBoltModule | undefined> {
  try {
    const importer = new Function("specifier", "return import(specifier);") as (
      specifier: string,
    ) => Promise<unknown>;
    const loaded = await importer("@slack/bolt");
    const module = loaded as Partial<SlackBoltModule>;
    if (typeof module.App !== "function") return undefined;
    return { App: module.App };
  } catch (error) {
    console.warn("[gateway:slack] @slack/bolt unavailable; slack channel disabled", {
      error: String(error),
    });
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.channel.dependency_missing",
      success: false,
      error: String(error),
    });
    return undefined;
  }
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
    item,
  };
}

async function resolveChannelName(channelId: string): Promise<string | undefined> {
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;
  if (!app) return undefined;

  try {
    const response = await app.client.conversations.info({ channel: channelId });
    const name = response.channel?.name;
    if (!name) return undefined;
    channelNameCache.set(channelId, name);
    return name;
  } catch (error) {
    console.warn("[gateway:slack] failed to resolve channel name", {
      channelId,
      error: String(error),
    });
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.channel.resolve_failed",
      success: false,
      error: String(error),
      metadata: { channelId },
    });
    return undefined;
  }
}

async function resolveUserLabel(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  if (!app) return userId;

  try {
    const response = await app.client.users.info({ user: userId });
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

async function handleIncomingMessage(rawMessage: unknown, kind: "message" | "mention"): Promise<void> {
  if (!enqueuePrompt) return;

  const message = parseMessageEvent(rawMessage);
  if (!message?.channel || !message.user || !message.text || !message.ts) return;
  if (message.bot_id) return;
  if (message.subtype && message.subtype !== "thread_broadcast") return;
  if (botUserId && message.user === botUserId) return;

  const dedupeKey = `${message.channel}:${message.ts}`;
  if (!rememberEvent(dedupeKey)) return;

  const text = kind === "mention" ? stripBotMention(message.text) : message.text.trim();
  if (!text) return;

  const startedAt = Date.now();
  const threadTs = extractThreadTs(message);
  const context = await resolveSlackContext(message.channel, message.channel_type, threadTs);
  const isDm = message.channel_type === "im" || message.channel.startsWith("D");
  const isAllowedUser = allowedUserId ? message.user === allowedUserId : false;

  // ADR-0131: Slack is passive intelligence only.
  // Only DMs from Joel get routed to the gateway session for a reply.
  // Channel messages are ingested for intelligence but never replied to.
  if (!isDm || !isAllowedUser) {
    void emitGatewayOtel({
      level: "debug",
      component: "slack-channel",
      action: "slack.message.passive_ingest",
      success: true,
      metadata: {
        channelId: message.channel,
        threadTs,
        userId: message.user,
        reason: !isDm ? "channel_message" : "non_joel_dm",
      },
    });
    return;
  }

  const userLabel = await resolveUserLabel(message.user);
  const prompt = `${context.prefix} ${userLabel}: ${text}`;

  await enqueuePrompt(context.source, prompt, {
    slackChannelId: message.channel,
    slackThreadTs: threadTs,
    slackUserId: message.user,
    slackTs: message.ts,
    slackEventKind: kind,
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
      threadTs,
      userId: message.user,
      length: text.length,
    },
  });
}

async function maybeAcknowledgeReaction(channelId: string, timestamp: string): Promise<void> {
  if (!app || !reactionAckEmoji) return;
  try {
    await app.client.reactions.add({
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
  const text = `${context.prefix} ${userLabel} reacted :${event.reaction}:`;

  await enqueuePrompt(context.source, text, {
    slackChannelId: event.item.channel,
    slackThreadTs: event.item.ts,
    slackUserId: event.user,
    slackReaction: event.reaction,
    slackEventKind: "reaction_added",
  });

  void emitGatewayOtel({
    level: "info",
    component: "slack-channel",
    action: "slack.reaction.received",
    success: true,
    duration_ms: Date.now() - startedAt,
    metadata: {
      channelId: event.item.channel,
      ts: event.item.ts,
      userId: event.user,
      reaction: event.reaction,
    },
  });

  await maybeAcknowledgeReaction(event.item.channel, event.item.ts);
}

function parseFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").pop()?.trim();
    if (filename) return filename;
  } catch {}
  return `attachment-${Date.now()}`;
}

export async function start(enqueue: EnqueueFn, options?: SlackStartOptions): Promise<void> {
  if (started) return;

  enqueuePrompt = enqueue;
  allowedUserId = options?.allowedUserId ?? process.env.SLACK_ALLOWED_USER_ID;
  reactionAckEmoji = options?.reactionAckEmoji ?? process.env.SLACK_REACTION_ACK_EMOJI ?? "eyes";

  const botToken = options?.botToken ?? leaseSecretSafe("slack_bot_token");
  const appToken = options?.appToken ?? leaseSecretSafe("slack_app_token");

  if (!botToken || !appToken) {
    console.warn("[gateway:slack] slack disabled — missing token(s)");
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.channel.disabled",
      success: false,
      metadata: {
        hasBotToken: Boolean(botToken),
        hasAppToken: Boolean(appToken),
      },
    });
    return;
  }

  const bolt = await loadSlackBolt();
  if (!bolt) return;

  app = new bolt.App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  if (typeof app.error === "function") {
    app.error((error: Error) => {
      console.error("[gateway:slack] app error", { error: error.message });
      void emitGatewayOtel({
        level: "error",
        component: "slack-channel",
        action: "slack.channel.error",
        success: false,
        error: error.message,
      });
    });
  }

  app.message(async ({ message }: Record<string, unknown>) => {
    try {
      await handleIncomingMessage(message, "message");
    } catch (error) {
      console.error("[gateway:slack] message handler failed", { error: String(error) });
      void emitGatewayOtel({
        level: "error",
        component: "slack-channel",
        action: "slack.message.handler_failed",
        success: false,
        error: String(error),
      });
    }
  });

  app.event("app_mention", async ({ event }: Record<string, unknown>) => {
    try {
      await handleIncomingMessage(event, "mention");
    } catch (error) {
      console.error("[gateway:slack] app_mention handler failed", { error: String(error) });
      void emitGatewayOtel({
        level: "error",
        component: "slack-channel",
        action: "slack.mention.handler_failed",
        success: false,
        error: String(error),
      });
    }
  });

  app.event("reaction_added", async ({ event }: Record<string, unknown>) => {
    try {
      await handleReactionAdded(event);
    } catch (error) {
      console.error("[gateway:slack] reaction_added handler failed", { error: String(error) });
      void emitGatewayOtel({
        level: "error",
        component: "slack-channel",
        action: "slack.reaction.handler_failed",
        success: false,
        error: String(error),
      });
    }
  });

  try {
    await app.start();
    started = true;
    const auth = await app.client.auth.test();
    botUserId = typeof auth.user_id === "string" ? auth.user_id : undefined;

    console.log("[gateway:slack] started", {
      botUserId,
      allowedUserId,
    });
    void emitGatewayOtel({
      level: "info",
      component: "slack-channel",
      action: "slack.channel.started",
      success: true,
      metadata: {
        botUserId,
        allowedUserId,
      },
    });
  } catch (error) {
    console.error("[gateway:slack] failed to start; slack channel disabled", {
      error: String(error),
    });
    void emitGatewayOtel({
      level: "error",
      component: "slack-channel",
      action: "slack.channel.start_failed",
      success: false,
      error: String(error),
    });
    app = undefined;
    started = false;
    botUserId = undefined;
  }
}

export async function send(channelOrThread: string, text: string, options?: SlackSendOptions): Promise<void> {
  if (!app || !started) {
    console.warn("[gateway:slack] app not started, skipping send");
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.send.skipped",
      success: false,
      error: "app_not_started",
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
      const response = await app.client.chat.postMessage({
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
      await app.client.reactions.add({
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

export async function sendMedia(
  channelOrThread: string,
  text: string,
  mediaUrl: string,
  options?: SlackSendMediaOptions,
): Promise<void> {
  if (!app || !started) {
    console.warn("[gateway:slack] app not started, skipping sendMedia");
    void emitGatewayOtel({
      level: "warn",
      component: "slack-channel",
      action: "slack.send_media.skipped",
      success: false,
      error: "app_not_started",
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
  const filename = options?.filename ?? parseFilenameFromUrl(mediaUrl);

  try {
    const response = await fetch(mediaUrl, {
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`media fetch failed with ${response.status}`);
    }

    const fileBuffer = Buffer.from(await response.arrayBuffer());
    await app.client.files.uploadV2({
      channel_id: target.channelId,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      ...(text.trim() ? { initial_comment: text.trim() } : {}),
      file: fileBuffer,
      filename,
      title: options?.title ?? filename,
    });

    void emitGatewayOtel({
      level: "info",
      component: "slack-channel",
      action: "slack.send_media.completed",
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: {
        channelId: target.channelId,
        threadTs: target.threadTs,
        mediaUrl,
        filename,
      },
    });
  } catch (error) {
    console.error("[gateway:slack] sendMedia failed, falling back to link", {
      channelId: target.channelId,
      threadTs: target.threadTs,
      mediaUrl,
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
        mediaUrl,
      },
    });

    const fallbackText = text.trim() ? `${text.trim()}\n${mediaUrl}` : mediaUrl;
    await send(`slack:${target.channelId}${target.threadTs ? `:${target.threadTs}` : ""}`, fallbackText);
  }
}

export async function shutdown(): Promise<void> {
  if (app) {
    try {
      await app.stop();
    } catch (error) {
      console.error("[gateway:slack] stop failed", { error: String(error) });
      void emitGatewayOtel({
        level: "warn",
        component: "slack-channel",
        action: "slack.channel.stop_failed",
        success: false,
        error: String(error),
      });
    }
  }

  app = undefined;
  enqueuePrompt = undefined;
  started = false;
  botUserId = undefined;
  channelNameCache.clear();
  userNameCache.clear();
  seenEvents.clear();
  seenOrder.length = 0;

  console.log("[gateway:slack] stopped");
  void emitGatewayOtel({
    level: "info",
    component: "slack-channel",
    action: "slack.channel.stopped",
    success: true,
  });
}

export function isStarted(): boolean {
  return started;
}
