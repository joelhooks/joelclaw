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

const LEGACY_SUBSCRIPTION_URLS: Record<string, string> = {
  "https://github.com/mariozechner/pi-coding-agent": "https://github.com/badlogic/pi-mono",
};

const LEGACY_SUBSCRIPTION_OVERRIDES: Record<string, Pick<Subscription, "feedUrl" | "checkInterval">> = {
  "pi-coding-agent": {
    feedUrl: "https://github.com/badlogic/pi-mono",
    checkInterval: "daily",
  },
};

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

function normalizeLegacySubscription(subscription: Subscription): {
  subscription: Subscription;
  changed: boolean;
} {
  let changed = false;
  let next = subscription;

  const trimmedFeedUrl = subscription.feedUrl.trim();
  const normalizedFeedUrl = LEGACY_SUBSCRIPTION_URLS[trimmedFeedUrl] ?? trimmedFeedUrl;
  if (normalizedFeedUrl !== next.feedUrl) {
    next = { ...next, feedUrl: normalizedFeedUrl };
    changed = true;
  }

  const legacyOverride = LEGACY_SUBSCRIPTION_OVERRIDES[next.id];
  if (legacyOverride) {
    if (next.feedUrl !== legacyOverride.feedUrl || next.checkInterval !== legacyOverride.checkInterval) {
      next = {
        ...next,
        feedUrl: legacyOverride.feedUrl,
        checkInterval: legacyOverride.checkInterval,
      };
      changed = true;
    }
  }

  return { subscription: next, changed };
}

function parseSubscription(raw: string | null): { subscription: Subscription; changed: boolean } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeSubscription(parsed);
    if (!normalized) return null;
    return normalizeLegacySubscription(normalized);
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

  const parsed = Object.entries(map)
    .map(([id, value]) => ({ id, parsed: parseSubscription(value) }))
    .filter(
      (item): item is { id: string; parsed: { subscription: Subscription; changed: boolean } } =>
        item.parsed !== null
    );

  const migrated = parsed.filter((item) => item.parsed.changed);
  if (migrated.length > 0) {
    await Promise.all(
      migrated.map((item) =>
        redis.hset(
          SUBSCRIPTIONS_REDIS_KEY,
          item.id,
          serializeSubscription(item.parsed.subscription)
        )
      )
    );
  }

  const subscriptions = parsed
    .map((item) => item.parsed.subscription)
    .sort((a, b) => a.name.localeCompare(b.name));

  return subscriptions;
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const redis = getRedisClient();
  const raw = await redis.hget(SUBSCRIPTIONS_REDIS_KEY, id);
  const parsed = parseSubscription(raw);
  if (!parsed) return null;

  if (parsed.changed) {
    await redis.hset(
      SUBSCRIPTIONS_REDIS_KEY,
      id,
      serializeSubscription(parsed.subscription)
    );
  }

  return parsed.subscription;
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
