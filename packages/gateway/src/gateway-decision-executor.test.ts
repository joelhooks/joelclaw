import { describe, expect, test } from "bun:test";
import type { MessageEventDocument } from "@joelclaw/message-event-log";
import { drainDeliverDecisions, EXECUTOR_CONSUMER } from "./gateway-decision-executor";

function decisionEvent(
  id: string,
  payload: Record<string, unknown>,
): MessageEventDocument {
  return {
    _id: id,
    kind: "gateway.decision.recorded",
    source: "joelclaw-gateway",
    flowId: `flow-${id}`,
    payload,
    recordedAt: 1,
    sequence: 1,
  } as unknown as MessageEventDocument;
}

function harness(events: MessageEventDocument[]) {
  const sent: string[] = [];
  const sentRequests: Array<{
    flowId: string;
    correlationId?: string;
  }> = [];
  const advanced: string[] = [];
  const logged: string[] = [];
  return {
    sent,
    sentRequests,
    advanced,
    logged,
    run: () =>
      drainDeliverDecisions({
        eventLog: {
          pendingForConsumer: async () => events,
          advanceCursor: async (consumer, eventId) => {
            expect(consumer).toBe(EXECUTOR_CONSUMER);
            advanced.push(eventId);
          },
        },
        recipientId: "joel",
        send: async (request) => {
          sent.push(request.text);
          sentRequests.push({
            flowId: request.flowId,
            ...(request.correlationId
              ? { correlationId: request.correlationId }
              : {}),
          });
          return { platformMessageId: `sent-${sent.length}` };
        },
        log: (message) => logged.push(message),
      }),
  };
}

describe("deliver executor", () => {
  test("executes a deliver decision with top-level rewrite", async () => {
    const event = decisionEvent(
      "d1",
      { decision: { verb: "deliver" }, rewrite: "Front is back up." },
    );
    event.flowId = "notify:11111111-1111-4111-8111-111111111111";
    event.correlationId = "daily-flow-agent:11111111-1111-4111-8111-111111111111";
    const harnessed = harness([event]);
    const result = await harnessed.run();
    expect(harnessed.sent).toEqual(["Front is back up."]);
    expect(harnessed.sentRequests).toEqual([{
      flowId: "notify:11111111-1111-4111-8111-111111111111",
      correlationId: "daily-flow-agent:11111111-1111-4111-8111-111111111111",
    }]);
    expect(harnessed.advanced).toEqual(["d1"]);
    expect(result).toEqual({ executed: 1, skipped: 0 });
  });

  test("delivers a close-deliver whose text sits on decision.rewrite", async () => {
    // Four real close-delivers on cutover day put the text here and were never
    // sent. Joel never saw those messages; the executor must read both places.
    const harnessed = harness([
      decisionEvent("d2", {
        decision: { verb: "aggregate", action: "close-deliver", rewrite: "3 health alerts, all Front." },
      }),
    ]);
    const result = await harnessed.run();
    expect(harnessed.sent).toEqual(["3 health alerts, all Front."]);
    expect(result).toEqual({ executed: 1, skipped: 0 });
  });

  test("prefers the top-level rewrite when both are present", async () => {
    const harnessed = harness([
      decisionEvent("d3", {
        decision: { verb: "deliver", rewrite: "stale draft" },
        rewrite: "final text",
      }),
    ]);
    await harnessed.run();
    expect(harnessed.sent).toEqual(["final text"]);
  });

  test("skips and reports a deliver decision carrying no text anywhere", async () => {
    const harnessed = harness([decisionEvent("d4", { decision: { verb: "deliver" } })]);
    const result = await harnessed.run();
    expect(harnessed.sent).toEqual([]);
    expect(harnessed.advanced).toEqual(["d4"]);
    expect(harnessed.logged.join(" ")).toContain("without rewrite text");
    expect(result).toEqual({ executed: 0, skipped: 1 });
  });

  test("advances past decisions that are not deliveries", async () => {
    const harnessed = harness([
      decisionEvent("d5", { decision: { verb: "drop" }, reason: "duplicate health tick" }),
      decisionEvent("d6", { decision: { verb: "aggregate", action: "join" } }),
    ]);
    const result = await harnessed.run();
    expect(harnessed.sent).toEqual([]);
    expect(harnessed.advanced).toEqual(["d5", "d6"]);
    expect(result).toEqual({ executed: 0, skipped: 2 });
  });
});
