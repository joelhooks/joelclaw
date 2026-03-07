import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  ack,
  type CandidateMessage,
  drainByPriority,
  getUnacked,
  indexMessagesByPriority,
  init,
  lookupQueueEvent,
  type QueueConfig,
  type QueueEventEnvelope,
  type QueueEventRegistryEntry,
  type StoredMessage,
  type TelemetryEmitter,
} from "@joelclaw/queue";
import Redis from "ioredis";
import { emitOtel } from "./otel";
import type { DagNodeInput, DagRunRequest } from "./workflows/dag-orchestrator";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const RESTATE_INGRESS_URL = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";
const QUEUE_DRAINER_ENABLED = parseBooleanEnv(process.env.QUEUE_DRAINER_ENABLED, true);
const QUEUE_DRAIN_INTERVAL_MS = parseNumberEnv(process.env.QUEUE_DRAIN_INTERVAL_MS, 2_000);
const QUEUE_DRAINER_CONCURRENCY = parseNumberEnv(process.env.QUEUE_DRAINER_CONCURRENCY, 1);
const QUEUE_DRAIN_FAILURE_BACKOFF_MS = parseNumberEnv(process.env.QUEUE_DRAIN_FAILURE_BACKOFF_MS, 30_000);
const DISPATCH_SEND_TIMEOUT_MS = parseNumberEnv(process.env.QUEUE_DRAIN_SEND_TIMEOUT_MS, 10_000);
const QUEUE_DRAIN_STALL_AFTER_MS = parseNumberEnv(process.env.QUEUE_DRAIN_STALL_AFTER_MS, 45_000);
const QUEUE_DRAIN_WATCHDOG_INTERVAL_MS = Math.min(
  QUEUE_DRAIN_STALL_AFTER_MS,
  Math.max(5_000, QUEUE_DRAIN_INTERVAL_MS),
);
const QUEUE_CONFIG: QueueConfig = {
  streamKey: "joelclaw:queue:events",
  priorityKey: "joelclaw:queue:priority",
  consumerGroup: "joelclaw:queue:restate",
  consumerName: `restate-${hostname()}-${process.pid}`,
};

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseNumberEnv(value: string | undefined, defaultValue: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function createImmediateTickScheduler(run: () => void): () => void {
  let scheduled = false;

  return () => {
    if (scheduled) return;
    scheduled = true;

    queueMicrotask(() => {
      scheduled = false;
      run();
    });
  };
}

type QueueDrainerStallReason = "tick_hung" | "dispatch_hung" | "backlog_idle";

type QueueDrainerWatchdogSnapshot = {
  now: number;
  queueDepth: number;
  draining: boolean;
  stopping: boolean;
  activeDispatchAgesMs: number[];
  lastTickStartedAt: number | null;
  lastTickFinishedAt: number | null;
  nextRetryAt: number | null;
  stallAfterMs: number;
};

type QueueDrainerStall = {
  reason: QueueDrainerStallReason;
  ageMs: number;
};

function detectQueueDrainerStall(snapshot: QueueDrainerWatchdogSnapshot): QueueDrainerStall | null {
  if (snapshot.stopping || snapshot.queueDepth <= 0) return null;

  if (snapshot.draining && snapshot.lastTickStartedAt != null) {
    const ageMs = snapshot.now - snapshot.lastTickStartedAt;
    if (ageMs >= snapshot.stallAfterMs) {
      return { reason: "tick_hung", ageMs };
    }
  }

  if (snapshot.activeDispatchAgesMs.length > 0) {
    const oldestDispatchAgeMs = Math.max(...snapshot.activeDispatchAgesMs);
    if (oldestDispatchAgeMs >= snapshot.stallAfterMs) {
      return { reason: "dispatch_hung", ageMs: oldestDispatchAgeMs };
    }
    return null;
  }

  if (snapshot.draining) return null;
  if (snapshot.nextRetryAt != null && snapshot.nextRetryAt > snapshot.now) return null;
  if (snapshot.lastTickFinishedAt == null) return null;

  const idleAgeMs = snapshot.now - snapshot.lastTickFinishedAt;
  if (idleAgeMs >= snapshot.stallAfterMs) {
    return { reason: "backlog_idle", ageMs: idleAgeMs };
  }

  return null;
}

async function readEnvValue(name: string): Promise<string | undefined> {
  const direct = process.env[name]?.trim();
  if (direct) return direct;

  const envPath = join(process.env.HOME ?? "/Users/joel", ".config", "system-bus.env");
  try {
    const raw = await readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key === name) return value.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // ignore env-file misses
  }

  return undefined;
}

function sanitizeWorkflowKey(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "-");
  return sanitized.length > 0 ? sanitized : "queue-dispatch";
}

function normalizeEnvelope(message: StoredMessage): QueueEventEnvelope<Record<string, unknown>> {
  const payload = message.payload ?? {};
  const payloadId = typeof payload.id === "string" && payload.id.trim().length > 0
    ? payload.id.trim()
    : `queue:${message.id}`;
  const name = typeof payload.name === "string" && payload.name.trim().length > 0
    ? payload.name.trim()
    : undefined;

  if (!name) {
    throw new Error(`queue payload ${message.id} is missing envelope.name`);
  }

  const source = typeof payload.source === "string" && payload.source.trim().length > 0
    ? payload.source.trim()
    : "queue";
  const ts = typeof payload.ts === "number" && Number.isFinite(payload.ts)
    ? payload.ts
    : message.timestamp;
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : {};

  return {
    id: payloadId,
    name,
    source,
    ts,
    data,
    priority: message.priority,
    ...(payload.trace && typeof payload.trace === "object" && !Array.isArray(payload.trace)
      ? { trace: payload.trace as QueueEventEnvelope["trace"] }
      : {}),
    ...(payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
      ? { meta: payload.meta as Record<string, unknown> }
      : {}),
  };
}

function buildDispatchWorkflowId(message: StoredMessage, envelope: QueueEventEnvelope): string {
  return `queue-dispatch-${sanitizeWorkflowKey(envelope.id || message.id)}`;
}

function buildInngestDispatchNode(
  registry: QueueEventRegistryEntry,
  envelope: QueueEventEnvelope<Record<string, unknown>>,
  inngestUrl: string,
  inngestEventKey: string,
): DagNodeInput {
  return {
    id: "dispatch-event",
    task: `dispatch ${envelope.name} to Inngest event ${registry.handler?.target}`,
    handler: "http",
    config: {
      url: `${inngestUrl.replace(/\/$/u, "")}/e/${inngestEventKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: envelope.id,
        name: registry.handler?.target,
        ts: envelope.ts,
        data: envelope.data,
      }),
      timeoutMs: 15_000,
    },
  };
}

function buildHttpDispatchNode(
  registry: QueueEventRegistryEntry,
  envelope: QueueEventEnvelope<Record<string, unknown>>,
): DagNodeInput {
  return {
    id: "dispatch-event",
    task: `dispatch ${envelope.name} to HTTP target ${registry.handler?.target}`,
    handler: "http",
    config: {
      url: registry.handler?.target,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope.data),
      timeoutMs: 15_000,
    },
  };
}

async function buildDispatchNode(
  registry: QueueEventRegistryEntry,
  envelope: QueueEventEnvelope<Record<string, unknown>>,
): Promise<DagNodeInput> {
  if (!registry.handler) {
    throw new Error(`queue event ${registry.name} has no handler target`);
  }

  switch (registry.handler.type) {
    case "inngest": {
      const inngestEventKey = await readEnvValue("INNGEST_EVENT_KEY");
      const inngestUrl = (await readEnvValue("INNGEST_URL")) ?? "http://localhost:8288";

      if (!inngestEventKey) {
        throw new Error("INNGEST_EVENT_KEY is required for queue drainer Inngest dispatch");
      }

      return buildInngestDispatchNode(registry, envelope, inngestUrl, inngestEventKey);
    }
    case "http":
      return buildHttpDispatchNode(registry, envelope);
    case "local":
      throw new Error(`queue handler ${registry.name} uses unsupported local target ${registry.handler.target}`);
    default:
      throw new Error(`queue handler ${registry.name} uses unknown handler type ${(registry.handler as { type?: string }).type ?? "unknown"}`);
  }
}

async function buildDispatchRequest(
  message: StoredMessage,
  registry: QueueEventRegistryEntry,
): Promise<{
  workflowId: string;
  envelope: QueueEventEnvelope<Record<string, unknown>>;
  request: DagRunRequest;
}> {
  const envelope = normalizeEnvelope(message);
  const workflowId = buildDispatchWorkflowId(message, envelope);
  const node = await buildDispatchNode(registry, envelope);

  return {
    workflowId,
    envelope,
    request: {
      requestId: workflowId,
      pipeline: `queue-dispatch:${envelope.name}`,
      nodes: [node],
    },
  };
}

async function postRestateSend(workflowId: string, request: DagRunRequest): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_SEND_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${RESTATE_INGRESS_URL.replace(/\/$/u, "")}/dagOrchestrator/${workflowId}/run/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Restate /send failed (${response.status}): ${errorText.slice(0, 500)}`);
    }

    const result = await response.json();
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return {};
  } finally {
    clearTimeout(timer);
  }
}

const queueTelemetry: TelemetryEmitter = {
  emit(action, detail, extra) {
    void emitOtel({
      action,
      component: "queue-drainer",
      metadata: {
        detail,
        ...(extra ?? {}),
      },
    });
  },
};

export async function startQueueDrainer(): Promise<() => Promise<void>> {
  if (!QUEUE_DRAINER_ENABLED) {
    console.log("[queue-drainer] disabled by QUEUE_DRAINER_ENABLED");
    return async () => {};
  }

  const redis = new Redis(REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
  redis.on("error", () => {
    // queue init/dispatch paths surface real failures; avoid noisy unhandled events
  });

  await init(redis, QUEUE_CONFIG, { telemetry: queueTelemetry });

  const replayable = await getUnacked();
  const replayIndexed = await indexMessagesByPriority(replayable);

  await emitOtel({
    action: "queue.drainer.started",
    component: "queue-drainer",
    metadata: {
      consumerGroup: QUEUE_CONFIG.consumerGroup,
      consumerName: QUEUE_CONFIG.consumerName,
      intervalMs: QUEUE_DRAIN_INTERVAL_MS,
      concurrency: QUEUE_DRAINER_CONCURRENCY,
      stallAfterMs: QUEUE_DRAIN_STALL_AFTER_MS,
      replayable: replayable.length,
      replayIndexed,
    },
  });

  console.log(
    `[queue-drainer] started consumer=${QUEUE_CONFIG.consumerName} interval=${QUEUE_DRAIN_INTERVAL_MS}ms stallAfter=${QUEUE_DRAIN_STALL_AFTER_MS}ms replayable=${replayable.length}`,
  );

  let stopping = false;
  let draining = false;
  const activeDispatches = new Map<string, number>();
  const retryNotBefore = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  let scheduleTickSoon: () => void = () => {};
  let lastTickStartedAt: number | null = null;
  let lastTickFinishedAt: number | null = Date.now();
  let watchdogTripped = false;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const tripWatchdog = async (reason: QueueDrainerStallReason, ageMs: number, queueDepth: number): Promise<void> => {
    if (watchdogTripped || stopping) return;
    watchdogTripped = true;
    stopping = true;

    const active = [...activeDispatches.entries()].map(([streamId, startedAt]) => ({
      streamId,
      ageMs: Math.max(0, Date.now() - startedAt),
    }));

    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }

    await emitOtel({
      level: "error",
      action: "queue.drainer.stalled",
      component: "queue-drainer",
      success: false,
      error: `queue drainer stalled: ${reason}`,
      metadata: {
        reason,
        ageMs,
        queueDepth,
        stallAfterMs: QUEUE_DRAIN_STALL_AFTER_MS,
        lastTickStartedAt,
        lastTickFinishedAt,
        activeDispatchCount: activeDispatches.size,
        activeDispatches: active,
      },
    });

    console.error(`[queue-drainer] stalled (${reason}, age=${ageMs}ms, depth=${queueDepth}); exiting for supervisor recovery`);
    setTimeout(() => {
      process.exit(1);
    }, 0);
  };

  const dispatchCandidate = async (candidate: CandidateMessage): Promise<void> => {
    const streamId = candidate.message.id;

    try {
      const envelope = normalizeEnvelope(candidate.message);
      const registry = lookupQueueEvent(envelope.name);
      if (!registry) {
        throw new Error(`queue event ${envelope.name} is not registered`);
      }

      const { workflowId, request } = await buildDispatchRequest(candidate.message, registry);

      await emitOtel({
        action: "queue.dispatch.started",
        component: "queue-drainer",
        metadata: {
          streamId,
          eventId: envelope.id,
          eventName: envelope.name,
          handlerType: registry.handler?.type,
          handlerTarget: registry.handler?.target,
          workflowId,
          waitTimeMs: candidate.waitTimeMs,
          promotedFrom: candidate.promotedFrom,
        },
      });

      const sendResult = await postRestateSend(workflowId, request);
      await ack(streamId);
      retryNotBefore.delete(streamId);

      await emitOtel({
        action: "queue.dispatch.completed",
        component: "queue-drainer",
        metadata: {
          streamId,
          eventId: envelope.id,
          eventName: envelope.name,
          workflowId,
          invocationId: sendResult.invocationId ?? sendResult.id,
          restateStatus: sendResult.status,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      retryNotBefore.set(streamId, Date.now() + QUEUE_DRAIN_FAILURE_BACKOFF_MS);

      await emitOtel({
        level: "error",
        action: "queue.dispatch.failed",
        component: "queue-drainer",
        success: false,
        error: message,
        metadata: {
          streamId,
          retryBackoffMs: QUEUE_DRAIN_FAILURE_BACKOFF_MS,
        },
      });

      console.error(`[queue-drainer] dispatch failed for ${streamId}: ${message}`);
    } finally {
      activeDispatches.delete(streamId);
      scheduleTickSoon();
    }
  };

  const tick = async (): Promise<void> => {
    if (stopping || draining || activeDispatches.size >= QUEUE_DRAINER_CONCURRENCY) {
      return;
    }

    draining = true;
    lastTickStartedAt = Date.now();

    try {
      const availableSlots = Math.max(0, QUEUE_DRAINER_CONCURRENCY - activeDispatches.size);
      if (availableSlots === 0) return;

      const candidates = await drainByPriority({
        limit: Math.max(availableSlots * 4, 4),
        excludeIds: activeDispatches.keys(),
      });

      const now = Date.now();
      const ready = candidates
        .filter((candidate) => (retryNotBefore.get(candidate.message.id) ?? 0) <= now)
        .slice(0, availableSlots);

      for (const candidate of ready) {
        activeDispatches.set(candidate.message.id, Date.now());
        let task: Promise<void> | undefined;
        task = dispatchCandidate(candidate).finally(() => {
          if (task) inflight.delete(task);
        });
        inflight.add(task);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await emitOtel({
        level: "error",
        action: "queue.drainer.loop.failed",
        component: "queue-drainer",
        success: false,
        error: message,
      });
      console.error(`[queue-drainer] loop failed: ${message}`);
    } finally {
      draining = false;
      lastTickFinishedAt = Date.now();
    }
  };

  scheduleTickSoon = createImmediateTickScheduler(() => {
    if (stopping) return;
    void tick();
  });

  watchdog = setInterval(() => {
    if (stopping) return;

    void (async () => {
      const depth = await getQueueStats();
      const nextRetryAt = retryNotBefore.size > 0 ? Math.min(...retryNotBefore.values()) : null;
      const stall = detectQueueDrainerStall({
        now: Date.now(),
        queueDepth: depth.total,
        draining,
        stopping,
        activeDispatchAgesMs: [...activeDispatches.values()].map((startedAt) => Math.max(0, Date.now() - startedAt)),
        lastTickStartedAt,
        lastTickFinishedAt,
        nextRetryAt,
        stallAfterMs: QUEUE_DRAIN_STALL_AFTER_MS,
      });

      if (stall) {
        await tripWatchdog(stall.reason, stall.ageMs, depth.total);
      }
    })().catch((error) => {
      console.error(`[queue-drainer] watchdog check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, QUEUE_DRAIN_WATCHDOG_INTERVAL_MS);

  const interval = setInterval(() => {
    void tick();
  }, QUEUE_DRAIN_INTERVAL_MS);
  void tick();

  return async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    await Promise.allSettled([...inflight]);

    try {
      await redis.quit();
    } catch {
      redis.disconnect(false);
    }

    await emitOtel({
      action: "queue.drainer.stopped",
      component: "queue-drainer",
      metadata: {
        activeDispatches: activeDispatches.size,
      },
    });
    console.log("[queue-drainer] stopped");
  };
}

export const __queueDrainerTestUtils = {
  buildDispatchWorkflowId,
  buildHttpDispatchNode,
  buildInngestDispatchNode,
  createImmediateTickScheduler,
  detectQueueDrainerStall,
  normalizeEnvelope,
  sanitizeWorkflowKey,
};
