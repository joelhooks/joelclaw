import { getRedisClient } from "./redis";

export const SUBSCRIPTIONS_REDIS_KEY = "joelclaw:subscriptions";

export type SubscriptionType = "atom" | "rss" | "github" | "page" | "bluesky";
export type SubscriptionInterval = "hourly" | "daily" | "weekly";

export interface Subscription {
  id: string;
  name: string;
  feedUrl: string;
  type: SubscriptionType;
  checkInterval: SubscriptionInterval;
  lastChecked: number;
  lastContentHash: string;
  lastEntryId: string;
  filters?: string[];
  publishToCool: boolean;
  notify: boolean;
  summarize: boolean;
  active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSubscription(value: unknown): Subscription | null {
  if (!isRecord(value)) return null;

  const type = asString(value.type) as SubscriptionType;
  const checkInterval = asString(value.checkInterval) as SubscriptionInterval;
  if (!type || !checkInterval) return null;

  const id = asString(value.id).trim();
  const name = asString(value.name).trim();
  const feedUrl = asString(value.feedUrl).trim();
  if (!id || !name || !feedUrl) return null;

  return {
    id,
    name,
    feedUrl,
    type,
    checkInterval,
    lastChecked: asNumber(value.lastChecked),
    lastContentHash: asString(value.lastContentHash),
    lastEntryId: asString(value.lastEntryId),
    filters: asStringArray(value.filters),
    publishToCool: asBoolean(value.publishToCool),
    notify: asBoolean(value.notify),
    summarize: asBoolean(value.summarize),
    active: asBoolean(value.active),
  };
}

function serializeSubscription(subscription: Subscription): string {
  return JSON.stringify(subscription);
}

function parseSubscription(raw: string | null): Subscription | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeSubscription(parsed);
  } catch {
    return null;
  }
}

export async function addSubscription(subscription: Subscription): Promise<Subscription> {
  const redis = getRedisClient();
  await redis.hset(
    SUBSCRIPTIONS_REDIS_KEY,
    subscription.id,
    serializeSubscription(subscription)
  );
  return subscription;
}

export async function removeSubscription(id: string): Promise<boolean> {
  const redis = getRedisClient();
  const removed = await redis.hdel(SUBSCRIPTIONS_REDIS_KEY, id);
  return removed > 0;
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const redis = getRedisClient();
  const map = await redis.hgetall(SUBSCRIPTIONS_REDIS_KEY);

  const subscriptions = Object.values(map)
    .map((value) => parseSubscription(value))
    .filter((item): item is Subscription => item !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return subscriptions;
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const redis = getRedisClient();
  const raw = await redis.hget(SUBSCRIPTIONS_REDIS_KEY, id);
  return parseSubscription(raw);
}

export async function updateSubscription(
  id: string,
  patch: Partial<Subscription>
): Promise<Subscription | null> {
  const existing = await getSubscription(id);
  if (!existing) return null;

  const next: Subscription = {
    ...existing,
    ...patch,
    id,
  };

  const redis = getRedisClient();
  await redis.hset(SUBSCRIPTIONS_REDIS_KEY, id, serializeSubscription(next));
  return next;
}
