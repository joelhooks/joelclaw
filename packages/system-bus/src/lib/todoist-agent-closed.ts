import { getRedisClient } from "./redis";

export const TODOIST_AGENT_CLOSED_KEY = "joelclaw:todoist:agent-closed";
export const TODOIST_AGENT_CLOSED_TTL_SECONDS = 60;

function normalizeTaskId(taskId: string): string {
  return String(taskId).trim();
}

export async function markTodoistTaskAgentClosed(taskId: string): Promise<void> {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!normalizedTaskId) return;

  const redis = getRedisClient();
  await redis
    .multi()
    .sadd(TODOIST_AGENT_CLOSED_KEY, normalizedTaskId)
    .expire(TODOIST_AGENT_CLOSED_KEY, TODOIST_AGENT_CLOSED_TTL_SECONDS)
    .exec();
}

export async function unmarkTodoistTaskAgentClosed(taskId: string): Promise<void> {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!normalizedTaskId) return;

  const redis = getRedisClient();
  await redis.srem(TODOIST_AGENT_CLOSED_KEY, normalizedTaskId);
}

export async function isTodoistTaskAgentClosed(taskId: string): Promise<boolean> {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!normalizedTaskId) return false;

  const redis = getRedisClient();
  const result = await redis.sismember(TODOIST_AGENT_CLOSED_KEY, normalizedTaskId);
  return result === 1;
}
