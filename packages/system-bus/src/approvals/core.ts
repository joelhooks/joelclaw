/**
 * Approval core state module.
 * ADR-0067: Pattern adapted from local-approvals by shaiss (openclaw/skills, MIT).
 *
 * Redis key schema:
 * - approval:auto:<agent> (SET)
 *   Members: category strings that are auto-approved for the agent.
 * - approval:pending:<requestId> (HASH)
 *   Fields: requestId, agent, category, operation, reasoning, status, createdAt,
 *   decisionAt, reviewer, learn.
 * - approval:history (ZSET)
 *   Score: decision timestamp (ms since epoch).
 *   Member: JSON string of an approval history record.
 */

import { randomUUID } from "node:crypto";
import type Redis from "ioredis";

export type RequestInput = {
  agent: string;
  category: string;
  operation: string;
  reasoning: string;
};

export type DecisionInput = {
  reviewer: string;
  learn?: boolean;
};

export type DenyInput = {
  reviewer: string;
};

export type PendingRecord = {
  requestId: string;
  agent: string;
  category: string;
  operation: string;
  reasoning: string;
  status: "pending";
  createdAt: string;
};

export type HistoryRecord = {
  requestId: string;
  agent: string;
  category: string;
  operation: string;
  reasoning: string;
  status: "approved" | "denied";
  createdAt: string;
  decisionAt: string;
  reviewer?: string;
  learn?: string;
  autoApproved?: string;
};

const AUTO_KEY = (agent: string) => `approval:auto:${agent}`;
const PENDING_KEY = (requestId: string) => `approval:pending:${requestId}`;
const HISTORY_KEY = "approval:history";

function getField(hash: Record<string, string>, field: string): string | null {
  return hash[field] ?? null;
}

function toPendingRecord(hash: Record<string, string>): PendingRecord | null {
  const requestId = getField(hash, "requestId");
  const agent = getField(hash, "agent");
  const category = getField(hash, "category");
  const operation = getField(hash, "operation");
  const reasoning = getField(hash, "reasoning");
  const createdAt = getField(hash, "createdAt");

  if (!requestId || !agent || !category || !operation || !reasoning || !createdAt) {
    return null;
  }

  return {
    requestId,
    agent,
    category,
    operation,
    reasoning,
    status: "pending",
    createdAt,
  };
}

function toHistoryRecord(
  pending: PendingRecord,
  status: "approved" | "denied"
): HistoryRecord {
  const decisionAt = new Date().toISOString();
  return {
    requestId: pending.requestId,
    agent: pending.agent,
    category: pending.category,
    operation: pending.operation,
    reasoning: pending.reasoning,
    status,
    createdAt: pending.createdAt,
    decisionAt,
  };
}

function historyScore(decisionAt: string): number {
  const parsed = Date.parse(decisionAt);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

async function writeHistory(redis: Redis, record: HistoryRecord): Promise<void> {
  await redis.zadd(HISTORY_KEY, historyScore(record.decisionAt), JSON.stringify(record));
}

export async function submitRequest(
  redis: Redis,
  { agent, category, operation, reasoning }: RequestInput
): Promise<{ requestId: string; autoApproved: boolean }> {
  const requestId = randomUUID();
  const createdAt = new Date().toISOString();

  const autoApproved = await checkAutoApprove(redis, agent, category);

  if (autoApproved) {
    await writeHistory(redis, {
      requestId,
      agent,
      category,
      operation,
      reasoning,
      status: "approved",
      createdAt,
      decisionAt: createdAt,
      reviewer: "system:auto-approve",
      autoApproved: "true",
    });

    return { requestId, autoApproved: true };
  }

  const pending: PendingRecord = {
    requestId,
    agent,
    category,
    operation,
    reasoning,
    status: "pending",
    createdAt,
  };

  await redis.hset(PENDING_KEY(requestId), pending);

  return { requestId, autoApproved: false };
}

export async function checkAutoApprove(
  redis: Redis,
  agent: string,
  category: string
): Promise<boolean> {
  const result = await redis.sismember(AUTO_KEY(agent), category);
  return result === 1;
}

export async function approveRequest(
  redis: Redis,
  id: string,
  { reviewer, learn = false }: DecisionInput
): Promise<void> {
  const key = PENDING_KEY(id);
  const hash = await redis.hgetall(key);
  const pending = toPendingRecord(hash);
  if (!pending) {
    throw new Error(`Pending approval not found: ${id}`);
  }

  if (learn) {
    await learnCategory(redis, pending.agent, pending.category);
  }

  const historyRecord: HistoryRecord = {
    ...toHistoryRecord(pending, "approved"),
    reviewer,
    learn: learn ? "true" : "false",
  };

  const tx = redis.multi();
  tx.zadd(HISTORY_KEY, historyScore(historyRecord.decisionAt), JSON.stringify(historyRecord));
  tx.del(key);
  await tx.exec();
}

export async function denyRequest(redis: Redis, id: string, { reviewer }: DenyInput): Promise<void> {
  const key = PENDING_KEY(id);
  const hash = await redis.hgetall(key);
  const pending = toPendingRecord(hash);
  if (!pending) {
    throw new Error(`Pending approval not found: ${id}`);
  }

  const historyRecord: HistoryRecord = {
    ...toHistoryRecord(pending, "denied"),
    reviewer,
  };

  const tx = redis.multi();
  tx.zadd(HISTORY_KEY, historyScore(historyRecord.decisionAt), JSON.stringify(historyRecord));
  tx.del(key);
  await tx.exec();
}

export async function learnCategory(redis: Redis, agent: string, category: string): Promise<void> {
  await redis.sadd(AUTO_KEY(agent), category);
}

export type AutoApprovalCategories = {
  agent: string;
  categories: string[];
};

export async function listAutoApproveCategories(
  redis: Redis,
  agent?: string
): Promise<AutoApprovalCategories[]> {
  if (agent) {
    const categories = await redis.smembers(AUTO_KEY(agent));
    return [{ agent, categories: categories.sort((a, b) => a.localeCompare(b)) }];
  }

  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", "approval:auto:*", "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  if (keys.length === 0) return [];

  const records = await Promise.all(
    keys.map(async (key) => {
      const categories = await redis.smembers(key);
      const agentName = key.slice("approval:auto:".length);
      return {
        agent: agentName,
        categories: categories.sort((a, b) => a.localeCompare(b)),
      };
    })
  );

  return records.sort((a, b) => a.agent.localeCompare(b.agent));
}

export async function resetAutoApproveCategories(redis: Redis, agent: string): Promise<boolean> {
  const deleted = await redis.del(AUTO_KEY(agent));
  return deleted > 0;
}

export async function listPending(redis: Redis, agent?: string): Promise<PendingRecord[]> {
  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", "approval:pending:*", "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  if (keys.length === 0) return [];

  const pending = await Promise.all(
    keys.map(async (key) => {
      const hash = await redis.hgetall(key);
      return toPendingRecord(hash);
    })
  );

  const filtered = pending.filter((item): item is PendingRecord => item !== null);
  if (!agent) return filtered;

  return filtered.filter((item) => item.agent === agent);
}

export async function getHistory(redis: Redis, limit = 50): Promise<HistoryRecord[]> {
  const clampedLimit = Math.max(1, limit);
  const raw = await redis.zrevrange(HISTORY_KEY, 0, clampedLimit - 1);

  return raw
    .map((entry) => {
      try {
        return JSON.parse(entry) as HistoryRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is HistoryRecord => entry !== null);
}
