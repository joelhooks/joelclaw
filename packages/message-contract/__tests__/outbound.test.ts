import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  createDeliveryReceipt,
  decodeOutboundIntent,
  FlowId,
  InvalidMessageIntentError,
  MESSAGE_CONTRACT_VERSION,
  MessageReactionReceivedEvent,
  mintFlowId,
  ROUTING_TABLE_V2,
  resolveMessageRoute,
} from "../src";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("message contract v2", () => {
  test("mints branded v2 flow ids", () => {
    const flowId = mintFlowId(() => UUID);
    expect(String(flowId)).toBe(`flow_v2_${UUID}`);
    expect(Schema.decodeUnknownSync(FlowId)(flowId)).toBe(flowId);
  });

  test("rejects blank producer intent with a teaching error", () => {
    expect(() => decodeOutboundIntent({
      contractVersion: MESSAGE_CONTRACT_VERSION,
      kind: "memory",
      content: "   ",
      correlationId: "memory-1",
    })).toThrow(InvalidMessageIntentError);
  });

  test("accepts bounded semantic reaction actions", () => {
    const intent = decodeOutboundIntent({
      contractVersion: MESSAGE_CONTRACT_VERSION,
      kind: "alert",
      content: "**Healthy.**",
      correlationId: "campaign-pulse-1",
      actions: [
        { kind: "reaction", label: "👍 Seen", emoji: "👍" },
        { kind: "reaction", label: "🔧 Run flow agent", emoji: "🔧" },
        { kind: "reaction", label: "🔎 Investigate", emoji: "🔎" },
      ],
    });

    expect(intent.actions?.map((action) => action.emoji)).toEqual(["👍", "🔧", "🔎"]);
  });

  test("rejects empty or oversized action declarations", () => {
    expect(() => decodeOutboundIntent({
      contractVersion: MESSAGE_CONTRACT_VERSION,
      kind: "alert",
      content: "Pulse",
      correlationId: "campaign-pulse-empty",
      actions: [],
    })).toThrow(InvalidMessageIntentError);
    expect(() => decodeOutboundIntent({
      contractVersion: MESSAGE_CONTRACT_VERSION,
      kind: "alert",
      content: "Pulse",
      correlationId: "campaign-pulse-many",
      actions: Array.from({ length: 7 }, (_, index) => ({
        kind: "reaction",
        label: `Action ${index}`,
        emoji: "👍",
      })),
    })).toThrow(InvalidMessageIntentError);
    expect(() => decodeOutboundIntent({
      contractVersion: MESSAGE_CONTRACT_VERSION,
      kind: "alert",
      content: "Pulse",
      correlationId: "campaign-pulse-callback-too-large",
      actions: [{
        kind: "reaction",
        label: "Too many emoji",
        emoji: "👍👍👍👍👍👍👍👍",
      }],
    })).toThrow(InvalidMessageIntentError);
  });

  test("owns versioned kind routing", () => {
    expect(ROUTING_TABLE_V2.version).toBe(2);
    expect(resolveMessageRoute("memory")).toEqual({
      platform: "telegram",
      lane: "operator",
      urgency: "normal",
      formatting: "markdown",
    });
    expect(resolveMessageRoute("receipt").platform).toBe("slack");
  });

  test("creates a HATEOAS delivery receipt", () => {
    const flowId = mintFlowId(() => UUID);
    const receipt = createDeliveryReceipt({
      flowId,
      correlationId: "canary-1",
      requestedAt: "2026-07-16T20:00:00.000Z",
      confirmedAt: "2026-07-16T20:00:01.000Z",
      deliveryState: "confirmed",
      platform: "telegram",
      platformMessageId: "42",
      threadId: "telegram:7",
      route: { lane: "operator", urgency: "normal", formatting: "markdown" },
    });
    expect(receipt._links.flow.href).toContain(flowId);
    expect(receipt.data.platformMessageId).toBe("42");
  });

  test("validates versioned reaction events", () => {
    const flowId = mintFlowId(() => UUID);
    const event = Schema.decodeUnknownSync(MessageReactionReceivedEvent)({
      name: "message/reaction.received",
      data: {
        contractVersion: 2,
        flowId,
        platform: "telegram",
        emoji: "👍",
        action: "added",
        added: true,
        rawEventId: "777932597",
        platformMessageId: "14562",
        correlationSource: "gateway-acting",
        actor: { id: "joel" },
        at: "2026-07-16T20:00:00.000Z",
      },
    });
    expect(event.data.flowId).toBe(flowId);
  });

  test("accepts legacy notify flow references during the return-path migration", () => {
    const event = Schema.decodeUnknownSync(MessageReactionReceivedEvent)({
      name: "message/reaction.received",
      data: {
        contractVersion: 2,
        flowId: "notify:7c1924bc-b192-42da-b145-64dedfa2fe94",
        platform: "telegram",
        emoji: "👏",
        action: "added",
        added: true,
        rawEventId: "777932597",
        platformMessageId: "14562",
        correlationSource: "redis-legacy-telegram",
        actor: { id: "joel" },
        at: "2026-07-17T03:26:18.905Z",
      },
    });
    expect(event.data.flowId).toStartWith("notify:");
  });
});
