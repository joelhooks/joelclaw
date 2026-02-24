/**
 * Discord channel — thread-based conversations (ADR-0120)
 *
 * @mention in a channel → create thread, post status, forward prompt
 * Message in existing thread → forward prompt with thread source
 * DMs → forward directly (no threads)
 * Responses route back via source: "discord:THREAD_OR_CHANNEL_ID"
 * Status message edited on completion/error
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { EnqueueFn } from "./redis";
import { emitGatewayOtel } from "../observability";
import { enrichPromptWithVaultContext } from "../vault-read";

const CHUNK_MAX = 2000;

let client: Client | undefined;
let allowedUserId: string | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let started = false;

// ── Thread state tracking ──────────────────────────────────────────
// Maps thread ID → status message ID in the parent channel.
// In-memory only — lost on restart, which is fine (status updates are nice-to-have).
const threadStatusMessages = new Map<string, { parentChannelId: string; statusMessageId: string }>();

// ── Helpers ────────────────────────────────────────────────────────

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

function stripBotMention(content: string): string {
  const botId = client?.user?.id;
  let text = content.trim();
  if (botId) {
    text = text.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
  }
  return text;
}

function threadName(text: string): string {
  const clean = text.replace(/\n/g, " ").trim();
  if (clean.length <= 50) return clean || "New conversation";
  return clean.slice(0, 47) + "...";
}

// ── Message handling ───────────────────────────────────────────────

async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (message.author.id !== allowedUserId) {
    console.warn("[gateway:discord] unauthorized user", {
      userId: message.author.id,
      username: message.author.tag,
    });
    return;
  }

  const text = stripBotMention(message.content);
  if (!text) return;

  const isThread = message.channel.isThread();
  const isDM = !message.guildId;

  // ── Message in an existing thread ────────────────────────────
  if (isThread) {
    await handleThreadMessage(message, text);
    return;
  }

  // ── DM — no threads, just forward directly ──────────────────
  if (isDM) {
    await handleDM(message, text);
    return;
  }

  // ── @mention in a guild channel — create thread ─────────────
  const isMentioned = client?.user && message.mentions.has(client.user);
  if (!isMentioned) return; // Ignore non-mention messages in channels

  await handleNewThread(message, text);
}

async function handleDM(message: Message, text: string): Promise<void> {
  const channelId = message.channelId;
  const source = `discord:${channelId}`;

  console.log("[gateway:discord] DM received", { channelId, length: text.length });

  void emitGatewayOtel({
    level: "info",
    component: "discord-channel",
    action: "discord.dm.received",
    success: true,
    metadata: { channelId, length: text.length },
  });

  try {
    if ("sendTyping" in message.channel) {
      await (message.channel as { sendTyping: () => Promise<void> }).sendTyping();
    }
  } catch { /* non-critical */ }

  const prompt = await enrichPromptWithVaultContext(text);

  enqueuePrompt!(source, prompt, {
    discordChannelId: channelId,
    discordMessageId: message.id,
    discordAuthorId: message.author.id,
  });
}

async function handleNewThread(message: Message, text: string): Promise<void> {
  const parentChannel = message.channel as TextChannel;

  console.log("[gateway:discord] @mention — creating thread", {
    channelId: parentChannel.id,
    guildId: message.guildId,
    length: text.length,
  });

  // Post status message in the parent channel
  let statusMessage;
  let thread: ThreadChannel;
  try {
    statusMessage = await parentChannel.send("⏳ Processing...");

    thread = await statusMessage.startThread({
      name: threadName(text),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });

    // Track so we can update status when response arrives
    threadStatusMessages.set(thread.id, {
      parentChannelId: parentChannel.id,
      statusMessageId: statusMessage.id,
    });
  } catch (error) {
    console.error("[gateway:discord] failed to create thread", { error: String(error) });
    void emitGatewayOtel({
      level: "error",
      component: "discord-channel",
      action: "discord.thread.create_failed",
      success: false,
      error: String(error),
    });
    try { await message.reply("Failed to start thread. Try again?"); } catch { /* */ }
    return;
  }

  void emitGatewayOtel({
    level: "info",
    component: "discord-channel",
    action: "discord.thread.created",
    success: true,
    metadata: {
      threadId: thread.id,
      parentChannelId: parentChannel.id,
      guildId: message.guildId ?? "dm",
      length: text.length,
    },
  });

  // Show typing in the thread
  try { await thread.sendTyping(); } catch { /* */ }

  // Source is the THREAD ID — responses route back here
  const source = `discord:${thread.id}`;
  const prompt = await enrichPromptWithVaultContext(text);

  enqueuePrompt!(source, prompt, {
    discordChannelId: thread.id,
    discordMessageId: message.id,
    discordGuildId: message.guildId ?? null,
    discordAuthorId: message.author.id,
    discordParentChannelId: parentChannel.id,
    discordStatusMessageId: statusMessage.id,
  });
}

async function handleThreadMessage(message: Message, text: string): Promise<void> {
  const threadId = message.channelId;

  console.log("[gateway:discord] thread message", {
    threadId,
    length: text.length,
  });

  void emitGatewayOtel({
    level: "info",
    component: "discord-channel",
    action: "discord.thread.message_received",
    success: true,
    metadata: { threadId, length: text.length },
  });

  try { await (message.channel as ThreadChannel).sendTyping(); } catch { /* */ }

  const source = `discord:${threadId}`;
  const prompt = await enrichPromptWithVaultContext(text);

  enqueuePrompt!(source, prompt, {
    discordChannelId: threadId,
    discordMessageId: message.id,
    discordGuildId: message.guildId ?? null,
    discordAuthorId: message.author.id,
  });
}

// ── Reaction handler: ✅ on last message marks thread done ────────

async function handleReaction(reaction: any, user: any): Promise<void> {
  if (user.bot) return;
  if (reaction.emoji.name !== "✅") return;

  const channel = reaction.message.channel;
  if (!channel.isThread()) return;

  try {
    const thread = channel as ThreadChannel;
    const parentId = thread.parentId;
    if (!parentId) return;

    // Check if this is the last message
    const messages = await thread.messages.fetch({ limit: 1 });
    const lastMessage = messages.first();
    if (!lastMessage || lastMessage.id !== reaction.message.id) return;

    console.log("[gateway:discord] ✅ reaction on last message", { threadId: thread.id });

    // Update status message in parent channel
    const tracked = threadStatusMessages.get(thread.id);
    if (tracked) {
      try {
        const parentChannel = await client!.channels.fetch(tracked.parentChannelId) as TextChannel;
        const statusMsg = await parentChannel.messages.fetch(tracked.statusMessageId);
        await statusMsg.edit("✅ Done");
        threadStatusMessages.delete(thread.id);
      } catch (error) {
        console.error("[gateway:discord] failed to update status on reaction", { error: String(error) });
      }
    }
  } catch (error) {
    console.error("[gateway:discord] reaction handler error", { error: String(error) });
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────

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
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
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

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReaction(reaction, user);
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

// ── Outbound: send to channel/thread ──────────────────────────────

/**
 * Send a text message to a Discord channel or thread.
 * Also updates the parent-channel status message to "✅ Done" if tracked.
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

  if (!("send" in channel)) {
    console.error("[gateway:discord] channel does not support send", { channelId });
    return;
  }

  const sendableChannel = channel as { sendTyping?: () => Promise<void>; send: (text: string) => Promise<unknown> };

  try { await sendableChannel.sendTyping?.(); } catch { /* */ }

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

  // Update status message in parent channel if this was a thread response
  await updateStatusMessage(channelId, "✅ Done");
}

/**
 * Mark a thread's status message as error.
 */
export async function markError(channelId: string): Promise<void> {
  await updateStatusMessage(channelId, "❌ Error");
}

async function updateStatusMessage(threadId: string, status: string): Promise<void> {
  const tracked = threadStatusMessages.get(threadId);
  if (!tracked || !client) return;

  try {
    const parentChannel = await client.channels.fetch(tracked.parentChannelId) as TextChannel;
    const statusMsg = await parentChannel.messages.fetch(tracked.statusMessageId);
    await statusMsg.edit(status);
    if (status.startsWith("✅") || status.startsWith("❌")) {
      threadStatusMessages.delete(threadId);
    }
  } catch (error) {
    console.error("[gateway:discord] status update failed", {
      threadId,
      status,
      error: String(error),
    });
  }
}

/**
 * Extract channel/thread ID from a discord source string like "discord:12345"
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
  threadStatusMessages.clear();
  console.log("[gateway:discord] stopped");
  void emitGatewayOtel({
    level: "info",
    component: "discord-channel",
    action: "discord.channel.stopped",
    success: true,
  });
}
