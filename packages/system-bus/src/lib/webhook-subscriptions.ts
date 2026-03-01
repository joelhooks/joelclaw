import { getRedisClient } from "./redis";

export const WEBHOOK_SUBSCRIPTIONS_KEY = "joelclaw:webhook:subscriptions";
export const WEBHOOK_INDEX_PREFIX = "joelclaw:webhook:index";
export const WEBHOOK_EVENTS_PREFIX = "joelclaw:webhook:events";
export const WEBHOOK_NOTIFY_PREFIX = "joelclaw:webhook:notify";
export const WEBHOOK_DEDUP_PREFIX = "joelclaw:webhook:dedup";

const WEBHOOK_EVENT_HISTORY_LIMIT = Number.parseInt(
  process.env.WEBHOOK_SUBSCRIPTION_EVENT_HISTORY_LIMIT ?? "200",
  10,
);
const WEBHOOK_DEDUP_TTL_SECONDS = Number.parseInt(
  process.env.WEBHOOK_SUBSCRIPTION_DEDUP_TTL_SECONDS ?? String(7 * 24 * 60 * 60),
  10,
);

export type WebhookSubscriptionFilters = {
  repo?: string;
  workflow?: string;
  branch?: string;
  conclusion?: string;
};

export interface WebhookSubscription {
  id: string;
  provider: string;
  event: string;
  filters: WebhookSubscriptionFilters;
  sessionId?: string;
  createdAt: string;
  expiresAt?: string;
  active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeString(value: unknown): string {
  return asString(value).trim().toLowerCase();
}

function normalizeFilters(value: unknown): WebhookSubscriptionFilters {
  if (!isRecord(value)) return {};

  const filters: WebhookSubscriptionFilters = {};

  const repo = asString(value.repo).trim();
  if (repo) filters.repo = repo;

  const workflow = asString(value.workflow).trim();
  if (workflow) filters.workflow = workflow;

  const branch = asString(value.branch).trim();
  if (branch) filters.branch = branch;

  const conclusion = asString(value.conclusion).trim();
  if (conclusion) filters.conclusion = conclusion;

  return filters;
}

export function parseWebhookSubscription(raw: string | null): WebhookSubscription | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;

    const id = asString(parsed.id).trim();
    const provider = asString(parsed.provider).trim();
    const event = asString(parsed.event).trim();
    const createdAt = asString(parsed.createdAt).trim();

    if (!id || !provider || !event || !createdAt) return null;

    const sessionId = asString(parsed.sessionId).trim();
    const expiresAt = asString(parsed.expiresAt).trim();

    return {
      id,
      provider,
      event,
      filters: normalizeFilters(parsed.filters),
      ...(sessionId ? { sessionId } : {}),
      createdAt,
      ...(expiresAt ? { expiresAt } : {}),
      active: parsed.active !== false,
    };
  } catch {
    return null;
  }
}

export function webhookSubscriptionIndexKey(provider: string, event: string): string {
  return `${WEBHOOK_INDEX_PREFIX}:${provider}:${event}`;
}

export function webhookSubscriptionEventsKey(subscriptionId: string): string {
  return `${WEBHOOK_EVENTS_PREFIX}:${subscriptionId}`;
}

export function webhookSubscriptionNotifyKey(subscriptionId: string): string {
  return `${WEBHOOK_NOTIFY_PREFIX}:${subscriptionId}`;
}

function webhookSubscriptionDedupKey(subscriptionId: string, deliveryKey: string): string {
  return `${WEBHOOK_DEDUP_PREFIX}:${subscriptionId}:${encodeURIComponent(deliveryKey)}`;
}

function shouldPruneExpired(subscription: WebhookSubscription, now = Date.now()): boolean {
  if (!subscription.expiresAt) return false;
  const parsed = Date.parse(subscription.expiresAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed <= now;
}

export async function removeWebhookSubscription(
  id: string,
  hint?: { provider?: string; event?: string },
): Promise<void> {
  const redis = getRedisClient();

  let provider = hint?.provider;
  let event = hint?.event;

  if (!provider || !event) {
    const raw = await redis.hget(WEBHOOK_SUBSCRIPTIONS_KEY, id);
    const parsed = parseWebhookSubscription(raw);
    provider = provider ?? parsed?.provider;
    event = event ?? parsed?.event;
  }

  if (provider && event) {
    await redis.srem(webhookSubscriptionIndexKey(provider, event), id);
  }

  await redis.hdel(WEBHOOK_SUBSCRIPTIONS_KEY, id);
  await redis.del(webhookSubscriptionEventsKey(id));
}

export function matchesWebhookSubscriptionPayload(
  subscription: WebhookSubscription,
  payload: Record<string, unknown>,
): boolean {
  if (subscription.provider === "github" && subscription.event === "workflow_run.completed") {
    const repo = normalizeString(payload.repository);
    const workflow = normalizeString(payload.workflowName);
    const branch = normalizeString(payload.branch);
    const conclusion = normalizeString(payload.conclusion || payload.status);

    const expectedRepo = normalizeString(subscription.filters.repo);
    const expectedWorkflow = normalizeString(subscription.filters.workflow);
    const expectedBranch = normalizeString(subscription.filters.branch);
    const expectedConclusion = normalizeString(subscription.filters.conclusion);

    if (expectedRepo && repo !== expectedRepo) return false;
    if (expectedWorkflow && workflow !== expectedWorkflow) return false;
    if (expectedBranch && branch !== expectedBranch) return false;
    if (expectedConclusion && conclusion !== expectedConclusion) return false;

    return true;
  }

  // Generic fallback: exact match any known filter fields against payload keys.
  const filters = subscription.filters;
  const expectedRepo = normalizeString(filters.repo);
  if (expectedRepo && normalizeString(payload.repo || payload.repository) !== expectedRepo) return false;

  const expectedWorkflow = normalizeString(filters.workflow);
  if (expectedWorkflow && normalizeString(payload.workflow || payload.workflowName) !== expectedWorkflow) return false;

  const expectedBranch = normalizeString(filters.branch);
  if (expectedBranch && normalizeString(payload.branch) !== expectedBranch) return false;

  const expectedConclusion = normalizeString(filters.conclusion);
  if (expectedConclusion && normalizeString(payload.conclusion || payload.status) !== expectedConclusion) return false;

  return true;
}

export async function findMatchingWebhookSubscriptions(
  provider: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<WebhookSubscription[]> {
  const redis = getRedisClient();
  const indexKey = webhookSubscriptionIndexKey(provider, event);
  const ids = await redis.smembers(indexKey);

  if (ids.length === 0) return [];

  const matches: WebhookSubscription[] = [];
  const staleIds: string[] = [];

  for (const id of ids) {
    const raw = await redis.hget(WEBHOOK_SUBSCRIPTIONS_KEY, id);
    const subscription = parseWebhookSubscription(raw);

    if (!subscription) {
      staleIds.push(id);
      continue;
    }

    if (subscription.provider !== provider || subscription.event !== event || !subscription.active) {
      staleIds.push(id);
      continue;
    }

    if (shouldPruneExpired(subscription)) {
      staleIds.push(id);
      continue;
    }

    if (!matchesWebhookSubscriptionPayload(subscription, payload)) {
      continue;
    }

    matches.push(subscription);
  }

  if (staleIds.length > 0) {
    for (const staleId of staleIds) {
      await removeWebhookSubscription(staleId, { provider, event });
      await redis.srem(indexKey, staleId);
    }
  }

  return matches;
}

export async function claimWebhookDelivery(
  subscriptionId: string,
  deliveryKey: string,
): Promise<boolean> {
  const redis = getRedisClient();
  const dedupKey = webhookSubscriptionDedupKey(subscriptionId, deliveryKey);
  const claimed = await redis.set(
    dedupKey,
    "1",
    "EX",
    Math.max(60, WEBHOOK_DEDUP_TTL_SECONDS),
    "NX",
  );

  return claimed === "OK";
}

export async function publishWebhookSubscriptionEvent(
  subscriptionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const redis = getRedisClient();
  const eventListKey = webhookSubscriptionEventsKey(subscriptionId);
  const notifyKey = webhookSubscriptionNotifyKey(subscriptionId);

  const eventEnvelope = {
    id: crypto.randomUUID(),
    type: "webhook.subscription.matched",
    subscriptionId,
    data: payload,
    ts: new Date().toISOString(),
  };

  const serialized = JSON.stringify(eventEnvelope);

  await redis.lpush(eventListKey, serialized);
  await redis.ltrim(eventListKey, 0, Math.max(1, WEBHOOK_EVENT_HISTORY_LIMIT) - 1);
  await redis.publish(notifyKey, serialized);
}
