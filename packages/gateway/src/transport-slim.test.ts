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
  createHeartbeatGateState,
  DEFAULT_FALLBACK_COALESCE_MS,
  DEFAULT_HEARTBEAT_BLIP_GRACE_MS,
  FALLBACK_PREFIX,
  formatFallbackText,
  type MessageEventAppender,
  makeExplicitTransportSender,
  makeRawTelegramFallbackSender,
  makeSlimNotifyIngress,
  type ProducerFacts,
  parseHeartbeatPayload,
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


function frozenClock(start = Date.parse("2026-07-21T18:12:00.000Z")) {
  let current = start;
  const waits: number[] = [];
  return {
    now: () => current,
    wait: async (ms: number) => {
      waits.push(ms);
      current += ms;
    },
    waits,
    get current() {
      return current;
    },
  };
}

function fallbackScheduleHarness() {
  const scheduled: Array<{
    cancelled: boolean;
    readonly delayMs: number;
    readonly task: () => Promise<void>;
  }> = [];
  return {
    schedule: (task: () => Promise<void>, delayMs: number) => {
      const entry = { cancelled: false, delayMs, task };
      scheduled.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    async flushLatest() {
      const entry = scheduled.findLast((candidate) => !candidate.cancelled);
      if (!entry) throw new Error("no scheduled fallback batch");
      entry.cancelled = true;
      await entry.task();
    },
    scheduled,
  };
}

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

function slackMessage(
  conversationId: string,
  isMention: boolean,
): InboundEvent {
  return decodeInboundEvent({
    contractVersion: 2,
    eventId: `slack:message:${conversationId}:${isMention}`,
    platform: "slack",
    type: "message",
    occurredAt: "2026-07-21T18:10:00.000Z",
    observedAt: "2026-07-21T18:10:00.100Z",
    shadow: true,
    actor: {
      platformUserId: "U030BJ3CK",
      userName: "joel",
      displayName: "Joel",
      isBot: false,
      isSelf: false,
    },
    platformIds: {
      conversationId,
      messageId: "171234.567",
      threadId: null,
      actorId: "U030BJ3CK",
      workspaceId: "T123",
    },
    rawAnchors: {
      transportEventId: "171234.568",
      updateId: null,
      callbackQueryId: null,
      sourceMessageId: "171234.567",
      sourceThreadId: null,
    },
    audit: {
      source: "gateway.slack.message",
      transport: "socket",
      sdkName: "vercel/chat",
      sdkVersion: "4.34.0",
      normalizedAt: "2026-07-21T18:10:00.100Z",
      rawEventType: "message",
      rawEventId: "171234.568",
      lineageId: `${conversationId}-${isMention}`,
    },
    authorization: {
      verdict: "accepted",
      reason: "authorized_joel",
      policyAction: "invoke",
      expectedActorId: "U030BJ3CK",
      actualActorId: "U030BJ3CK",
      canPublish: true,
      canExecute: false,
    },
    text: isMention ? "<@UBOT> status" : "message for a human",
    isMention,
    attachmentCount: 0,
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
    expect(result).toMatchObject({
      disposition: "agent",
      sourceEventId: "stream:1",
      flowId: facts.flowId,
      heartbeatGateReason: "present",
    });
    expect(events[0]).toMatchObject({
      flowId: facts.flowId,
      correlationId: `${facts.source}:${facts.eventId}`,
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
      target: { platform: "slack", recipientId: "CMEGA" },
      content: { markdown: "agent chose **this**" },
      text: "agent chose this",
      flowId: "flow-agent-send-1",
      origin,
      correlationId: "decision:event-1",
      replyThreadId: "slack:CMEGA:1785950000.100",
    });

    expect(posted).toEqual([{ markdown: "agent chose **this**" }]);
    expect(calls).toContain("post:slack:CMEGA:1785950000.100");
    expect(calls.some((call) => call.startsWith("open:"))).toBe(false);
    expect(receipt).toMatchObject({ platform: "slack", platformMessageId: "171234.567" });
    expect(remembered).toEqual([receipt]);
    expect(events.map((event) => event.kind)).toEqual([
      "delivery.requested",
      "delivery.confirmed",
    ]);
    expect(calls).not.toContain("route:kind");
  });

  test("stamps Slack channel messages ambient, mentions addressed, and DMs addressed", async () => {
    const { events, eventLog } = eventLogHarness();
    const publisher = createStreamInboundPublisher({
      eventLog,
      machineId: "flagg",
      resolveFlowId: async () => undefined,
    });

    await publisher.publishEvent(slackMessage("C123", false));
    await publisher.publishEvent(slackMessage("C123", true));
    await publisher.publishEvent(slackMessage("D123", false));
    await publisher.publishEvent(inbound("message"));

    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ addressing: "ambient" }),
      expect.objectContaining({ addressing: "addressed" }),
      expect.objectContaining({ addressing: "addressed" }),
      expect.objectContaining({ addressing: "addressed" }),
    ]);
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
        payload: {
          addressing: "addressed",
          replyFlowId: "flow-agent-send-1",
        },
      });
    }
    expect(events[1]?.payload).toMatchObject({
      content: { text: "👍" },
    });
  });

  test("sends the first stale-heartbeat fallback summary immediately, then marks it once", async () => {
    const calls: string[] = [];
    const { events, eventLog } = eventLogHarness(calls);
    const posts: unknown[] = [];
    const clock = frozenClock();
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
      now: clock.now,
      wait: clock.wait,
      heartbeatTtlMs: 60_000,
      blipGraceMs: DEFAULT_HEARTBEAT_BLIP_GRACE_MS,
      gateState: createHeartbeatGateState(),
    })(facts);

    expect(result.disposition).toBe("fallback");
    expect(posts).toEqual([{
      raw: [
        `${FALLBACK_PREFIX} gateway unreachable — 1 message held`,
        "Sources: deploy-worker × 1",
        "Urgent/critical subjects:",
        "- deploy-worker: deploy failed",
      ].join("\n"),
    }]);
    expect(JSON.stringify(posts)).not.toContain("privateDiagnostic");
    expect(calls).toEqual([
      "append:message.requested",
      "telegram:send",
      "journal:confirmed",
      "append:fallback.delivered",
    ]);
    expect(clock.waits).toEqual([DEFAULT_HEARTBEAT_BLIP_GRACE_MS]);
    // Measured staleness = recheck gap floored by TTL when never seen present.
    expect(events.at(-1)).toMatchObject({
      kind: "fallback.delivered",
      flowId: facts.flowId,
      payload: {
        fallback: true,
        heldCount: 1,
        sourceCounts: { "deploy-worker": 1 },
        outcome: "confirmed",
        heartbeatStaleForMs: 60_000,
        heartbeatGateReason: "stale",
      },
    });
    expect(result).toMatchObject({
      disposition: "fallback",
      heartbeatStaleForMs: 60_000,
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
        wait: async () => {},
        blipGraceMs: 0,
        now: () => Date.parse("2026-07-21T18:12:00.000Z"),
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

  test("records measured heartbeat age from driver checkedAt on the agent path", async () => {
    const { eventLog } = eventLogHarness();
    const checkedAt = Date.parse("2026-07-21T18:11:50.000Z");
    const now = Date.parse("2026-07-21T18:12:00.000Z");
    const result = await makeSlimNotifyIngress({
      eventLog,
      probeHeartbeat: async () => ({ present: true, checkedAt }),
      fallbackChannel: "telegram",
      sendRawTelegramFallback: async () => {
        throw new Error("fresh heartbeat must not fallback");
      },
      now: () => now,
    })(facts);

    expect(result).toMatchObject({
      disposition: "agent",
      heartbeatStaleForMs: 10_000,
      heartbeatGateReason: "present",
    });
    expect(parseHeartbeatPayload(JSON.stringify({ checkedAt, state: "ready" }))).toEqual({
      present: true,
      checkedAt,
    });
  });

  test("a one-poll heartbeat blip does not fall back after recheck recovers", async () => {
    const calls: string[] = [];
    const { eventLog } = eventLogHarness(calls);
    const clock = frozenClock();
    let probes = 0;
    const result = await makeSlimNotifyIngress({
      eventLog,
      probeHeartbeat: async () => {
        probes += 1;
        calls.push(`probe:${probes}`);
        return probes === 1
          ? { present: false }
          : { present: true, checkedAt: clock.current - 1_000 };
      },
      fallbackChannel: "telegram",
      sendRawTelegramFallback: async () => {
        throw new Error("blip must not fallback");
      },
      now: clock.now,
      wait: clock.wait,
      blipGraceMs: DEFAULT_HEARTBEAT_BLIP_GRACE_MS,
      gateState: createHeartbeatGateState(),
    })(facts);

    expect(probes).toBe(2);
    expect(clock.waits).toEqual([DEFAULT_HEARTBEAT_BLIP_GRACE_MS]);
    expect(result).toMatchObject({
      disposition: "agent",
      heartbeatGateReason: "blip-recovered",
      heartbeatStaleForMs: 1_000,
    });
    expect(calls.filter((call) => call.startsWith("append:"))).toEqual([
      "append:message.requested",
    ]);
  });

  test("a real outage still falls back after the blip grace recheck", async () => {
    const posts: unknown[] = [];
    const { events, eventLog } = eventLogHarness();
    const clock = frozenClock();
    const gateState = createHeartbeatGateState();
    // Seed a recent present observation so measured staleness is wall-clock, not TTL floor.
    gateState.lastPresentAt = clock.current - 5_000;

    const result = await makeSlimNotifyIngress({
      eventLog,
      probeHeartbeat: async () => ({ present: false }),
      fallbackChannel: "telegram",
      sendRawTelegramFallback: async (input) => {
        posts.push(input);
        return {
          flowId: input.flowId,
          platform: "telegram",
          platformMessageId: "telegram:7718912466:15099",
          threadId: "telegram:7718912466",
        };
      },
      now: clock.now,
      wait: clock.wait,
      blipGraceMs: DEFAULT_HEARTBEAT_BLIP_GRACE_MS,
      heartbeatTtlMs: 60_000,
      gateState,
    })(facts);

    expect(result.disposition).toBe("fallback");
    expect(clock.waits).toEqual([DEFAULT_HEARTBEAT_BLIP_GRACE_MS]);
    const sent = posts[0] as { heartbeatStaleForMs: number; heartbeatGateReason: string };
    // firstAt + grace - lastPresentAt = 5s + 20s = 25s
    expect(sent.heartbeatStaleForMs).toBe(25_000);
    expect(sent.heartbeatGateReason).toBe("stale");
    expect(events.map((event) => event.kind)).toEqual(["message.requested"]);
    expect(result).toMatchObject({
      heartbeatStaleForMs: 25_000,
      heartbeatGateReason: "stale",
    });
  });

  test("summarizes fallback facts instead of dumping health markdown", async () => {
    const posts: unknown[] = [];
    const { eventLog } = eventLogHarness();
    const clock = frozenClock();
    const healthFacts: ProducerFacts = {
      ...facts,
      eventId: "health:1",
      source: "inngest/check-system-health",
      flowId: "health:1",
      origin: { ...origin, producer: "inngest/check-system-health" },
      text: [
        "## System Health",
        "",
        "NAS: ok",
        "Redis: ok",
        "Inngest: ok",
        "a".repeat(400),
      ].join("\n"),
      evidence: { sourceFunction: "system/check-system-health" },
    };

    expect(formatFallbackText(healthFacts)).toBe(
      [
        "gateway unreachable — 1 message held",
        "Sources: inngest/check-system-health × 1",
      ].join("\n"),
    );

    const result = await makeSlimNotifyIngress({
      eventLog,
      heartbeatExists: async () => false,
      fallbackChannel: "telegram",
      sendRawTelegramFallback: async (input) => {
        posts.push(input.text);
        return {
          flowId: input.flowId,
          platform: "telegram",
          platformMessageId: "telegram:7718912466:15100",
          threadId: "telegram:7718912466",
        };
      },
      now: clock.now,
      wait: clock.wait,
      blipGraceMs: 0,
      gateState: createHeartbeatGateState(),
    })(healthFacts);

    expect(result.disposition).toBe("fallback");
    expect(posts).toEqual([[
      "gateway unreachable — 1 message held",
      "Sources: inngest/check-system-health × 1",
    ].join("\n")]);
    expect(JSON.stringify(posts)).not.toContain("NAS: ok");
  });

  test("uses a rolling ten-minute window and writes receipts only after the summary sends", async () => {
    const posts: unknown[] = [];
    const { events, eventLog } = eventLogHarness();
    const clock = frozenClock();
    const scheduler = fallbackScheduleHarness();
    const gateState = createHeartbeatGateState();
    gateState.confirmedAbsentSince = clock.current - 30_000;
    const fallback = makeRawTelegramFallbackSender({
      adapter: {
        openDM: async () => "telegram:test",
        postMessage: async (_threadId, content) => {
          posts.push(content);
          return { id: `telegram:msg:${posts.length}`, threadId: "telegram:test" };
        },
      },
      recipientId: "test",
      journal: { record: async () => ({ persisted: true }) },
      eventLog,
    });

    const ingest = makeSlimNotifyIngress({
      eventLog,
      heartbeatExists: async () => false,
      fallbackChannel: "telegram",
      sendRawTelegramFallback: fallback,
      now: clock.now,
      wait: clock.wait,
      blipGraceMs: 0,
      coalesceWindowMs: DEFAULT_FALLBACK_COALESCE_MS,
      scheduleFallbackBatch: scheduler.schedule,
      gateState,
    });

    const first = await ingest({ ...facts, eventId: "fallback:a", flowId: "fallback:a" });
    const second = await ingest({ ...facts, eventId: "fallback:b", flowId: "fallback:b" });
    const third = await ingest({ ...facts, eventId: "fallback:c", flowId: "fallback:c" });

    expect(first.disposition).toBe("fallback");
    expect(second).toMatchObject({ disposition: "held", heldCount: 1 });
    expect(third).toMatchObject({ disposition: "held", heldCount: 2 });
    expect(posts).toHaveLength(1);
    expect(scheduler.scheduled).toHaveLength(2);
    expect(scheduler.scheduled[0]).toMatchObject({
      cancelled: true,
      delayMs: DEFAULT_FALLBACK_COALESCE_MS,
    });
    expect(events.filter((event) => event.kind === "fallback.delivered")).toHaveLength(1);

    await scheduler.flushLatest();

    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({
      raw: [
        `${FALLBACK_PREFIX} gateway unreachable — 2 messages held`,
        "Sources: deploy-worker × 2",
        "Urgent/critical subjects:",
        "- deploy-worker: deploy failed",
      ].join("\n"),
    });
    expect(events.filter((event) => event.kind === "fallback.delivered")).toHaveLength(3);
    expect(events.filter((event) => event.kind === "fallback.delivered").slice(1))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          flowId: "fallback:b",
          payload: expect.objectContaining({ outcome: "batch-confirmed", heldCount: 2 }),
        }),
        expect.objectContaining({
          flowId: "fallback:c",
          payload: expect.objectContaining({ outcome: "batch-confirmed", heldCount: 2 }),
        }),
      ]));
  });

  test("cancels a held batch on heartbeat recovery and leaves its input for the agent", async () => {
    const posts: unknown[] = [];
    const { events, eventLog } = eventLogHarness();
    const clock = frozenClock();
    const scheduler = fallbackScheduleHarness();
    const gateState = createHeartbeatGateState();
    gateState.confirmedAbsentSince = clock.current - 30_000;
    let heartbeatPresent = false;
    const fallback = makeRawTelegramFallbackSender({
      adapter: {
        openDM: async () => "telegram:test",
        postMessage: async (_threadId, content) => {
          posts.push(content);
          return { id: `telegram:recovery:${posts.length}`, threadId: "telegram:test" };
        },
      },
      recipientId: "test",
      journal: { record: async () => ({ persisted: true }) },
      eventLog,
    });
    const ingest = makeSlimNotifyIngress({
      eventLog,
      heartbeatExists: async () => heartbeatPresent,
      fallbackChannel: "telegram",
      sendRawTelegramFallback: fallback,
      now: clock.now,
      wait: clock.wait,
      blipGraceMs: 0,
      scheduleFallbackBatch: scheduler.schedule,
      gateState,
    });

    await ingest({ ...facts, eventId: "recovery:first", flowId: "recovery:first" });
    const held = await ingest({
      ...facts,
      eventId: "recovery:held",
      flowId: "recovery:held",
    });
    heartbeatPresent = true;
    await scheduler.flushLatest();

    expect(held.disposition).toBe("held");
    expect(posts).toHaveLength(1);
    expect(events.filter((event) => event.kind === "message.requested")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "fallback.delivered")).toHaveLength(1);
    expect(gateState.fallbackOutageActive).toBe(false);
  });

  test("redacts Front, email, and Slack bodies by source even when marked critical", async () => {
    const posts: unknown[] = [];
    const { events, eventLog } = eventLogHarness();
    const clock = frozenClock();
    const scheduler = fallbackScheduleHarness();
    const gateState = createHeartbeatGateState();
    gateState.confirmedAbsentSince = clock.current - 30_000;
    const fallback = makeRawTelegramFallbackSender({
      adapter: {
        openDM: async () => "telegram:test",
        postMessage: async (_threadId, content) => {
          posts.push(content);
          return { id: `telegram:redacted:${posts.length}`, threadId: "telegram:test" };
        },
      },
      recipientId: "test",
      journal: { record: async () => ({ persisted: true }) },
      eventLog,
    });
    const ingest = makeSlimNotifyIngress({
      eventLog,
      heartbeatExists: async () => false,
      fallbackChannel: "telegram",
      sendRawTelegramFallback: fallback,
      now: clock.now,
      wait: clock.wait,
      blipGraceMs: 0,
      scheduleFallbackBatch: scheduler.schedule,
      gateState,
    });
    const privateFacts = [
      {
        source: "inngest/front/message.received",
        text: "FRONT_PRIVATE_BODY",
      },
      {
        source: "inngest/check-email",
        text: "EMAIL_PRIVATE_BODY",
      },
      {
        source: "gateway.slack.chat-sdk.message",
        text: "SLACK_PRIVATE_BODY",
      },
    ] as const;

    for (const [index, item] of privateFacts.entries()) {
      await ingest({
        ...facts,
        eventId: `private:${index}`,
        flowId: `private:${index}`,
        source: item.source,
        origin: { ...origin, producer: item.source },
        text: item.text,
        evidence: { kind: "inbound-reply", priority: "critical" },
      });
    }
    await scheduler.flushLatest();

    const rendered = JSON.stringify(posts);
    expect(rendered).not.toContain("FRONT_PRIVATE_BODY");
    expect(rendered).not.toContain("EMAIL_PRIVATE_BODY");
    expect(rendered).not.toContain("SLACK_PRIVATE_BODY");
    expect(rendered).not.toContain("Urgent/critical subjects");
    expect(rendered).toContain("inngest/front/message.received");
    expect(rendered).toContain("inngest/check-email");
    expect(rendered).toContain("gateway.slack.chat-sdk.message");
    expect(events.filter((event) => event.kind === "fallback.delivered")).toHaveLength(3);
  });

  test("replays the 07-27 source mix as six summaries with zero private bodies", async () => {
    const posts: unknown[] = [];
    const { events, eventLog } = eventLogHarness();
    const clock = frozenClock();
    const scheduler = fallbackScheduleHarness();
    const gateState = createHeartbeatGateState();
    gateState.confirmedAbsentSince = clock.current - 30_000;
    const fallback = makeRawTelegramFallbackSender({
      adapter: {
        openDM: async () => "telegram:test",
        postMessage: async (_threadId, content) => {
          posts.push(content);
          return { id: `telegram:replay:${posts.length}`, threadId: "telegram:test" };
        },
      },
      recipientId: "test",
      journal: { record: async () => ({ persisted: true }) },
      eventLog,
    });
    const ingest = makeSlimNotifyIngress({
      eventLog,
      heartbeatExists: async () => false,
      fallbackChannel: "telegram",
      sendRawTelegramFallback: fallback,
      now: clock.now,
      wait: clock.wait,
      blipGraceMs: 0,
      scheduleFallbackBatch: scheduler.schedule,
      gateState,
    });
    const sourceMix = [
      ...Array.from({ length: 10 }, () => "inngest/check-system-health"),
      ...Array.from({ length: 7 }, () => "inngest/front/message.received"),
      ...Array.from({ length: 4 }, () => "campaign-pulse"),
      ...Array.from({ length: 4 }, () => "cli/notify"),
      ...Array.from({ length: 3 }, () => "inngest-function-health"),
      ...Array.from({ length: 2 }, () => "inngest/check-email"),
      "inngest/inngest/scheduled.timer",
      "typesense-recovery-startup-budget",
      "work-state-pass",
    ];
    expect(sourceMix).toHaveLength(33);

    for (const [index, source] of sourceMix.entries()) {
      const isPrivate = /front|email|slack/i.test(source);
      await ingest({
        ...facts,
        eventId: `replay:${index}`,
        flowId: `replay:${index}`,
        source,
        origin: { ...origin, producer: source },
        text: isPrivate ? `PRIVATE_BODY_${index}` : `subject ${index}`,
        evidence: {
          kind: isPrivate ? "inbound-reply" : "alert",
          priority: index % 5 === 0 ? "urgent" : "high",
        },
      });
      // Five rolling batches after the immediate outage notice.
      if ([6, 12, 18, 25, 32].includes(index)) await scheduler.flushLatest();
    }

    expect(posts).toHaveLength(6);
    expect(posts.every((post) =>
      JSON.stringify(post).includes("gateway unreachable —")
    )).toBe(true);
    const rendered = JSON.stringify(posts);
    expect(rendered).not.toContain("PRIVATE_BODY_");
    expect(rendered).toContain("subject 5");
    expect(rendered).not.toContain("subject 1");
    expect(events.filter((event) => event.kind === "fallback.delivered")).toHaveLength(33);
  });

});
