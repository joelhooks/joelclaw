import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getRedisClient } from "./redis";

type CacheTier = "hot" | "warm" | "cold";

export interface CacheOptions {
  hotTtlSeconds?: number;
  warmTtlSeconds?: number;
  tier?: CacheTier;
  namespace?: string;
}

type ResolvedCacheOptions = {
  hotTtlSeconds: number;
  warmTtlSeconds: number;
  tier: CacheTier;
  namespace: string;
};

type CacheEnvelope<T> = {
  cached_at_ms: number;
  value: T;
};

const DEFAULT_HOT_TTL_SECONDS = 300;
const DEFAULT_WARM_TTL_SECONDS = 3600;
const DEFAULT_NAMESPACE = "default";
const WARM_CACHE_ROOT = path.join(os.homedir(), ".cache", "joelclaw");
const COLD_CACHE_ROOT = "/Volumes/nas-nvme/cache/joelclaw";
const NAS_MOUNT_PATH = "/Volumes/nas-nvme";
const NAS_MOUNT_CHECK_TTL_MS = 30_000;

let nasMountedMemo: { mounted: boolean; checkedAtMs: number } | null = null;

function normalizeNamespace(namespace?: string): string {
  const trimmed = namespace?.trim();
  if (!trimmed) return DEFAULT_NAMESPACE;

  const normalized = trimmed.replace(/[^a-zA-Z0-9._:-]/g, "-");
  return normalized.length > 0 ? normalized : DEFAULT_NAMESPACE;
}

function resolveOptions(options?: CacheOptions): ResolvedCacheOptions {
  return {
    hotTtlSeconds: options?.hotTtlSeconds ?? DEFAULT_HOT_TTL_SECONDS,
    warmTtlSeconds: options?.warmTtlSeconds ?? DEFAULT_WARM_TTL_SECONDS,
    tier: options?.tier ?? "hot",
    namespace: normalizeNamespace(options?.namespace),
  };
}

function resolveTierChain(tier: CacheTier): CacheTier[] {
  if (tier === "cold") return ["hot", "warm", "cold"];
  if (tier === "warm") return ["hot", "warm"];
  return ["hot"];
}

function redisKey(namespace: string, key: string): string {
  return `cache:${namespace}:${key}`;
}

function encodedFileKey(key: string): string {
  return encodeURIComponent(key);
}

function warmFilePath(namespace: string, key: string): string {
  return path.join(WARM_CACHE_ROOT, namespace, `${encodedFileKey(key)}.json`);
}

function coldFilePath(namespace: string, key: string): string {
  return path.join(COLD_CACHE_ROOT, namespace, `${encodedFileKey(key)}.json`);
}

function logCacheEvent(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...payload }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function ageSecondsFromMs(cachedAtMs: number): number {
  return Math.max(0, Math.floor((Date.now() - cachedAtMs) / 1000));
}

function parseEnvelope<T>(raw: unknown, fallbackCachedAtMs: number): CacheEnvelope<T> {
  if (!isRecord(raw)) {
    return { value: raw as T, cached_at_ms: fallbackCachedAtMs };
  }

  if ("value" in raw) {
    const cachedAtMs =
      typeof raw.cached_at_ms === "number" && Number.isFinite(raw.cached_at_ms)
        ? raw.cached_at_ms
        : typeof raw.cached_at === "number" && Number.isFinite(raw.cached_at)
          ? raw.cached_at > 1_000_000_000_000
            ? raw.cached_at
            : raw.cached_at * 1000
          : fallbackCachedAtMs;

    return {
      value: raw.value as T,
      cached_at_ms: cachedAtMs,
    };
  }

  return { value: raw as T, cached_at_ms: fallbackCachedAtMs };
}

async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data), "utf8");
  await rename(tmpPath, filePath);
}

async function readFileCache<T>(filePath: string, ttlSeconds: number): Promise<{ value: T; ageSeconds: number } | null> {
  try {
    const [rawText, fileStats] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath),
    ]);
    const parsed = JSON.parse(rawText) as unknown;
    const envelope = parseEnvelope<T>(parsed, fileStats.mtimeMs);
    const ageSeconds = ageSecondsFromMs(envelope.cached_at_ms);
    if (ageSeconds > ttlSeconds) {
      await rm(filePath, { force: true }).catch(() => {});
      return null;
    }
    return { value: envelope.value, ageSeconds };
  } catch {
    return null;
  }
}

async function isNasMounted(): Promise<boolean> {
  const now = Date.now();
  if (nasMountedMemo && now - nasMountedMemo.checkedAtMs < NAS_MOUNT_CHECK_TTL_MS) {
    return nasMountedMemo.mounted;
  }

  try {
    await access(NAS_MOUNT_PATH);
    nasMountedMemo = { mounted: true, checkedAtMs: now };
    return true;
  } catch {
    nasMountedMemo = { mounted: false, checkedAtMs: now };
    return false;
  }
}

export async function cacheGet<T>(key: string, opts?: CacheOptions): Promise<T | null> {
  const options = resolveOptions(opts);
  const tiers = resolveTierChain(options.tier);
  const keyForRedis = redisKey(options.namespace, key);

  if (tiers.includes("hot")) {
    try {
      const redis = getRedisClient();
      const raw = await redis.get(keyForRedis);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        const envelope = parseEnvelope<T>(parsed, Date.now());
        const ageSeconds = ageSecondsFromMs(envelope.cached_at_ms);
        logCacheEvent("cache.hit", {
          key,
          namespace: options.namespace,
          tier: "hot",
          age_seconds: ageSeconds,
        });
        return envelope.value;
      }
    } catch {}
  }

  if (tiers.includes("warm")) {
    const warmPath = warmFilePath(options.namespace, key);
    const hit = await readFileCache<T>(warmPath, options.warmTtlSeconds);
    if (hit) {
      logCacheEvent("cache.hit", {
        key,
        namespace: options.namespace,
        tier: "warm",
        age_seconds: hit.ageSeconds,
      });

      if (tiers.includes("hot")) {
        const envelope: CacheEnvelope<T> = { cached_at_ms: Date.now(), value: hit.value };
        try {
          await getRedisClient().set(
            keyForRedis,
            JSON.stringify(envelope),
            "EX",
            options.hotTtlSeconds
          );
        } catch {}
      }

      return hit.value;
    }
  }

  if (tiers.includes("cold")) {
    if (await isNasMounted()) {
      const coldPath = coldFilePath(options.namespace, key);
      const hit = await readFileCache<T>(coldPath, options.warmTtlSeconds);
      if (hit) {
        logCacheEvent("cache.hit", {
          key,
          namespace: options.namespace,
          tier: "cold",
          age_seconds: hit.ageSeconds,
        });

        const envelope: CacheEnvelope<T> = { cached_at_ms: Date.now(), value: hit.value };
        if (tiers.includes("warm")) {
          await writeJsonFileAtomic(warmFilePath(options.namespace, key), envelope).catch(() => {});
        }
        if (tiers.includes("hot")) {
          await getRedisClient()
            .set(keyForRedis, JSON.stringify(envelope), "EX", options.hotTtlSeconds)
            .catch(() => {});
        }

        return hit.value;
      }
    }
  }

  logCacheEvent("cache.miss", {
    key,
    namespace: options.namespace,
    tier: options.tier,
  });
  return null;
}

export async function cacheSet<T>(key: string, value: T, opts?: CacheOptions): Promise<void> {
  const options = resolveOptions(opts);
  const tiers = resolveTierChain(options.tier);
  const envelope: CacheEnvelope<T> = {
    cached_at_ms: Date.now(),
    value,
  };

  if (tiers.includes("hot")) {
    await getRedisClient()
      .set(
        redisKey(options.namespace, key),
        JSON.stringify(envelope),
        "EX",
        options.hotTtlSeconds
      )
      .catch(() => {});
  }

  if (tiers.includes("warm")) {
    await writeJsonFileAtomic(
      warmFilePath(options.namespace, key),
      envelope
    ).catch(() => {});
  }

  if (tiers.includes("cold") && (await isNasMounted())) {
    await writeJsonFileAtomic(
      coldFilePath(options.namespace, key),
      envelope
    ).catch(() => {});
  }
}

export async function cacheInvalidate(key: string, opts?: CacheOptions): Promise<void> {
  const options = resolveOptions(opts);
  const tiers = resolveTierChain(options.tier);

  if (tiers.includes("hot")) {
    await getRedisClient()
      .del(redisKey(options.namespace, key))
      .catch(() => {});
  }

  if (tiers.includes("warm")) {
    await rm(warmFilePath(options.namespace, key), { force: true }).catch(() => {});
  }

  if (tiers.includes("cold") && (await isNasMounted())) {
    await rm(coldFilePath(options.namespace, key), { force: true }).catch(() => {});
  }

  logCacheEvent("cache.invalidate", {
    key,
    namespace: options.namespace,
    tier: options.tier,
  });
}

export async function cacheWrap<T>(
  key: string,
  opts: CacheOptions,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = await cacheGet<T>(key, opts);
  if (cached !== null) return cached;

  const value = await fetcher();
  await cacheSet(key, value, opts);
  return value;
}

export async function invalidatePattern(pattern: string): Promise<number> {
  const redis = getRedisClient();
  const scanPattern = pattern.startsWith("cache:") ? pattern : `cache:${pattern}`;
  let cursor = "0";
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", scanPattern, "COUNT", "100");
    cursor = nextCursor;
    if (keys.length > 0) {
      deleted += keys.length;
      await redis.del(...keys);
    }
  } while (cursor !== "0");

  logCacheEvent("cache.invalidate_pattern", {
    pattern: scanPattern,
    deleted,
  });

  return deleted;
}

export const cache = {
  get: cacheGet,
  set: cacheSet,
  invalidate: cacheInvalidate,
  wrap: cacheWrap,
  invalidatePattern,
};
