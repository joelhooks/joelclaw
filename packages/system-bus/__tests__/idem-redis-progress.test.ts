/**
 * IDEM-6: Progress tracking via Redis
 *
 * Tests the behavioral contract: appendProgress, readProgress, writeRecommendations,
 * readRecommendations, writePatterns, readPatterns all use Redis as backing store.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import {
  appendProgress,
  readProgress,
  writeRecommendations,
  readRecommendations,
  writePatterns,
  readPatterns,
} from "../src/inngest/functions/agent-loop/utils";

// ── Scoped Redis mock ──────────────────────────────────────────────────

type RedisValue = { value: string; expiresAtMs: number | null };
const store = new Map<string, RedisValue>();
const lists = new Map<string, string[]>();

const originals = {
  set: Redis.prototype.set,
  get: Redis.prototype.get,
  del: Redis.prototype.del,
  rpush: Redis.prototype.rpush,
  lrange: Redis.prototype.lrange,
};

beforeAll(() => {
  (Redis.prototype as any).set = async function (key: string, value: string) {
    store.set(key, { value: String(value), expiresAtMs: null });
    return "OK";
  };
  (Redis.prototype as any).get = async function (key: string) {
    const entry = store.get(key);
    return entry ? entry.value : null;
  };
  (Redis.prototype as any).del = async function (...keys: string[]) {
    let d = 0;
    for (const k of keys) { if (store.delete(k)) d++; }
    return d;
  };
  (Redis.prototype as any).rpush = async function (key: string, ...values: string[]) {
    const list = lists.get(key) ?? [];
    list.push(...values);
    lists.set(key, list);
    return list.length;
  };
  (Redis.prototype as any).lrange = async function (key: string, start: number, stop: number) {
    const list = lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  };
});

afterAll(() => {
  Object.assign(Redis.prototype, originals);
});

beforeEach(() => {
  store.clear();
  lists.clear();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("IDEM-6: appendProgress / readProgress", () => {
  test("appends entries to a Redis list keyed by loopId", async () => {
    await appendProgress("loop-1", "Story X passed");
    await appendProgress("loop-1", "Story Y failed");

    const entries = await readProgress("loop-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("Story X passed");
    expect(entries[1]).toContain("Story Y failed");
  });

  test("entries include ISO timestamp", async () => {
    await appendProgress("loop-ts", "test entry");
    const entries = await readProgress("loop-ts");
    // Format: ### 2026-02-15T...
    expect(entries[0]).toMatch(/^### \d{4}-\d{2}-\d{2}T/);
  });

  test("different loopIds are isolated", async () => {
    await appendProgress("loop-a", "entry a");
    await appendProgress("loop-b", "entry b");

    expect(await readProgress("loop-a")).toHaveLength(1);
    expect(await readProgress("loop-b")).toHaveLength(1);
    expect(await readProgress("loop-c")).toHaveLength(0);
  });
});

describe("IDEM-6: writeRecommendations / readRecommendations", () => {
  test("round-trips JSON through Redis", async () => {
    const recs = { toolRankings: [{ tool: "claude", passRate: 0.8 }], suggestedRetryLadder: ["claude", "codex"] };
    await writeRecommendations("/my/project", recs);
    const result = await readRecommendations("/my/project");
    expect(result).toEqual(recs);
  });

  test("returns null for missing project", async () => {
    expect(await readRecommendations("/no/such/project")).toBeNull();
  });
});

describe("IDEM-6: writePatterns / readPatterns", () => {
  test("round-trips pattern string through Redis", async () => {
    await writePatterns("/my/project", "- Use Bun\n- Use Effect");
    const result = await readPatterns("/my/project");
    expect(result).toBe("- Use Bun\n- Use Effect");
  });

  test("returns empty string for missing project", async () => {
    expect(await readPatterns("/no/such/project")).toBe("");
  });
});

describe("IDEM-6: buildPrompt reads from Redis", () => {
  test("implement.ts source reads recommendations and patterns from Redis helpers", async () => {
    const source = await Bun.file("src/inngest/functions/agent-loop/implement.ts").text();
    expect(source).toContain("readRecommendations");
    expect(source).toContain("readPatterns");
  });
});
