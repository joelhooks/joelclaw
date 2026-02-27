import { createHmac } from "node:crypto";
import { $ } from "bun";
import Redis from "ioredis";
import { getRedisPort } from "../../lib/redis";
import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";

const X_CREATE_POST_URL = "https://api.twitter.com/2/tweets";
const DAILY_CAP = 5;
const DAILY_TTL_SECONDS = 86400;
const COOLDOWN_SECONDS = 1800;
const DAILY_KEY_PREFIX = "joelclaw:x:daily";
const COOLDOWN_KEY = "joelclaw:x:cooldown";
const URLS_KEY = "joelclaw:x:urls";
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = getRedisPort();

type PostCategory = "post" | "adr" | "discovery" | "digest";

type PostRequestedData = {
  text: string;
  url?: string;
  category?: PostCategory;
};

type GuardrailReservation = {
  dailyKey: string;
  dailyReserved: boolean;
  cooldownReserved: boolean;
  urlReserved: boolean;
  url?: string;
};

type GuardrailResult = {
  allowed: boolean;
  reason?: string;
  reservation: GuardrailReservation;
};

type TwitterCredentials = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

type OAuthToken = { key: string; secret: string };

type OAuthRequest = {
  url: string;
  method: string;
};

type OAuthConfig = {
  consumer: { key: string; secret: string };
  signature_method: "HMAC-SHA1";
  hash_function: (baseString: string, key: string) => string;
};

interface OAuthClient {
  authorize(request: OAuthRequest, token?: OAuthToken): Record<string, string>;
}

interface OAuthConstructor {
  new (config: OAuthConfig): OAuthClient;
}

function getDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function createRedis(): Redis {
  return new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    commandTimeout: 5000,
  });
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function buildOAuthAuthorizationHeader(params: Record<string, string>): string {
  const parts = Object.entries(params)
    .filter(([key]) => key.startsWith("oauth_"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`);

  return `OAuth ${parts.join(", ")}`;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function twitterErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback.slice(0, 500);
  }

  const record = payload as Record<string, unknown>;
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const firstError =
    errors.length > 0 && typeof errors[0] === "object" && errors[0] !== null
      ? (errors[0] as Record<string, unknown>)
      : undefined;

  const detail =
    typeof firstError?.detail === "string"
      ? firstError.detail
      : typeof firstError?.message === "string"
        ? firstError.message
        : typeof record.detail === "string"
          ? record.detail
          : typeof record.title === "string"
            ? record.title
            : undefined;

  return detail ?? fallback.slice(0, 500);
}

function tweetUrl(tweetId: string): string {
  return `https://x.com/joelclaw/status/${tweetId}`;
}

async function leaseSecret(name: string): Promise<string> {
  const secret = await $`secrets lease ${name}`.text().then((s) => s.trim());
  if (!secret) {
    throw new Error(`secrets lease returned empty value for ${name}`);
  }
  return secret;
}

async function leaseTwitterCredentials(): Promise<TwitterCredentials> {
  const [consumerKey, consumerSecret, accessToken, accessTokenSecret] = await Promise.all([
    leaseSecret("x_consumer_key"),
    leaseSecret("x_consumer_secret"),
    leaseSecret("x_access_token"),
    leaseSecret("x_access_token_secret"),
  ]);

  return {
    consumerKey,
    consumerSecret,
    accessToken,
    accessTokenSecret,
  };
}

async function loadOAuthConstructor(): Promise<OAuthConstructor | null> {
  const moduleName = "oauth-1.0a";
  try {
    const imported = (await import(moduleName)) as { default?: OAuthConstructor };
    const ctor = imported.default;
    if (typeof ctor === "function") {
      return ctor;
    }
  } catch {
    // No-op: fallback signer below handles environments without the package.
  }

  return null;
}

function canonicalRequestUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const isDefaultPort =
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80") ||
    parsed.port === "";

  return `${parsed.protocol}//${parsed.hostname}${isDefaultPort ? "" : `:${parsed.port}`}${parsed.pathname}`;
}

function oauthParameterString(
  oauthParams: Record<string, string>,
  requestUrl: string
): string {
  const queryPairs = Array.from(new URL(requestUrl).searchParams.entries());
  const oauthPairs = Object.entries(oauthParams);
  const allPairs = [...queryPairs, ...oauthPairs]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey)
    );

  return allPairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function buildFallbackOAuthParams(
  request: OAuthRequest,
  token: OAuthToken,
  credentials: TwitterCredentials
): Record<string, string> {
  const params: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: `${Date.now()}${Math.random().toString(16).slice(2)}`,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token.key,
    oauth_version: "1.0",
  };

  const baseString = [
    request.method.toUpperCase(),
    percentEncode(canonicalRequestUrl(request.url)),
    percentEncode(oauthParameterString(params, request.url)),
  ].join("&");

  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(token.secret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  return {
    ...params,
    oauth_signature: signature,
  };
}

async function authorizeOAuthRequest(
  request: OAuthRequest,
  token: OAuthToken,
  credentials: TwitterCredentials
): Promise<Record<string, string>> {
  const OAuth = await loadOAuthConstructor();
  if (!OAuth) {
    return buildFallbackOAuthParams(request, token, credentials);
  }

  const oauth = new OAuth({
    consumer: {
      key: credentials.consumerKey,
      secret: credentials.consumerSecret,
    },
    signature_method: "HMAC-SHA1",
    hash_function(baseString: string, key: string): string {
      return createHmac("sha1", key).update(baseString).digest("base64");
    },
  });

  return oauth.authorize(request, token);
}

async function rollbackGuardrailReservation(
  redis: Redis,
  reservation: GuardrailReservation
): Promise<void> {
  if (reservation.urlReserved && reservation.url) {
    await redis.srem(URLS_KEY, reservation.url);
    reservation.urlReserved = false;
  }

  if (reservation.cooldownReserved) {
    await redis.del(COOLDOWN_KEY);
    reservation.cooldownReserved = false;
  }

  if (reservation.dailyReserved) {
    const remaining = await redis.decr(reservation.dailyKey);
    if (remaining <= 0) {
      await redis.del(reservation.dailyKey);
    }
    reservation.dailyReserved = false;
  }
}

async function reserveGuardrails(redis: Redis, url?: string): Promise<GuardrailResult> {
  const reservation: GuardrailReservation = {
    dailyKey: `${DAILY_KEY_PREFIX}:${getDateKey()}`,
    dailyReserved: false,
    cooldownReserved: false,
    urlReserved: false,
    url,
  };

  if (url) {
    const alreadyPosted = await redis.sismember(URLS_KEY, url);
    if (alreadyPosted === 1) {
      return {
        allowed: false,
        reason: `URL already posted: ${url}`,
        reservation,
      };
    }
  }

  const count = await redis.incr(reservation.dailyKey);
  reservation.dailyReserved = true;
  if (count === 1) {
    await redis.expire(reservation.dailyKey, DAILY_TTL_SECONDS);
  }

  if (count > DAILY_CAP) {
    await rollbackGuardrailReservation(redis, reservation);
    return {
      allowed: false,
      reason: `Daily cap reached (${DAILY_CAP}/${DAILY_CAP})`,
      reservation,
    };
  }

  const cooldownLock = await redis.set(
    COOLDOWN_KEY,
    new Date().toISOString(),
    "EX",
    COOLDOWN_SECONDS,
    "NX"
  );
  if (cooldownLock !== "OK") {
    await rollbackGuardrailReservation(redis, reservation);
    return {
      allowed: false,
      reason: "Cooldown active (30m)",
      reservation,
    };
  }
  reservation.cooldownReserved = true;

  if (url) {
    const added = await redis.sadd(URLS_KEY, url);
    if (added === 0) {
      await rollbackGuardrailReservation(redis, reservation);
      return {
        allowed: false,
        reason: `URL already posted: ${url}`,
        reservation,
      };
    }
    reservation.urlReserved = true;
  }

  return { allowed: true, reservation };
}

async function postTweet(
  text: string,
  credentials: TwitterCredentials
): Promise<{ tweetId: string; url: string }> {
  const request: OAuthRequest = {
    url: X_CREATE_POST_URL,
    method: "POST",
  };
  const token: OAuthToken = {
    key: credentials.accessToken,
    secret: credentials.accessTokenSecret,
  };
  const authParams = await authorizeOAuthRequest(request, token, credentials);

  const authorization = buildOAuthAuthorizationHeader(authParams);
  const response = await fetch(X_CREATE_POST_URL, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const rawBody = await response.text();
  const parsedBody = parseJson(rawBody);

  if (!response.ok) {
    throw new Error(`X API ${response.status}: ${twitterErrorMessage(parsedBody, rawBody)}`);
  }

  const tweetId =
    parsedBody &&
    typeof parsedBody === "object" &&
    "data" in parsedBody &&
    parsedBody.data &&
    typeof parsedBody.data === "object" &&
    "id" in parsedBody.data &&
    typeof parsedBody.data.id === "string"
      ? parsedBody.data.id
      : null;

  if (!tweetId) {
    throw new Error("X API response missing tweet id");
  }

  return {
    tweetId,
    url: tweetUrl(tweetId),
  };
}

export const xPost = inngest.createFunction(
  {
    id: "x-post",
    name: "X Post",
    retries: 0,
    concurrency: { limit: 1, key: "x-post" },
  },
  { event: "x/post.requested" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as { gateway?: GatewayContext }).gateway;
    const payload = event.data as PostRequestedData;
    const text = payload.text.trim();
    const category = payload.category ?? "post";
    const redis = createRedis();
    let reservation: GuardrailReservation | undefined;

    if (!text) {
      return { status: "skipped", reason: "empty tweet text" };
    }

    try {
      const guardrailResult = await step.run("guardrails-reserve", () =>
        reserveGuardrails(redis, payload.url)
      );
      reservation = guardrailResult.reservation;

      if (!guardrailResult.allowed) {
        if (gateway) {
          await gateway.notify(`🐦 Tweet skipped: ${guardrailResult.reason ?? "guardrail blocked"}`);
        }
        return {
          status: "skipped",
          reason: guardrailResult.reason ?? "guardrail blocked",
        };
      }

      const credentials = await step.run("lease-x-secrets", leaseTwitterCredentials);
      const posted = await step.run("post-x-tweet", () => postTweet(text, credentials));

      await step.sendEvent("emit-x-post-completed", {
        name: "x/post.completed",
        data: {
          tweetId: posted.tweetId,
          tweetUrl: posted.url,
          text,
          url: payload.url,
          category,
        },
      });

      if (gateway) {
        await gateway.notify(`🐦 Tweet posted: ${text}`);
      }

      return {
        status: "posted",
        tweetId: posted.tweetId,
        tweetUrl: posted.url,
        category,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (reservation) {
        await rollbackGuardrailReservation(redis, reservation);
      }

      if (gateway) {
        await gateway.notify(`🐦 Tweet failed: ${message}`);
      }

      return {
        status: "failed",
        error: message,
      };
    } finally {
      redis.disconnect();
    }
  }
);
