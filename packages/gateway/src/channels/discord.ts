import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import type { EnqueueFn } from "./redis";
import { emitGatewayOtel } from "../observability";

const CHUNK_MAX = 2000;

let client: Client | undefined;
let allowedUserId: string | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let started = false;

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

async function handleMessage(message: Message): Promise<void> {
  // Only handle DMs and guild messages (not system messages, bots, etc.)
  if (message.author.bot) return;
  if (message.author.id !== allowedUserId) {
    console.warn("[gateway:discord] unauthorized user", {
      userId: message.author.id,
      username: message.author.tag,
    });
    return;
  }

  const text = message.content.trim();
  if (!text) return;

  const channelId = message.channelId;
  const source = `discord:${channelId}`;

  console.log("[gateway:discord] message received", {
    channelId,
    guildId: message.guildId ?? "dm",
    length: text.length,
  });

  void emitGatewayOtel({
    level: "info",
    component: "discord-channel",
    action: "discord.message.received",
    success: true,
    metadata: {
      channelId,
      guildId: message.guildId ?? "dm",
      length: text.length,
    },
  });

  // Show typing indicator
  try {
    if ("sendTyping" in message.channel) {
      await (message.channel as { sendTyping: () => Promise<void> }).sendTyping();
    }
  } catch {
    // non-critical
  }

  enqueuePrompt!(source, text, {
    discordChannelId: channelId,
    discordMessageId: message.id,
    discordGuildId: message.guildId ?? null,
    discordAuthorId: message.author.id,
  });
}

export async function start(token: string, userId: string, enqueue: EnqueueFn): Promise<void> {
  if (started) return;

  enqueuePrompt = enqueue;
  allowedUserId = userId;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.on(Events.ClientReady, (readyClient) => {
    console.log("[gateway:discord] started", {
      botId: readyClient.user.id,
      botUsername: readyClient.user.tag,
      allowedUserId,
    });
    void emitGatewayOtel({
      level: "info",
      component: "discord-channel",
      action: "discord.channel.started",
      success: true,
      metadata: {
        botId: readyClient.user.id,
        botUsername: readyClient.user.tag,
      },
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message);
  });

  client.on(Events.Error, (error) => {
    console.error("[gateway:discord] client error", { error: error.message });
    void emitGatewayOtel({
      level: "error",
      component: "discord-channel",
      action: "discord.channel.error",
      success: false,
      error: error.message,
    });
  });

  try {
    await client.login(token);
    started = true;
  } catch (error) {
    console.error("[gateway:discord] failed to start; discord channel disabled", {
      error: String(error),
    });
    void emitGatewayOtel({
      level: "error",
      component: "discord-channel",
      action: "discord.channel.start_failed",
      success: false,
      error: String(error),
    });
    client = undefined;
    throw error;
  }
}

/**
 * Send a text message to a Discord channel.
 * Discord renders markdown natively — pass through as-is, chunk at 2000 chars.
 */
export async function send(channelId: string, text: string): Promise<void> {
  if (!client) {
    console.error("[gateway:discord] client not started, can't send");
    void emitGatewayOtel({
      level: "warn",
      component: "discord-channel",
      action: "discord.send.skipped",
      success: false,
      error: "client_not_started",
    });
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    console.error("[gateway:discord] channel fetch failed", { channelId, error: String(error) });
    void emitGatewayOtel({
      level: "error",
      component: "discord-channel",
      action: "discord.send.channel_fetch_failed",
      success: false,
      error: String(error),
      metadata: { channelId },
    });
    return;
  }

  if (!channel || !channel.isTextBased()) {
    console.error("[gateway:discord] channel not text-based", { channelId });
    return;
  }

  // PartialGroupDMChannel doesn't support sendTyping/send — skip those
  if (!("send" in channel)) {
    console.error("[gateway:discord] channel does not support send", { channelId });
    return;
  }

  const sendableChannel = channel as { sendTyping?: () => Promise<void>; send: (text: string) => Promise<unknown> };

  // Show typing before sending
  try {
    await sendableChannel.sendTyping?.();
  } catch {
    // non-critical
  }

  const chunks = chunkMessage(text);
  const sendStartedAt = Date.now();

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    try {
      await sendableChannel.send(chunk);
    } catch (error) {
      console.error("[gateway:discord] send failed", { channelId, error: String(error) });
      void emitGatewayOtel({
        level: "error",
        component: "discord-channel",
        action: "discord.send.failed",
        success: false,
        error: String(error),
        metadata: { channelId },
      });
      return;
    }
  }

  void emitGatewayOtel({
    level: "debug",
    component: "discord-channel",
    action: "discord.send.completed",
    success: true,
    duration_ms: Date.now() - sendStartedAt,
    metadata: {
      channelId,
      chunks: chunks.length,
      length: text.length,
    },
  });
}

/**
 * Extract channel ID from a discord source string like "discord:12345"
 */
export function parseChannelId(source: string): string | undefined {
  const match = source.match(/^discord:(\d+)$/);
  return match?.[1];
}

export async function shutdown(): Promise<void> {
  if (client) {
    client.destroy();
    client = undefined;
  }
  started = false;
  console.log("[gateway:discord] stopped");
  void emitGatewayOtel({
    level: "info",
    component: "discord-channel",
    action: "discord.channel.stopped",
    success: true,
  });
}
