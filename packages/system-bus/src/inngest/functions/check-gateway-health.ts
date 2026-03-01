import { spawnSync } from "node:child_process";
import Redis from "ioredis";

/**
 * Gateway health monitor (general + channel-specific).
 *
 * ADR-0062: Heartbeat fan-out check function.
 * ADR-0090: O11y triage alignment with streak-based suppression + escalation.
 */
import { getRedisPort } from "../../lib/redis";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const GATEWAY_MONITOR_EVENT = "gateway/health.check.requested";

const GENERAL_STREAK_KEY = "gateway:health:monitor:general-streak";
const GENERAL_ALERT_COOLDOWN_KEY = "gateway:health:monitor:general-alert-cooldown";
const GENERAL_RESTART_COOLDOWN_KEY = "gateway:health:monitor:restart-cooldown";
const CHANNEL_STREAK_KEY_PREFIX = "gateway:health:monitor:channel-streak:";
const CHANNEL_ALERT_COOLDOWN_KEY = "gateway:health:monitor:channel-alert-cooldown";
const MUTED_CHANNELS_KEY = "gateway:health:muted-channels";

const STREAK_TTL_SECONDS = 6 * 60 * 60;
const GENERAL_ALERT_COOLDOWN_SECONDS = 20 * 60;
const CHANNEL_ALERT_COOLDOWN_SECONDS = 30 * 60;
const RESTART_COOLDOWN_SECONDS = 15 * 60;

const TYPESENSE_QUERY_BY = "action,component,source,error,metadata_json,search_text";
const CRITICAL_GENERAL_LAYERS = new Set(["process", "cli-status", "e2e-test", "redis-state"]);

function asPositiveInt(raw: string | undefined, fallback: number, min = 1): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

const CHANNEL_WINDOW_MINUTES = asPositiveInt(process.env.GATEWAY_CHANNEL_HEALTH_WINDOW_MINUTES, 30, 5);
const CHANNEL_DEGRADED_ERROR_THRESHOLD = asPositiveInt(process.env.GATEWAY_CHANNEL_DEGRADED_THRESHOLD, 3, 1);
const CHANNEL_FAILED_ERROR_THRESHOLD = asPositiveInt(process.env.GATEWAY_CHANNEL_FAILED_THRESHOLD, 6, 2);
const GENERAL_ALERT_STREAK_THRESHOLD = asPositiveInt(process.env.GATEWAY_GENERAL_ALERT_STREAK_THRESHOLD, 2, 1);
const GENERAL_RESTART_STREAK_THRESHOLD = asPositiveInt(process.env.GATEWAY_GENERAL_RESTART_STREAK_THRESHOLD, 2, 1);
const CHANNEL_ALERT_STREAK_THRESHOLD = asPositiveInt(process.env.GATEWAY_CHANNEL_ALERT_STREAK_THRESHOLD, 2, 1);

let redisClient: Redis | null = null;

function getRedis(): Redis {
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

type GatewayLayerStatus = "ok" | "degraded" | "failed" | "skipped";

type GatewayDiagnoseLayer = {
  layer: string;
  status: GatewayLayerStatus;
  detail: string;
  findings?: string[];
};

type GatewayDiagnoseResult = {
  timestamp?: string;
  window?: string;
  healthy: boolean;
  summary?: string;
  layers: GatewayDiagnoseLayer[];
};

type JoelclawEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error?: { message?: string };
};

type CliResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: string; stderr?: string };

type ChannelProbeConfig = {
  id: "telegram" | "discord" | "imessage" | "slack";
  component: string;
  severeActions: string[];
  successActions: string[];
};

type ChannelHealthStatus = "ok" | "degraded" | "failed" | "unknown";

type ChannelHealthSummary = {
  channel: ChannelProbeConfig["id"];
  component: string;
  status: ChannelHealthStatus;
  severeCount: number;
  successCount: number;
  latestErrorAction?: string;
  latestError?: string;
  streak: number;
};

type RestartAttemptSummary = {
  attempted: boolean;
  cooldownBlocked?: boolean;
  restartError?: string;
  postHealthy?: boolean;
  postSummary?: string;
  postCriticalFailures?: string[];
};

const CHANNEL_PROBES: ChannelProbeConfig[] = [
  {
    id: "telegram",
    component: "telegram-channel",
    severeActions: [
      "telegram.channel.start_failed",
      "telegram.send.failed",
      "telegram.send_media.failed",
      "telegram.send_media.fallback_failed",
    ],
    successActions: [
      "telegram.channel.started",
      "telegram.send.completed",
      "telegram.message.received",
    ],
  },
  {
    id: "discord",
    component: "discord-channel",
    severeActions: [
      "discord.channel.start_failed",
      "discord.channel.error",
      "discord.send.failed",
      "discord.send.channel_fetch_failed",
    ],
    successActions: [
      "discord.channel.started",
      "discord.send.completed",
      "discord.dm.received",
    ],
  },
  {
    id: "imessage",
    component: "imessage-channel",
    severeActions: [
      "imessage.send.failed",
      "imessage.send.not_connected",
      "imessage.socket.error",
      "imessage.socket.heal.failed",
    ],
    successActions: [
      "imessage.channel.started",
      "imessage.send.completed",
      "imessage.message.received",
      "imessage.socket.connected",
    ],
  },
  {
    id: "slack",
    component: "slack-channel",
    severeActions: [
      "slack.channel.start_failed",
      "slack.channel.error",
      "slack.send.failed",
      "slack.send_media.failed",
    ],
    successActions: [
      "slack.channel.started",
      "slack.send.completed",
      "slack.message.received",
    ],
  },
];

const CHANNEL_IDS = new Set<ChannelProbeConfig["id"]>(CHANNEL_PROBES.map((probe) => probe.id));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSafeText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function truncate(value: string, max = 180): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 3))}...`;
}

function escapeFilterValue(value: string): string {
  return value.replace(/[`\\]/g, "\\$&");
}

function eqFilter(field: string, value: string): string {
  return `${field}:=\`${escapeFilterValue(value)}\``;
}

function parseCriticalFailures(result: GatewayDiagnoseResult | undefined): GatewayDiagnoseLayer[] {
  if (!result || !Array.isArray(result.layers)) return [];
  return result.layers.filter(
    (layer) => CRITICAL_GENERAL_LAYERS.has(layer.layer) && layer.status === "failed",
  );
}

function runJoelclawEnvelope<T>(args: string[], timeoutMs: number): CliResult<T> {
  try {
    const proc = spawnSync("joelclaw", args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    });

    if (proc.error) {
      return { ok: false, error: `spawn failed: ${String(proc.error)}` };
    }

    const stdout = toSafeText(proc.stdout, "");
    const stderr = toSafeText(proc.stderr, "");

    if (proc.status !== 0) {
      const detail = stderr || stdout || `exit ${proc.status ?? "unknown"}`;
      return { ok: false, error: truncate(detail), stderr: stderr || undefined };
    }

    if (!stdout) {
      return { ok: false, error: "empty CLI response" };
    }

    let parsed: JoelclawEnvelope<T>;
    try {
      parsed = JSON.parse(stdout) as JoelclawEnvelope<T>;
    } catch (error) {
      return {
        ok: false,
        error: `invalid JSON envelope: ${truncate(String(error), 140)}`,
      };
    }

    if (!parsed.ok || parsed.result == null) {
      const err = parsed.error?.message ?? "command returned ok=false";
      return { ok: false, error: truncate(err), stderr: stderr || undefined };
    }

    return { ok: true, result: parsed.result };
  } catch (error) {
    return { ok: false, error: truncate(String(error)) };
  }
}

async function setFailureStreak(key: string, failing: boolean): Promise<number> {
  const redis = getRedis();
  if (!failing) {
    await redis.del(key);
    return 0;
  }

  const streak = await redis.incr(key);
  await redis.expire(key, STREAK_TTL_SECONDS);
  return Math.max(1, streak);
}

async function claimCooldown(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedis();
  const claimed = await redis.set(key, String(Date.now()), "EX", ttlSeconds, "NX");
  return claimed === "OK";
}

function normalizeChannelId(value: unknown): ChannelProbeConfig["id"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!CHANNEL_IDS.has(normalized as ChannelProbeConfig["id"])) return null;
  return normalized as ChannelProbeConfig["id"];
}

function parseMutedChannels(raw: string | null): ChannelProbeConfig["id"][] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const muted = new Set<ChannelProbeConfig["id"]>();
    for (const value of parsed) {
      const normalized = normalizeChannelId(value);
      if (normalized) muted.add(normalized);
    }
    return [...muted];
  } catch {
    return [];
  }
}

async function loadMutedChannelsFromRedis(): Promise<ChannelProbeConfig["id"][]> {
  try {
    const redis = getRedis();
    const raw = await redis.get(MUTED_CHANNELS_KEY);
    return parseMutedChannels(raw);
  } catch {
    return [];
  }
}

function partitionAlertableChannels(
  channels: ChannelHealthSummary[],
  mutedChannels: ChannelProbeConfig["id"][],
): { alertableChannels: ChannelHealthSummary[]; mutedActionableChannels: ChannelHealthSummary[] } {
  const muted = new Set(mutedChannels);
  const alertableChannels: ChannelHealthSummary[] = [];
  const mutedActionableChannels: ChannelHealthSummary[] = [];

  for (const channel of channels) {
    if (muted.has(channel.channel)) {
      mutedActionableChannels.push(channel);
    } else {
      alertableChannels.push(channel);
    }
  }

  return { alertableChannels, mutedActionableChannels };
}

async function countActionEvents(filterBy: string): Promise<number> {
  const result = await typesense.search({
    collection: "otel_events",
    q: "*",
    query_by: TYPESENSE_QUERY_BY,
    per_page: 1,
    filter_by: filterBy,
  });

  return result.found ?? 0;
}

async function fetchLatestError(baseFilter: string): Promise<{ action?: string; error?: string } | null> {
  const result = await typesense.search({
    collection: "otel_events",
    q: "*",
    query_by: TYPESENSE_QUERY_BY,
    per_page: 1,
    sort_by: "timestamp:desc",
    include_fields: "action,error,timestamp",
    filter_by: `${baseFilter} && success:=false`,
  });

  const hit = Array.isArray(result.hits) ? result.hits[0] : undefined;
  if (!hit) return null;
  const doc = hit.document ?? {};

  return {
    action: typeof doc.action === "string" ? doc.action : undefined,
    error: typeof doc.error === "string" ? doc.error : undefined,
  };
}

async function probeChannelHealth(
  config: ChannelProbeConfig,
  cutoffMs: number,
): Promise<Omit<ChannelHealthSummary, "streak">> {
  const baseFilter = [
    `timestamp:>=${Math.floor(cutoffMs)}`,
    eqFilter("source", "gateway"),
    eqFilter("component", config.component),
  ].join(" && ");

  try {
    let severeCount = 0;
    for (const action of config.severeActions) {
      severeCount += await countActionEvents(`${baseFilter} && ${eqFilter("action", action)}`);
    }

    let successCount = 0;
    for (const action of config.successActions) {
      successCount += await countActionEvents(`${baseFilter} && ${eqFilter("action", action)}`);
    }

    const latestError = severeCount > 0 ? await fetchLatestError(baseFilter) : null;

    let status: ChannelHealthStatus = "unknown";
    if (severeCount >= CHANNEL_FAILED_ERROR_THRESHOLD && successCount === 0) {
      status = "failed";
    } else if (severeCount >= CHANNEL_DEGRADED_ERROR_THRESHOLD) {
      status = "degraded";
    } else if (severeCount > 0 && successCount === 0) {
      status = "degraded";
    } else if (successCount > 0) {
      status = "ok";
    }

    return {
      channel: config.id,
      component: config.component,
      status,
      severeCount,
      successCount,
      latestErrorAction: latestError?.action,
      latestError: latestError?.error,
    };
  } catch (error) {
    return {
      channel: config.id,
      component: config.component,
      status: "unknown",
      severeCount: 0,
      successCount: 0,
      latestErrorAction: "monitor.probe.failed",
      latestError: truncate(String(error), 200),
    };
  }
}

function buildGeneralAlertPrompt(args: {
  streak: number;
  summary?: string;
  criticalFailures: GatewayDiagnoseLayer[];
  restartAttempt?: RestartAttemptSummary;
  diagnoseError?: string;
}): string {
  const lines = [
    "## 🚨 Gateway Health Degradation",
    "",
    `Failure streak: ${args.streak}`,
  ];

  if (args.summary) {
    lines.push(`Summary: ${args.summary}`);
  }

  if (args.diagnoseError) {
    lines.push(`Diagnose error: ${truncate(args.diagnoseError, 160)}`);
  }

  if (args.criticalFailures.length > 0) {
    lines.push("", "Critical layers:");
    for (const layer of args.criticalFailures) {
      lines.push(`- ${layer.layer}: ${truncate(layer.detail, 140)}`);
    }
  }

  if (args.restartAttempt?.attempted) {
    if (args.restartAttempt.restartError) {
      lines.push("", `Auto-restart attempted: failed (${truncate(args.restartAttempt.restartError, 160)})`);
    } else {
      const post = args.restartAttempt.postHealthy === true ? "healthy" : "still degraded";
      lines.push("", `Auto-restart attempted: ${post}`);
    }
  }

  lines.push("", "Run `joelclaw gateway diagnose --hours 1 --lines 200` for deeper trace.");
  return lines.join("\n");
}

function buildSelfHealedPrompt(args: {
  summary?: string;
  restartAttempt: RestartAttemptSummary;
}): string {
  const lines = [
    "## ✅ Gateway Self-Healed",
    "",
    `Auto-restart succeeded. Post-check status: ${args.restartAttempt.postHealthy ? "healthy" : "unknown"}`,
  ];

  if (args.summary) {
    lines.push(`Summary: ${args.summary}`);
  }

  if (args.restartAttempt.postCriticalFailures && args.restartAttempt.postCriticalFailures.length > 0) {
    lines.push("", `Residual critical findings: ${args.restartAttempt.postCriticalFailures.join(", ")}`);
  }

  return lines.join("\n");
}

function buildChannelAlertPrompt(channels: ChannelHealthSummary[]): string {
  const lines = [
    "## ⚠️ Gateway Channel Degradation",
    "",
    `Window: last ${CHANNEL_WINDOW_MINUTES} minutes`,
    "",
  ];

  for (const channel of channels) {
    const latest = channel.latestErrorAction
      ? `${channel.latestErrorAction}${channel.latestError ? ` — ${truncate(channel.latestError, 90)}` : ""}`
      : "no recent error payload";
    lines.push(
      `- ${channel.channel}: ${channel.status} (severe=${channel.severeCount}, success=${channel.successCount}, streak=${channel.streak})`,
    );
    lines.push(`  ${latest}`);
  }

  lines.push("", "Review with `joelclaw otel search gateway --source gateway --hours 1`.");
  return lines.join("\n");
}

export const __checkGatewayHealthTestUtils = {
  parseMutedChannels,
  partitionAlertableChannels,
};

export const checkGatewayHealth = inngest.createFunction(
  {
    id: "check/gateway-health",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: GATEWAY_MONITOR_EVENT },
  async ({ step }) => {
    const mutedChannels = await step.run("load-muted-channels", async () =>
      loadMutedChannelsFromRedis()
    );

    const diagnose = await step.run("diagnose-gateway", async () =>
      runJoelclawEnvelope<GatewayDiagnoseResult>(
        ["gateway", "diagnose", "--hours", "1", "--lines", "120"],
        60_000,
      )
    );

    let diagnoseError: string | undefined;
    let diagnoseSummary: string | undefined;
    let criticalFailures: GatewayDiagnoseLayer[] = [];
    let generalFailure = false;

    if (diagnose.ok) {
      diagnoseSummary = diagnose.result.summary;
      criticalFailures = parseCriticalFailures(diagnose.result);
      generalFailure = criticalFailures.length > 0;
    } else {
      diagnoseError = diagnose.error;
      generalFailure = true;
    }

    let generalStreak = await step.run("update-general-streak", async () =>
      setFailureStreak(GENERAL_STREAK_KEY, generalFailure)
    );

    let restartAttempt: RestartAttemptSummary | undefined;

    if (generalFailure && generalStreak >= GENERAL_RESTART_STREAK_THRESHOLD) {
      restartAttempt = await step.run("maybe-auto-restart-gateway", async () => {
        const cooldownClaimed = await claimCooldown(GENERAL_RESTART_COOLDOWN_KEY, RESTART_COOLDOWN_SECONDS);
        if (!cooldownClaimed) {
          return {
            attempted: false,
            cooldownBlocked: true,
          } satisfies RestartAttemptSummary;
        }

        const restartResult = runJoelclawEnvelope<Record<string, unknown>>(
          ["gateway", "restart"],
          90_000,
        );

        if (!restartResult.ok) {
          return {
            attempted: true,
            restartError: restartResult.error,
          } satisfies RestartAttemptSummary;
        }

        await sleep(6_000);

        const postDiagnose = runJoelclawEnvelope<GatewayDiagnoseResult>(
          ["gateway", "diagnose", "--hours", "1", "--lines", "120"],
          60_000,
        );

        if (!postDiagnose.ok) {
          return {
            attempted: true,
            restartError: `post-check failed: ${postDiagnose.error}`,
          } satisfies RestartAttemptSummary;
        }

        const postCritical = parseCriticalFailures(postDiagnose.result).map((layer) =>
          `${layer.layer}:${truncate(layer.detail, 80)}`
        );

        return {
          attempted: true,
          postHealthy: postCritical.length === 0,
          postSummary: postDiagnose.result.summary,
          postCriticalFailures: postCritical,
        } satisfies RestartAttemptSummary;
      });

      if (restartAttempt.postHealthy) {
        generalFailure = false;
        diagnoseError = undefined;
        criticalFailures = [];
        generalStreak = await step.run("clear-general-streak-after-recovery", async () =>
          setFailureStreak(GENERAL_STREAK_KEY, false)
        );
      }
    }

    const channelHealth = await step.run("probe-channel-health", async () => {
      const cutoffMs = Date.now() - CHANNEL_WINDOW_MINUTES * 60 * 1000;
      const summaries: ChannelHealthSummary[] = [];

      for (const config of CHANNEL_PROBES) {
        const summary = await probeChannelHealth(config, cutoffMs);
        const failing = summary.status === "failed" || summary.status === "degraded";
        const streak = await setFailureStreak(`${CHANNEL_STREAK_KEY_PREFIX}${config.id}`, failing);
        summaries.push({ ...summary, streak });
      }

      return summaries;
    });

    const actionableChannels = channelHealth.filter(
      (item) =>
        (item.status === "failed" || item.status === "degraded")
        && item.streak >= CHANNEL_ALERT_STREAK_THRESHOLD,
    );

    const { alertableChannels, mutedActionableChannels } = partitionAlertableChannels(
      actionableChannels,
      mutedChannels,
    );

    const channelAlertSent = await step.run("maybe-alert-channel-degradation", async () => {
      if (alertableChannels.length === 0) return false;

      const shouldAlert = await claimCooldown(CHANNEL_ALERT_COOLDOWN_KEY, CHANNEL_ALERT_COOLDOWN_SECONDS);
      if (!shouldAlert) return false;

      await pushGatewayEvent({
        type: "gateway.channels.degraded",
        source: "inngest/check-gateway-health",
        payload: {
          prompt: buildChannelAlertPrompt(alertableChannels),
          level: "warn",
          immediateTelegram: true,
          channels: alertableChannels,
          mutedChannels,
          mutedActionableChannels,
          windowMinutes: CHANNEL_WINDOW_MINUTES,
        },
      });

      return true;
    });

    const generalAlertSent = await step.run("maybe-alert-general-degradation", async () => {
      if (!generalFailure || generalStreak < GENERAL_ALERT_STREAK_THRESHOLD) return false;

      const shouldAlert = await claimCooldown(GENERAL_ALERT_COOLDOWN_KEY, GENERAL_ALERT_COOLDOWN_SECONDS);
      if (!shouldAlert) return false;

      await pushGatewayEvent({
        type: "gateway.health.degraded",
        source: "inngest/check-gateway-health",
        payload: {
          prompt: buildGeneralAlertPrompt({
            streak: generalStreak,
            summary: diagnoseSummary,
            criticalFailures,
            restartAttempt,
            diagnoseError,
          }),
          level: "error",
          immediateTelegram: true,
          generalStreak,
          criticalFailures,
          diagnoseError,
          restartAttempt,
        },
      });

      return true;
    });

    const selfHealedSent = await step.run("maybe-notify-self-healed", async () => {
      if (!restartAttempt?.attempted || restartAttempt.postHealthy !== true) return false;

      await pushGatewayEvent({
        type: "gateway.health.self-healed",
        source: "inngest/check-gateway-health",
        payload: {
          prompt: buildSelfHealedPrompt({
            summary: restartAttempt.postSummary ?? diagnoseSummary,
            restartAttempt,
          }),
          level: "info",
          immediateTelegram: false,
          restartAttempt,
        },
      });

      return true;
    });

    await step.run("emit-gateway-health-otel", async () => {
      await emitOtelEvent({
        level: generalFailure || actionableChannels.length > 0 ? "warn" : "info",
        source: "worker",
        component: "check-gateway-health",
        action: "gateway.health.checked",
        success: !generalFailure && actionableChannels.length === 0,
        error: generalFailure
          ? diagnoseError ?? criticalFailures.map((layer) => `${layer.layer}:${layer.detail}`).join(" | ")
          : actionableChannels.length > 0
            ? actionableChannels
                .map((channel) => `${channel.channel}:${channel.status}:s${channel.severeCount}:k${channel.streak}`)
                .join(" | ")
            : undefined,
        metadata: {
          monitorEvent: GATEWAY_MONITOR_EVENT,
          windowMinutes: CHANNEL_WINDOW_MINUTES,
          diagnoseSummary,
          diagnoseError,
          generalFailure,
          generalStreak,
          generalAlertSent,
          channelAlertSent,
          selfHealedSent,
          mutedChannels,
          alertableChannels: alertableChannels.map((channel) => ({
            channel: channel.channel,
            status: channel.status,
            severeCount: channel.severeCount,
            successCount: channel.successCount,
            streak: channel.streak,
          })),
          mutedActionableChannels: mutedActionableChannels.map((channel) => ({
            channel: channel.channel,
            status: channel.status,
            severeCount: channel.severeCount,
            successCount: channel.successCount,
            streak: channel.streak,
          })),
          restartAttempt,
          criticalFailures: criticalFailures.map((layer) => ({
            layer: layer.layer,
            status: layer.status,
            detail: layer.detail,
          })),
          channelHealth: channelHealth.map((channel) => ({
            channel: channel.channel,
            status: channel.status,
            severeCount: channel.severeCount,
            successCount: channel.successCount,
            streak: channel.streak,
            latestErrorAction: channel.latestErrorAction,
            latestError: channel.latestError,
          })),
        },
      });
    });

    return {
      status: generalFailure
        ? "degraded"
        : actionableChannels.length > 0
          ? "channel-degraded"
          : "ok",
      general: {
        failed: generalFailure,
        streak: generalStreak,
        criticalFailures: criticalFailures.map((layer) => ({
          layer: layer.layer,
          detail: layer.detail,
        })),
        diagnoseError,
        diagnoseSummary,
        restartAttempt,
        alertSent: generalAlertSent,
        selfHealedSent,
      },
      channels: {
        alertSent: channelAlertSent,
        mutedChannels,
        muted: mutedActionableChannels.map((item) => ({
          channel: item.channel,
          status: item.status,
          severeCount: item.severeCount,
          successCount: item.successCount,
          streak: item.streak,
        })),
        actionable: actionableChannels.map((item) => ({
          channel: item.channel,
          status: item.status,
          severeCount: item.severeCount,
          successCount: item.successCount,
          streak: item.streak,
        })),
        all: channelHealth,
      },
    };
  },
);
