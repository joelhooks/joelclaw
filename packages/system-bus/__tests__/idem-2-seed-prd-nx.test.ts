import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";
import { seedPrd } from "../src/inngest/functions/agent-loop/utils.ts";

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
  (Redis as any).prototype.ttl = originalMethods.ttl;
});

beforeEach(() => {
  store.clear();
});

function prdRedisKey(loopId: string): string {
  return `agent-loop:prd:${loopId}`;
}

describe("IDEM-2: seedPrd first-writer-wins guard", () => {
  test("duplicate seedPrd calls preserve original PRD state and return existing data", async () => {
    const loopId = "loop-idem-2";
    const projectDir = mkdtempSync(join(tmpdir(), "idem-2-seed-prd-"));

    const firstPrd = {
      title: "Original PRD",
      description: "first write",
      stories: [
        {
          id: "story-1",
          title: "First story",
          description: "first version",
          acceptance_criteria: ["first criterion"],
          priority: 1,
          passes: false,
        },
      ],
    };

    const secondPrd = {
      title: "Overwriting PRD",
      description: "second write should not win",
      stories: [
        {
          id: "story-1",
          title: "Second story",
          description: "second version",
          acceptance_criteria: ["second criterion"],
          priority: 2,
          passes: false,
        },
      ],
    };

    await Bun.write(join(projectDir, "first-prd.json"), JSON.stringify(firstPrd));
    await Bun.write(join(projectDir, "second-prd.json"), JSON.stringify(secondPrd));

    const firstResult = await seedPrd(loopId, projectDir, "first-prd.json");
    const ttlAfterFirstSeed = await (new Redis() as any).ttl(prdRedisKey(loopId));

    const secondResult = await seedPrd(loopId, projectDir, "second-prd.json");

    const redis = new Redis();
    const persistedJson = await redis.get(prdRedisKey(loopId));
    const persistedPrd = JSON.parse(persistedJson ?? "{}");
    const ttlAfterSecondSeed = await (redis as any).ttl(prdRedisKey(loopId));

    expect(firstResult).toEqual(firstPrd);
    expect(secondResult).toEqual(firstPrd);
    expect(persistedPrd).toEqual(firstPrd);

    expect(ttlAfterFirstSeed).toBeGreaterThan(604700);
    expect(ttlAfterFirstSeed).toBeLessThanOrEqual(604800);
    expect(ttlAfterSecondSeed).toBeLessThanOrEqual(ttlAfterFirstSeed);
  });
});

describe("IDEM-2: TypeScript compile acceptance criterion", () => {
  test(
    "bunx tsc --noEmit succeeds",
    async () => {
      const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: join(import.meta.dir, ".."),
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        console.error("tsc stdout:", stdout);
        console.error("tsc stderr:", stderr);
      }

      expect(exitCode).toBe(0);
    },
    30_000
  );
});
