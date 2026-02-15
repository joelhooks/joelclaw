/**
 * IDEM-3: Plan claims story before dispatch
 *
 * Tests the observable behavior: plan.ts must claim a story via Redis SETNX
 * before dispatching work. If already claimed, it skips. Uses @inngest/test
 * for proper Inngest function execution — no hand-rolled step mocks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import Redis from "ioredis";
import { agentLoopPlan } from "../src/inngest/functions/agent-loop/plan";
import { claimStory } from "../src/inngest/functions/agent-loop/utils";

// ── Scoped Redis mock (in-memory) ──────────────────────────────────────

type RedisValue = { value: string; expiresAtMs: number | null };
const store = new Map<string, RedisValue>();
const lists = new Map<string, string[]>();

function getLiveEntry(key: string): RedisValue | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry;
}

const originals = {
  set: Redis.prototype.set,
  get: Redis.prototype.get,
  expire: Redis.prototype.expire,
  del: Redis.prototype.del,
  ttl: Redis.prototype.ttl,
  rpush: Redis.prototype.rpush,
  lrange: Redis.prototype.lrange,
};

beforeAll(() => {
  (Redis.prototype as any).set = async function (...args: unknown[]) {
    const [key, rawValue, ...rest] = args as [string, string, ...unknown[]];
    const value = String(rawValue);
    let exSeconds: number | null = null;
    let nx = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "EX") { exSeconds = Number(rest[i + 1]); i++; }
      if (rest[i] === "NX") nx = true;
    }
    const existing = getLiveEntry(key);
    if (nx && existing) return null;
    const expiresAtMs = exSeconds !== null ? Date.now() + exSeconds * 1000 : existing?.expiresAtMs ?? null;
    store.set(key, { value, expiresAtMs });
    return "OK";
  };
  (Redis.prototype as any).get = async function (key: string) {
    const entry = getLiveEntry(key);
    return entry ? entry.value : null;
  };
  (Redis.prototype as any).expire = async function (key: string, seconds: number) {
    const entry = getLiveEntry(key);
    if (!entry) return 0;
    entry.expiresAtMs = Date.now() + Number(seconds) * 1000;
    store.set(key, entry);
    return 1;
  };
  (Redis.prototype as any).del = async function (...keys: string[]) {
    let deleted = 0;
    for (const key of keys) { if (store.delete(key)) deleted++; }
    return deleted;
  };
  (Redis.prototype as any).ttl = async function (key: string) {
    const entry = getLiveEntry(key);
    if (!entry) return -2;
    if (entry.expiresAtMs === null) return -1;
    const ms = entry.expiresAtMs - Date.now();
    if (ms <= 0) { store.delete(key); return -2; }
    return Math.ceil(ms / 1000);
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

// ── Helpers ─────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const PRD = {
  title: "Test PRD",
  stories: [
    {
      id: "STORY-1",
      title: "First story",
      description: "Do the thing",
      acceptance_criteria: ["It works"],
      priority: 1,
      passes: false,
    },
  ],
};

let tmpProject: string;

beforeEach(async () => {
  // Create a real git repo so branch steps don't explode
  tmpProject = mkdtempSync(join(tmpdir(), "idem-test-"));
  await $`cd ${tmpProject} && git init -b main && git commit --allow-empty -m "init"`.quiet();
});

import { afterEach } from "bun:test";
afterEach(() => {
  try { rmSync(tmpProject, { recursive: true, force: true }); } catch {}
});

async function makePlanEngine(loopId: string, extraSteps?: InngestTestEngine.Options["steps"]) {
  // Pre-create the loop branch so verify-branch succeeds
  const branchName = `agent-loop/${loopId}`;
  await $`cd ${tmpProject} && git checkout -b ${branchName}`.quiet();

  return new InngestTestEngine({
    function: agentLoopPlan,
    events: [{
      name: "agent/loop.plan" as const,
      data: { loopId, project: tmpProject, maxIterations: 10, maxRetries: 2, retryLadder: ["codex", "claude"] },
    }],
    steps: [
      { id: "check-cancel", handler: () => false },
      { id: "read-prd", handler: () => PRD },
      ...(extraSteps ?? []),
    ],
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("IDEM-3: plan claims before dispatch", () => {
  test("dispatches when story is unclaimed", async () => {
    const loopId = "loop-claim-ok-" + Date.now();
    const t = await makePlanEngine(loopId);
    const { result } = await t.execute();

    expect(result).toMatchObject({ status: "dispatched", storyId: "STORY-1" });
  });

  test("returns already-claimed when another process owns the story", async () => {
    const loopId = "loop-conflict-" + Date.now();
    await claimStory(loopId, "STORY-1", "other-process-token");

    const t = await makePlanEngine(loopId);
    const { result } = await t.execute();

    expect(result).toMatchObject({ status: "already-claimed", storyId: "STORY-1" });
  });
});
