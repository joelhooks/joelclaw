/**
 * Gateway heartbeat — tripwire, watchdog, and digest flush.
 *
 * NO LONGER injects HEARTBEAT.md prompts into the pi session.
 * Health checks are handled by Inngest check/* functions (ADR-0062)
 * which push to gateway only when actionable.
 *
 * This module:
 * 1. Writes a tripwire file so launchd can detect a dead gateway
 * 2. Runs a watchdog alarm if tripwire goes stale
 * 3. Emits a local health snapshot + Talon health signal (localhost)
 * 4. Flushes batched event digests hourly
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import { flushBatchDigest, getGatewayMode, isHealthy as isRedisHealthy } from "./channels/redis";
import { getConsecutiveFailures, getQueueDepth } from "./command-queue";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const TALON_HEALTH_URL = process.env.TALON_HEALTH_URL ?? "http://127.0.0.1:9999/health";
const TALON_HEALTH_TIMEOUT_MS = Number.parseInt(process.env.TALON_HEALTH_TIMEOUT_MS ?? "1200", 10) || 1200;

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

type LocalHealth = {
  redis: boolean;
  session: boolean;
  queueDepth: number;
};

type TalonHealth = {
  ok: boolean;
  reachable: boolean;
  state?: string;
  failedProbeCount?: number;
  error?: string;
};

/**
 * Lightweight gateway health snapshot.
 * Local checks stay in-process; Talon check is localhost-only and times out fast.
 */
function getLocalHealth(): LocalHealth {
  const failures = getConsecutiveFailures();
  const queueDepth = getQueueDepth();
  const redis = isRedisHealthy();
  const session = failures < 3;
  return { redis, session, queueDepth };
}

async function getTalonHealth(): Promise<TalonHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TALON_HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(TALON_HEALTH_URL, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reachable: true, error: `http_${response.status}` };
    }

    const payload = await response.json() as Record<string, unknown>;
    const ok = payload.ok === true;
    const state = typeof payload.state === "string" ? payload.state : undefined;
    const failedProbeCount = typeof payload.failed_probe_count === "number"
      ? payload.failed_probe_count
      : undefined;

    return {
      ok,
      reachable: true,
      state,
      failedProbeCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reachable: false,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
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

  const local = getLocalHealth();
  const talon = await getTalonHealth();

  const healthy = local.redis
    && local.session
    && local.queueDepth <= 2
    && talon.ok;

  void emitGatewayOtel({
    level: healthy ? "debug" : "warn",
    component: "heartbeat",
    action: "heartbeat.tick",
    success: healthy,
    metadata: {
      redis: local.redis ? "ok" : "degraded",
      session: local.session ? "ok" : "degraded",
      queueDepth: local.queueDepth,
      talon: talon.ok ? "ok" : talon.reachable ? "degraded" : "failed",
      talonState: talon.state ?? "unknown",
      talonFailedProbeCount: talon.failedProbeCount ?? -1,
      talonHealthUrl: TALON_HEALTH_URL,
      ...(talon.error ? { talonError: talon.error } : {}),
    },
  });

  if (!healthy) {
    console.warn("[heartbeat] health degraded", { local, talon });
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
