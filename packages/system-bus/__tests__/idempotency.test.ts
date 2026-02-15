import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import {
  claimStory,
  guardStory,
  renewLease,
  releaseClaim,
} from "../src/inngest/functions/agent-loop/utils.ts";

type RedisValue = {
  value: string;
  expiresAtMs: number | null;
};

const store = new Map<string, RedisValue>();

function getLiveEntry(key: string): RedisValue | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

const originalMethods = {
  set: (Redis as any).prototype.set,
  get: (Redis as any).prototype.get,
  expire: (Redis as any).prototype.expire,
  del: (Redis as any).prototype.del,
  ttl: (Redis as any).prototype.ttl,
};

beforeAll(() => {
  (Redis as any).prototype.set = async function (...args: unknown[]) {
    const [key, rawValue, ...rest] = args as [string, string, ...unknown[]];
    const value = String(rawValue);

    let exSeconds: number | null = null;
    let nx = false;

    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === "EX") {
        exSeconds = Number(rest[i + 1]);
        i += 1;
      }
      if (token === "NX") {
        nx = true;
      }
    }

    const existing = getLiveEntry(key);
    if (nx && existing) return null;

    const expiresAtMs =
      exSeconds !== null ? Date.now() + exSeconds * 1000 : existing?.expiresAtMs ?? null;

    store.set(key, { value, expiresAtMs });
    return "OK";
  };

  (Redis as any).prototype.get = async function (key: string) {
    const entry = getLiveEntry(key);
    return entry ? entry.value : null;
  };

  (Redis as any).prototype.expire = async function (key: string, seconds: number) {
    const entry = getLiveEntry(key);
    if (!entry) return 0;
    entry.expiresAtMs = Date.now() + Number(seconds) * 1000;
    store.set(key, entry);
    return 1;
  };

  (Redis as any).prototype.del = async function (...keys: string[]) {
    let deleted = 0;
    for (const key of keys) {
      if (store.delete(key)) deleted += 1;
    }
    return deleted;
  };

  (Redis as any).prototype.ttl = async function (key: string) {
    const entry = getLiveEntry(key);
    if (!entry) return -2;
    if (entry.expiresAtMs === null) return -1;
    const remainingMs = entry.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      store.delete(key);
      return -2;
    }
    return Math.ceil(remainingMs / 1000);
  };
});

afterAll(() => {
  (Redis as any).prototype.set = originalMethods.set;
  (Redis as any).prototype.get = originalMethods.get;
  (Redis as any).prototype.expire = originalMethods.expire;
  (Redis as any).prototype.del = originalMethods.del;
  (Redis as any).prototype.ttl = originalMethods.ttl;
});

beforeEach(() => {
  store.clear();
});

function claimRedisKey(loopId: string, storyId: string): string {
  return `agent-loop:claim:${loopId}:${storyId}`;
}

function prdRedisKey(loopId: string): string {
  return `agent-loop:prd:${loopId}`;
}

describe("IDEM-1: lease claim helpers", () => {
  test("exports claimStory, guardStory, renewLease, and releaseClaim", () => {
    expect(typeof claimStory).toBe("function");
    expect(typeof guardStory).toBe("function");
    expect(typeof renewLease).toBe("function");
    expect(typeof releaseClaim).toBe("function");
  });

  test("claimStory enforces single-owner claim and isolates claims by loop/story key schema", async () => {
    const first = await claimStory("loop-a", "story-1", "token-1");
    const second = await claimStory("loop-a", "story-1", "token-2");
    const differentLoop = await claimStory("loop-b", "story-1", "token-3");
    const differentStory = await claimStory("loop-a", "story-2", "token-4");

    expect(first).toBe("token-1");
    expect(second).toBeNull();
    expect(differentLoop).toBe("token-3");
    expect(differentStory).toBe("token-4");

    const redis = new Redis();
    const ttl = await (redis as any).ttl(claimRedisKey("loop-a", "story-1"));
    expect(ttl).toBeGreaterThan(1700);
    expect(ttl).toBeLessThanOrEqual(1800);
  });

  test("guardStory returns already_claimed when the story is owned by another token", async () => {
    await claimStory("loop-c", "story-1", "owner-token");

    const guard = await guardStory("loop-c", "story-1", "different-token");

    expect(guard).toEqual({ ok: false, reason: "already_claimed" });
  });

  test("guardStory returns already_passed when PRD marks story as passed", async () => {
    const loopId = "loop-d";
    const storyId = "story-1";
    const runToken = "token-pass";

    await claimStory(loopId, storyId, runToken);

    const redis = new Redis();
    await redis.set(
      prdRedisKey(loopId),
      JSON.stringify({
        stories: [{ id: storyId, status: "passed" }],
      })
    );

    const guard = await guardStory(loopId, storyId, runToken);

    expect(guard).toEqual({ ok: false, reason: "already_passed" });
  });

  test("guardStory returns already_passed when PRD marks story as skipped", async () => {
    const loopId = "loop-e";
    const storyId = "story-1";
    const runToken = "token-skip";

    await claimStory(loopId, storyId, runToken);

    const redis = new Redis();
    await redis.set(
      prdRedisKey(loopId),
      JSON.stringify({
        stories: [{ id: storyId, status: "skipped" }],
      })
    );

    const guard = await guardStory(loopId, storyId, runToken);

    expect(guard).toEqual({ ok: false, reason: "already_passed" });
  });

  test("renewLease refuses non-owner token and extends TTL for owner token", async () => {
    const loopId = "loop-f";
    const storyId = "story-1";
    const key = claimRedisKey(loopId, storyId);

    await claimStory(loopId, storyId, "owner-token");

    const redis = new Redis();
    await redis.expire(key, 10);

    const nonOwnerRenew = await renewLease(loopId, storyId, "other-token");
    const ttlAfterNonOwner = await (redis as any).ttl(key);

    const ownerRenew = await renewLease(loopId, storyId, "owner-token");
    const ttlAfterOwner = await (redis as any).ttl(key);

    expect(nonOwnerRenew).toBe(false);
    expect(ttlAfterNonOwner).toBeLessThanOrEqual(10);

    expect(ownerRenew).toBe(true);
    expect(ttlAfterOwner).toBeGreaterThan(1700);
    expect(ttlAfterOwner).toBeLessThanOrEqual(1800);
  });

  test("releaseClaim removes claim key", async () => {
    const loopId = "loop-g";
    const storyId = "story-1";

    await claimStory(loopId, storyId, "token-release");
    await releaseClaim(loopId, storyId);

    const redis = new Redis();
    const claim = await redis.get(claimRedisKey(loopId, storyId));
    const guard = await guardStory(loopId, storyId, "token-release");

    expect(claim).toBeNull();
    expect(guard).toEqual({ ok: false, reason: "lease_expired" });
  });
});

describe("IDEM-1: TypeScript compile gate", () => {
  test(
    "bunx tsc --noEmit succeeds",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: new URL("..", import.meta.url).pathname,
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    },
    30_000
  );
});
