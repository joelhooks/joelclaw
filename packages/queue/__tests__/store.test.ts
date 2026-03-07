import { afterEach, describe, expect, test, vi } from "vitest";
import {
  drainByPriority,
  getQueueStats,
  init,
  inspectById,
  listMessages,
  Priority,
  persist,
  type StoredMessage,
} from "../src";
import { __queueTestUtils } from "../src/store";

const { toPriority, priorityName } = __queueTestUtils;

class MockRedis {
  private readonly streams = new Map<string, Map<string, [string, string[]]>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();
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
