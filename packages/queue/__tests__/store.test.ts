import { afterEach, describe, expect, test, vi } from "vitest"
import {
  drainByPriority,
  getDepth,
  init,
  inspectById,
  listMessages,
  loadEnvelope,
  Priority,
  persist,
  persistEnvelope,
  type QueueEventEnvelope,
  type StoredMessage,
} from "../src"
import { __queueTestUtils } from "../src/store"

const { toPriority, priorityName } = __queueTestUtils

class MockRedis {
  private readonly streams = new Map<string, Map<string, [string, string[]]>>()
  private readonly sortedSets = new Map<string, Map<string, number>>()
  private readonly pending = new Map<string, Set<string>>()
  private sequence = 0

  async xgroup(..._args: unknown[]): Promise<"OK"> {
    return "OK"
  }

  async xadd(streamKey: string, _id: string, ...fields: string[]): Promise<string> {
    const timestampIndex = fields.indexOf("timestamp")
    const timestamp = timestampIndex >= 0 ? fields[timestampIndex + 1] : `${Date.now()}`
    const id = `${timestamp ?? Date.now()}-${this.sequence++}`
    const stream = this.streams.get(streamKey) ?? new Map<string, [string, string[]]>()
    stream.set(id, [id, fields])
    this.streams.set(streamKey, stream)
    return id
  }

  async zadd(key: string, ...args: Array<string | number>): Promise<number> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>()
    const [first, second, third] = args
    const hasNx = first === "NX"
    const score = Number(hasNx ? second : first)
    const member = String(hasNx ? third : second)

    if (hasNx && bucket.has(member)) {
      this.sortedSets.set(key, bucket)
      return 0
    }

    const existed = bucket.has(member)
    bucket.set(member, score)
    this.sortedSets.set(key, bucket)
    return existed ? 0 : 1
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>()
    const ordered = [...bucket.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member)

    const end = stop < 0 ? ordered.length - 1 : stop
    return ordered.slice(start, end + 1)
  }

  async xrange(
    streamKey: string,
    start: string,
    end: string,
    ...args: Array<string | number>
  ): Promise<Array<[string, string[]]>> {
    const stream = this.streams.get(streamKey) ?? new Map<string, [string, string[]]>()
    const countIndex = args.findIndex((arg) => arg === "COUNT")
    const count = countIndex >= 0 ? Number(args[countIndex + 1]) : Number.POSITIVE_INFINITY

    return [...stream.values()]
      .filter(([id]) => (start === "-" || id >= start) && (end === "+" || id <= end))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, count)
  }

  async xack(streamKey: string, _group: string, ...ids: string[]): Promise<number> {
    const bucket = this.pending.get(streamKey) ?? new Set<string>()
    let removed = 0
    for (const id of ids) {
      if (bucket.delete(id)) removed += 1
    }
    this.pending.set(streamKey, bucket)
    return removed
  }

  async xdel(streamKey: string, ...ids: string[]): Promise<number> {
    const stream = this.streams.get(streamKey) ?? new Map<string, [string, string[]]>()
    let deleted = 0

    for (const id of ids) {
      if (stream.delete(id)) deleted += 1
    }

    this.streams.set(streamKey, stream)
    return deleted
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>()
    let removed = 0

    for (const member of members) {
      if (bucket.delete(member)) removed += 1
    }

    this.sortedSets.set(key, bucket)
    return removed
  }

  async xpending(streamKey: string, _group: string, ...args: unknown[]): Promise<unknown> {
    const bucket = this.pending.get(streamKey) ?? new Set<string>()

    if (args.length === 0) {
      return [bucket.size]
    }

    return [...bucket].map((id) => [id, "consumer", 0, 1])
  }

  async xclaim(..._args: unknown[]): Promise<[]> {
    return []
  }

  async xreadgroup(..._args: unknown[]): Promise<[]> {
    return []
  }

  async zcard(key: string): Promise<number> {
    const bucket = this.sortedSets.get(key) ?? new Map<string, number>()
    return bucket.size
  }

  markPending(streamKey: string, id: string): void {
    const bucket = this.pending.get(streamKey) ?? new Set<string>()
    bucket.add(id)
    this.pending.set(streamKey, bucket)
  }
}

const queueConfig = {
  streamKey: "test:queue:messages",
  priorityKey: "test:queue:priority",
  consumerGroup: "test-group",
  consumerName: "test-consumer",
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Priority enum", () => {
  test("maps to numeric ladder", () => {
    expect(Priority.P0).toBe(0)
    expect(Priority.P1).toBe(1)
    expect(Priority.P2).toBe(2)
    expect(Priority.P3).toBe(3)
  })
})

describe("Priority conversion utilities", () => {
  test("converts numbers to Priority", () => {
    expect(toPriority(-1)).toBe(Priority.P0)
    expect(toPriority(0)).toBe(Priority.P0)
    expect(toPriority(1)).toBe(Priority.P1)
    expect(toPriority(2)).toBe(Priority.P2)
    expect(toPriority(3)).toBe(Priority.P3)
    expect(toPriority(99)).toBe(Priority.P3)
  })

  test("converts Priority to name", () => {
    expect(priorityName(Priority.P0)).toBe("P0")
    expect(priorityName(Priority.P1)).toBe("P1")
    expect(priorityName(Priority.P2)).toBe("P2")
    expect(priorityName(Priority.P3)).toBe("P3")
  })
})

describe("StoredMessage type shape", () => {
  test("has required properties", () => {
    const sample: StoredMessage = {
      id: "1749990000000-0",
      payload: { message: "hello" },
      metadata: { event: "test.event" },
      timestamp: 1_749_990_000_000,
      priority: Priority.P1,
      acked: false,
    }

    expect(sample).toMatchObject({
      id: expect.any(String),
      payload: expect.any(Object),
      timestamp: expect.any(Number),
      priority: Priority.P1,
      acked: false,
    })
  })
})

describe("persistEnvelope/loadEnvelope", () => {
  test("round-trips a canonical queue envelope", async () => {
    const redis = new MockRedis()
    await init(redis as never, queueConfig)

    const envelope: QueueEventEnvelope<{ url: string }> = {
      id: "01KTESTENVELOPE",
      event: "discovery/noted",
      source: "cli",
      ts: 1_750_000_000_000,
      data: { url: "https://example.com" },
      priority: Priority.P2,
      dedupKey: "example.com",
      trace: {
        correlationId: "corr-1",
        causationId: "cause-1",
      },
      meta: {
        actor: "CyanDune",
      },
    }

    const persisted = await persistEnvelope(envelope)
    const loaded = await loadEnvelope<{ url: string }>(persisted.streamId)

    expect(loaded).toEqual(envelope)
  })
})

describe("drainByPriority", () => {
  test("orders aged candidates by effective priority and age, not raw zset order", async () => {
    const redis = new MockRedis()
    await init(redis as never, queueConfig)

    const nowSpy = vi.spyOn(Date, "now")

    nowSpy.mockReturnValue(1_000_000)
    const promotedP2 = await persist({
      payload: { label: "old-p2" },
      priority: Priority.P2,
    })

    nowSpy.mockReturnValue(1_000_001)
    const freshP1 = await persist({
      payload: { label: "new-p1" },
      priority: Priority.P1,
    })

    nowSpy.mockReturnValue(1_060_000)

    expect(promotedP2).not.toBeNull()
    expect(freshP1).not.toBeNull()
    if (!promotedP2 || !freshP1) {
      throw new Error("queue persist unexpectedly returned null")
    }

    const drained = await drainByPriority({
      limit: 2,
      agingPromotionMs: 10_000,
    })

    expect(drained.map((candidate) => candidate.message.id)).toEqual([
      promotedP2.streamId,
      freshP1.streamId,
    ])
    expect(drained[0]).toMatchObject({
      effectivePriority: Priority.P1,
      promotedFrom: Priority.P2,
    })
    expect(drained[1]).toMatchObject({
      effectivePriority: Priority.P1,
    })
  })
})

describe("getDepth", () => {
  test("returns ready/pending depth stats with breakdown by priority", async () => {
    const redis = new MockRedis()
    await init(redis as never, queueConfig)

    const p0 = await persist({ payload: { label: "p0-msg" }, priority: Priority.P0 })
    await persist({ payload: { label: "p1-msg" }, priority: Priority.P1 })
    await persist({ payload: { label: "p2-msg-1" }, priority: Priority.P2 })
    await persist({ payload: { label: "p2-msg-2" }, priority: Priority.P2 })
    const p3 = await persist({ payload: { label: "p3-msg" }, priority: Priority.P3 })

    if (!p0 || !p3) throw new Error("persist unexpectedly returned null")
    redis.markPending(queueConfig.streamKey, p3.streamId)

    const depth = await getDepth()

    expect(depth.total).toBe(5)
    expect(depth.ready).toBe(4)
    expect(depth.pending).toBe(1)
    expect(depth.byPriority.P0).toBe(1)
    expect(depth.byPriority.P1).toBe(1)
    expect(depth.byPriority.P2).toBe(2)
    expect(depth.byPriority.P3).toBe(1)
    expect(depth.oldest).toBeDefined()
    expect(depth.oldest?.id).toBe(p0.streamId)
    expect(depth.oldest?.priority).toBe(Priority.P0)
  })
})

describe("inspectById", () => {
  test("returns envelope and queue state hints", async () => {
    const redis = new MockRedis()
    await init(redis as never, queueConfig)

    const persisted = await persistEnvelope({
      id: "01KTESTINSPECT",
      event: "content/updated",
      source: "cli",
      ts: 1_750_000_100_000,
      data: { slug: "hello-world" },
      priority: Priority.P1,
      trace: { correlationId: "corr-2" },
    })

    redis.markPending(queueConfig.streamKey, persisted.streamId)

    const record = await inspectById<{ slug: string }>(persisted.streamId)

    expect(record).toBeDefined()
    expect(record?.state).toBe("leased")
    expect(record?.stored.id).toBe(persisted.streamId)
    expect(record?.envelope?.event).toBe("content/updated")
    expect(record?.envelope?.trace?.correlationId).toBe("corr-2")
  })
})

describe("listMessages", () => {
  test("lists messages in priority order", async () => {
    const redis = new MockRedis()
    await init(redis as never, queueConfig)

    await persist({ payload: { label: "p3-msg" }, priority: Priority.P3 })
    await persist({ payload: { label: "p1-msg" }, priority: Priority.P1 })
    await persist({ payload: { label: "p2-msg" }, priority: Priority.P2 })
    await persist({ payload: { label: "p0-msg" }, priority: Priority.P0 })

    const messages = await listMessages(10)

    expect(messages).toHaveLength(4)
    expect(messages[0]?.priority).toBe(Priority.P0)
    expect(messages[1]?.priority).toBe(Priority.P1)
    expect(messages[2]?.priority).toBe(Priority.P2)
    expect(messages[3]?.priority).toBe(Priority.P3)
  })
})
