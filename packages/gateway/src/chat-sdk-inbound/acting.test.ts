import { describe, expect, test } from "bun:test";
import {
  decodeInboundEvent,
  type FlowIdType,
  type InboundEvent,
  MESSAGE_REACTION_RECEIVED,
} from "@joelclaw/message-contract";
import { createActingInboundDispatcher } from "./acting";
import {
  createTelegramSdkRawNormalizer,
  normalizeRawInbound,
  type RawInboundEnvelope,
} from "./normalize";
import { createObserveOnlyInboundPublisher } from "./publish";

function inbound(
  overrides: Partial<InboundEvent> = {},
): InboundEvent {
  return decodeInboundEvent({
    contractVersion: 2,
    eventId: "telegram:message:event-1",
    type: "message",
    platform: "telegram",
    occurredAt: "2026-07-16T21:23:17.000Z",
    observedAt: "2026-07-16T21:23:17.100Z",
    shadow: true,
    actor: {
      platformUserId: "7718912466",
      userName: "joel",
      displayName: "Joel",
      isBot: false,
      isSelf: false,
    },
    platformIds: {
      conversationId: "7718912466",
      messageId: "14543",
      threadId: "telegram:7718912466",
      actorId: "7718912466",
      workspaceId: null,
    },
    rawAnchors: {
      transportEventId: "1784237017",
      updateId: "1784237017",
      callbackQueryId: null,
      sourceMessageId: "14543",
      sourceThreadId: null,
    },
    audit: {
      source: "gateway.telegram.message",
      transport: "polling",
      sdkName: "vercel/chat",
      sdkVersion: "4.34.0",
      normalizedAt: "2026-07-16T21:23:17.100Z",
      rawEventType: "message",
      rawEventId: "1784237017",
      lineageId: "lineage-1",
    },
    authorization: {
      verdict: "accepted",
      reason: "authorized_joel",
      policyAction: "invoke",
      expectedActorId: "7718912466",
      actualActorId: "7718912466",
      canPublish: true,
      canExecute: false,
    },
    text: "cut over now lol",
    isMention: false,
    attachmentCount: 0,
    ...overrides,
  });
}

function harness() {
  const enqueued: Array<{
    source: string;
    prompt: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const published: unknown[] = [];
  const correlations: unknown[] = [];
  const dispatch = createActingInboundDispatcher({
    enqueue: async (source, prompt, metadata) => {
      enqueued.push({ source, prompt, metadata });
    },
    publisher: createObserveOnlyInboundPublisher({
      send: async (event) => {
        published.push(event);
      },
    }),
    resolveFlowId: async () =>
      "flow_v2_11111111-1111-4111-8111-111111111111" as FlowIdType,
    publishReaction: async (event) => {
      correlations.push(event);
    },
  });
  return { dispatch, enqueued, published, correlations };
}

describe("Chat SDK acting inbound dispatcher", () => {
  test("publishes once and enqueues through the supplied gateway boundary once", async () => {
    const { dispatch, enqueued, published } = harness();
    const event = inbound();

    expect(await dispatch(event)).toMatchObject({ status: "enqueued" });
    expect(await dispatch(event)).toEqual({ status: "duplicate" });

    expect(published).toHaveLength(1);
    expect(enqueued).toEqual([
      {
        source: "telegram:7718912466",
        prompt: "cut over now lol",
        metadata: expect.objectContaining({
          chatSdkActing: true,
          chatSdkEventId: event.eventId,
          telegramMessageId: 14_543,
        }),
      },
    ]);
  });

  test("allows the same event to retry after enqueue fails", async () => {
    let attempts = 0;
    const dispatch = createActingInboundDispatcher({
        enqueue: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("redis unavailable");
      },
      publisher: createObserveOnlyInboundPublisher({ send: async () => {} }),
      resolveFlowId: async () => undefined,
      publishReaction: async () => {},
    });
    const event = inbound();

    await expect(dispatch(event)).rejects.toThrow("redis unavailable");
    expect(await dispatch(event)).toMatchObject({ status: "enqueued" });
    expect(attempts).toBe(2);
  });

  test("rejects self and non-Joel events before the queue", async () => {
    const { dispatch, enqueued, published } = harness();
    const self = inbound({
      eventId: "telegram:message:self",
      authorization: {
        verdict: "rejected",
        reason: "self_message",
        policyAction: "reject",
        expectedActorId: "7718912466",
        actualActorId: "999",
        canPublish: true,
        canExecute: false,
      },
    });
    const stranger = inbound({
      eventId: "telegram:message:stranger",
      authorization: {
        verdict: "rejected",
        reason: "non_joel_actor",
        policyAction: "reject",
        expectedActorId: "7718912466",
        actualActorId: "123",
        canPublish: true,
        canExecute: false,
      },
    });

    expect(await dispatch(self)).toEqual({ status: "rejected" });
    expect(await dispatch(stranger)).toEqual({ status: "rejected" });
    expect(enqueued).toEqual([]);
    expect(published).toHaveLength(2);
  });

  test("delegates Slack messages to the established Reply Grant/passive-intel policy", async () => {
    const delegated: unknown[] = [];
    const enqueued: unknown[] = [];
    const dispatch = createActingInboundDispatcher({
        enqueue: async (...args) => {
        enqueued.push(args);
      },
      publisher: createObserveOnlyInboundPublisher({ send: async () => {} }),
      resolveFlowId: async () => undefined,
      publishReaction: async () => {},
      dispatchPlatformPolicy: async (event, raw) => {
        delegated.push({ event, raw });
        return event.platform === "slack";
      },
    });
    const telegram = inbound();
    const slack = decodeInboundEvent({
      ...telegram,
      eventId: "slack:message:event-3",
      platform: "slack",
      actor: {
        ...telegram.actor,
        platformUserId: "UOTHER",
      },
      platformIds: {
        ...telegram.platformIds,
        conversationId: "C123",
        messageId: "1784238835.123",
        threadId: "slack:C123:",
        actorId: "UOTHER",
      },
      authorization: {
        verdict: "rejected",
        reason: "non_joel_actor",
        policyAction: "reject",
        expectedActorId: "UJOEL",
        actualActorId: "UOTHER",
        canPublish: true,
        canExecute: false,
      },
      text: "reply-grant candidate",
    });
    const raw = { channel: "C123", user: "UOTHER" };

    expect(await dispatch(slack, { raw })).toEqual({
      status: "platform-policy",
    });
    expect(delegated).toEqual([{ event: slack, raw }]);
    expect(enqueued).toEqual([]);
  });

  test("correlates a reaction on a sent platform message back to flowId", async () => {
    const { dispatch, enqueued, correlations } = harness();
    const message = inbound();
    const reaction = decodeInboundEvent({
      ...message,
      eventId: "telegram:reaction:event-2",
      type: "reaction",
      authorization: {
        ...message.authorization,
        policyAction: "observe",
      },
      emoji: "thumbs_up",
      rawEmoji: "👍",
      added: true,
    });

    expect(await dispatch(reaction)).toEqual({ status: "observed" });
    expect(enqueued).toEqual([]);
    expect(correlations).toEqual([
      {
        id: "telegram:reaction:event-2:flow:flow_v2_11111111-1111-4111-8111-111111111111",
        name: MESSAGE_REACTION_RECEIVED,
        data: expect.objectContaining({
          flowId: "flow_v2_11111111-1111-4111-8111-111111111111",
          platform: "telegram",
          emoji: "👍",
          action: "added",
          actor: { id: "7718912466", displayName: "Joel" },
        }),
      },
    ]);
  });

  test("publishes the real nested Telegram reaction update through the canonical path", async () => {
    const rawUpdate = {
      update_id: 777_932_597,
      message_reaction: {
        chat: { id: 7_718_912_466, type: "private", first_name: "Joel" },
        message_id: 14_562,
        date: 1_784_258_778,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👏" }],
        user: {
          id: 7_718_912_466,
          is_bot: false,
          first_name: "joel ⛈️",
          username: "lowdown976",
        },
      },
    };
    const envelope: RawInboundEnvelope = {
      platform: "telegram",
      kind: "reaction",
      transport: "polling",
      rawEventType: "message_reaction",
      raw: rawUpdate,
      receivedAt: "2026-07-17T03:26:18.905Z",
      allowedActorId: "7718912466",
      botActorId: "999",
    };
    const [reaction] = await normalizeRawInbound(
      envelope,
      createTelegramSdkRawNormalizer({
        botToken: "test-token",
        mode: "webhook",
        userName: "joelclaw_bot",
        botActorId: "999",
      }),
      { sdkVersion: "4.34.0", now: () => new Date("2026-07-17T03:26:18.910Z") },
    );
    if (!reaction) throw new Error("expected nested Telegram reaction");

    const { dispatch, correlations } = harness();
    expect(await dispatch(reaction)).toEqual({ status: "observed" });
    expect(reaction).toMatchObject({
      type: "reaction",
      platformIds: { conversationId: "7718912466", messageId: "14562" },
      rawAnchors: { updateId: "777932597", sourceMessageId: "14562" },
      rawEmoji: "👏",
      added: true,
    });
    expect(correlations).toEqual([
      expect.objectContaining({
        name: MESSAGE_REACTION_RECEIVED,
        data: expect.objectContaining({
          platformMessageId: "14562",
          rawEventId: "777932597",
          emoji: "👏",
          action: "added",
        }),
      }),
    ]);
  });

});
