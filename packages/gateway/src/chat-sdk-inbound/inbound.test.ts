import { describe, expect, test } from "bun:test";
import {
  decodeInboundEvent,
  type InboundEvent,
} from "@joelclaw/message-contract";
import { diffInboundDecision, type LegacyInboundDecision } from "./diff";
import { createInboundMirrorTap } from "./mirror";
import {
  createDiscordSdkRawNormalizer,
  createSlackSdkRawNormalizer,
  createTelegramSdkRawNormalizer,
  normalizeRawInbound,
  type RawInboundEnvelope,
} from "./normalize";
import {
  createGatewayInboundBusClient,
  createObserveOnlyInboundPublisher,
} from "./publish";

const FIXED_DATE = new Date("2026-07-16T19:00:00.050Z");
const now = () => FIXED_DATE;

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

function matchingLegacy(event: InboundEvent): LegacyInboundDecision {
  const base = {
    platform: event.platform,
    authorizationVerdict: event.authorization.verdict,
    policyAction: event.authorization.policyAction,
    actorId: event.platformIds.actorId,
    conversationId: event.platformIds.conversationId,
    messageId: event.platformIds.messageId,
    acted:
      event.authorization.verdict === "accepted" &&
      event.authorization.policyAction === "invoke",
    reason: "legacy-handler",
  };
  switch (event.type) {
    case "message":
      return { ...base, kind: event.type, text: event.text };
    case "command":
      return {
        ...base,
        kind: event.type,
        command: event.command,
        argumentsText: event.argumentsText,
      };
    case "interaction":
      return {
        ...base,
        kind: event.type,
        actionId: event.actionId,
        value: event.value,
      };
    case "reaction":
      return {
        ...base,
        kind: event.type,
        emoji: event.emoji,
        rawEmoji: event.rawEmoji,
        added: event.added,
      };
  }
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

describe("observe-only publish and diff", () => {
  test("posts the exact Inngest event envelope", async () => {
    let capturedBody = "";
    const client = createGatewayInboundBusClient({
      eventApi: "http://inngest.test/e/redacted",
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = String(init?.body ?? "");
        return new Response('{"ids":["event-1"]}', { status: 200 });
      }) as typeof fetch,
    });
    const event = await normalizedTelegramMessage();

    await client.send({
      id: event.eventId,
      name: "message/inbound.message",
      data: event,
    });

    expect(JSON.parse(capturedBody)).toEqual({
      id: event.eventId,
      name: "message/inbound.message",
      data: event,
    });
  });

  test("publishes under message/inbound.* with shadow evidence", async () => {
    const sent: unknown[] = [];
    const publisher = createObserveOnlyInboundPublisher({
      send: async (event) => {
        sent.push(event);
      },
    });
    const event = await normalizedTelegramMessage();
    const report = diffInboundDecision(matchingLegacy(event), event, now);
    const laterReport = diffInboundDecision(
      matchingLegacy(event),
      event,
      () => new Date("2026-07-16T20:00:00.000Z"),
    );

    expect(laterReport.reportId).toBe(report.reportId);
    await publisher.publishEvent(event);
    await publisher.publishDiff(report);

    expect(sent).toEqual([
      {
        id: event.eventId,
        name: "message/inbound.message",
        data: event,
      },
      {
        id: report.reportId,
        name: "message/inbound.diff",
        data: report,
      },
    ]);
    expect(report).toMatchObject({
      parity: true,
      shadow: true,
      sdk: { actualActed: false, wouldAct: true },
    });
  });

  test("reconciles the live Telegram adapter-qualified ID mismatch", async () => {
    const event = await normalizedTelegram(
      capturedTelegramInteraction,
      "interaction",
    );
    const legacy: LegacyInboundDecision = {
      kind: "interaction",
      platform: "telegram",
      authorizationVerdict: "accepted",
      policyAction: "invoke",
      actorId: "7718912466",
      conversationId: "7718912466",
      messageId: "14543",
      acted: true,
      reason: "legacy middleware admits Joel",
      actionId: "act:f4decc6f-1a37-442c-a0cf-ab8664a57960",
      value: "act:f4decc6f-1a37-442c-a0cf-ab8664a57960",
    };

    expect(event.platformIds).toMatchObject({
      conversationId: "7718912466",
      messageId: "14543",
      threadId: "telegram:7718912466",
    });
    expect(diffInboundDecision(legacy, event, now)).toMatchObject({
      parity: true,
      mismatches: [],
    });
  });

  test("compares reaction direction and emoji semantics", async () => {
    const message = await normalizedTelegramMessage();
    const reaction = decodeInboundEvent({
      ...message,
      type: "reaction",
      authorization: {
        ...message.authorization,
        policyAction: "observe",
      },
      emoji: "thumbs_up",
      rawEmoji: "👍",
      added: false,
    });
    const legacy = matchingLegacy(reaction);
    if (legacy.kind !== "reaction") throw new Error("expected reaction decision");

    const report = diffInboundDecision(
      { ...legacy, emoji: "heart", rawEmoji: "❤️", added: true },
      reaction,
      now,
    );

    expect(report.parity).toBe(false);
    expect(report.mismatches.map((mismatch) => mismatch.field)).toEqual([
      "emoji",
      "rawEmoji",
      "added",
    ]);
  });

  test("reports policy mismatches as cutover evidence", async () => {
    const event = await normalizedTelegramMessage();
    const legacy = {
      ...matchingLegacy(event),
      policyAction: "observe" as const,
    };

    const report = diffInboundDecision(legacy, event, now);

    expect(report.parity).toBe(false);
    expect(report.mismatches).toContainEqual({
      field: "authorization.policyAction",
      legacy: "observe",
      sdk: "invoke",
    });
  });

  test("mirror failures stay fail-open and never call a queue", async () => {
    const sent: unknown[] = [];
    const errors: string[] = [];
    const tap = createInboundMirrorTap({
      sdkNormalize: async () => {
        throw new Error("sdk normalization failed");
      },
      normalizeOptions: { sdkVersion: "4.34.0", now },
      publisher: createObserveOnlyInboundPublisher({
        send: async (event) => {
          sent.push(event);
        },
      }),
      onError: (error) => {
        errors.push(String(error));
      },
    });
    const event = await normalizedTelegramMessage();

    const result = await tap({
      raw: envelope("telegram", "message", rawTelegramUpdate, "7718912466", "999"),
      legacyDecision: matchingLegacy(event),
    });

    expect(result).toEqual({
      status: "failed-open",
      error: "sdk normalization failed",
      publishedEventIds: [],
      publishedDiffReportIds: [],
    });
    expect(sent).toEqual([]);
    expect(errors).toEqual(["Error: sdk normalization failed"]);
  });

  test("reports partial publication with deterministic retry ids", async () => {
    const event = await normalizedTelegramMessage();
    let sendCount = 0;
    const tap = createInboundMirrorTap({
      sdkNormalize: async () => ({
        kind: "message",
        platform: "telegram",
        actor: {
          id: event.actor.platformUserId,
          userName: event.actor.userName ?? undefined,
          displayName: event.actor.displayName ?? undefined,
          isBot: event.actor.isBot,
          isMe: event.actor.isSelf,
        },
        conversationId: event.platformIds.conversationId,
        messageId: event.platformIds.messageId ?? undefined,
        threadId: event.platformIds.threadId ?? undefined,
        occurredAt: event.occurredAt,
        rawEventId: event.audit.rawEventId ?? undefined,
        text: event.type === "message" ? event.text : "",
        isMention: false,
        attachmentCount: 0,
      }),
      normalizeOptions: { sdkVersion: "4.34.0", now },
      publisher: createObserveOnlyInboundPublisher({
        send: async () => {
          sendCount += 1;
          if (sendCount === 2) throw new Error("diff publish failed");
        },
      }),
      now,
    });

    const result = await tap({
      raw: envelope("telegram", "message", rawTelegramUpdate, "7718912466", "999"),
      legacyDecision: matchingLegacy(event),
    });

    expect(result).toMatchObject({
      status: "failed-open",
      error: "diff publish failed",
      publishedDiffReportIds: [],
    });
    if (result.status !== "failed-open") throw new Error("expected failed-open");
    expect(result.publishedEventIds).toHaveLength(1);
  });
});
