import { describe, expect, test } from "bun:test";
import type { MessageEventDocument } from "@joelclaw/message-event-log";
import { drainDeliverDecisions, EXECUTOR_CONSUMER } from "./gateway-decision-executor";

function decisionEvent(id: string, payload: Record<string, unknown>): MessageEventDocument {
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

function harness(events: MessageEventDocument[], recipientId = "joel") {
  const sent: string[] = [];
  const sentRequests: Array<{
    flowId: string;
    correlationId?: string;
    platform: string;
    recipientId: string;
    replyThreadId?: string;
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
        recipientId,
        send: async (request) => {
          sent.push(request.text);
          sentRequests.push({
            flowId: request.flowId,
            platform: request.target.platform,
            recipientId: request.target.recipientId,
            ...(request.correlationId ? { correlationId: request.correlationId } : {}),
            ...(request.replyThreadId ? { replyThreadId: request.replyThreadId } : {}),
          });
          return { platformMessageId: `sent-${sent.length}` };
        },
        log: (message) => logged.push(message),
      }),
  };
}

describe("deliver executor", () => {
  test("executes a deliver decision with top-level rewrite", async () => {
    const event = decisionEvent("d1", {
      decision: { verb: "deliver" },
      rewrite: "Front is back up.",
    });
    event.flowId = "notify:11111111-1111-4111-8111-111111111111";
    event.correlationId = "daily-flow-agent:11111111-1111-4111-8111-111111111111";
    const harnessed = harness([event]);
    const result = await harnessed.run();
    expect(harnessed.sent).toEqual(["Front is back up."]);
    expect(harnessed.sentRequests).toEqual([
      {
        flowId: "notify:11111111-1111-4111-8111-111111111111",
        correlationId: "daily-flow-agent:11111111-1111-4111-8111-111111111111",
        platform: "telegram",
        recipientId: "joel",
      },
    ]);
    expect(harnessed.advanced).toEqual(["d1"]);
    expect(result).toEqual({ executed: 1, skipped: 0 });
  });

  test("delivers to the Slack thread named by the decision target", async () => {
    const harnessed = harness([
      decisionEvent("slack-result", {
        decision: {
          verb: "deliver",
          target: {
            kind: "platform",
            platform: "slack",
            conversationId: "CMEGA",
            threadId: "slack:CMEGA:1785950000.100",
          },
        },
        rewrite: "Review complete: nine defects found.",
      }),
    ], "");

    const result = await harnessed.run();
    expect(harnessed.sentRequests).toEqual([
      {
        flowId: "flow-slack-result",
        platform: "slack",
        recipientId: "CMEGA",
        replyThreadId: "slack:CMEGA:1785950000.100",
      },
    ]);
    expect(result).toEqual({ executed: 1, skipped: 0 });
  });

  test("claims an operator-approved Slack reply before crossing the send boundary", async () => {
    const event = decisionEvent("slack-operator", {
      decision: {
        verb: "deliver",
        target: {
          kind: "platform",
          platform: "slack",
          conversationId: "CMEGA",
          threadId: "slack:CMEGA:1785950000.100",
        },
      },
      rewrite: "Approved exact reply.",
    });
    event.source = "operator.jc-slack";
    const calls: string[] = [];

    await expect(
      drainDeliverDecisions({
        eventLog: {
          pendingForConsumer: async () => [event],
          advanceCursor: async (_consumer, eventId) => {
            calls.push(`claim:${eventId}`);
          },
        },
        recipientId: "",
        send: async () => {
          calls.push("send");
          throw new Error("post-send receipt persistence failed");
        },
      }),
    ).rejects.toThrow("post-send receipt persistence failed");

    expect(calls).toEqual(["claim:slack-operator", "send"]);
  });

  test("delivers a close-deliver whose text sits on decision.rewrite", async () => {
    // Four real close-delivers on cutover day put the text here and were never
    // sent. Joel never saw those messages; the executor must read both places.
    const harnessed = harness([
      decisionEvent("d2", {
        decision: {
          verb: "aggregate",
          action: "close-deliver",
          rewrite: "3 health alerts, all Front.",
        },
      }),
    ]);
    const result = await harnessed.run();
    expect(harnessed.sent).toEqual(["3 health alerts, all Front."]);
    expect(result).toEqual({ executed: 1, skipped: 0 });
  });

  test("delivers an incident aggregate open marked for immediate delivery", async () => {
    const harnessed = harness([
      decisionEvent("incident-open", {
        decision: {
          verb: "aggregate",
          action: "open",
          aggregateId: "incident:welcome-email-backlog:1",
          anomalyId: "welcome-email-backlog",
          delivery: "immediate",
        },
        rewrite: "Three welcome emails are stuck.",
      }),
    ]);
    const result = await harnessed.run();
    expect(harnessed.sent).toEqual(["Three welcome emails are stuck."]);
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
