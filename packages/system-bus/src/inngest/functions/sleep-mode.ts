import { NonRetriableError } from "inngest";
import { infer } from "../../lib/inference";
import { getRedisClient } from "../../lib/redis";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const SYSTEM_SLEEP_KEY = "system:sleep";
const SLEEP_QUEUE_KEY = "sleep:queue";
const MAX_DIGEST_ITEMS = 200;
const WAKE_DIGEST_SYSTEM_PROMPT =
  "You are summarizing queued system events for Joel. Group by source, highlight actionable items, summarize noise into counts. Be concise — this is read on mobile.";

type SleepState = {
  since: string;
  reason?: string;
  duration?: string;
};

type SleepQueueItem = {
  event: string;
  timestamp: string;
  summary: string;
};

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseDurationToSeconds(input: string): number | null {
  const compact = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!compact) return null;

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
  };

  const matches = Array.from(compact.matchAll(/(\d+)([smhdw])/g));
  if (matches.length === 0) return null;

  let consumed = "";
  let totalSeconds = 0;

  for (const match of matches) {
    const amountRaw = match[1];
    const unit = match[2];
    if (!amountRaw || !unit) return null;

    const amount = Number.parseInt(amountRaw, 10);
    const multiplier = multipliers[unit];
    if (!Number.isFinite(amount) || amount <= 0 || !multiplier) return null;

    totalSeconds += amount * multiplier;
    consumed += match[0];
  }

  if (consumed.length !== compact.length) return null;
  return totalSeconds > 0 ? totalSeconds : null;
}

function parseSleepState(raw: string | null): SleepState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const since = readOptionalString(parsed.since);
    if (!since) return null;
    const reason = readOptionalString(parsed.reason);
    const duration = readOptionalString(parsed.duration);
    return {
      since,
      ...(reason ? { reason } : {}),
      ...(duration ? { duration } : {}),
    };
  } catch {
    return null;
  }
}

function parseSleepQueueItem(raw: string): SleepQueueItem {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const event = readOptionalString(parsed.event) ?? "unknown";
    const timestamp = readOptionalString(parsed.timestamp) ?? new Date().toISOString();
    const summary = readOptionalString(parsed.summary) ?? event;
    return { event, timestamp, summary };
  } catch {
    return {
      event: "unknown",
      timestamp: new Date().toISOString(),
      summary: raw.slice(0, 220),
    };
  }
}

function getSourceFromEventName(eventName: string): string {
  const token = eventName.split(/[/.]/)[0]?.trim();
  return token && token.length > 0 ? token : "system";
}

function formatSleepDuration(sinceIso: string | undefined): string | undefined {
  if (!sinceIso) return undefined;
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return undefined;

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function buildDigestPrompt(items: SleepQueueItem[], sleepState: SleepState | null): string {
  const limitedItems = items.slice(0, MAX_DIGEST_ITEMS);
  const omitted = Math.max(0, items.length - limitedItems.length);
  const sleptFor = formatSleepDuration(sleepState?.since);

  const lines = limitedItems.map((item, index) => {
    const source = getSourceFromEventName(item.event);
    return `${index + 1}. [${item.timestamp}] source=${source} event=${item.event} summary=${item.summary}`;
  });

  return [
    "Queued system events:",
    ...lines,
    omitted > 0 ? `Additional events omitted from prompt: ${omitted}` : "",
    "",
    "Sleep metadata:",
    `- since: ${sleepState?.since ?? "unknown"}`,
    `- reason: ${sleepState?.reason ?? "unspecified"}`,
    `- requestedDuration: ${sleepState?.duration ?? "unspecified"}`,
    sleptFor ? `- elapsed: ${sleptFor}` : "- elapsed: unknown",
    "",
    "Write a concise wake digest for mobile reading.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFallbackDigest(items: SleepQueueItem[], sleepState: SleepState | null): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const source = getSourceFromEventName(item.event);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  const topSources = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const sleptFor = formatSleepDuration(sleepState?.since);

  const lines = [
    `Queued events while sleeping: ${items.length}`,
    sleptFor ? `Sleep duration: ${sleptFor}` : "",
    "By source:",
    ...topSources.map(([source, count]) => `- ${source}: ${count}`),
    "",
    "Sample items:",
    ...items.slice(0, 6).map((item) => `- ${item.summary}`),
  ].filter(Boolean);

  return lines.join("\n");
}

export const sleepModeRequested = inngest.createFunction(
  {
    id: "system-sleep-requested",
    name: "System: Sleep Mode Requested",
  },
  { event: "system/sleep.requested" },
  async ({ event, step }) => {
    const reason = readOptionalString(event.data.reason);
    const duration = readOptionalString(event.data.duration);

    const ttlSeconds = duration ? parseDurationToSeconds(duration) : null;
    if (duration && !ttlSeconds) {
      throw new NonRetriableError(
        `Invalid sleep duration "${duration}". Use values like 30m, 2h, 1d, or 1h30m.`
      );
    }

    const sleepState = await step.run("set-system-sleep-key", async () => {
      const redis = getRedisClient();
      const state: SleepState = {
        since: new Date().toISOString(),
        ...(reason ? { reason } : {}),
        ...(duration ? { duration } : {}),
      };
      const payload = JSON.stringify(state);

      if (ttlSeconds) {
        await redis.set(SYSTEM_SLEEP_KEY, payload, "EX", ttlSeconds);
      } else {
        await redis.set(SYSTEM_SLEEP_KEY, payload);
      }

      return {
        ...state,
        ttlSeconds: ttlSeconds ?? null,
      };
    });

    await step.run("notify-gateway-sleep-activated", async () => {
      const contextBits: string[] = [];
      if (sleepState.duration) contextBits.push(`for ${sleepState.duration}`);
      if (sleepState.reason) contextBits.push(`reason: ${sleepState.reason}`);

      const suffix = contextBits.length > 0 ? ` (${contextBits.join(", ")})` : "";
      await pushGatewayEvent({
        type: "system.sleep.activated",
        source: "inngest/sleep-mode",
        payload: {
          message: `🌙 Sleep mode activated${suffix}`,
          since: sleepState.since,
          reason: sleepState.reason,
          duration: sleepState.duration,
          ttlSeconds: sleepState.ttlSeconds,
        },
      });
    });

    return {
      sleeping: true,
      since: sleepState.since,
      reason: sleepState.reason,
      duration: sleepState.duration,
      ttlSeconds: sleepState.ttlSeconds,
    };
  }
);

export const wakeModeRequested = inngest.createFunction(
  {
    id: "system-wake-requested",
    name: "System: Wake Mode Requested",
  },
  { event: "system/wake.requested" },
  async ({ step }) => {
    const previousSleepStateRaw = await step.run("clear-system-sleep-key", async () => {
      const redis = getRedisClient();
      const current = await redis.get(SYSTEM_SLEEP_KEY);
      await redis.del(SYSTEM_SLEEP_KEY);
      return current;
    });

    const queuedRaw = await step.run("drain-sleep-queue", async () => {
      const redis = getRedisClient();
      const rows = await redis.lrange(SLEEP_QUEUE_KEY, 0, -1);
      await redis.del(SLEEP_QUEUE_KEY);
      return rows;
    });

    const sleepState = parseSleepState(previousSleepStateRaw);
    const queuedItems = queuedRaw.map(parseSleepQueueItem);

    if (queuedItems.length === 0) {
      await step.run("notify-gateway-wake-empty", async () => {
        await pushGatewayEvent({
          type: "system.sleep.woke",
          source: "inngest/sleep-mode",
          payload: {
            message: "☀️ Woke up — nothing queued",
            sleptFor: formatSleepDuration(sleepState?.since),
            since: sleepState?.since,
            reason: sleepState?.reason,
          },
        });
      });

      return {
        sleeping: false,
        queuedCount: 0,
        digestSynthesized: false,
      };
    }

    const digest = await step.run("synthesize-wake-digest", async () => {
      const prompt = buildDigestPrompt(queuedItems, sleepState);

      try {
        const result = await infer(prompt, {
          system: WAKE_DIGEST_SYSTEM_PROMPT,
          timeout: 120_000,
        });
        const text = result.text.trim();
        if (text.length > 0) {
          return { text, synthesized: true };
        }
      } catch (error) {
        console.warn(`[sleep-mode] digest inference failed: ${error}`);
      }

      return {
        text: buildFallbackDigest(queuedItems, sleepState),
        synthesized: false,
      };
    });

    await step.run("notify-gateway-wake-digest", async () => {
      await pushGatewayEvent({
        type: "system.sleep.digest",
        source: "inngest/sleep-mode",
        payload: {
          message: `☀️ Wake Digest\n\n${digest.text}`,
          queuedCount: queuedItems.length,
          synthesized: digest.synthesized,
          sleptFor: formatSleepDuration(sleepState?.since),
          since: sleepState?.since,
          reason: sleepState?.reason,
        },
      });
    });

    return {
      sleeping: false,
      queuedCount: queuedItems.length,
      digestSynthesized: digest.synthesized,
    };
  }
);
