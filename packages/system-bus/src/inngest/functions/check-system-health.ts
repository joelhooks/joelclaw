import { getRedisPort } from "../../lib/redis";
/**
 * System health check — ping core services.
 * ADR-0062. Only notifies gateway on degradation.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import { getCurrentTasks, hasTaskMatching } from "../../tasks";
import { pushSystemStatus, pushNotification } from "../../lib/convex";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import Redis from "ioredis";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";

type ServiceStatus = { name: string; ok: boolean; detail?: string; durationMs?: number };
type HealthCheckMode = "core" | "signals" | "full";
type HealthSlicePolicy = {
  cadenceMinutes: number;
  importance: "critical" | "high" | "medium";
  alertSensitivity: "high" | "medium" | "low";
  selfHealing: "manual" | "automatic";
  rank: number;
};

const VALID_HEALTH_CHECK_MODES = new Set<HealthCheckMode>([
  "core",
  "signals",
  "full",
]);

const HEALTH_SLICE_POLICIES: Record<HealthCheckMode, HealthSlicePolicy> = {
  core: {
    cadenceMinutes: 15,
    importance: "critical",
    alertSensitivity: "high",
    selfHealing: "automatic",
    rank: 1,
  },
  signals: {
    cadenceMinutes: 60,
    importance: "high",
    alertSensitivity: "medium",
    selfHealing: "manual",
    rank: 2,
  },
  full: {
    cadenceMinutes: 0,
    importance: "critical",
    alertSensitivity: "high",
    selfHealing: "manual",
    rank: 0,
  },
};

const CRITICAL_COMPONENTS = new Set([
  "redis",
  "inngest",
  "worker",
  "gateway",
  "typesense",
  "agent secrets",
]);
const WRITE_GATE_DRIFT_LAST_NOTIFIED_KEY = "memory:health:write_gate_drift:last_notified";
const WRITE_GATE_DRIFT_NOTIFY_COOLDOWN_SECONDS = 6 * 60 * 60;
const SELF_HEALING_GATEWAY_REQUEST_EVENT = "system/self.healing.requested";
const GATEWAY_BRIDGE_HEALTH_REQUEST_EVENT = "system/gateway.bridge.health.requested";
const HEALTH_OTEL_GAP_LAST_NOTIFIED_KEY = "memory:health:otel_gap:last_notified";
const HEALTH_OTEL_GAP_NOTIFY_COOLDOWN_SECONDS = 10 * 60;
const GATEWAY_HEALING_RETRY_POLICY = {
  maxRetries: 10,
  sleepMinMs: 90_000,
  sleepMaxMs: 900_000,
  sleepStepMs: 45_000,
};

function normalizeTimestampToMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

async function withTiming<T>(
  timings: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    timings[key] = normalizeTimestampToMs(Date.now() - startedAt);
  }
}

async function timedServiceCheck(
  checkName: string,
  fn: () => Promise<ServiceStatus>,
): Promise<ServiceStatus> {
  const startedAt = Date.now();
  const result = await fn();
  return {
    ...result,
    durationMs: normalizeTimestampToMs(Date.now() - startedAt),
    name: checkName,
  };
}

export function resolveHealthCheckMode(
  eventName: "system/health.requested" | "system/health.check",
  rawMode: unknown,
): HealthCheckMode {
  if (typeof rawMode === "string") {
    const normalized = rawMode.trim().toLowerCase();
    if (VALID_HEALTH_CHECK_MODES.has(normalized as HealthCheckMode)) {
      return normalized as HealthCheckMode;
    }
  }

  return eventName === "system/health.check" ? "full" : "core";
}

function getNumericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseMetadataJson(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string" || input.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toSafeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

type OtelErrorRateSummary = {
  total: number;
  errors: number;
  rate: number;
  windowMinutes: number;
  threshold: number;
  minEvents: number;
  shouldEscalate: boolean;
  unavailable?: string;
};

type WriteGateDriftSummary = {
  totalEvents: number;
  eventsWithGateCounts: number;
  legacyEvents: number;
  allowCount: number;
  holdCount: number;
  discardCount: number;
  fallbackCount: number;
  totalWithVerdict: number;
  holdRatio: number;
  discardRatio: number;
  fallbackRate: number;
  windowMinutes: number;
  minEvents: number;
  minVerdicts: number;
  holdRatioThreshold: number;
  discardRatioThreshold: number;
  fallbackRateThreshold: number;
  shouldEscalate: boolean;
  unavailable?: string;
};

type HealthSelfHealingRequest = {
  sourceEventId?: string;
  sourceEventName?: string;
  runContextKey?: string;
  flowTrace?: string[];
  sourceFunction: string;
  targetComponent: string;
  targetEventName: string;
  problemSummary: string;
  domain: "gateway-bridge" | "otel-pipeline";
  attempt: number;
  reason: string;
  evidence: Array<{ type: string; detail: string }>;
  playbook: {
    actions: string[];
    restart: string[];
    kill: string[];
    defer: string[];
    notify: string[];
  links: string[];
  };
};

type SelfHealingFlowContext = {
  runContextKey: string;
  flowTrace: string[];
  sourceFunction: string;
  sourceEventId?: string;
  sourceEventName?: string;
  attempt: number;
};

function buildSelfHealingFlowContext(input: {
  sourceFunction: string;
  targetComponent: string;
  targetEventName: string;
  domain: string;
  eventName: string;
  eventId: string | undefined;
  attempt: number;
  evidenceCount?: number;
}): SelfHealingFlowContext {
  const sourceFunction = toSafeText(input.sourceFunction, "system/check-system-health");
  const targetComponent = toSafeText(input.targetComponent, "unknown");
  const targetEventName = toSafeText(input.targetEventName, "system.health.checked");
  const domain = toSafeText(input.domain, "unknown");
  const eventName = toSafeText(input.eventName, "system/health.check");
  const evidenceSeed = Number.isFinite(input.evidenceCount ?? 0) ? Math.max(0, Math.floor(input.evidenceCount ?? 0)) : 0;

  return {
    runContextKey: `${eventName}::${sourceFunction}::${targetComponent}::${domain}::${targetEventName}::a${Math.max(0, Math.floor(input.attempt))}::e${evidenceSeed}`,
    flowTrace: [
      eventName,
      "system/self-healing.router",
      `${sourceFunction}→${targetComponent}`,
      domain,
      targetEventName,
      `attempt:${Math.max(0, Math.floor(input.attempt))}`,
    ],
    sourceFunction,
    sourceEventId: input.eventId,
    sourceEventName: eventName,
    attempt: Math.max(0, Math.floor(input.attempt)),
  };
}

function summarizeEvidenceForOtel(
  evidence: Array<{ type: string; detail: string }> | undefined,
): { count: number; samples: Array<{ type: string; detail: string }>; types: string[] } {
  const safeEvidence = Array.isArray(evidence) ? evidence : [];
  const sampleCount = Math.min(6, safeEvidence.length);
  const samples = safeEvidence.slice(0, sampleCount);
  const types = [...new Set(safeEvidence.map((entry) => toSafeText(entry.type, "unknown")))];
  return {
    count: safeEvidence.length,
    samples,
    types,
  };
}

async function warnOtelGapViaEvents(
  redisHost: string,
  redisPort: number,
  payload: HealthSelfHealingRequest & { attempt: number },
): Promise<void> {
  const redis = new Redis({
    host: redisHost,
    port: redisPort,
    lazyConnect: true,
    connectTimeout: 3_000,
  });
  redis.on("error", () => {});

  try {
    await redis.connect();
    const alreadyNotified = await redis.get(HEALTH_OTEL_GAP_LAST_NOTIFIED_KEY);
      if (alreadyNotified) return;

    await redis.set(
      HEALTH_OTEL_GAP_LAST_NOTIFIED_KEY,
      new Date().toISOString(),
      "EX",
      HEALTH_OTEL_GAP_NOTIFY_COOLDOWN_SECONDS,
    );

    await Promise.allSettled([
      emitOtelEvent({
        level: "warn",
        source: "worker",
        component: "check-system-health",
        action: "system.health.otel.write.gap",
        success: false,
        error: payload.reason,
        metadata: {
          reason: payload.reason,
          domain: payload.domain,
          runContext: {
            runContextKey: payload.runContextKey ?? "missing-run-context",
            flowTrace: payload.flowTrace ?? [],
            sourceEventId: payload.sourceEventId,
            sourceEventName: payload.sourceEventName,
            attempt: payload.attempt,
          },
          evidenceSummary: summarizeEvidenceForOtel(payload.evidence),
          sourceFunction: payload.sourceFunction,
          targetComponent: payload.targetComponent,
          targetEventName: payload.targetEventName,
        },
      }),
      pushNotification(
        "warn",
        "OTEL telemetry write gap detected",
        `${payload.reason}`,
      ),
    ]);
  } finally {
    redis.disconnect();
  }
}

async function checkRedis(): Promise<ServiceStatus> {
  const redis = new Redis({ host: "localhost", port: 6379, lazyConnect: true, connectTimeout: 3000 });
  redis.on("error", () => {});
  try {
    const pong = await redis.ping();
    return { name: "Redis", ok: pong === "PONG" };
  } catch (err) {
    return { name: "Redis", ok: false, detail: String(err) };
  } finally {
    redis.disconnect();
  }
}

async function checkInngest(): Promise<ServiceStatus> {
  try {
    const res = await fetch("http://localhost:8288/health", { signal: AbortSignal.timeout(3000) });
    return { name: "Inngest", ok: res.ok };
  } catch (err) {
    return { name: "Inngest", ok: false, detail: String(err) };
  }
}

async function checkWorker(): Promise<ServiceStatus> {
  try {
    const res = await fetch("http://localhost:3111/", { signal: AbortSignal.timeout(3000) });
    return { name: "Worker", ok: res.ok };
  } catch (err) {
    return { name: "Worker", ok: false, detail: String(err) };
  }
}

async function checkGateway(): Promise<ServiceStatus> {
  try {
    // Check PID file — is the process alive?
    const pidRaw = await readFile("/tmp/joelclaw/gateway.pid", "utf8").catch(() => "");
    const pid = parseInt(pidRaw.trim(), 10);
    if (!pid || isNaN(pid)) {
      return { name: "Gateway", ok: false, detail: "no PID file" };
    }

    // Check process is alive (kill -0 doesn't actually kill)
    try {
      process.kill(pid, 0);
    } catch {
      return { name: "Gateway", ok: false, detail: `PID ${pid} is dead` };
    }

    // Check WS server responds — read port, open WS, request status, close
    const portRaw = await readFile("/tmp/joelclaw/gateway.ws.port", "utf8").catch(() => "");
    const wsPort = parseInt(portRaw.trim(), 10);
    if (!wsPort || isNaN(wsPort)) {
      return { name: "Gateway", ok: false, detail: "no WS port file — daemon may not have WS server" };
    }

    // Probe via HTTP upgrade attempt (Bun.serve returns 426 for non-WS)
    const res = await fetch(`http://localhost:${wsPort}/`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!res) {
      return { name: "Gateway", ok: false, detail: `WS port ${wsPort} not responding` };
    }
    // 426 = "Upgrade Required" = WS server is there and healthy
    if (res.status === 426) {
      return { name: "Gateway", ok: true };
    }
    return { name: "Gateway", ok: false, detail: `unexpected status ${res.status}` };
  } catch (err) {
    return { name: "Gateway", ok: false, detail: String(err) };
  }
}

async function checkTypesense(): Promise<ServiceStatus> {
  try {
    const res = await fetch("http://localhost:8108/health", {
      signal: AbortSignal.timeout(3000),
      headers: { "X-TYPESENSE-API-KEY": process.env.TYPESENSE_API_KEY ?? "" },
    });
    const data = await res.json() as { ok?: boolean };
    return { name: "Typesense", ok: data.ok === true };
  } catch (err) {
    return { name: "Typesense", ok: false, detail: String(err) };
  }
}

async function checkAgentSecrets(): Promise<ServiceStatus> {
  try {
    const result = spawnSync("secrets", ["health"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.status === 0) {
      return { name: "Agent Secrets", ok: true };
    }

    const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("{"));
    return {
      name: "Agent Secrets",
      ok: false,
      detail: (text ?? "secrets daemon unreachable").slice(0, 140),
    };
  } catch (err) {
    return { name: "Agent Secrets", ok: false, detail: String(err).slice(0, 140) };
  }
}

async function checkNfsMounts(): Promise<ServiceStatus> {
  const mounts = [
    { name: "nas-nvme", path: "/Volumes/nas-nvme" },
    { name: "three-body", path: "/Volumes/three-body" },
  ];
  const results: string[] = [];
  let allOk = true;

  for (const mount of mounts) {
    try {
      const probe = spawnSync("stat", [mount.path], { timeout: 5000 });
      if (probe.status === 0) {
        results.push(`${mount.name}: ok`);
      } else {
        allOk = false;
        results.push(`${mount.name}: missing`);
      }
    } catch {
      allOk = false;
      results.push(`${mount.name}: timeout`);
    }
  }

  return {
    name: "NFS Mounts",
    ok: allOk,
    detail: results.join(", "),
  };
}

async function checkWebhooks(): Promise<ServiceStatus> {
  try {
    // Probe webhook server locally (avoids TLS cert issues with Tailscale funnel)
    const res = await fetch("http://localhost:3111/webhooks", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as { status?: string; providers?: string[] };
      return { name: "Webhooks", ok: true, detail: `providers: ${data.providers?.join(", ") ?? "none"}` };
    }
    return { name: "Webhooks", ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { name: "Webhooks", ok: false, detail: String(err) };
  }
}

async function checkOtelErrorRate(): Promise<OtelErrorRateSummary> {
  const windowMinutes = getNumericEnv("OTEL_EVENTS_ERROR_RATE_WINDOW_MINUTES", 15);
  const threshold = getNumericEnv("OTEL_EVENTS_ERROR_RATE_THRESHOLD", 0.2);
  const minEvents = getNumericEnv("OTEL_EVENTS_ERROR_RATE_MIN_EVENTS", 20);
  const cutoff = Date.now() - windowMinutes * 60 * 1000;

  const baseFilter = `timestamp:>=${Math.floor(cutoff)} && component:!=check-system-health`;

  try {
    const [all, errors] = await Promise.all([
      typesense.search({
        collection: "otel_events",
        q: "*",
        query_by: "action,component,source,error,metadata_json,search_text",
        per_page: 1,
        filter_by: baseFilter,
      }),
      typesense.search({
        collection: "otel_events",
        q: "*",
        query_by: "action,component,source,error,metadata_json,search_text",
        per_page: 1,
        filter_by: `${baseFilter} && level:=[error,fatal]`,
      }),
    ]);

    const total = all.found ?? 0;
    const errorCount = errors.found ?? 0;
    const rate = total > 0 ? errorCount / total : 0;

    return {
      total,
      errors: errorCount,
      rate,
      windowMinutes,
      threshold,
      minEvents,
      shouldEscalate: total >= minEvents && rate >= threshold,
    };
  } catch (error) {
    return {
      total: 0,
      errors: 0,
      rate: 0,
      windowMinutes,
      threshold,
      minEvents,
      shouldEscalate: false,
      unavailable: String(error),
    };
  }
}

async function checkWriteGateDrift(): Promise<WriteGateDriftSummary> {
  const windowMinutes = getNumericEnv("MEMORY_WRITE_GATE_DRIFT_WINDOW_MINUTES", 60);
  const minEvents = getNumericEnv("MEMORY_WRITE_GATE_DRIFT_MIN_EVENTS", 30);
  const minVerdicts = getNumericEnv(
    "MEMORY_WRITE_GATE_DRIFT_MIN_VERDICTS",
    Math.max(minEvents, 45)
  );
  const fallbackRateThreshold = getNumericEnv("MEMORY_WRITE_GATE_FALLBACK_RATE_THRESHOLD", 0.45);
  const holdRatioThreshold = getNumericEnv("MEMORY_WRITE_GATE_HOLD_RATIO_THRESHOLD", 0.85);
  const discardRatioThreshold = getNumericEnv("MEMORY_WRITE_GATE_DISCARD_RATIO_THRESHOLD", 0.7);
  const cutoff = Date.now() - windowMinutes * 60 * 1000;

  const filterBy = `timestamp:>=${Math.floor(cutoff)} && component:=observe && action:=observe.store.completed && success:=true`;

  try {
    let page = 1;
    const perPage = 100;
    let totalEvents = 0;
    let eventsWithGateCounts = 0;
    let allowCount = 0;
    let holdCount = 0;
    let discardCount = 0;
    let fallbackCount = 0;

    for (;;) {
      const result = await typesense.search({
        collection: "otel_events",
        q: "*",
        query_by: "action,component,source,error,metadata_json,search_text",
        per_page: perPage,
        page,
        include_fields: "id,metadata_json",
        sort_by: "timestamp:desc",
        filter_by: filterBy,
      });

      const hits = Array.isArray(result.hits) ? result.hits : [];
      for (const hit of hits) {
        totalEvents += 1;
        const metadata = parseMetadataJson(hit.document?.metadata_json);
        const hasCounts =
          metadata.allowCount != null ||
          metadata.holdCount != null ||
          metadata.discardCount != null ||
          metadata.fallbackCount != null;
        if (!hasCounts) continue;

        eventsWithGateCounts += 1;
        allowCount += asFiniteNumber(metadata.allowCount, 0);
        holdCount += asFiniteNumber(metadata.holdCount, 0);
        discardCount += asFiniteNumber(metadata.discardCount, 0);
        fallbackCount += asFiniteNumber(metadata.fallbackCount, 0);
      }

      if (hits.length < perPage) break;
      page += 1;
    }

    const totalWithVerdict = allowCount + holdCount + discardCount;
    const holdRatio = totalWithVerdict > 0 ? holdCount / totalWithVerdict : 0;
    const discardRatio = totalWithVerdict > 0 ? discardCount / totalWithVerdict : 0;
    const fallbackRate = totalWithVerdict > 0 ? fallbackCount / totalWithVerdict : 0;
    const hasObservationData = totalEvents > 0 && eventsWithGateCounts > 0 && totalWithVerdict > 0;

    return {
      totalEvents,
      eventsWithGateCounts,
      legacyEvents: Math.max(0, totalEvents - eventsWithGateCounts),
      allowCount,
      holdCount,
      discardCount,
      fallbackCount,
      totalWithVerdict,
      holdRatio,
      discardRatio,
      fallbackRate,
      windowMinutes,
      minEvents,
      minVerdicts,
      holdRatioThreshold,
      discardRatioThreshold,
      fallbackRateThreshold,
      shouldEscalate:
        hasObservationData
        && totalWithVerdict >= minVerdicts
        && eventsWithGateCounts >= minEvents
        && (fallbackRate >= fallbackRateThreshold
          || holdRatio >= holdRatioThreshold
          || discardRatio >= discardRatioThreshold),
    };
  } catch (error) {
    return {
      totalEvents: 0,
      eventsWithGateCounts: 0,
      legacyEvents: 0,
      allowCount: 0,
      holdCount: 0,
      discardCount: 0,
      fallbackCount: 0,
      totalWithVerdict: 0,
      holdRatio: 0,
      discardRatio: 0,
      fallbackRate: 0,
      windowMinutes,
      minEvents,
      minVerdicts,
      holdRatioThreshold,
      discardRatioThreshold,
      fallbackRateThreshold,
      shouldEscalate: false,
      unavailable: String(error),
    };
  }
}

export const checkSystemHealth = inngest.createFunction(
  { id: "check/system-health", concurrency: { limit: 1 }, retries: 1 },
  [{ event: "system/health.requested" }, { event: "system/health.check" }],
  async ({ step, event }) => {
    const eventName = event.name as "system/health.requested" | "system/health.check";
    const mode = resolveHealthCheckMode(
      eventName,
      (event.data as { mode?: unknown } | undefined)?.mode,
    );
    const slicePolicy = HEALTH_SLICE_POLICIES[mode];
    const flowContext = buildSelfHealingFlowContext({
      sourceFunction: "system/check-system-health",
      targetComponent: "otel-pipeline",
      targetEventName: "system.health.checked",
      domain: "otel-pipeline",
      eventName,
      eventId: event.id,
      attempt: 0,
      evidenceCount: 0,
    });
    const runCoreChecks = mode !== "signals";
    const runSignalChecks = mode !== "core";
    const runStartedAt = Date.now();
    const stepDurationsMs: Record<string, number> = {};

    const services = runCoreChecks
      ? await withTiming(stepDurationsMs, "core.ping-services", async () =>
        step.run("ping-services", async () => {
          const results = await Promise.all([
            timedServiceCheck("Redis", checkRedis),
            timedServiceCheck("Inngest", checkInngest),
            timedServiceCheck("Worker", checkWorker),
            timedServiceCheck("Gateway", checkGateway),
            timedServiceCheck("Webhooks", checkWebhooks),
            timedServiceCheck("Typesense", checkTypesense),
            timedServiceCheck("Agent Secrets", checkAgentSecrets),
            timedServiceCheck("NFS Mounts", checkNfsMounts),
          ]);
          return results;
        })
      )
      : [];

    if (runCoreChecks) {
      await withTiming(stepDurationsMs, "core.slog-agent-secrets-health", async () =>
        step.run("slog-agent-secrets-health", async () => {
          const service = services.find((item) => item.name === "Agent Secrets");
          if (!service) return { skipped: true, reason: "service-missing" };

          const redis = new Redis({
            host: "localhost",
            port: 6379,
            lazyConnect: true,
            connectTimeout: 3000,
          });
          redis.on("error", () => {});

          try {
            if (!service.ok) {
              const shouldLog = await redis.set(
                "health:agent-secrets:down:logged",
                String(Date.now()),
                "EX",
                3600,
                "NX"
              );
              if (!shouldLog) return { logged: false, reason: "cooldown" };

              await step.sendEvent("slog-agent-secrets-down", {
                name: "system/log.written",
                data: {
                  action: "degraded",
                  tool: "agent-secrets",
                  detail: `Agent Secrets daemon unavailable: ${service.detail ?? "unknown"}`,
                  reason: "check/system-health",
                },
              });

              return { logged: true, state: "down" };
            }

            const shouldLogRecovery = await redis.set(
              "health:agent-secrets:up:logged",
              String(Date.now()),
              "EX",
              3600,
              "NX"
            );
            await redis.del("health:agent-secrets:down:logged");
            if (!shouldLogRecovery) return { logged: false, state: "up", reason: "cooldown" };

            await step.sendEvent("slog-agent-secrets-up", {
              name: "system/log.written",
              data: {
                action: "recovered",
                tool: "agent-secrets",
                detail: "Agent Secrets daemon healthy",
                reason: "check/system-health",
              },
            });
            return { logged: true, state: "up" };
          } catch (error) {
            return { logged: false, error: String(error) };
          } finally {
            redis.disconnect();
          }
        })
      );
    }

    let otelErrorRate: OtelErrorRateSummary | null = null;
    let writeGateDrift: WriteGateDriftSummary | null = null;

    if (runSignalChecks) {
      otelErrorRate = await withTiming(stepDurationsMs, "signals.check-otel-error-rate", async () =>
        step.run("check-otel-error-rate", async () => checkOtelErrorRate())
      );

      writeGateDrift = await withTiming(
        stepDurationsMs,
        "signals.check-memory-write-gate-drift",
        async () => step.run("check-memory-write-gate-drift", async () => checkWriteGateDrift()),
      );
    }

    const otelHealthResult = await withTiming(stepDurationsMs, "summary.emit-otel-health", async () =>
      step.run("emit-otel-health-summary", async () => {
        const degradedCount = services.filter((service) => !service.ok).length;
        return emitOtelEvent({
          level: degradedCount === 0 ? "info" : "warn",
          source: "worker",
          component: "check-system-health",
          action: "system.health.checked",
          success: degradedCount === 0,
          metadata: {
            runContext: flowContext,
            mode,
            slicePolicy,
            runCoreChecks,
            runSignalChecks,
            runtimeMs: normalizeTimestampToMs(Date.now() - runStartedAt),
            stepDurationsMs,
            degradedCount,
            services: services.map((service) => ({
              name: service.name,
              ok: service.ok,
              durationMs: service.durationMs ?? 0,
            })),
            otelErrorRate,
            writeGateDrift,
          },
        });
      })
    );

    if (!otelHealthResult.stored) {
      const otelRedisPort = getRedisPort();
      await warnOtelGapViaEvents(
        process.env.REDIS_HOST ?? "localhost",
        otelRedisPort,
        {
          sourceFunction: "system/check-system-health",
          targetComponent: "otel_events",
              targetEventName: "system.health.checked",
              problemSummary: "otel_events write gap in check-system-health",
              domain: "otel-pipeline",
              attempt: 0,
              reason: "Unable to persist health summary telemetry from check-system-health",
              sourceEventId: event.id,
              sourceEventName: eventName,
              runContextKey: flowContext.runContextKey,
              flowTrace: flowContext.flowTrace,
              evidence: [{ type: "health-summary", detail: `stored=${otelHealthResult.stored}` }],
              playbook: {
            actions: ["Collect recent otel_events sink status", "Check typesense/convex availability"],
            restart: [],
            kill: [],
            defer: [],
            notify: ["joelclaw gateway events", "joelclaw otel list --hours 1"],
            links: ["/Users/joel/Vault/system/system-log.jsonl"],
          },
        },
      );
    }

    if (!runCoreChecks) {
      return {
        status: "signals",
        mode,
        slicePolicy,
        services,
        otelErrorRate,
        writeGateDrift,
        stepDurationsMs,
      };
    }

    // Push all service statuses to Convex dashboard — ADR-0075
    await withTiming(stepDurationsMs, "core.push-to-convex", async () =>
      step.run("push-to-convex", async () => {
        await Promise.allSettled(
          services.map((s) =>
            pushSystemStatus(
              s.name.toLowerCase(),
              s.ok ? "healthy" : "down",
              s.detail
            )
          )
        );
      })
    );

    const degraded = services.filter((s) => !s.ok);

    const gatewayCriticalDegrade = degraded.filter((service) =>
      service.name === "Gateway" || service.name === "Redis"
    );

    if (gatewayCriticalDegrade.length > 0) {
      await withTiming(stepDurationsMs, "core.dispatch-gateway-bridge-self-heal", async () =>
        step.run("dispatch-gateway-bridge-self-heal", async () => {
          const evidence = gatewayCriticalDegrade.map((service) => ({
            type: "service-health",
            detail: `${service.name}: ${service.detail ?? "down"}`,
          }));
          const summaryLine = gatewayCriticalDegrade
            .map((service) => `${service.name}=${service.ok ? "ok" : "down"}`)
            .join(", ");
          const dispatchFlowContext = buildSelfHealingFlowContext({
            sourceFunction: "system/check-system-health",
            targetComponent: "gateway-bridge",
            targetEventName: GATEWAY_BRIDGE_HEALTH_REQUEST_EVENT,
            domain: "gateway-bridge",
            eventName,
            eventId: event.id,
            attempt: 0,
            evidenceCount: evidence.length,
          });

          await step.sendEvent("emit-gateway-bridge-self-healing-request", {
            name: SELF_HEALING_GATEWAY_REQUEST_EVENT,
            data: {
              sourceFunction: "system/check-system-health",
              targetComponent: "gateway-bridge",
              targetEventName: GATEWAY_BRIDGE_HEALTH_REQUEST_EVENT,
              problemSummary: `Gateway bridge degradation detected: ${summaryLine}`,
              domain: "gateway-bridge",
              attempt: 0,
              retryPolicy: GATEWAY_HEALING_RETRY_POLICY,
              evidence,
              context: {
                checkMode: mode,
                services: gatewayCriticalDegrade.map((service) => ({
                  name: service.name,
                  detail: service.detail ?? "",
                })),
                runContextKey: dispatchFlowContext.runContextKey,
                flowTrace: dispatchFlowContext.flowTrace,
                summaryLine,
                sourceEventName: dispatchFlowContext.sourceEventName,
                sourceEventId: dispatchFlowContext.sourceEventId,
                evidenceSummary: summarizeEvidenceForOtel(evidence),
                flowContext: dispatchFlowContext,
                serviceDetails: gatewayCriticalDegrade.map((service) => ({
                  name: service.name,
                  detail: service.detail ?? "",
                })),
              },
              playbook: {
                actions: [
                  "Reconcile pending stream entries",
                  "Prune orphaned priority queue indexes",
                  "Purge malformed gateway event queue entries",
                ],
                restart: [
                  "joelclaw gateway restart",
                  "joelclaw inngest restart-worker --register",
                ],
                kill: ["pkill -f joelclaw-gateway"],
                defer: ["joelclaw status", "joelclaw gateway status", "joelclaw runs --count 10 --hours 1"],
                notify: ["joelclaw gateway events"],
                links: [
                  "/Users/joel/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/self-healing-gateway-bridge.ts",
                  "/Users/joel/Code/joelhooks/joelclaw/packages/system-bus/src/inngest/functions/check-system-health.ts",
                ],
              },
              owner: "system",
              fallbackAction: "manual",
              requestedBy: "system/check-system-health",
              dryRun: false,
            },
          });
          await emitOtelEvent({
            level: "info",
            source: "worker",
            component: "check-system-health",
            action: "system.health.self-healing.dispatch",
            success: true,
            metadata: {
              flowContext: dispatchFlowContext,
              mode,
              severity: "gateway-bridge",
              targetEventName: GATEWAY_BRIDGE_HEALTH_REQUEST_EVENT,
              targetServices: gatewayCriticalDegrade.map((service) => service.name),
              evidenceSummary: summarizeEvidenceForOtel(evidence),
            },
          });
        })
      );
    }

    if (otelErrorRate && otelErrorRate.shouldEscalate) {
      await withTiming(stepDurationsMs, "signals.notify-otel-error-rate", async () =>
        step.run("notify-otel-error-rate", async () => {
          const prompt = [
            "## 🚨 Elevated Error Rate",
            "",
            `Window: last ${otelErrorRate.windowMinutes} minutes`,
            `Errors: ${otelErrorRate.errors} / ${otelErrorRate.total} (${Math.round(otelErrorRate.rate * 100)}%)`,
            `Threshold: ${Math.round(otelErrorRate.threshold * 100)}% with >= ${otelErrorRate.minEvents} events`,
            "",
            "Investigate recent otel_events grouped by component and prioritize fatal/error sources.",
          ].join("\n");

          await pushGatewayEvent({
            type: "system.health.error-rate",
            source: "inngest/check-system-health",
            payload: {
              prompt,
              level: "error",
              immediateTelegram: true,
              otelErrorRate,
            },
          });
        })
      );

      await withTiming(stepDurationsMs, "signals.notify-convex-otel-error-rate", async () =>
        step.run("notify-convex-otel-error-rate", async () => {
          await pushNotification(
            "error",
            `Elevated error rate: ${Math.round(otelErrorRate.rate * 100)}%`,
            `Errors ${otelErrorRate.errors}/${otelErrorRate.total} in ${otelErrorRate.windowMinutes}m`
          );
        })
      );
    }

    if (writeGateDrift && writeGateDrift.shouldEscalate) {
      await withTiming(stepDurationsMs, "signals.notify-memory-write-gate-drift", async () =>
        step.run("notify-memory-write-gate-drift", async () => {
          const prompt = [
            "## ⚠️ Memory Write-Gate Drift",
            "",
            `Window: last ${writeGateDrift.windowMinutes} minutes`,
            `Observe events with gate counts: ${writeGateDrift.eventsWithGateCounts}/${writeGateDrift.totalEvents}`,
            `allow|hold|discard: ${writeGateDrift.allowCount}|${writeGateDrift.holdCount}|${writeGateDrift.discardCount}`,
            `hold ratio: ${Math.round(writeGateDrift.holdRatio * 100)}% (threshold ${Math.round(writeGateDrift.holdRatioThreshold * 100)}%)`,
            `discard ratio: ${Math.round(writeGateDrift.discardRatio * 100)}% (threshold ${Math.round(writeGateDrift.discardRatioThreshold * 100)}%)`,
            `fallback rate: ${Math.round(writeGateDrift.fallbackRate * 100)}% (threshold ${Math.round(writeGateDrift.fallbackRateThreshold * 100)}%)`,
            "",
            "Investigate observe prompt/parser drift and recent ingest quality.",
          ].join("\n");

          await pushGatewayEvent({
            type: "system.health.memory-write-gate-drift",
            source: "inngest/check-system-health",
            payload: {
              prompt,
              level: "warn",
              immediateTelegram: true,
              writeGateDrift,
            },
          });
        })
      );

      await withTiming(stepDurationsMs, "signals.notify-convex-memory-write-gate-drift", async () =>
        step.run("notify-convex-memory-write-gate-drift", async () => {
          await pushNotification(
            "error",
            "Memory write-gate drift detected",
            `hold=${Math.round(writeGateDrift.holdRatio * 100)}% discard=${Math.round(writeGateDrift.discardRatio * 100)}% fallback=${Math.round(writeGateDrift.fallbackRate * 100)}%`
          );
        })
      );

      await withTiming(stepDurationsMs, "signals.emit-memory-write-gate-drift", async () =>
        step.run("emit-memory-write-gate-drift", async () => {
          const redis = new Redis({
            host: "localhost",
            port: 6379,
            lazyConnect: true,
            connectTimeout: 3000,
          });
          redis.on("error", (e) => console.error("[write-gate-drift] redis error:", e));

          try {
            await redis.connect();
            const lastNotified = await redis.get(WRITE_GATE_DRIFT_LAST_NOTIFIED_KEY);
            if (lastNotified) {
              return { emitted: false, reason: "cooldown" };
            }

            await emitOtelEvent({
              level: "warn",
              source: "worker",
              component: "check-system-health",
              action: "memory.write_gate_drift.detected",
              success: false,
              metadata: {
                runContext: {
                  runContextKey: flowContext.runContextKey,
                  flowTrace: flowContext.flowTrace,
                  sourceEventName: flowContext.sourceEventName,
                  sourceEventId: flowContext.sourceEventId,
                  attempt: flowContext.attempt,
                },
                mode,
                writeGateDrift,
              },
            });

            await redis.set(
              WRITE_GATE_DRIFT_LAST_NOTIFIED_KEY,
              new Date().toISOString(),
              "EX",
              WRITE_GATE_DRIFT_NOTIFY_COOLDOWN_SECONDS,
            );

            return { emitted: true };
          } finally {
            redis.disconnect();
          }
        })
      );
    }

    // NOOP: all healthy → no notification
    if (degraded.length === 0) {
      // ADR-0085: trigger live network status collection after health checks.
      await withTiming(stepDurationsMs, "core.emit-network-update", async () =>
        step.sendEvent("emit-network-update", {
          name: "system/network.update",
          data: { source: "check-system-health", checkedAt: Date.now() },
        })
      );
      return { status: "noop", mode, slicePolicy, services, stepDurationsMs };
    }

    // Filter: don't re-alert about things that already have tasks
    const newDegraded = await withTiming(stepDurationsMs, "core.filter-against-tasks", async () =>
      step.run("filter-against-tasks", async () => {
        const tasks = await getCurrentTasks();
        return degraded.filter((s) => !hasTaskMatching(tasks, s.name));
      })
    );

    if (newDegraded.length === 0) {
      // ADR-0085: trigger live network status collection after health checks.
      await withTiming(stepDurationsMs, "core.emit-network-update", async () =>
        step.sendEvent("emit-network-update", {
          name: "system/network.update",
          data: { source: "check-system-health", checkedAt: Date.now() },
        })
      );
      return {
        status: "noop",
        mode,
        slicePolicy,
        reason: "degraded but already tracked in tasks",
        services,
        stepDurationsMs,
      };
    }

    // Something's down and NOT already tracked → alert gateway
    const typedDegraded = newDegraded as unknown as ServiceStatus[];
    const degradedNames = typedDegraded.map((s) => s.name);
    const degradedDetails = typedDegraded.map((s) => `${s.name}: ${s.detail ?? "down"}`);
    const criticalDown = typedDegraded.filter((service) =>
      CRITICAL_COMPONENTS.has(service.name.toLowerCase())
    );

    await withTiming(stepDurationsMs, "core.notify-degradation", async () =>
      step.run("notify-degradation", async () => {
        const lines = [
          "## 🚨 System Health Degradation",
          "",
          ...services.map((s) => {
            const icon = s.ok ? "✅" : "❌";
            const detail = s.detail ? ` — ${s.detail.slice(0, 100)}` : "";
            return `- ${icon} **${s.name}**${detail}`;
          }),
        ];

        await pushGatewayEvent({
          type: "system.health.degraded",
          source: "inngest/check-system-health",
          payload: {
            prompt: lines.join("\n"),
            degraded: degraded.map((s) => s.name),
          },
        });
      })
    );

    if (criticalDown.length > 0) {
      await withTiming(stepDurationsMs, "core.notify-fatal-immediate", async () =>
        step.run("notify-fatal-immediate", async () => {
          const prompt = [
            "## ☠️ Critical Service Failure",
            "",
            ...criticalDown.map((service) => `- ${service.name}: ${service.detail ?? "down"}`),
            "",
            "Immediate attention required. This alert bypassed normal digest batching.",
          ].join("\n");

          await pushGatewayEvent({
            type: "system.fatal",
            source: "inngest/check-system-health",
            payload: {
              prompt,
              level: "fatal",
              immediateTelegram: true,
              critical: criticalDown.map((service) => service.name),
            },
          });
        })
      );

      await withTiming(stepDurationsMs, "core.emit-fatal-service-alert", async () =>
        step.run("emit-fatal-service-alert", async () => {
          await emitOtelEvent({
            level: "fatal",
            source: "worker",
            component: "check-system-health",
            action: "system.health.critical_failure",
            success: false,
            error: criticalDown.map((service) => service.name).join(", "),
            metadata: {
              runContext: {
                runContextKey: flowContext.runContextKey,
                flowTrace: flowContext.flowTrace,
                sourceEventName: flowContext.sourceEventName,
                sourceEventId: flowContext.sourceEventId,
                attempt: flowContext.attempt,
              },
              mode,
              criticalDown,
            },
          });
        })
      );
    }

    // Push degradation notification to Convex dashboard — ADR-0075
    await withTiming(stepDurationsMs, "core.notify-convex-degradation", async () =>
      step.run("notify-convex-degradation", async () => {
        await pushNotification(
          "error",
          `Health degradation: ${degradedNames.join(", ")}`,
          degradedDetails.join("\n")
        );
      })
    );

    // ADR-0085: trigger live network status collection after health checks.
    await withTiming(stepDurationsMs, "core.emit-network-update", async () =>
      step.sendEvent("emit-network-update", {
        name: "system/network.update",
        data: { source: "check-system-health", checkedAt: Date.now() },
      })
    );

    return {
      status: "degraded",
      mode,
      slicePolicy,
      degraded: degraded.map((s) => s.name),
      services,
      otelErrorRate,
      stepDurationsMs,
    };
  }
);

export const checkSystemHealthSignalsSchedule = inngest.createFunction(
  { id: "check/system-health-signals-schedule" },
  [{ cron: "7 * * * *" }],
  async ({ step }) => {
    await step.sendEvent("request-health-signals-slice", {
      name: "system/health.requested",
      data: {
        mode: "signals",
        source: "system-health-signals-hourly",
      },
    });

    await step.run("emit-otel-health-signals-scheduled", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "check-system-health",
        action: "system.health.signals.scheduled",
        success: true,
        metadata: {
          mode: "signals",
          slicePolicy: HEALTH_SLICE_POLICIES.signals,
          cron: "7 * * * *",
        },
      });
    });

    return { status: "scheduled", mode: "signals" };
  }
);
