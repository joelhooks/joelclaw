import {
  clickHouseClientLayer,
  type JournalEvent,
  MessageJournalQuery,
  messageJournalQueryLayer,
  resolveMessageJournalConnection,
} from "@joelclaw/message-journal";
// @joelclaw/message-journal owns the Effect runtime used by its services.
import { Effect, Layer } from "@joelclaw/message-journal/node_modules/effect";
import Redis from "ioredis";
import { getRedisPort } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

export const TELEGRAM_SIGNAL_CONTENT_KINDS = [
  "memory",
  "action",
  "reminder",
  "escalation",
  "recovery-receipt",
] as const;

export type TelegramSignalContentKind =
  (typeof TELEGRAM_SIGNAL_CONTENT_KINDS)[number];

export const NOISE_RATE_TARGET = 0.1;
export const NOISE_RATE_WINDOW = "24h";
export const NOISE_RATE_QUERY_LIMIT = 1_000;

const DIGEST_QUEUE = "joelclaw:telegram:signal-digest";
const DIGEST_COOLDOWN_KEY = "joelclaw:telegram:noise-rate-guard:digest-cooldown";
const DIGEST_COOLDOWN_SECONDS = 24 * 60 * 60;
export const ENQUEUE_DIGEST_ATOMIC_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
redis.call("RPUSH", KEYS[2], ARGV[1])
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1
`;
const CONVERSATION_REPLY_REASON =
  "deliver.exempt.joel-initiated-conversation-reply";
const CANARY_MARKER = /(?:^|[./:_-])(canary|telegram-flow-audit)(?:$|[./:_-])/iu;
const CONTENT_KIND_SET = new Set<string>(TELEGRAM_SIGNAL_CONTENT_KINDS);

export type NoiseRateGuardReport = {
  window: string;
  target: number;
  denominator: number;
  nonActionable: number;
  nonActionableRate: number;
  breached: boolean;
  excludedCanaries: number;
  excludedConversationReplies: number;
  duplicateLifecycleRows: number;
  queriedRows: number;
  queryLimitReached: boolean;
  measurementComplete: boolean;
  classificationCounts: Record<string, number>;
};

export type NoiseRateDigestItem = {
  owner: "agent";
  kind: "investigation";
  candidate: {
    content: string;
    producer: "telegram-noise-rate-guard";
    sourceEventType: "telegram/noise-rate.breached";
    auditLineage: {
      signalId: string;
    };
  };
  decision: {
    disposition: "digest";
    category: "action";
    reason: "digest.agent-owned-noise-rate-investigation";
    producer: "telegram-noise-rate-guard";
  };
  report: NoiseRateGuardReport;
  queuedAt: string;
};

export type NoiseRateDigestRedis = {
  eval(
    script: string,
    keyCount: number,
    ...args: ReadonlyArray<string>
  ): Promise<unknown>;
};

export type NoiseRateGuardDependencies = {
  measureNoiseRate(window: string): Promise<NoiseRateGuardReport>;
  enqueueDigestItem(item: NoiseRateDigestItem): Promise<{ queued: boolean }>;
  emitReport(
    report: NoiseRateGuardReport,
    digest: { queued: boolean } | undefined,
  ): Promise<void>;
  now(): Date;
};

function isTelegramChannel(channel: string): boolean {
  return channel === "telegram" || channel.startsWith("telegram:");
}

function isCanary(row: JournalEvent): boolean {
  return [
    row.flow_id,
    row.message_key,
    row.producer,
    row.origin_system_id,
    row.source_event_id ?? "",
    row.source_ref,
    row.route,
    row.reason,
  ].some((value) => CANARY_MARKER.test(value));
}

function deliveryIdentity(row: JournalEvent): string {
  if (row.telegram_message_id !== null) {
    return `${row.telegram_chat_id}:${row.telegram_message_id}`;
  }
  return `${row.flow_id}:${row.chunk_index ?? 0}`;
}

function isNewerDelivery(candidate: JournalEvent, current: JournalEvent): boolean {
  // A revision is a newer visible message state. Attempt only orders retries
  // within that revision, so revision intentionally wins when they cross.
  if (candidate.revision !== current.revision) {
    return candidate.revision > current.revision;
  }
  if (candidate.attempt !== current.attempt) {
    return candidate.attempt > current.attempt;
  }
  return candidate.occurred_at > current.occurred_at;
}

export function computeNoiseRate(
  rows: ReadonlyArray<JournalEvent>,
  options: {
    window?: string;
    target?: number;
    queryLimit?: number;
  } = {},
): NoiseRateGuardReport {
  const deliveries = new Map<string, JournalEvent>();
  let duplicateLifecycleRows = 0;

  for (const row of rows) {
    if (
      row.direction !== "outbound"
      || !isTelegramChannel(row.channel)
      || row.event_type !== "delivery.confirmed"
    ) {
      continue;
    }

    const identity = deliveryIdentity(row);
    const current = deliveries.get(identity);
    if (!current || isNewerDelivery(row, current)) {
      if (current) duplicateLifecycleRows += 1;
      deliveries.set(identity, row);
    } else {
      duplicateLifecycleRows += 1;
    }
  }

  let excludedCanaries = 0;
  let excludedConversationReplies = 0;
  let nonActionable = 0;
  const classificationCounts: Record<string, number> = {};

  for (const row of deliveries.values()) {
    if (isCanary(row)) {
      excludedCanaries += 1;
      continue;
    }
    if (row.reason === CONVERSATION_REPLY_REASON) {
      excludedConversationReplies += 1;
      continue;
    }

    const rawClassification = row.classification.trim();
    const classification = CONTENT_KIND_SET.has(rawClassification)
      ? rawClassification
      : "other";
    classificationCounts[classification] =
      (classificationCounts[classification] ?? 0) + 1;
    if (classification === "other") nonActionable += 1;
  }

  const denominator = Object.values(classificationCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const nonActionableRate = denominator === 0 ? 0 : nonActionable / denominator;
  const target = options.target ?? NOISE_RATE_TARGET;
  const queryLimit = options.queryLimit ?? NOISE_RATE_QUERY_LIMIT;
  const queryLimitReached = rows.length >= queryLimit;
  const measurementComplete = !queryLimitReached;

  return {
    window: options.window ?? NOISE_RATE_WINDOW,
    target,
    denominator,
    nonActionable,
    nonActionableRate,
    breached:
      measurementComplete && denominator > 0 && nonActionableRate >= target,
    excludedCanaries,
    excludedConversationReplies,
    duplicateLifecycleRows,
    queriedRows: rows.length,
    queryLimitReached,
    measurementComplete,
    classificationCounts,
  };
}

export function buildNoiseRateDigestItem(
  report: NoiseRateGuardReport,
  queuedAt: Date,
): NoiseRateDigestItem {
  const percent = (report.nonActionableRate * 100).toFixed(1);
  const targetPercent = (report.target * 100).toFixed(1);
  const queuedAtIso = queuedAt.toISOString();

  return {
    owner: "agent",
    kind: "investigation",
    candidate: {
      content:
        `Investigate Telegram noise-rate breach: ${report.nonActionable}/${report.denominator} `
        + `included outbound messages were outside the five-kind contract (${percent}%; target <${targetPercent}%).`,
      producer: "telegram-noise-rate-guard",
      sourceEventType: "telegram/noise-rate.breached",
      auditLineage: {
        signalId: `telegram-noise-rate:${queuedAtIso}`,
      },
    },
    decision: {
      disposition: "digest",
      category: "action",
      reason: "digest.agent-owned-noise-rate-investigation",
      producer: "telegram-noise-rate-guard",
    },
    report,
    queuedAt: queuedAtIso,
  };
}

let queryPromise: Promise<
  (window: string) => Promise<ReadonlyArray<JournalEvent>>
> | undefined;

async function createJournalLoader(): Promise<
  (window: string) => Promise<ReadonlyArray<JournalEvent>>
> {
  const connection = await Effect.runPromise(resolveMessageJournalConnection("reader"));
  const queryLayer = messageJournalQueryLayer(connection).pipe(
    Layer.provide(clickHouseClientLayer(connection)),
  );
  const query = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* MessageJournalQuery;
    }).pipe(Effect.provide(queryLayer)),
  );

  return (window) =>
    Effect.runPromise(
      query.auditMessages({
        since: window,
        channel: "telegram",
        direction: "outbound",
        limit: NOISE_RATE_QUERY_LIMIT,
      }),
    );
}

async function measureNoiseRate(window: string): Promise<NoiseRateGuardReport> {
  queryPromise ??= createJournalLoader();
  const load = await queryPromise;
  const rows = await load(window);
  return computeNoiseRate(rows, { window });
}

export async function enqueueNoiseRateDigestItemWithRedis(
  redis: NoiseRateDigestRedis,
  item: NoiseRateDigestItem,
): Promise<{ queued: boolean }> {
  const result = await redis.eval(
    ENQUEUE_DIGEST_ATOMIC_SCRIPT,
    2,
    DIGEST_COOLDOWN_KEY,
    DIGEST_QUEUE,
    JSON.stringify(item),
    item.queuedAt,
    String(DIGEST_COOLDOWN_SECONDS),
  );
  return { queued: Number(result) === 1 };
}

async function enqueueDigestItem(
  item: NoiseRateDigestItem,
): Promise<{ queued: boolean }> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: getRedisPort(),
  });
  try {
    return await enqueueNoiseRateDigestItemWithRedis(redis, item);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

async function emitReport(
  report: NoiseRateGuardReport,
  digest: { queued: boolean } | undefined,
): Promise<void> {
  await emitOtelEvent({
    level: report.breached || !report.measurementComplete ? "warn" : "info",
    source: "worker",
    component: "telegram-noise-rate-guard",
    action: !report.measurementComplete
      ? "telegram.noise_rate.inconclusive"
      : report.breached
        ? "telegram.noise_rate.breached"
        : "telegram.noise_rate.measured",
    success: true,
    metadata: {
      ...report,
      nonActionableRatePercent: Number((report.nonActionableRate * 100).toFixed(2)),
      digestQueued: digest?.queued ?? false,
      contentKinds: TELEGRAM_SIGNAL_CONTENT_KINDS,
    },
  });
}

const defaultDependencies: NoiseRateGuardDependencies = {
  measureNoiseRate,
  enqueueDigestItem,
  emitReport,
  now: () => new Date(),
};

export function createNoiseRateGuardFunction(
  dependencies: NoiseRateGuardDependencies = defaultDependencies,
) {
  return inngest.createFunction(
    {
      id: "telegram-noise-rate-guard",
      name: "Telegram: Noise Rate Guard",
      concurrency: { limit: 1 },
      singleton: { key: '"global"', mode: "skip" },
    },
    { cron: "23 * * * *" },
    async ({ step }) => {
      const window = process.env.TELEGRAM_NOISE_RATE_WINDOW?.trim() || NOISE_RATE_WINDOW;
      // Keep exact journal bodies inside this step. Only the body-free aggregate
      // enters Inngest run state.
      const report = await step.run("measure-noise-rate", () =>
        dependencies.measureNoiseRate(window),
      );

      const digest = report.breached
        ? await step.run("queue-agent-investigation", () =>
            dependencies.enqueueDigestItem(
              buildNoiseRateDigestItem(report, dependencies.now()),
            ),
          )
        : undefined;

      await step.run("emit-noise-rate-report", () =>
        dependencies.emitReport(report, digest),
      );

      return {
        ...report,
        digestQueued: digest?.queued ?? false,
      };
    },
  );
}

export const noiseRateGuard = createNoiseRateGuardFunction();
