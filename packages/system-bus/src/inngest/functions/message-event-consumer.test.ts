import { describe, expect, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import type {
  MaterializeMessageEventReceipt,
  MessageEventDocument,
} from "@joelclaw/message-event-log";
import { createMessageEventConsumerFunction } from "./message-event-consumer";

const event = {
  id: "message-event-consume:fixture-1",
  name: "message/event.consume.requested",
  data: { reason: "test" },
} as any;

const pendingEvent: MessageEventDocument = {
  _id: "fixture-1",
  _creationTime: 1,
  schemaVersion: 1,
  sequence: 1,
  semanticKey: "proof:fixture-1",
  kind: "message.requested",
  source: "proof",
  payload: { proof: true },
  occurredAt: 1,
  recordedAt: 2,
  flowId: "flow-proof-1",
};

describe("message event consumer", () => {
  test("tails Convex and acknowledges only after the view mutation returns", async () => {
    const calls: Array<{ eventId: string; inngestEventId: string }> = [];
    const receipt: MaterializeMessageEventReceipt = {
      eventId: "fixture-1",
      deduplicated: false,
      flowView: true,
      platformView: false,
      terminalView: false,
      actionView: false,
    };
    const fn = createMessageEventConsumerFunction({
      pending: async () => [pendingEvent],
      materialize: async (input) => {
        calls.push(input);
        return receipt;
      },
      emit: async () => ({ stored: true }),
    });

    const execution = await new InngestTestEngine({
      function: fn as any,
      events: [event],
    }).execute();

    expect(calls).toEqual([
      {
        eventId: "fixture-1",
        inngestEventId: "message-event-consume:fixture-1:fixture-1",
      },
    ]);
    expect(execution.result).toEqual({
      scanned: 1,
      materialized: 1,
      deduplicated: 0,
      eventIds: ["fixture-1"],
    });
  });

  test("reports a replay receipt without changing a view twice", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const fn = createMessageEventConsumerFunction({
      pending: async () => [pendingEvent],
      materialize: async () => ({
        eventId: "fixture-1",
        deduplicated: true,
        flowView: false,
        platformView: false,
        terminalView: false,
        actionView: false,
      }),
      emit: async (input) => {
        emitted.push(input as Record<string, unknown>);
        return { stored: true };
      },
    });

    const execution = await new InngestTestEngine({
      function: fn as any,
      events: [event],
    }).execute();

    expect(execution.result).toMatchObject({ deduplicated: 1, materialized: 0 });
    expect(emitted).toEqual([
      expect.objectContaining({ action: "message.event.replay_deduplicated" }),
    ]);
  });

  test("does no work when the cursor has no pending events", async () => {
    let materializeCalls = 0;
    const fn = createMessageEventConsumerFunction({
      pending: async () => [],
      materialize: async () => {
        materializeCalls += 1;
        throw new Error("must not run");
      },
      emit: async () => ({ stored: true }),
    });

    const execution = await new InngestTestEngine({
      function: fn as any,
      events: [event],
    }).execute();

    expect(materializeCalls).toBe(0);
    expect(execution.result).toEqual({
      scanned: 0,
      materialized: 0,
      deduplicated: 0,
      eventIds: [],
    });
  });
});
