import { describe, expect, test } from "bun:test";
import type { ConvexHttpClient } from "convex/browser";

import {
  createMessageEventLogClient,
  GATEWAY_MESSAGE_EVENT_CONSUMER,
  GATEWAY_TRANSPORT_READINESS_CONSUMER,
  type GatewayDecisionRecordedPayload,
  gatewayDecisionSemanticKey,
  MessageEventLogError,
  resolveMessageEventLogUrl,
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
  test("derives the Convex URL from the fleet Central URL on satellites", () => {
    const names = [
      "MESSAGE_EVENT_CONVEX_URL",
      "CONVEX_SELF_HOSTED_URL",
      "CONVEX_URL",
      "JOELCLAW_CENTRAL_URL",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.JOELCLAW_CENTRAL_URL = "http://central.example.test:3011/api";
      expect(resolveMessageEventLogUrl()).toBe("http://central.example.test:3210/");
      process.env.MESSAGE_EVENT_CONVEX_URL = "http://explicit.example.test:4444";
      expect(resolveMessageEventLogUrl()).toBe("http://explicit.example.test:4444");
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

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

  test("probes the deployed messageEvents query with a bounded named consumer", async () => {
    const calls: unknown[] = [];
    const fakeClient = {
      mutation: async () => ({}),
      query: async (_ref: unknown, args: unknown) => {
        calls.push(args);
        return [];
      },
    } as unknown as ConvexHttpClient;
    const client = createMessageEventLogClient({ client: fakeClient });

    await client.probe(50);

    expect(calls).toEqual([
      {
        consumer: GATEWAY_TRANSPORT_READINESS_CONSUMER,
        limit: 1,
      },
    ]);
  });

  test("fails a probe within its timeout instead of hanging startup", async () => {
    const fakeClient = {
      mutation: async () => ({}),
      query: async () => new Promise(() => {}),
    } as unknown as ConvexHttpClient;
    const client = createMessageEventLogClient({ client: fakeClient });

    try {
      await client.probe(5);
      throw new Error("expected probe failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MessageEventLogError);
      expect(error).toMatchObject({
        operation: "probe",
        code: "MESSAGE_EVENT_PROBE_FAILED",
      });
    }
  });

  test("uses independent named cursors and the bounded gateway replay contract", async () => {
    const calls: Array<{ operation: string; args: unknown }> = [];
    const replayContext = {
      pending: [],
      latestHandoff: null,
      coverages: [
        {
          inputEventId: "event-17",
          decisionEventId: "decision-17",
          terminal: true,
          verb: "drop" as const,
        },
      ],
    };
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
        if (typeof args === "object" && args !== null && !("consumer" in args)) {
          return replayContext;
        }
        return [];
      },
    } as unknown as ConvexHttpClient;
    const client = createMessageEventLogClient({ client: fakeClient });

    await client.pendingForConsumer(GATEWAY_MESSAGE_EVENT_CONSUMER, 25);
    await client.advanceCursor(GATEWAY_MESSAGE_EVENT_CONSUMER, "event-18");
    const context = await client.gatewayReplayContext(75);
    const replay = await client.readSince(1_721_600_000_000, 100, "cursor-1");

    expect(calls.map(({ args }) => args)).toEqual([
      { consumer: "gateway/agent", limit: 25 },
      { consumer: "gateway/agent", eventId: "event-18" },
      { limit: 75 },
      { cursor: "cursor-1", limit: 100, recordedAt: 1_721_600_000_000 },
    ]);
    expect(context).toEqual(replayContext);
    expect(replay).toEqual({ events: [], nextCursor: null, source: "message-event-log" });
  });

  test("rejects gateway replay limits outside the public API contract", async () => {
    const fakeClient = {
      mutation: async () => ({}),
      query: async () => ({ pending: [], latestHandoff: null, coverages: [] }),
    } as unknown as ConvexHttpClient;
    const client = createMessageEventLogClient({ client: fakeClient });

    await expect(client.gatewayReplayContext(0)).rejects.toMatchObject({
      operation: "gatewayReplayContext",
      code: "MESSAGE_EVENT_GATEWAY_REPLAY_CONTEXT_INVALID_LIMIT",
    });
    await expect(client.gatewayReplayContext(101)).rejects.toMatchObject({
      operation: "gatewayReplayContext",
      code: "MESSAGE_EVENT_GATEWAY_REPLAY_CONTEXT_INVALID_LIMIT",
    });
  });
});
