import { describe, expect, test } from "bun:test";
import { TelegramAdapter } from "@chat-adapter/telegram";
import {
  type InboundEvent,
} from "@joelclaw/message-contract";
import type { ChatInstance } from "chat";
import {
  type ChatSdkNormalizedInbound,
  createDiscordSdkRawNormalizer,
  createSlackSdkRawNormalizer,
  createTelegramSdkRawNormalizer,
  normalizeRawInbound,
  normalizeSdkInboundEvent,
  type RawInboundEnvelope,
} from "./normalize";

const FIXED_DATE = new Date("2026-07-16T19:00:00.050Z");
const now = () => FIXED_DATE;

class CallbackAckTelegramAdapter extends TelegramAdapter {
  readonly calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];

  protected override async telegramFetch<TResult>(
    method: string,
    payload?: Record<string, unknown> | FormData,
  ): Promise<TResult> {
    this.calls.push({
      method,
      ...(payload && !(payload instanceof FormData) ? { payload } : {}),
    });
    return true as TResult;
  }

  async captureCallback(update: unknown): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    this.chat = {
      processAction: async () => undefined,
    } as unknown as ChatInstance;
    this.processUpdate(update as never, {
      waitUntil: (task) => tasks.push(Promise.resolve(task)),
    });
    await Promise.all(tasks);
  }
}

const rawTelegramUpdate = {
  update_id: 42,
  message: {
    message_id: 420,
    date: 1_768_500_000,
    chat: { id: 7_718_912_466, type: "private", first_name: "Joel" },
    from: {
      id: 7_718_912_466,
      is_bot: false,
      first_name: "Joel",
      username: "joel",
    },
    text: "status",
  },
};

const rawTelegramSelfUpdate = {
  update_id: 43,
  message: {
    message_id: 421,
    date: 1_768_500_001,
    chat: { id: 7_718_912_466, type: "private", first_name: "Joel" },
    from: {
      id: 999,
      is_bot: true,
      first_name: "JoelClaw",
      username: "joelclaw_bot",
    },
    text: "self-generated output",
  },
};

const rawTelegramCommand = {
  update_id: 44,
  message: {
    message_id: 422,
    date: 1_768_500_002,
    chat: { id: 7_718_912_466, type: "private", first_name: "Joel" },
    from: {
      id: 7_718_912_466,
      is_bot: false,
      first_name: "Joel",
      username: "joel",
    },
    text: "/stop now",
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
  },
};

const rawTelegramEscCommand = {
  ...rawTelegramCommand,
  message: {
    ...rawTelegramCommand.message,
    text: "/esc now",
    entities: [{ type: "bot_command", offset: 0, length: 4 }],
  },
};

const rawSlackMessage = {
  type: "message",
  event_ts: "1768500000.000200",
  channel: "C123",
  channel_type: "channel",
  user: "UOTHER",
  text: "unauthorized Slack message",
  ts: "1768500000.000100",
};

const rawTelegramInteraction = {
  update_id: 45,
  callback_query: {
    id: "telegram-callback-1",
    from: {
      id: 7_718_912_466,
      is_bot: false,
      first_name: "Joel",
      username: "joel",
    },
    message: {
      message_id: 500,
      date: 1_768_500_003,
      chat: { id: 7_718_912_466, type: "private", first_name: "Joel" },
      text: "Approve this?",
    },
    chat_instance: "chat-instance-1",
    data: "approve:item-42",
  },
};

// Source-shaped reconstruction of the first live diff reports captured from
// Inngest/Postgres at 2026-07-16T21:23Z. Chat SDK emitted adapter-qualified
// handles (`telegram:7718912466`, `7718912466:14543`); contract v2 requires
// the platform-native IDs used by the legacy decision and flow index.
const capturedTelegramInteraction = {
  update_id: 1_784_237_017,
  callback_query: {
    id: "captured-callback-20260716",
    from: {
      id: 7_718_912_466,
      is_bot: false,
      first_name: "Joel",
      username: "joel",
    },
    message: {
      message_id: 14_543,
      date: 1_784_237_017,
      chat: { id: 7_718_912_466, type: "private", first_name: "Joel" },
      text: "Captured cutover action",
    },
    chat_instance: "captured-chat-instance",
    data: "act:f4decc6f-1a37-442c-a0cf-ab8664a57960",
  },
};

const rawDiscordMessage = {
  attachments: [],
  author: {
    bot: false,
    displayName: "Joel Hooks",
    id: "DJOEL",
    username: "joel",
  },
  channel: { isThread: () => false },
  channelId: "D123",
  content: "Discord status",
  createdAt: new Date("2026-07-16T19:00:00.000Z"),
  editedAt: null,
  guildId: null,
  id: "discord-message-1",
};

const rawDiscordCommand = {
  applicationId: "DBOT",
  channel: { id: "D123", type: 1 },
  channelId: "D123",
  commandName: "status",
  commandType: 1,
  guildId: null,
  id: "discord-interaction-1",
  options: { data: [] },
  token: "interaction-token",
  type: 2,
  user: {
    avatar: null,
    bot: false,
    discriminator: "0",
    globalName: "Joel Hooks",
    id: "DJOEL",
    username: "joel",
  },
  version: 1,
};

const rawDiscordReaction = {
  added: true,
  reaction: {
    emoji: { name: "✅", id: null },
    message: {
      id: "discord-message-1",
      channelId: "D123",
      guildId: null,
      channel: { isThread: () => false, parentId: null },
    },
  },
  user: { id: "DJOEL", username: "joel", bot: false },
};

function envelope(
  platform: RawInboundEnvelope["platform"],
  kind: RawInboundEnvelope["kind"],
  raw: unknown,
  allowedActorId: string,
  botActorId?: string,
): RawInboundEnvelope {
  return {
    platform,
    kind,
    transport: platform === "telegram" ? "grammy-long-polling" : "socket",
    rawEventType: kind,
    raw,
    receivedAt: FIXED_DATE.toISOString(),
    allowedActorId,
    botActorId,
  };
}

async function normalizedTelegram(
  rawUpdate:
    | typeof rawTelegramUpdate
    | typeof rawTelegramSelfUpdate
    | typeof rawTelegramCommand
    | typeof rawTelegramEscCommand
    | typeof rawTelegramInteraction
    | typeof capturedTelegramInteraction,
  kind: RawInboundEnvelope["kind"],
): Promise<InboundEvent> {
  const [event] = await normalizeRawInbound(
    envelope("telegram", kind, rawUpdate, "7718912466", "999"),
    createTelegramSdkRawNormalizer({
      botActorId: "999",
      botToken: "test-token",
      mode: "webhook",
      userName: "joelclaw_bot",
    }),
    { sdkVersion: "4.34.0", now },
  );
  if (!event) throw new Error(`expected one normalized ${kind} event`);
  return event;
}

function normalizedTelegramMessage(
  rawUpdate: typeof rawTelegramUpdate | typeof rawTelegramSelfUpdate = rawTelegramUpdate,
): Promise<InboundEvent> {
  return normalizedTelegram(rawUpdate, "message");
}

describe("Chat SDK inbound normalization", () => {
  test("passes the real nested Telegram update through the pinned adapter", async () => {
    const event = await normalizedTelegramMessage();

    expect(event).toMatchObject({
      type: "message",
      platform: "telegram",
      shadow: true,
      text: "status",
      rawAnchors: {
        updateId: "42",
        sourceMessageId: "420",
      },
      authorization: {
        verdict: "accepted",
        reason: "authorized_joel",
        policyAction: "invoke",
        canExecute: false,
      },
    });
  });

  test("rejects a self-originated Telegram update", async () => {
    const event = await normalizedTelegramMessage(rawTelegramSelfUpdate);

    expect(event.authorization).toMatchObject({
      verdict: "rejected",
      reason: "self_message",
      policyAction: "reject",
      canPublish: true,
      canExecute: false,
    });
  });

  test("uses the SDK command parser and keeps command ids distinct", async () => {
    const stop = await normalizedTelegram(rawTelegramCommand, "command");
    const esc = await normalizedTelegram(rawTelegramEscCommand, "command");

    expect(stop).toMatchObject({
      type: "command",
      command: "/stop",
      argumentsText: "now",
      authorization: { verdict: "accepted", canExecute: false },
    });
    expect(esc).toMatchObject({ type: "command", command: "/esc" });
    expect(stop.eventId).not.toBe(esc.eventId);
  });

  test("rejects a non-Joel actor from the SDK Slack message parser", async () => {
    const [event] = await normalizeRawInbound(
      envelope("slack", "message", rawSlackMessage, "UJOEL", "UBOT"),
      createSlackSdkRawNormalizer({
        appToken: "xapp-test",
        botToken: "xoxb-test",
        botUserId: "UBOT",
        mode: "socket",
      }),
      { sdkVersion: "4.34.0", now },
    );

    expect(event?.authorization).toMatchObject({
      verdict: "rejected",
      reason: "non_joel_actor",
      policyAction: "reject",
      canExecute: false,
    });
  });

  test("uses the SDK callback decoder for a real Telegram interaction", async () => {
    const event = await normalizedTelegram(
      rawTelegramInteraction,
      "interaction",
    );

    expect(event).toMatchObject({
      type: "interaction",
      actionId: "approve:item-42",
      value: "approve:item-42",
      rawAnchors: { callbackQueryId: "telegram-callback-1" },
      authorization: { verdict: "accepted", canExecute: false },
    });
  });

  test("keeps a live Chat SDK callback identity stable across reprocessing", () => {
    const projected: ChatSdkNormalizedInbound = {
      kind: "interaction",
      platform: "telegram",
      actor: {
        id: "7718912466",
        userName: "joel",
        displayName: "Joel",
        isBot: false,
        isMe: false,
      },
      conversationId: "telegram:7718912466",
      messageId: "7718912466:500",
      threadId: "telegram:7718912466",
      occurredAt: "2026-07-16T19:00:00.000Z",
      actionId: "message_action",
      value: "learner-flow.ack",
    };
    const callbackEnvelope: RawInboundEnvelope = {
      platform: "telegram",
      kind: "interaction",
      transport: "polling",
      rawEventType: "chat-sdk.interaction",
      raw: rawTelegramInteraction.callback_query,
      receivedAt: "2026-07-16T19:00:00.050Z",
      allowedActorId: "7718912466",
      botActorId: "999",
    };
    const first = normalizeSdkInboundEvent(projected, callbackEnvelope, {
      sdkVersion: "4.34.0",
      now: () => new Date("2026-07-16T19:00:00.060Z"),
    });
    const replay = normalizeSdkInboundEvent(
      { ...projected, occurredAt: "2026-07-16T19:05:00.000Z" },
      callbackEnvelope,
      {
        sdkVersion: "4.34.0",
        now: () => new Date("2026-07-16T19:05:00.000Z"),
      },
    );

    expect(first.eventId).toBe(replay.eventId);
    expect(first).toMatchObject({
      platformIds: { messageId: "500" },
      rawAnchors: {
        callbackQueryId: "telegram-callback-1",
        sourceMessageId: "500",
        transportEventId: "telegram-callback-1",
      },
      audit: { rawEventId: "telegram-callback-1" },
    });
  });

  test("the existing Chat SDK Telegram owner answers callback queries", async () => {
    const adapter = new CallbackAckTelegramAdapter({
      botToken: "test-token",
      mode: "webhook",
    });

    await adapter.captureCallback(rawTelegramInteraction);

    expect(adapter.calls).toContainEqual({
      method: "answerCallbackQuery",
      payload: { callback_query_id: "telegram-callback-1" },
    });
  });

  test("decodes Chat SDK callback buttons into the semantic action ID", async () => {
    const [event] = await normalizeRawInbound(
      envelope(
        "telegram",
        "interaction",
        {
          ...rawTelegramInteraction,
          callback_query: {
            ...rawTelegramInteraction.callback_query,
            data: "chat:{\"a\":\"message_action\",\"v\":\"learner-flow.investigate\"}",
          },
        },
        "7718912466",
        "999",
      ),
      createTelegramSdkRawNormalizer({
        botToken: "test-token",
        mode: "webhook",
        userName: "joelclaw_bot",
        botActorId: "999",
      }),
      { sdkVersion: "4.34.0", now },
    );

    expect(event).toMatchObject({
      type: "interaction",
      actionId: "message_action",
      value: "learner-flow.investigate",
      rawAnchors: { callbackQueryId: "telegram-callback-1" },
      authorization: { verdict: "accepted", canExecute: false },
    });
  });

  test("uses the SDK Discord Gateway message normalizer without thread creation", async () => {
    const [event] = await normalizeRawInbound(
      envelope("discord", "message", rawDiscordMessage, "DJOEL", "DBOT"),
      createDiscordSdkRawNormalizer({
        applicationId: "DBOT",
        botToken: "test-token",
        publicKey: "0".repeat(64),
      }),
      { sdkVersion: "4.34.0", now },
    );

    expect(event).toMatchObject({
      type: "message",
      text: "Discord status",
      authorization: { verdict: "accepted", canExecute: false },
    });
  });

  test("uses the SDK Discord Gateway slash-command normalizer", async () => {
    const [event] = await normalizeRawInbound(
      envelope("discord", "command", rawDiscordCommand, "DJOEL", "DBOT"),
      createDiscordSdkRawNormalizer({
        applicationId: "DBOT",
        botToken: "test-token",
        publicKey: "0".repeat(64),
      }),
      { sdkVersion: "4.34.0", now },
    );

    expect(event).toMatchObject({
      type: "command",
      command: "/status",
      authorization: { verdict: "accepted", canExecute: false },
    });
  });

  test("uses the SDK Discord Gateway reaction normalizer", async () => {
    const [event] = await normalizeRawInbound(
      envelope("discord", "reaction", rawDiscordReaction, "DJOEL", "DBOT"),
      createDiscordSdkRawNormalizer({
        applicationId: "DBOT",
        botToken: "test-token",
        publicKey: "0".repeat(64),
      }),
      { sdkVersion: "4.34.0", now },
    );

    expect(event).toMatchObject({
      type: "reaction",
      rawEmoji: "✅",
      added: true,
      authorization: {
        verdict: "accepted",
        policyAction: "observe",
        canExecute: false,
      },
    });
  });
});
