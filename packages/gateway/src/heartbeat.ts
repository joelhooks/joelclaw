/**
 * Gateway heartbeat — tripwire, watchdog, and digest flush.
 *
 * NO LONGER injects HEARTBEAT.md prompts into the pi session.
 * Health checks are handled by Inngest check/* functions (ADR-0062)
 * which push to gateway only when actionable.
 *
 * This module only:
 * 1. Writes a tripwire file so launchd can detect a dead gateway
 * 2. Runs a watchdog alarm if tripwire goes stale
 * 3. Flushes batched event digests hourly
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getConsecutiveFailures, getQueueDepth } from "./command-queue";
import { flushBatchDigest, getGatewayMode, isHealthy as isRedisHealthy } from "./channels/redis";
import { emitGatewayOtel } from "./observability";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const HEARTBEAT_CHECKLIST_PATH = `${homedir()}/Vault/HEARTBEAT.md`;
const TRIPWIRE_DIR = "/tmp/joelclaw";
const TRIPWIRE_PATH = `${TRIPWIRE_DIR}/last-heartbeat.ts`;

type TimerHandle = ReturnType<typeof setInterval>;

export type HeartbeatRunner = {
  stop: () => Promise<void>;
  shutdown: () => Promise<void>;
};

let lastHeartbeatTs: number | undefined;
let watchdogAlarmFired = false;

async function writeTripwire(ts: number): Promise<void> {
  await mkdir(TRIPWIRE_DIR, { recursive: true });
  await writeFile(TRIPWIRE_PATH, `export const lastHeartbeatTs = ${ts};\n`);
}

/**
 * Lightweight local health snapshot — no tool calls, no API hits.
 * Checks in-process state only. Used for OTEL and watchdog decisions.
 */
function getLocalHealth(): { healthy: boolean; redis: boolean; session: boolean; queueDepth: number } {
  const failures = getConsecutiveFailures();
  const queueDepth = getQueueDepth();
  const redis = isRedisHealthy();
  const session = failures < 3;
  return { healthy: redis && session && queueDepth <= 2, redis, session, queueDepth };
}

async function tickHeartbeat(): Promise<void> {
  const mode = await getGatewayMode();
  if (mode === "sleep") {
    console.log("[heartbeat] skipped tick (sleep mode)");
    return;
  }

  const ts = Date.now();
  lastHeartbeatTs = ts;
  watchdogAlarmFired = false;

  // Write tripwire for launchd watchdog
  try {
    await writeTripwire(ts);
  } catch (error) {
    console.error("[heartbeat] failed to write tripwire", {
      path: TRIPWIRE_PATH,
      error,
    });
  }

  // Emit local health snapshot (no tool calls)
  const health = getLocalHealth();
  void emitGatewayOtel({
    level: health.healthy ? "debug" : "warn",
    component: "heartbeat",
    action: "heartbeat.tick",
    success: health.healthy,
    metadata: {
      redis: health.redis ? "ok" : "degraded",
      session: health.session ? "ok" : "degraded",
      queueDepth: health.queueDepth,
    },
  });

  if (!health.healthy) {
    console.warn("[heartbeat] local health degraded", health);
  }
}

function runWatchdog(): void {
  if (lastHeartbeatTs === undefined) return;
  if (watchdogAlarmFired) return;

  const elapsedMs = Date.now() - lastHeartbeatTs;
  if (elapsedMs <= THIRTY_MINUTES_MS) return;

  watchdogAlarmFired = true;

  console.warn("[heartbeat] watchdog alarm: heartbeat overdue", {
    lastHeartbeatTs,
    elapsedMs,
    thresholdMs: THIRTY_MINUTES_MS,
  });
}

/**
 * Filter heartbeat responses — kept for backward compatibility
 * but will no longer fire since we don't inject heartbeat prompts.
 */
export function filterHeartbeatResponse(response: unknown, context?: { source?: unknown }): boolean {
  const source = typeof context?.source === "string" ? context.source : undefined;
  if (source !== "heartbeat") return false;

  if (typeof response !== "string") return false;
  const trimmed = response.trim();
  return trimmed === "HEARTBEAT_OK" || (trimmed.includes("HEARTBEAT_OK") && trimmed.length < 300);
}

export function startHeartbeatRunner(): HeartbeatRunner {
  lastHeartbeatTs = Date.now();
  watchdogAlarmFired = false;

  // Initialize tripwire immediately on startup
  void writeTripwire(lastHeartbeatTs).catch((error) => {
    console.error("[heartbeat] failed to initialize tripwire", {
      path: TRIPWIRE_PATH,
      error,
    });
  });

  // Tripwire tick — lightweight, no pi session involvement
  const heartbeatTimer: TimerHandle = setInterval(async () => {
    await tickHeartbeat();
  }, FIFTEEN_MINUTES_MS);

  const watchdogTimer: TimerHandle = setInterval(() => {
    runWatchdog();
  }, FIVE_MINUTES_MS);

  // Hourly batch digest flush
  const digestTimer: TimerHandle = setInterval(async () => {
    try {
      const mode = await getGatewayMode();
      if (mode === "sleep") {
        console.log("[heartbeat] skipped digest flush (sleep mode)");
        return;
      }

      const count = await flushBatchDigest();
      if (count > 0) {
        console.log(`[heartbeat] hourly digest flushed ${count} events`);
      }
    } catch (error) {
      console.error("[heartbeat] digest flush failed", { error });
    }
  }, ONE_HOUR_MS);

  const stop = async (): Promise<void> => {
    clearInterval(heartbeatTimer);
    clearInterval(watchdogTimer);
    clearInterval(digestTimer);
  };

  return {
    stop,
    shutdown: stop,
  };
}

export { HEARTBEAT_CHECKLIST_PATH, TRIPWIRE_PATH };

export default startHeartbeatRunner;
