#!/usr/bin/env bun

import Redis from "ioredis";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { triageProposal, type Proposal, type TriageResult } from "../packages/system-bus/src/memory/triage";

type MemorySection =
  | "Joel"
  | "Miller Hooks"
  | "Conventions"
  | "Hard Rules"
  | "System Architecture"
  | "Patterns";

const REVIEW_PENDING_KEY = "memory:review:pending";

type RedisPort = {
  mode: "localhost" | "kubectl";
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, fields: Record<string, string>): Promise<void>;
  set(key: string, value: string): Promise<void>;
  lrem(key: string, count: number, value: string): Promise<void>;
  del(...keys: string[]): Promise<void>;
  disconnect(): Promise<void>;
};

type TriageSummary = {
  promoted: Array<{ proposal: Proposal; reason: string }>;
  rejected: Array<{ proposal: Proposal; reason: string }>;
  merged: Array<{ proposal: Proposal; targetId: string; reason: string }>;
  needsReview: Array<{ proposal: Proposal; reason: string }>;
};

class LocalRedisPort implements RedisPort {
  mode = "localhost" as const;
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.redis.lrange(key, start, stop);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    const args = Object.entries(fields).flatMap(([field, value]) => [field, value]);
    if (args.length === 0) return;
    await this.redis.hset(key, ...args);
  }

  async set(key: string, value: string): Promise<void> {
    await this.redis.set(key, value);
  }

  async lrem(key: string, count: number, value: string): Promise<void> {
    await this.redis.lrem(key, count, value);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis.del(...keys);
  }

  async disconnect(): Promise<void> {
    this.redis.disconnect();
  }
}

class KubectlRedisPort implements RedisPort {
  mode = "kubectl" as const;

  private runRedisCli(args: string[]): string {
    const proc = Bun.spawnSync([
      "kubectl",
      "exec",
      "-n",
      "joelclaw",
      "redis-0",
      "--",
      "redis-cli",
      "--raw",
      ...args,
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array());
    const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array());

    if (proc.exitCode !== 0) {
      throw new Error(`kubectl redis-cli failed (${proc.exitCode}): ${stderr || stdout || "unknown error"}`);
    }

    return stdout;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const output = this.runRedisCli(["LRANGE", key, String(start), String(stop)]);
    const values = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return values;
  }

  async get(key: string): Promise<string | null> {
    const output = this.runRedisCli(["GET", key]).trim();
    if (!output || output === "(nil)") return null;
    return output;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const output = this.runRedisCli(["HGETALL", key]);
    const lines = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "(empty array)");

    const hash: Record<string, string> = {};
    for (let i = 0; i < lines.length; i += 2) {
      const field = lines[i];
      const value = lines[i + 1] ?? "";
      if (field) hash[field] = value;
    }

    return hash;
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    const args = Object.entries(fields).flatMap(([field, value]) => [field, value]);
    if (args.length === 0) return;
    this.runRedisCli(["HSET", key, ...args]);
  }

  async set(key: string, value: string): Promise<void> {
    this.runRedisCli(["SET", key, value]);
  }

  async lrem(key: string, count: number, value: string): Promise<void> {
    this.runRedisCli(["LREM", key, String(count), value]);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    this.runRedisCli(["DEL", ...keys]);
  }

  async disconnect(): Promise<void> {
    return;
  }
}

function jsonKey(id: string): string {
  return `memory:proposal:${id}`;
}

function hashKey(id: string): string {
  return `memory:review:proposal:${id}`;
}

function normalizeSection(value: string | undefined): MemorySection {
  const trimmed = value?.trim();
  if (trimmed === "Joel") return trimmed;
  if (trimmed === "Miller Hooks") return trimmed;
  if (trimmed === "Conventions") return trimmed;
  if (trimmed === "Hard Rules") return trimmed;
  if (trimmed === "System Architecture") return trimmed;
  if (trimmed === "Patterns") return trimmed;
  return "Hard Rules";
}

function extractDate(value: string | undefined): string | null {
  if (!value) return null;
  const exact = /^(\d{4}-\d{2}-\d{2})/u.exec(value);
  if (exact?.[1]) return exact[1];

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function extractDateFromProposal(proposal: Proposal): string {
  const fromTimestamp = extractDate(proposal.timestamp);
  if (fromTimestamp) return fromTimestamp;

  const idMatch = /^p-(\d{4})(\d{2})(\d{2})-\d+$/u.exec(proposal.id);
  if (idMatch?.[1] && idMatch[2] && idMatch[3]) {
    return `${idMatch[1]}-${idMatch[2]}-${idMatch[3]}`;
  }

  return new Date().toISOString().slice(0, 10);
}

function appendBulletToSection(markdown: string, section: MemorySection, bullet: string): string {
  const lines = markdown.split(/\r?\n/u);
  const header = `## ${section}`;
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  const fallbackHeaderIndex = lines.findIndex((line) => line.trim() === "## Hard Rules");
  const targetHeaderIndex = headerIndex >= 0 ? headerIndex : fallbackHeaderIndex;

  if (targetHeaderIndex < 0) {
    throw new Error(`Target section not found in MEMORY.md: ${section}`);
  }

  let sectionEnd = lines.length;
  for (let i = targetHeaderIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  let insertIndex = sectionEnd;
  while (insertIndex > targetHeaderIndex + 1 && (lines[insertIndex - 1]?.trim() ?? "") === "") {
    insertIndex -= 1;
  }

  lines.splice(insertIndex, 0, bullet);
  return lines.join("\n");
}

function mergeChanges(primary: string, secondary: string): string {
  const a = primary.trim();
  const b = secondary.trim();
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return a.length >= b.length ? `${a}\n${b}` : `${b}\n${a}`;
}

function titleFor(proposal: Proposal): string {
  const line = proposal.change.replace(/\s+/gu, " ").trim();
  if (line.length <= 90) return line;
  return `${line.slice(0, 87)}...`;
}

function toProposal(input: Partial<Proposal> & { id: string }): Proposal {
  return {
    id: input.id,
    section: (input.section ?? "Hard Rules").trim(),
    change: (input.change ?? "").trim(),
    source: input.source?.trim(),
    timestamp: input.timestamp?.trim(),
  };
}

async function loadProposal(redis: RedisPort, id: string): Promise<Proposal | null> {
  const raw = await redis.get(jsonKey(id));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Proposal>;
      return toProposal({ ...parsed, id });
    } catch {
      // fall through
    }
  }

  const hash = await redis.hgetall(hashKey(id));
  if (Object.keys(hash).length === 0) return null;

  return toProposal({
    id,
    section: hash.section,
    change: hash.change,
    source: hash.source,
    timestamp: hash.timestamp ?? hash.capturedAt ?? hash.date,
  });
}

async function writeProposal(redis: RedisPort, proposal: Proposal): Promise<void> {
  await redis.set(jsonKey(proposal.id), JSON.stringify(proposal));
  await redis.hset(hashKey(proposal.id), {
    id: proposal.id,
    section: proposal.section,
    change: proposal.change,
    source: proposal.source ?? "",
    timestamp: proposal.timestamp ?? "",
    capturedAt: proposal.timestamp ?? "",
  });
}

async function removeProposal(redis: RedisPort, id: string): Promise<void> {
  await redis.lrem(REVIEW_PENDING_KEY, 0, id);
  await redis.del(jsonKey(id), hashKey(id));
}

function getMemoryPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/Users/joel";
  return join(home, ".joelclaw", "workspace", "MEMORY.md");
}

async function connectRedis(): Promise<RedisPort> {
  const local = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    connectTimeout: 1500,
    commandTimeout: 1500,
    maxRetriesPerRequest: 1,
  });

  try {
    await local.ping();
    return new LocalRedisPort(local);
  } catch {
    try {
      local.disconnect();
    } catch {
      // ignore
    }
    const kubectl = new KubectlRedisPort();
    await kubectl.lrange(REVIEW_PENDING_KEY, 0, 0);
    return kubectl;
  }
}

function updatePendingList(
  pending: Proposal[],
  update: { kind: "remove"; id: string } | { kind: "replace"; proposal: Proposal }
): Proposal[] {
  if (update.kind === "remove") {
    return pending.filter((proposal) => proposal.id !== update.id);
  }

  return pending.map((proposal) => (proposal.id === update.proposal.id ? update.proposal : proposal));
}

function printSummary(summary: TriageSummary): void {
  console.log(`Auto-promoted: ${summary.promoted.length}`);
  for (const item of summary.promoted) {
    console.log(`- ${item.proposal.id}: ${titleFor(item.proposal)}`);
  }

  console.log(`\nAuto-rejected: ${summary.rejected.length}`);
  for (const item of summary.rejected) {
    console.log(`- ${item.proposal.id}: ${item.reason}`);
  }

  console.log(`\nAuto-merged: ${summary.merged.length}`);
  for (const item of summary.merged) {
    console.log(`- ${item.proposal.id} -> ${item.targetId}: ${item.reason}`);
  }

  console.log(`\nNeeds-review: ${summary.needsReview.length}`);
  for (const item of summary.needsReview) {
    console.log(`- ${item.proposal.id}: ${titleFor(item.proposal)}`);
  }
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const redis = await connectRedis();

  try {
    const pendingIds = await redis.lrange(REVIEW_PENDING_KEY, 0, -1);
    const proposals: Proposal[] = [];

    for (const id of pendingIds) {
      const proposal = await loadProposal(redis, id);
      if (proposal) proposals.push(proposal);
    }

    let memoryMarkdown = await Bun.file(getMemoryPath()).text();
    let pendingState = [...proposals];

    const summary: TriageSummary = {
      promoted: [],
      rejected: [],
      merged: [],
      needsReview: [],
    };

    for (const proposalId of pendingIds) {
      const proposal = pendingState.find((item) => item.id === proposalId);
      if (!proposal) continue;

      const others = pendingState.filter((item) => item.id !== proposal.id);
      const triage = triageProposal(proposal, memoryMarkdown, others);

      if (triage.action === "auto-promote") {
        summary.promoted.push({ proposal, reason: triage.reason });

        const section = normalizeSection(proposal.section);
        const date = extractDateFromProposal(proposal);
        memoryMarkdown = appendBulletToSection(memoryMarkdown, section, `- (${date}) ${proposal.change}`);

        pendingState = updatePendingList(pendingState, { kind: "remove", id: proposal.id });
        if (execute) {
          await removeProposal(redis, proposal.id);
        }
        continue;
      }

      if (triage.action === "auto-reject") {
        summary.rejected.push({ proposal, reason: triage.reason });
        pendingState = updatePendingList(pendingState, { kind: "remove", id: proposal.id });
        if (execute) {
          await removeProposal(redis, proposal.id);
        }
        continue;
      }

      if (triage.action === "auto-merge") {
        const targetId = triage.mergeWith;
        if (!targetId) {
          summary.needsReview.push({
            proposal,
            reason: "merge target missing; manual review required",
          });
          continue;
        }

        const target = pendingState.find((item) => item.id === targetId);
        if (!target) {
          summary.needsReview.push({
            proposal,
            reason: `merge target ${targetId} missing; manual review required`,
          });
          continue;
        }

        const mergedTarget: Proposal = {
          ...target,
          change: mergeChanges(target.change, proposal.change),
          timestamp: target.timestamp ?? proposal.timestamp,
          source: target.source ?? proposal.source,
        };

        summary.merged.push({ proposal, targetId, reason: triage.reason });
        pendingState = updatePendingList(pendingState, { kind: "replace", proposal: mergedTarget });
        pendingState = updatePendingList(pendingState, { kind: "remove", id: proposal.id });

        if (execute) {
          await writeProposal(redis, mergedTarget);
          await removeProposal(redis, proposal.id);
        }
        continue;
      }

      const result: TriageResult = triage;
      summary.needsReview.push({ proposal, reason: result.reason });
    }

    if (execute) {
      const memoryPath = getMemoryPath();
      const tmpPath = `${memoryPath}.tmp`;
      await Bun.write(tmpPath, memoryMarkdown);
      await rename(tmpPath, memoryPath);
    }

    console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}`);
    console.log(`Redis mode: ${redis.mode}`);
    console.log(`Pending proposals scanned: ${pendingIds.length}\n`);
    printSummary(summary);
  } finally {
    await redis.disconnect();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
