import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  decodeInboundEvent,
  InboundEvent,
  type InboundEventKind,
} from "../inbound-events";

function fixture(type: InboundEventKind): Record<string, unknown> {
  const common = {
    contractVersion: 2,
    eventId: `telegram:update-42:${type}`,
    platform: "telegram",
    occurredAt: "2026-07-16T19:00:00.000Z",
    observedAt: "2026-07-16T19:00:00.050Z",
    shadow: true,
    actor: {
      platformUserId: "7718912466",
      userName: "joel",
      displayName: "Joel Hooks",
      isBot: false,
      isSelf: false,
    },
    platformIds: {
      conversationId: "7718912466",
      messageId: "420",
      threadId: null,
      actorId: "7718912466",
      workspaceId: null,
    },
    rawAnchors: {
      transportEventId: "42",
      updateId: "42",
      callbackQueryId: null,
      sourceMessageId: "420",
      sourceThreadId: null,
    },
    audit: {
      source: "gateway.telegram.message:text",
      transport: "grammy-long-polling",
      sdkName: "vercel/chat",
      sdkVersion: "4.34.0",
      normalizedAt: "2026-07-16T19:00:00.040Z",
      rawEventType: "message:text",
      rawEventId: "42",
      lineageId: `telegram:42:${type}`,
    },
    authorization: {
      verdict: "accepted",
      reason: "authorized_joel",
      policyAction: type === "reaction" ? "observe" : "invoke",
      expectedActorId: "7718912466",
      actualActorId: "7718912466",
      canPublish: true,
      canExecute: false,
    },
  };

  switch (type) {
    case "message":
      return { ...common, type, text: "status", isMention: false, attachmentCount: 0 };
    case "command":
      return { ...common, type, command: "/status", argumentsText: "" };
    case "interaction":
      return { ...common, type, actionId: "approve", value: "item-42" };
    case "reaction":
      return { ...common, type, emoji: "thumbs_up", rawEmoji: "👍", added: true };
  }
}

describe("contract-v2 inbound events", () => {
  test("decodes every normalized inbound shape", () => {
    for (const type of ["message", "command", "interaction", "reaction"] as const) {
      expect(decodeInboundEvent(fixture(type)).type).toBe(type);
    }
  });

  test("makes observe-only invariants unrepresentable", () => {
    expect(() =>
      Schema.decodeUnknownSync(InboundEvent)({
        ...fixture("message"),
        shadow: false,
      }),
    ).toThrow();

    const message = fixture("message");
    expect(() =>
      Schema.decodeUnknownSync(InboundEvent)({
        ...message,
        authorization: {
          ...(message.authorization as Record<string, unknown>),
          canExecute: true,
        },
      }),
    ).toThrow();
  });

  test("rejects contradictory authorization and invalid identity data", () => {
    const message = fixture("message");
    expect(() =>
      Schema.decodeUnknownSync(InboundEvent)({
        ...message,
        authorization: {
          verdict: "accepted",
          reason: "self_message",
          policyAction: "reject",
          expectedActorId: "7718912466",
          actualActorId: "7718912466",
          canPublish: true,
          canExecute: false,
        },
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(InboundEvent)({
        ...message,
        eventId: "",
        occurredAt: "not-a-timestamp",
      }),
    ).toThrow();
  });
});
