import { afterEach, describe, expect, test, vi } from "vitest";
import {
  drainByPriority,
  expireQueueFamilyPauses,
  getQueueStats,
  init,
  inspectById,
  listActiveQueueFamilyPauses,
  listMessages,
  Priority,
  pauseQueueFamily,
  persist,
  type QueueEventEnvelope,
  type QueueTriageDecision,
  resumeQueueFamily,
  type StoredMessage,
} from "../src";
import { __queueTestUtils } from "../src/store";

const { toPriority, priorityName } = __queueTestUtils;

class MockRedis {
  private readonly streams = new Map<string, Map<string, [string, string[]]>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private sequence = 0;

  async xgroup(..._args: unknown[]): Promise<"OK"> {
    return "OK";
  }

  async xadd(streamKey: string, _id: string, ...fields: string[]): Promise<string> {
    const timestampIndex = fields.indexOf("timestamp");
    const timestamp = timestampIndex >= 0 ? fields[timestampIndex + 1] : `${Date.now()}`;
    const id = `${timestamp ?? Date.now()}-${this.sequence++}`;
    const stream = this.streams.get(streamKey) ?? new Map<string, [string, string[]]>();
    stream.set(id, [id, fields]);
    this.streams.set(streamKey, stream);
    return id;
  }

  async zadd(key: string, ...args: Array<string | number>): Promise<number> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>();
    const [first, second, third] = args;
    const hasNx = first === "NX";
    const score = Number(hasNx ? second : first);
    const member = String(hasNx ? third : second);

    if (hasNx && bucket.has(member)) {
      this.sortedSets.set(key, bucket);
      return 0;
    }

    const existed = bucket.has(member);
    bucket.set(member, score);
    this.sortedSets.set(key, bucket);
    return existed ? 0 : 1;
  }

  async zcard(key: string): Promise<number> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>();
    return bucket.size;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const bucket = this.hashes.get(key) ?? new Map<string, string>();
    const existed = bucket.has(field);
    bucket.set(field, value);
    this.hashes.set(key, bucket);
    return existed ? 0 : 1;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const bucket = this.hashes.get(key) ?? new Map<string, string>();
    return bucket.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const bucket = this.hashes.get(key) ?? new Map<string, string>();
    return Object.fromEntries(bucket.entries());
  }

  async hdel(key: string, field: string): Promise<number> {
    const bucket = this.hashes.get(key) ?? new Map<string, string>();
    const removed = bucket.delete(field);
    this.hashes.set(key, bucket);
    return removed ? 1 : 0;
  }

  async zrange(key: string, start: number, stop: number, ...args: Array<string>): Promise<string[]> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>();
    const ordered = [...bucket.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

    const end = stop < 0 ? ordered.length + stop : stop;
    const slice = ordered.slice(start, end + 1);

    const withScores = args.includes("WITHSCORES");
    if (withScores) {
      return slice.flatMap(([member, score]) => [member, String(score)]);
    }

    return slice.map(([member]) => member);
  }

  async xrange(
    streamKey: string,
    start: string,
    end: string,
    ...args: Array<string | number>
  ): Promise<Array<[string, string[]]>> {
    const stream = this.streams.get(streamKey) ?? new Map<string, [string, string[]]>();
    const countIndex = args.findIndex((arg) => arg === "COUNT");
    const count = countIndex >= 0 ? Number(args[countIndex + 1]) : Number.POSITIVE_INFINITY;

    return [...stream.values()]
      .filter(([id]) => (start === "-" || id >= start) && (end === "+" || id <= end))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, count);
  }

  async xack(..._args: unknown[]): Promise<number> {
    return 1;
  }

  async xdel(streamKey: string, ...ids: string[]): Promise<number> {
    const stream = this.streams.get(streamKey) ?? new Map<string, [string, string[]]>();
    let deleted = 0;

    for (const id of ids) {
      if (stream.delete(id)) deleted += 1;
    }

    this.streams.set(streamKey, stream);
    return deleted;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>();
    let removed = 0;

    for (const member of members) {
      if (bucket.delete(member)) removed += 1;
    }

    this.sortedSets.set(key, bucket);
    return removed;
  }

  async zrangebyscore(key: string, min: string, max: string): Promise<string[]> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>();
    const minValue = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
    const maxValue = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);

    return [...bucket.entries()]
      .filter(([, score]) => score >= minValue && score <= maxValue)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
  }

  async xpending(..._args: unknown[]): Promise<[number]> {
    return [0];
  }

  async xclaim(..._args: unknown[]): Promise<[]> {
    return [];
  }

  async xreadgroup(..._args: unknown[]): Promise<[]> {
    return [];
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Priority enum", () => {
  test("maps to numeric ladder", () => {
    expect(Priority.P0).toBe(0);
    expect(Priority.P1).toBe(1);
    expect(Priority.P2).toBe(2);
    expect(Priority.P3).toBe(3);
  });
});

describe("Priority conversion utilities", () => {
  test("converts numbers to Priority", () => {
    expect(toPriority(-1)).toBe(Priority.P0);
    expect(toPriority(0)).toBe(Priority.P0);
    expect(toPriority(1)).toBe(Priority.P1);
    expect(toPriority(2)).toBe(Priority.P2);
    expect(toPriority(3)).toBe(Priority.P3);
    expect(toPriority(99)).toBe(Priority.P3);
  });

  test("converts Priority to name", () => {
    expect(priorityName(Priority.P0)).toBe("P0");
    expect(priorityName(Priority.P1)).toBe("P1");
    expect(priorityName(Priority.P2)).toBe("P2");
    expect(priorityName(Priority.P3)).toBe("P3");
  });
});

describe("StoredMessage type shape", () => {
  test("has required properties", () => {
    const sample: StoredMessage = {
      id: "1749990000000-0",
      payload: { message: "hello" },
      metadata: { event: "test.event" },
      timestamp: 1_749_990_000_000,
      priority: Priority.P1,
      acked: false,
    };

    expect(sample).toMatchObject({
      id: expect.any(String),
      payload: expect.any(Object),
      timestamp: expect.any(Number),
      priority: Priority.P1,
      acked: false,
    });
  });

  test("accepts optional metadata", () => {
    const sample: StoredMessage = {
      id: "1749990000000-0",
      payload: { message: "hello" },
      timestamp: 1_749_990_000_000,
      priority: Priority.P1,
      acked: false,
    };

    expect(sample.metadata).toBeUndefined();
  });

  test("queue envelope can carry bounded triage metadata without changing core payload shape", () => {
    const triage: QueueTriageDecision = {
      mode: "shadow",
      family: "discovery/noted",
      suggested: {
        priority: "P1",
        dedupKey: "discovery:https://example.com",
        routeCheck: "confirm",
      },
      final: {
        priority: "P2",
        dedupKey: undefined,
        routeCheck: "confirm",
      },
      applied: false,
      latencyMs: 123,
    };

    const envelope: QueueEventEnvelope = {
      id: "evt-queue-envelope",
      name: "discovery/noted",
      source: "test",
      ts: 1_749_990_000_000,
      data: { url: "https://example.com" },
      priority: Priority.P2,
      trace: {
        correlationId: "corr-queue-envelope",
        causationId: "cause-queue-envelope",
      },
      triage,
    };

    expect(envelope.trace?.correlationId).toBe("corr-queue-envelope");
    expect(envelope.triage?.family).toBe("discovery/noted");
    expect(envelope.data).toMatchObject({ url: "https://example.com" });
  });
});

describe("drainByPriority", () => {
  test("orders aged candidates by effective priority and age, not raw zset order", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(1_000_000);
    const promotedP2 = await persist({
      payload: { label: "old-p2" },
      priority: Priority.P2,
    });

    nowSpy.mockReturnValue(1_000_001);
    const freshP1 = await persist({
      payload: { label: "new-p1" },
      priority: Priority.P1,
    });

    nowSpy.mockReturnValue(1_060_000);

    expect(promotedP2).not.toBeNull();
    expect(freshP1).not.toBeNull();
    if (!promotedP2 || !freshP1) {
      throw new Error("queue persist unexpectedly returned null");
    }

    const drained = await drainByPriority({
      limit: 2,
      agingPromotionMs: 10_000,
    });

    expect(drained.map((candidate) => candidate.message.id)).toEqual([
      promotedP2.streamId,
      freshP1.streamId,
    ]);
    expect(drained[0]).toMatchObject({
      effectivePriority: Priority.P1,
      promotedFrom: Priority.P2,
    });
    expect(drained[1]).toMatchObject({
      effectivePriority: Priority.P1,
    });
  });

  test("applies a deterministic filter after ordering so paused families defer without losing lower-priority work", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(2_000_000);
    const paused = await persist({
      payload: { name: "content/updated", label: "paused" },
      priority: Priority.P0,
    });
    nowSpy.mockReturnValue(2_000_001);
    const ready = await persist({
      payload: { name: "discovery/noted", label: "ready" },
      priority: Priority.P1,
    });

    expect(paused).not.toBeNull();
    expect(ready).not.toBeNull();
    if (!paused || !ready) throw new Error("queue persist unexpectedly returned null");

    const drained = await drainByPriority({
      limit: 1,
      filter: (candidate) => candidate.message.payload.name !== "content/updated",
    });

    expect(drained).toHaveLength(1);
    expect(drained[0]?.message.id).toBe(ready.streamId);
  });
});

describe("queue control state", () => {
  test("stores active family pauses with TTL metadata and clears them on resume", async () => {
    const redis = new MockRedis();

    const pause = await pauseQueueFamily(redis as never, {
      family: "content/updated",
      ttlMs: 300_000,
      reason: "Pause content during supervised drain testing.",
      actor: "queue-control-test",
      now: 1_000,
    });

    expect(pause).toMatchObject({
      family: "content/updated",
      ttlMs: 300_000,
      mode: "manual",
      source: "manual",
      actor: "queue-control-test",
    });

    const active = await listActiveQueueFamilyPauses(redis as never, { now: 2_000 });
    expect(active).toEqual([pause]);

    const resumed = await resumeQueueFamily(redis as never, { family: "content/updated" });
    expect(resumed).toEqual({ removed: true, pause });
    expect(await listActiveQueueFamilyPauses(redis as never, { now: 2_000 })).toEqual([]);
  });

  test("expires pause state deterministically once TTL passes", async () => {
    const redis = new MockRedis();

    await pauseQueueFamily(redis as never, {
      family: "content/updated",
      ttlMs: 60_000,
      reason: "Short TTL proof.",
      now: 10_000,
    });

    expect(await listActiveQueueFamilyPauses(redis as never, { now: 69_999 })).toHaveLength(1);

    const expired = await expireQueueFamilyPauses(redis as never, { now: 70_000 });
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      family: "content/updated",
      expiredAtMs: 70_000,
    });
    expect(await listActiveQueueFamilyPauses(redis as never, { now: 70_001 })).toEqual([]);
  });
});

describe("getQueueStats", () => {
  test("returns queue depth and priority distribution", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    await persist({ payload: { id: 1 }, priority: Priority.P0 });
    await persist({ payload: { id: 2 }, priority: Priority.P1 });
    await persist({ payload: { id: 3 }, priority: Priority.P1 });
    await persist({ payload: { id: 4 }, priority: Priority.P2 });
    await persist({ payload: { id: 5 }, priority: Priority.P3 });

    const stats = await getQueueStats();

    expect(stats.total).toBe(5);
    expect(stats.byPriority.P0).toBe(1);
    expect(stats.byPriority.P1).toBe(2);
    expect(stats.byPriority.P2).toBe(1);
    expect(stats.byPriority.P3).toBe(1);
    expect(stats.oldestTimestamp).toBe(1_000_000);
    expect(stats.newestTimestamp).toBe(1_000_000);
  });

  test("handles empty queue", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const stats = await getQueueStats();

    expect(stats.total).toBe(0);
    expect(stats.byPriority.P0).toBe(0);
    expect(stats.byPriority.P1).toBe(0);
    expect(stats.byPriority.P2).toBe(0);
    expect(stats.byPriority.P3).toBe(0);
    expect(stats.oldestTimestamp).toBeNull();
    expect(stats.newestTimestamp).toBeNull();
  });

  test("derives priority and timestamps from stored messages when epoch millis exceed the score factor", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_772_939_336_503);

    await persist({ payload: { id: 1 }, priority: Priority.P1 });
    nowSpy.mockReturnValue(1_772_939_336_663);
    await persist({ payload: { id: 2 }, priority: Priority.P1 });
    nowSpy.mockReturnValue(1_772_939_336_828);
    await persist({ payload: { id: 3 }, priority: Priority.P1 });

    const stats = await getQueueStats();

    expect(stats.total).toBe(3);
    expect(stats.byPriority).toEqual({ P0: 0, P1: 3, P2: 0, P3: 0 });
    expect(stats.oldestTimestamp).toBe(1_772_939_336_503);
    expect(stats.newestTimestamp).toBe(1_772_939_336_828);
  });
});

describe("inspectById", () => {
  test("loads message by stream ID", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const result = await persist({
      payload: { message: "test" },
      priority: Priority.P1,
      metadata: { source: "test" },
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("persist returned null");

    const message = await inspectById(result.streamId);

    expect(message).toBeDefined();
    expect(message?.id).toBe(result.streamId);
    expect(message?.payload.message).toBe("test");
    expect(message?.priority).toBe(Priority.P1);
    expect(message?.metadata?.source).toBe("test");
  });

  test("returns undefined for nonexistent ID", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const message = await inspectById("9999999999999-0");

    expect(message).toBeUndefined();
  });
});

describe("listMessages", () => {
  test("lists messages in priority order", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    const p2Result = await persist({ payload: { priority: "P2" }, priority: Priority.P2 });
    const p0Result = await persist({ payload: { priority: "P0" }, priority: Priority.P0 });
    const p1Result = await persist({ payload: { priority: "P1" }, priority: Priority.P1 });

    expect(p2Result).not.toBeNull();
    expect(p0Result).not.toBeNull();
    expect(p1Result).not.toBeNull();

    const messages = await listMessages(10);

    expect(messages.length).toBe(3);
    expect(messages[0]?.priority).toBe(Priority.P0);
    expect(messages[1]?.priority).toBe(Priority.P1);
    expect(messages[2]?.priority).toBe(Priority.P2);
  });

  test("respects limit", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    await persist({ payload: { id: 1 }, priority: Priority.P1 });
    await persist({ payload: { id: 2 }, priority: Priority.P1 });
    await persist({ payload: { id: 3 }, priority: Priority.P1 });

    const messages = await listMessages(2);

    expect(messages.length).toBe(2);
  });

  test("returns empty array for empty queue", async () => {
    const redis = new MockRedis();

    await init(redis as never, {
      streamKey: "test:queue:messages",
      priorityKey: "test:queue:priority",
      consumerGroup: "test-group",
      consumerName: "test-consumer",
    });

    const messages = await listMessages(10);

    expect(messages.length).toBe(0);
  });
});
