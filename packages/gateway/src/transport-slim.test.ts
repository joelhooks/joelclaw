import { describe, expect, test } from "bun:test";
import {
  decodeInboundEvent,
  type InboundEvent,
} from "@joelclaw/message-contract";
import type {
  AppendMessageEventInput,
  AppendMessageEventReceipt,
  MessageEventOrigin,
} from "@joelclaw/message-event-log";
import { routeNotifySendToSlimTransport } from "./chat-sdk/notify-stream";
import { normalizeSdkInboundEvent } from "./chat-sdk-inbound/normalize";
import { createStreamInboundPublisher } from "./chat-sdk-inbound/publish";
import {
  FALLBACK_PREFIX,
  type MessageEventAppender,
  makeExplicitTransportSender,
  makeRawTelegramFallbackSender,
  makeSlimNotifyIngress,
  type ProducerFacts,
} from "./transport-slim";

const origin: MessageEventOrigin = {
  producer: "deploy-worker",
  machineId: "flagg",
  paneId: "w28:pF",
  sessionId: "session-transport-test",
};

const facts: ProducerFacts = {
  eventId: "notify:event-1",
  source: "deploy-worker",
  text: "deploy failed\ncheck the worker",
  flowId: "notify:event-1",
  occurredAt: Date.parse("2026-07-21T18:00:00.000Z"),
  origin,
  evidence: {
    priority: "critical",
    data: { privateDiagnostic: "stream-only" },
  },
};

function eventLogHarness(calls: string[] = []) {
  const events: AppendMessageEventInput[] = [];
  const eventLog: MessageEventAppender = {
    append: async (input): Promise<AppendMessageEventReceipt> => {
      calls.push(`append:${input.kind}`);
      events.push(input);
      return {
        eventId: `stream:${events.length}`,
        semanticKey: input.semanticKey,
        deduplicated: false,
        schemaVersion: 1,
      };
    },
  };
  return { events, eventLog };
}

function inboundReply(): InboundEvent {
  return normalizeSdkInboundEvent({
    kind: "message",
    platform: "telegram",
    actor: {
      id: "7718912466",
      userName: "joel",
      displayName: "Joel",
      isBot: false,
      isMe: false,
    },
    conversationId: "7718912466",
    messageId: "16000",
    threadId: "telegram:7718912466",
    occurredAt: "2026-07-21T18:10:00.000Z",
    text: "reply to this",
    isMention: false,
    attachmentCount: 0,
  }, {
    platform: "telegram",
    kind: "message",
    transport: "polling",
    rawEventType: "message",
    raw: {
      message: {
        message_id: 16000,
        reply_to_message: { message_id: 15000 },
      },
    },
    receivedAt: "2026-07-21T18:10:00.100Z",
    allowedActorId: "7718912466",
  }, {
    sdkVersion: "4.34.0",
    now: () => new Date("2026-07-21T18:10:00.100Z"),
  });
}

function inbound(type: "message" | "reaction"): InboundEvent {
  const common = {
    contractVersion: 2,
    eventId: `telegram:${type}:event-1`,
    platform: "telegram",
    occurredAt: "2026-07-21T18:10:00.000Z",
    observedAt: "2026-07-21T18:10:00.100Z",
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
      messageId: "telegram:7718912466:14543",
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
      source: `gateway.telegram.${type}`,
      transport: "polling",
      sdkName: "vercel/chat",
      sdkVersion: "4.34.0",
      normalizedAt: "2026-07-21T18:10:00.100Z",
      rawEventType: type,
      rawEventId: "1784237017",
      lineageId: `lineage-${type}`,
    },
    authorization: {
      verdict: "accepted",
      reason: "authorized_joel",
      policyAction: type === "message" ? "invoke" : "observe",
      expectedActorId: "7718912466",
      actualActorId: "7718912466",
      canPublish: true,
      canExecute: false,
    },
  } as const;
  return type === "message"
    ? decodeInboundEvent({
        ...common,
        type,
        text: "reply to this",
        isMention: false,
        attachmentCount: 0,
      })
    : decodeInboundEvent({
        ...common,
        type,
        emoji: "thumbs_up",
        rawEmoji: "👍",
        added: true,
      });
}

describe("gateway transport slim-down seams", () => {
  test("appends producer facts before the fresh-heartbeat check and stops", async () => {
    const calls: string[] = [];
    const { events, eventLog } = eventLogHarness(calls);
    const result = await makeSlimNotifyIngress({
      eventLog,
      heartbeatExists: async () => {
        calls.push("heartbeat:exists");
        return true;
      },
      fallbackChannel: "telegram",
      sendRawTelegramFallback: async () => {
        throw new Error("fresh heartbeat must not fallback");
      },
    })(facts);

    expect(calls).toEqual(["append:message.requested", "heartbeat:exists"]);
    expect(result).toEqual({
      disposition: "agent",
      sourceEventId: "stream:1",
      flowId: facts.flowId,
    });
    expect(events[0]).toMatchObject({
      flowId: facts.flowId,
      origin,
      payload: { text: facts.text, evidence: facts.evidence },
    });
  });

  test("decodes notify wire facts without trimming or using compatibility routing", async () => {
    const { events, eventLog } = eventLogHarness();
    const result = await routeNotifySendToSlimTransport({
      id: "notify-wire-1",
      type: "gateway.notify",
      source: "existing-producer",
      ts: facts.occurredAt,
      payload: {
        prompt: "  exact producer text\n",
        priority: "critical",
        telegramOnly: true,
        audit: { flowId: "notify:wire-1", originSystemId: "flagg" },
        context: { data: { diagnostic: "stream-only" } },
      },
    }, {
      eventLog,
      heartbeatExists: async () => true,
      machineId: "flagg",
    });

    expect(result).toMatchObject({ handled: true, disposition: "agent" });
    expect(events[0]).toMatchObject({
      kind: "message.requested",
      flowId: "notify:wire-1",
      payload: {
        text: "  exact producer text\n",
        evidence: {
          priority: "critical",
          telegramOnly: true,
        },
      },
    });
  });

  test("sends agent-authored content to its explicit target without routing policy", async () => {
    const calls: string[] = [];
    const { events, eventLog } = eventLogHarness(calls);
    const posted: unknown[] = [];
    const remembered: unknown[] = [];
    const send = makeExplicitTransportSender({
      adapters: {
        slack: {
          openDM: async (recipientId) => {
            calls.push(`open:${recipientId}`);
            return "slack:D123:";
          },
          postMessage: async (threadId, content) => {
            calls.push(`post:${threadId}`);
            posted.push(content);
            return { id: "171234.567", threadId };
          },
        },
      },
      journal: {
        record: async (input) => {
          calls.push(`journal:${input.deliveryState}`);
          return { persisted: true };
        },
      },
      eventLog,
      rememberFlow: async (receipt) => {
        calls.push("remember:flow");
        remembered.push(receipt);
      },
    });

    const receipt = await send({
      target: { platform: "slack", recipientId: "UJOEL" },
      content: { markdown: "agent chose **this**" },
      text: "agent chose this",
      flowId: "flow-agent-send-1",
      origin,
      correlationId: "decision:event-1",
    });

    expect(posted).toEqual([{ markdown: "agent chose **this**" }]);
    expect(receipt).toMatchObject({ platform: "slack", platformMessageId: "171234.567" });
    expect(remembered).toEqual([receipt]);
    expect(events.map((event) => event.kind)).toEqual([
      "delivery.requested",
      "delivery.confirmed",
    ]);
    expect(calls).not.toContain("route:kind");
  });

  test("appends inbound replies and reactions with outbound flow correlation", async () => {
    const { events, eventLog } = eventLogHarness();
    const resolutions: unknown[] = [];
    const publisher = createStreamInboundPublisher({
      eventLog,
      machineId: "flagg",
      resolveFlowId: async (...args) => {
        resolutions.push(args);
        return "flow-agent-send-1";
      },
    });

    await publisher.publishEvent(inboundReply());
    await publisher.publishEvent(inbound("reaction"));

    expect(resolutions).toEqual([
      ["telegram", "15000", "7718912466"],
      ["telegram", "telegram:7718912466:14543", "7718912466"],
    ]);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        kind: "inbound.received",
        flowId: "flow-agent-send-1",
        payload: { replyFlowId: "flow-agent-send-1" },
      });
    }
    expect(events[1]?.payload).toMatchObject({
      content: { text: "👍" },
    });
  });

  test("uses verbatim stale-heartbeat fallback, then journals and marks it once", async () => {
    const calls: string[] = [];
    const { events, eventLog } = eventLogHarness(calls);
    const posts: unknown[] = [];
    const fallback = makeRawTelegramFallbackSender({
      adapter: {
        openDM: async () => "telegram:7718912466",
        postMessage: async (_threadId, content) => {
          calls.push("telegram:send");
          posts.push(content);
          return { id: "telegram:7718912466:15001", threadId: "telegram:7718912466" };
        },
      },
      recipientId: "7718912466",
      journal: {
        record: async () => {
          calls.push("journal:confirmed");
          return { persisted: true };
        },
      },
      eventLog,
    });
    const result = await makeSlimNotifyIngress({
      eventLog,
      heartbeatExists: async () => false,
      fallbackChannel: "telegram",
      sendRawTelegramFallback: fallback,
      now: () => Date.parse("2026-07-21T18:12:00.000Z"),
      heartbeatTtlMs: 60_000,
    })(facts);

    expect(result.disposition).toBe("fallback");
    expect(posts).toEqual([{ raw: `${FALLBACK_PREFIX} ${facts.text}` }]);
    expect(JSON.stringify(posts)).not.toContain("privateDiagnostic");
    expect(calls).toEqual([
      "append:message.requested",
      "telegram:send",
      "journal:confirmed",
      "append:fallback.delivered",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "fallback.delivered",
      flowId: facts.flowId,
      payload: {
        fallback: true,
        outcome: "confirmed",
        heartbeatStaleForMs: 60_000,
      },
    });
  });

  test("keeps the queue retryable when fallback fails before Telegram", async () => {
    const previousUserId = process.env.TELEGRAM_USER_ID;
    delete process.env.TELEGRAM_USER_ID;
    const { eventLog } = eventLogHarness();
    try {
      await routeNotifySendToSlimTransport({
        id: "notify-pre-send-failure",
        type: "gateway.notify",
        source: "deploy-worker",
        ts: facts.occurredAt,
        payload: {
          message: facts.text,
          audit: { flowId: "notify:pre-send-failure" },
        },
      }, {
        eventLog,
        heartbeatExists: async () => false,
      });
      throw new Error("expected pre-send failure");
    } catch (error) {
      expect(error).toMatchObject({ handled: false });
    } finally {
      if (previousUserId === undefined) delete process.env.TELEGRAM_USER_ID;
      else process.env.TELEGRAM_USER_ID = previousUserId;
    }
  });

  test("does not retry when the post-send journal rejects", async () => {
    let sends = 0;
    const { eventLog } = eventLogHarness();
    const fallback = makeRawTelegramFallbackSender({
      adapter: {
        openDM: async () => "telegram:7718912466",
        postMessage: async () => {
          sends += 1;
          return { id: "15002", threadId: "telegram:7718912466" };
        },
      },
      recipientId: "7718912466",
      journal: { record: async () => { throw new Error("journal offline"); } },
      eventLog,
    });

    await expect(fallback({
      text: facts.text,
      flowId: facts.flowId,
      sourceEventId: "stream:1",
      origin,
      heartbeatObservedAt: Date.now(),
      heartbeatStaleForMs: 60_000,
    })).rejects.toThrow("after the platform boundary");
    expect(sends).toBe(1);
  });

  test("does not retry an ambiguous post-send fallback failure", async () => {
    let sends = 0;
    const { eventLog } = eventLogHarness();
    const fallback = makeRawTelegramFallbackSender({
      adapter: {
        openDM: async () => "telegram:7718912466",
        postMessage: async () => {
          sends += 1;
          return { id: "15002", threadId: "telegram:7718912466" };
        },
      },
      recipientId: "7718912466",
      journal: { record: async () => ({ persisted: false }) },
      eventLog,
    });

    await expect(fallback({
      text: facts.text,
      flowId: facts.flowId,
      sourceEventId: "stream:1",
      origin,
      heartbeatObservedAt: Date.now(),
      heartbeatStaleForMs: 60_000,
    })).rejects.toThrow("automatic retry forbidden");
    expect(sends).toBe(1);
  });
});
