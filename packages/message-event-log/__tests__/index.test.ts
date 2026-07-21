import { describe, expect, test } from "bun:test";
import type { ConvexHttpClient } from "convex/browser";

import {
  createMessageEventLogClient,
  GATEWAY_MESSAGE_EVENT_CONSUMER,
  type GatewayDecisionRecordedPayload,
  gatewayDecisionSemanticKey,
} from "../src/index";

const decisionPayload: GatewayDecisionRecordedPayload = {
  inputEventIds: ["event-17"],
  reason: "The producer reported a failed deploy.",
  promptRevision: "gateway-v3",
  decisionSeq: 2,
  decision: {
    verb: "deliver",
    target: { kind: "platform", platform: "telegram" },
    rewrite: "Deploy failed.",
  },
};

describe("gateway stream contracts", () => {
  test("derives the ADR-0249 decision semantic key", () => {
    expect(gatewayDecisionSemanticKey(decisionPayload)).toBe("gateway:event-17:2");
    expect(() => gatewayDecisionSemanticKey({ inputEventIds: [], decisionSeq: 1 })).toThrow(
      "inputEventIds[0] must be a non-empty string",
    );
    expect(() =>
      gatewayDecisionSemanticKey({ inputEventIds: ["event-17"], decisionSeq: 0 }),
    ).toThrow("decisionSeq must be a positive safe integer");
  });

  test("passes the gateway origin and typed decision payload through append", async () => {
    const calls: Array<{ operation: string; args: unknown }> = [];
    const fakeClient = {
      mutation: async (_ref: unknown, args: unknown) => {
        calls.push({ operation: "mutation", args });
        return {
          eventId: "event-decision-1",
          semanticKey: "gateway:event-17:2",
          deduplicated: false,
          schemaVersion: 1,
        };
      },
      query: async () => [],
    } as unknown as ConvexHttpClient;
    const client = createMessageEventLogClient({ client: fakeClient });

    await client.append({
      semanticKey: gatewayDecisionSemanticKey(decisionPayload),
      kind: "gateway.decision.recorded",
      source: "gateway",
      flowId: "flow-17",
      origin: {
        producer: "deploy-worker",
        machineId: "flagg",
        paneId: "w28:pB",
        sessionId: "session-17",
      },
      payload: decisionPayload,
    });

    expect(calls[0]?.args).toEqual({
      semanticKey: "gateway:event-17:2",
      kind: "gateway.decision.recorded",
      source: "gateway",
      flowId: "flow-17",
      origin: {
        producer: "deploy-worker",
        machineId: "flagg",
        paneId: "w28:pB",
        sessionId: "session-17",
      },
      payload: decisionPayload,
    });
  });

  test("uses independent named cursors and the paginated replay contract", async () => {
    const calls: Array<{ operation: string; args: unknown }> = [];
    const fakeClient = {
      mutation: async (_ref: unknown, args: unknown) => {
        calls.push({ operation: "mutation", args });
        return {
          consumer: GATEWAY_MESSAGE_EVENT_CONSUMER,
          lastEventId: "event-18",
          lastSequence: 18,
          updatedAt: 1000,
        };
      },
      query: async (_ref: unknown, args: unknown) => {
        calls.push({ operation: "query", args });
        if (typeof args === "object" && args !== null && "recordedAt" in args) {
          return { events: [], nextCursor: null, source: "message-event-log" };
        }
        return [];
      },
    } as unknown as ConvexHttpClient;
    const client = createMessageEventLogClient({ client: fakeClient });

    await client.pendingForConsumer(GATEWAY_MESSAGE_EVENT_CONSUMER, 25);
    await client.advanceCursor(GATEWAY_MESSAGE_EVENT_CONSUMER, "event-18");
    const replay = await client.readSince(1_721_600_000_000, 100, "cursor-1");

    expect(calls.map(({ args }) => args)).toEqual([
      { consumer: "gateway/agent", limit: 25 },
      { consumer: "gateway/agent", eventId: "event-18" },
      { cursor: "cursor-1", limit: 100, recordedAt: 1_721_600_000_000 },
    ]);
    expect(replay).toEqual({ events: [], nextCursor: null, source: "message-event-log" });
  });
});
