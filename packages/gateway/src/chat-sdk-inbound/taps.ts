/**
 * Production composition for the inbound shadow taps.
 *
 * Existing channel owners call these fire-and-forget helpers with the raw
 * event they already received. Everything is gated behind
 * CHAT_SDK_INBOUND_SHADOW_ENABLED=1, lazily constructed, and fail-open:
 * a broken tap logs once and becomes a no-op — it can never take down or
 * slow the legacy listener that owns the transport.
 */

import type { InboundPlatform } from "@joelclaw/message-contract";
import type { LegacyInboundDecision } from "./diff";
import { createInboundMirrorTap, type InboundMirrorTap } from "./mirror";
import {
  createDiscordSdkRawNormalizer,
  createSlackSdkRawNormalizer,
  createTelegramSdkRawNormalizer,
  type RawInboundEnvelope,
} from "./normalize";
import { createGatewayInboundBusClient, createObserveOnlyInboundPublisher } from "./publish";

const SDK_VERSION = "4.34.0";

function shadowEnabled(): boolean {
  return process.env.CHAT_SDK_INBOUND_SHADOW_ENABLED === "1";
}

const disabledPlatforms = new Set<InboundPlatform>();
const taps = new Map<InboundPlatform, InboundMirrorTap>();

function logTapError(platform: InboundPlatform, phase: string, error: unknown): void {
  console.warn("[gateway:chat-sdk-shadow] tap error", {
    platform,
    phase,
    error: error instanceof Error ? error.message : String(error),
  });
}

function getTap(platform: InboundPlatform): InboundMirrorTap | undefined {
  if (!shadowEnabled() || disabledPlatforms.has(platform)) return undefined;
  const existing = taps.get(platform);
  if (existing) return existing;
  try {
    const publisher = createObserveOnlyInboundPublisher(createGatewayInboundBusClient());
    const sdkNormalize = (() => {
      if (platform === "telegram") {
        const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
        if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN absent in gateway env");
        return createTelegramSdkRawNormalizer({ botToken, botActorId: process.env.TELEGRAM_BOT_ID || undefined });
      }
      if (platform === "slack") {
        const botToken = process.env.SLACK_BOT_TOKEN ?? "";
        if (!botToken) throw new Error("SLACK_BOT_TOKEN absent in gateway env");
        return createSlackSdkRawNormalizer({ botToken });
      }
      const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
      if (!botToken) throw new Error("DISCORD_BOT_TOKEN absent in gateway env");
      return createDiscordSdkRawNormalizer({
        botToken,
        applicationId: process.env.DISCORD_APPLICATION_ID ?? "",
        publicKey: process.env.DISCORD_PUBLIC_KEY ?? "",
      });
    })();
    const tap = createInboundMirrorTap({
      sdkNormalize,
      normalizeOptions: { sdkVersion: SDK_VERSION },
      publisher,
      onError: (error) => logTapError(platform, "mirror", error),
    });
    taps.set(platform, tap);
    return tap;
  } catch (error) {
    disabledPlatforms.add(platform);
    logTapError(platform, "construct", error);
    return undefined;
  }
}

function fire(
  platform: InboundPlatform,
  envelope: Omit<RawInboundEnvelope, "platform" | "receivedAt">,
  legacyDecision: LegacyInboundDecision,
): void {
  const tap = getTap(platform);
  if (!tap) return;
  void tap({
    raw: { ...envelope, platform, receivedAt: new Date().toISOString() },
    legacyDecision,
  }).catch((error) => logTapError(platform, "fire", error));
}

// ── Telegram: one tap classifies the whole update ──────────────────

export function tapTelegramUpdate(update: any, allowedUserId: number | undefined, botId?: number): void {
  if (!shadowEnabled()) return;
  try {
    const allowed = String(allowedUserId ?? "");
    const bot = botId ? String(botId) : undefined;
    if (update?.callback_query) {
      const q = update.callback_query;
      const from = String(q?.from?.id ?? "");
      fire("telegram", { kind: "interaction", transport: "polling", rawEventType: "callback_query", raw: update, allowedActorId: allowed, botActorId: bot }, {
        kind: "interaction", platform: "telegram",
        authorizationVerdict: from === allowed ? "accepted" : "rejected",
        policyAction: from === allowed ? "invoke" : "reject",
        actorId: from,
        conversationId: String(q?.message?.chat?.id ?? ""),
        messageId: q?.message?.message_id != null ? String(q.message.message_id) : null,
        acted: from === allowed,
        reason: from === allowed ? "legacy middleware admits Joel" : "legacy middleware silently drops non-Joel",
        actionId: String(q?.data ?? ""), value: q?.data != null ? String(q.data) : null,
      });
      return;
    }
    if (update?.message_reaction) {
      const r = update.message_reaction;
      const from = String(r?.user?.id ?? "");
      const newEmoji = Array.isArray(r?.new_reaction) && r.new_reaction.length > 0 ? (r.new_reaction[0]?.emoji ?? "") : "";
      const oldEmoji = Array.isArray(r?.old_reaction) && r.old_reaction.length > 0 ? (r.old_reaction[0]?.emoji ?? "") : "";
      fire("telegram", { kind: "reaction", transport: "polling", rawEventType: "message_reaction", raw: update, allowedActorId: allowed, botActorId: bot }, {
        kind: "reaction", platform: "telegram",
        authorizationVerdict: from === allowed ? "accepted" : "rejected",
        // Legacy has NO telegram reaction handler: even Joel's reactions are unobserved today.
        policyAction: "reject",
        actorId: from,
        conversationId: String(r?.chat?.id ?? ""),
        messageId: r?.message_id != null ? String(r.message_id) : null,
        acted: false,
        reason: "legacy telegram has no reaction handler",
        emoji: newEmoji || oldEmoji, rawEmoji: newEmoji || oldEmoji, added: Boolean(newEmoji),
      });
      return;
    }
    const m = update?.message;
    if (!m) return;
    const from = String(m?.from?.id ?? "");
    const text: string = typeof m?.text === "string" ? m.text : "";
    const isCommand = text.startsWith("/");
    const base = {
      platform: "telegram" as const,
      authorizationVerdict: (from === allowed ? "accepted" : "rejected") as "accepted" | "rejected",
      policyAction: (from === allowed ? "invoke" : "reject") as "invoke" | "reject",
      actorId: from,
      conversationId: String(m?.chat?.id ?? ""),
      messageId: m?.message_id != null ? String(m.message_id) : null,
      acted: from === allowed,
      reason: from === allowed ? "legacy middleware admits Joel" : "legacy middleware silently drops non-Joel",
    };
    if (isCommand) {
      const [command = "", ...rest] = text.split(/\s+/u);
      fire("telegram", { kind: "command", transport: "polling", rawEventType: "message", raw: update, allowedActorId: allowed, botActorId: bot }, { ...base, kind: "command", command, argumentsText: rest.join(" ") });
    } else {
      fire("telegram", { kind: "message", transport: "polling", rawEventType: "message", raw: update, allowedActorId: allowed, botActorId: bot }, { ...base, kind: "message", text });
    }
  } catch (error) {
    logTapError("telegram", "classify", error);
  }
}

// ── Slack ───────────────────────────────────────────────────────────

export function tapSlackMessage(rawMessage: unknown, context: { botUserId?: string; allowedUserId?: string }): void {
  if (!shadowEnabled()) return;
  try {
    const m = rawMessage as any;
    const user = String(m?.user ?? "");
    const isBot = Boolean(m?.bot_id) || (context.botUserId ? user === context.botUserId : false);
    const droppedSubtype = Boolean(m?.subtype && m.subtype !== "thread_broadcast");
    const acted = Boolean(user && m?.text && m?.ts && m?.channel) && !isBot && !droppedSubtype;
    fire("slack", { kind: "message", transport: "socket", rawEventType: "message", raw: rawMessage, allowedActorId: context.allowedUserId ?? "", botActorId: context.botUserId }, {
      kind: "message", platform: "slack",
      authorizationVerdict: isBot ? "rejected" : "accepted",
      policyAction: acted ? "invoke" : "reject",
      actorId: user,
      conversationId: String(m?.channel ?? ""),
      messageId: m?.ts != null ? String(m.ts) : null,
      acted,
      reason: acted ? "legacy message path proceeds" : "legacy drops bot/subtype/incomplete message",
      text: String(m?.text ?? ""),
    });
  } catch (error) {
    logTapError("slack", "classify", error);
  }
}

export function tapSlackReaction(rawEvent: unknown, context: { botUserId?: string; allowedUserId?: string }): void {
  if (!shadowEnabled()) return;
  try {
    const e = rawEvent as any;
    const user = String(e?.user ?? "");
    const isBot = context.botUserId ? user === context.botUserId : false;
    const isJoel = context.allowedUserId ? user === context.allowedUserId : true;
    const complete = Boolean(user && e?.item?.channel && e?.item?.ts && e?.reaction && e?.item?.type === "message");
    const acted = complete && !isBot && isJoel;
    fire("slack", { kind: "reaction", transport: "socket", rawEventType: "reaction_added", raw: rawEvent, allowedActorId: context.allowedUserId ?? "", botActorId: context.botUserId }, {
      kind: "reaction", platform: "slack",
      authorizationVerdict: !isBot && isJoel ? "accepted" : "rejected",
      policyAction: acted ? "invoke" : "reject",
      actorId: user,
      conversationId: String(e?.item?.channel ?? ""),
      messageId: e?.item?.ts != null ? String(e.item.ts) : null,
      acted,
      reason: acted ? "legacy reaction path proceeds" : "legacy drops bot/non-Joel/incomplete reaction",
      emoji: String(e?.reaction ?? ""), rawEmoji: String(e?.reaction ?? ""), added: true,
    });
  } catch (error) {
    logTapError("slack", "classify", error);
  }
}

// ── Discord ─────────────────────────────────────────────────────────

export function tapDiscordMessage(message: any, allowedUserId: string | undefined): void {
  if (!shadowEnabled()) return;
  try {
    const authorId = String(message?.author?.id ?? "");
    const isBot = Boolean(message?.author?.bot);
    const isJoel = allowedUserId ? authorId === allowedUserId : false;
    const acted = !isBot && isJoel;
    fire("discord", { kind: "message", transport: "gateway", rawEventType: "messageCreate", raw: message, allowedActorId: allowedUserId ?? "" }, {
      kind: "message", platform: "discord",
      authorizationVerdict: acted ? "accepted" : "rejected",
      policyAction: acted ? "invoke" : "reject",
      actorId: authorId,
      conversationId: String(message?.channelId ?? message?.channel?.id ?? ""),
      messageId: message?.id != null ? String(message.id) : null,
      acted,
      reason: acted ? "legacy message path proceeds" : "legacy drops bot/non-Joel author",
      text: String(message?.content ?? ""),
    });
  } catch (error) {
    logTapError("discord", "classify", error);
  }
}

export function tapDiscordInteraction(interaction: any, allowedUserId: string | undefined): void {
  if (!shadowEnabled()) return;
  try {
    const userId = String(interaction?.user?.id ?? "");
    const isJoel = allowedUserId ? userId === allowedUserId : false;
    fire("discord", { kind: "interaction", transport: "gateway", rawEventType: "interactionCreate", raw: interaction, allowedActorId: allowedUserId ?? "" }, {
      kind: "interaction", platform: "discord",
      authorizationVerdict: isJoel ? "accepted" : "rejected",
      policyAction: isJoel ? "invoke" : "reject",
      actorId: userId,
      conversationId: String(interaction?.channelId ?? ""),
      messageId: interaction?.id != null ? String(interaction.id) : null,
      acted: isJoel,
      reason: isJoel ? "legacy slash path proceeds" : "legacy replies Unauthorized",
      actionId: String(interaction?.commandName ?? ""),
      value: null,
    });
  } catch (error) {
    logTapError("discord", "classify", error);
  }
}

export function tapDiscordReaction(reaction: any, user: any, allowedUserId: string | undefined): void {
  if (!shadowEnabled()) return;
  try {
    const userId = String(user?.id ?? "");
    const isBot = Boolean(user?.bot);
    const isCheck = reaction?.emoji?.name === "✅";
    const inThread = Boolean(reaction?.message?.channel?.isThread?.());
    // Deliberate diff surface: legacy has NO Joel allowlist on this path.
    const acted = !isBot && isCheck && inThread;
    fire("discord", { kind: "reaction", transport: "gateway", rawEventType: "messageReactionAdd", raw: { reaction, user }, allowedActorId: allowedUserId ?? "" }, {
      kind: "reaction", platform: "discord",
      authorizationVerdict: isBot ? "rejected" : "accepted",
      policyAction: acted ? "invoke" : "reject",
      actorId: userId,
      conversationId: String(reaction?.message?.channelId ?? reaction?.message?.channel?.id ?? ""),
      messageId: reaction?.message?.id != null ? String(reaction.message.id) : null,
      acted,
      reason: acted ? "legacy reaction path proceeds WITHOUT Joel allowlist" : "legacy drops bot/non-check/non-thread reaction",
      emoji: String(reaction?.emoji?.name ?? ""), rawEmoji: String(reaction?.emoji?.name ?? ""), added: true,
    });
  } catch (error) {
    logTapError("discord", "classify", error);
  }
}
