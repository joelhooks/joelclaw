import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeInboundEvent,
  type FlowIdType,
  type InboundEvent,
} from "@joelclaw/message-contract";
import { init as initMessageStore } from "@joelclaw/message-store";
import type Redis from "ioredis";
import {
  __commandQueueTestUtils,
  enqueue,
  replayUnacked,
  setIdleWaiter,
  setSession,
} from "../command-queue";
import { createActingInboundDispatcher } from "./acting";
import { createObserveOnlyInboundPublisher } from "./publish";

class MockRedis {
  private readonly streams = new Map<string, Map<string, [string, string[]]>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();
  private readonly strings = new Map<string, string>();
  private readonly delivered = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly persistedPriorities: string[] = [];
  private sequence = 0;

  async xgroup(): Promise<"OK"> {
    return "OK";
  }

  async set(key: string, value: string, ...args: string[]): Promise<"OK" | null> {
    if (args.includes("NX") && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    const existed = this.strings.delete(key);
    return existed ? 1 : 0;
  }

  async xadd(streamKey: string, _id: string, ...fields: string[]): Promise<string> {
    const timestampIndex = fields.indexOf("timestamp");
    const timestamp = fields[timestampIndex + 1] ?? `${Date.now()}`;
    const id = `${timestamp}-${this.sequence++}`;
    const stream = this.streams.get(streamKey) ?? new Map();
    stream.set(id, [id, fields]);
    const priorityIndex = fields.indexOf("priority");
    this.persistedPriorities.push(fields[priorityIndex + 1] ?? "");
    this.streams.set(streamKey, stream);
    return id;
  }

  async zadd(key: string, ...args: Array<string | number>): Promise<number> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>();
    const hasNx = args[0] === "NX";
    const score = Number(hasNx ? args[1] : args[0]);
    const member = String(hasNx ? args[2] : args[1]);
    if (hasNx && bucket.has(member)) return 0;
    const existed = bucket.has(member);
    bucket.set(member, score);
    this.sortedSets.set(key, bucket);
    return existed ? 0 : 1;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const ordered = [...(this.sortedSets.get(key) ?? new Map()).entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
    const end = stop < 0 ? ordered.length + stop : stop;
    return ordered.slice(start, end + 1).map(([member]) => member);
  }

  async xrange(
    streamKey: string,
    start: string,
    end: string,
    ...args: Array<string | number>
  ): Promise<Array<[string, string[]]>> {
    const countIndex = args.indexOf("COUNT");
    const count = countIndex >= 0 ? Number(args[countIndex + 1]) : Number.POSITIVE_INFINITY;
    return [...(this.streams.get(streamKey) ?? new Map()).values()]
      .filter(([id]) => (start === "-" || id >= start) && (end === "+" || id <= end))
      .sort((left, right) => left[0].localeCompare(right[0]))
      .slice(0, count);
  }

  async xpending(
    _streamKey: string,
    _group: string,
    ...args: Array<string | number>
  ): Promise<[number] | Array<[string, string, number, number]>> {
    if (args.length === 0) return [this.pending.size];
    return [...this.pending].map(
      (id): [string, string, number, number] => [id, "daemon", 0, 1],
    );
  }

  async xclaim(
    streamKey: string,
    _group: string,
    _consumer: string,
    _idle: number,
    ...ids: string[]
  ): Promise<Array<[string, string[]]>> {
    const stream = this.streams.get(streamKey) ?? new Map();
    return ids.flatMap((id) => {
      const entry = stream.get(id);
      return entry ? [entry] : [];
    });
  }

  async xreadgroup(...args: Array<string | number>): Promise<unknown[]> {
    const streamsIndex = args.indexOf("STREAMS");
    const streamKey = String(args[streamsIndex + 1]);
    const stream = this.streams.get(streamKey) ?? new Map();
    const entries = [...stream.values()].filter(([id]) => !this.delivered.has(id));
    for (const [id] of entries) {
      this.delivered.add(id);
      this.pending.add(id);
    }
    return entries.length > 0 ? [[streamKey, entries]] : [];
  }

  async xack(_streamKey: string, _group: string, ...ids: string[]): Promise<number> {
    for (const id of ids) this.pending.delete(id);
    return ids.length;
  }

  async xdel(streamKey: string, ...ids: string[]): Promise<number> {
    const stream = this.streams.get(streamKey) ?? new Map();
    let deleted = 0;
    for (const id of ids) {
      if (stream.delete(id)) deleted += 1;
      this.pending.delete(id);
      this.delivered.delete(id);
    }
    return deleted;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const bucket = this.sortedSets.get(key) ?? new Map();
    let removed = 0;
    for (const member of members) {
      if (bucket.delete(member)) removed += 1;
    }
    return removed;
  }

  priorities(): string[] {
    return [...this.persistedPriorities];
  }
}

function message(index: number, actorId = "7718912466"): InboundEvent {
  const accepted = actorId === "7718912466";
  return decodeInboundEvent({
    contractVersion: 2,
    eventId: `telegram:message:burst-${index}-${actorId}`,
    type: "message",
    platform: "telegram",
    occurredAt: `2026-07-16T21:30:0${index}.000Z`,
    observedAt: `2026-07-16T21:30:0${index}.100Z`,
    shadow: true,
    actor: {
      platformUserId: actorId,
      userName: accepted ? "joel" : "other",
      displayName: accepted ? "Joel" : "Other",
      isBot: false,
      isSelf: false,
    },
    platformIds: {
      conversationId: "7718912466",
      messageId: String(15_000 + index),
      threadId: "telegram:7718912466",
      actorId,
      workspaceId: null,
    },
    rawAnchors: {
      transportEventId: String(20_000 + index),
      updateId: String(20_000 + index),
      callbackQueryId: null,
      sourceMessageId: String(15_000 + index),
      sourceThreadId: null,
    },
    audit: {
      source: "gateway.telegram.message",
      transport: "polling",
      sdkName: "vercel/chat",
      sdkVersion: "4.34.0",
      normalizedAt: `2026-07-16T21:30:0${index}.100Z`,
      rawEventType: "message",
      rawEventId: String(20_000 + index),
      lineageId: `lineage-${index}-${actorId}`,
    },
    authorization: accepted
      ? {
          verdict: "accepted",
          reason: "authorized_joel",
          policyAction: "invoke",
          expectedActorId: "7718912466",
          actualActorId: actorId,
          canPublish: true,
          canExecute: false,
        }
      : {
          verdict: "rejected",
          reason: "non_joel_actor",
          policyAction: "reject",
          expectedActorId: "7718912466",
          actualActorId: actorId,
          canPublish: true,
          canExecute: false,
        },
    text: `burst-${index}`,
    isMention: false,
    attachmentCount: 0,
  });
}

function dispatcher(enqueueBoundary: typeof enqueue) {
  return createActingInboundDispatcher({
    env: { CHAT_SDK_ACTING_ENABLED: "1" },
    enqueue: async (source, prompt, metadata) => {
      await enqueueBoundary(source, prompt, {
        ...metadata,
        gatewayHumanLatestWins: true,
        gatewaySupersessionKey: source,
        gatewayBatchKey: source,
        gatewayBatchWindowMs: 15,
      });
    },
    publisher: createObserveOnlyInboundPublisher({ send: async () => {} }),
    resolveFlowId: async () => undefined,
    publishReaction: async () => {},
  });
}

afterEach(() => {
  __commandQueueTestUtils.resetState();
});

describe("Chat SDK cutover end-to-end harness", () => {
  test("five rapid inbound messages keep real command-queue batching, priority, and single execution", async () => {
    const redis = new MockRedis();
    await initMessageStore(redis as unknown as Redis);
    const prompts: string[] = [];
    setSession({
      prompt: async (prompt) => {
        prompts.push(prompt);
      },
      reload: async () => {},
      compact: async () => {},
      newSession: async () => {},
    });
    setIdleWaiter(async () => {});
    const dispatch = dispatcher(enqueue);

    for (let index = 0; index < 5; index += 1) {
      await dispatch(message(index));
    }
    await dispatch(message(0));
    await dispatch(message(5, "someone-else"));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(prompts).toHaveLength(1);
    for (let index = 0; index < 5; index += 1) {
      expect(prompts[0]).toContain(`burst-${index}`);
    }
    expect(prompts[0]).not.toContain("burst-5");
    expect(redis.priorities()).toEqual(["1"]); // One durable P1 Telegram batch, not five hidden SDK queue items.
  });

  test("replays one acting event after process death and durably rejects its transport retry", async () => {
    const redis = new MockRedis();
    await initMessageStore(redis as unknown as Redis);
    const event = message(9);
    const makeCrashDispatcher = () =>
      createActingInboundDispatcher({
        env: { CHAT_SDK_ACTING_ENABLED: "1" },
        enqueue: async (source, prompt, metadata) => {
          await enqueue(source, prompt, {
            ...metadata,
            gatewayHumanLatestWins: true,
            gatewaySupersessionKey: source,
          });
        },
        publisher: createObserveOnlyInboundPublisher({ send: async () => {} }),
        resolveFlowId: async () => undefined,
        publishReaction: async () => {},
      });

    await makeCrashDispatcher()(event);
    expect(redis.priorities()).toEqual(["1"]);

    // A new dispatcher models a replacement process receiving the transport
    // retry. The 24h Chat SDK event-ID claim prevents a second durable item.
    __commandQueueTestUtils.resetState();
    await makeCrashDispatcher()(event);
    expect(redis.priorities()).toEqual(["1"]);

    __commandQueueTestUtils.resetState();
    const prompts: string[] = [];
    setSession({
      prompt: async (prompt) => {
        prompts.push(prompt);
      },
      reload: async () => {},
      compact: async () => {},
      newSession: async () => {},
    });
    setIdleWaiter(async () => {});

    await replayUnacked();

    expect(prompts).toEqual(["burst-9"]);
    expect(redis.priorities()).toEqual(["1"]);
  });
});
