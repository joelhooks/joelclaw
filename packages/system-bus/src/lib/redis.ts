import Redis from "ioredis";

const DEFAULT_REDIS_PORT = 6379;

let cachedRedisPort: number | null = null;
let redisClient: Redis | null = null;

function parseRedisPortValue(raw: string | undefined): number | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }

  return null;
}

function parseRedisPortFromUrl(rawUrl: string | undefined): number | null {
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    if (!parsed.port) return null;

    return parseRedisPortValue(parsed.port);
  } catch {
    return null;
  }
}

export function getRedisPort(): number {
  if (cachedRedisPort !== null) return cachedRedisPort;

  const direct = parseRedisPortValue(process.env.REDIS_PORT);
  const fromUrl = parseRedisPortFromUrl(process.env.REDIS_URL);

  const resolved = direct ?? fromUrl ?? DEFAULT_REDIS_PORT;
  cachedRedisPort = resolved;

  return resolved;
}

export function getRedisClient(): Redis {
  if (redisClient) return redisClient;

  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: getRedisPort(),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});

  return redisClient;
}
