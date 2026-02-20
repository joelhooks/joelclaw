import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { enqueue, getConsecutiveFailures, getQueueDepth } from "./command-queue";
import { flushBatchDigest, getGatewayMode, isHealthy as isRedisHealthy } from "./channels/redis";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const HEARTBEAT_SOURCE = "heartbeat";
const HEARTBEAT_CHECKLIST_PATH = `${homedir()}/Vault/HEARTBEAT.md`;
const TRIPWIRE_DIR = "/tmp/joelclaw";
const TRIPWIRE_PATH = `${TRIPWIRE_DIR}/last-heartbeat.ts`;
const HEARTBEAT_OK = "HEARTBEAT_OK";

type TimerHandle = ReturnType<typeof setInterval>;

export type HeartbeatRunner = {
  stop: () => Promise<void>;
  shutdown: () => Promise<void>;
};

let lastHeartbeatTs: number | undefined;
let watchdogAlarmFired = false;

function buildAgentHealthBlock(): string {
  const failures = getConsecutiveFailures();
  const queueDepth = getQueueDepth();
  const redisOk = isRedisHealthy();
  const sessionOk = failures < 3;
  const allGreen = redisOk && sessionOk && queueDepth <= 2;

  if (allGreen) {
    return "## Agent Health: ✅ all green";
  }

  const lines = ["## Agent Health: ⚠️ NEEDS ATTENTION"];
  if (!redisOk) lines.push("- ❌ Redis: DEGRADED — channels may be dropping events");
  if (!sessionOk) lines.push(`- ❌ Session: DEAD — ${failures} consecutive prompt failures (auto-restart pending)`);
  if (queueDepth > 2) lines.push(`- ⚠️ Queue depth: ${queueDepth} — messages backing up`);
  return lines.join("\n");
}

function buildHeartbeatPrompt(checklistContent: string): string {
  const timestamp = new Date().toISOString();
  const agentHealth = buildAgentHealthBlock();

  return [
    "HEARTBEAT",
    "",
    `Timestamp: ${timestamp}`,
    "",
    agentHealth,
    "",
    "Run this checklist now. Keep the response short and operational.",
    `If nothing needs attention, reply exactly: ${HEARTBEAT_OK}`,
    "If anything needs attention, report issue + next action.",
    "",
    "HEARTBEAT.md",
    "----",
    checklistContent,
    "----",
  ].join("\n");
}

async function writeTripwire(ts: number): Promise<void> {
  await mkdir(TRIPWIRE_DIR, { recursive: true });
  await writeFile(TRIPWIRE_PATH, `export const lastHeartbeatTs = ${ts};\n`);
}

async function runHeartbeat(): Promise<void> {
  const mode = await getGatewayMode();
  if (mode === "sleep") {
    console.log("[heartbeat] skipped heartbeat injection (sleep mode)");
    return;
  }

  let checklistContent = "";

  try {
    checklistContent = await readFile(HEARTBEAT_CHECKLIST_PATH, "utf8");
  } catch (error) {
    console.error("[heartbeat] failed to read checklist", {
      path: HEARTBEAT_CHECKLIST_PATH,
      error,
    });
  }

  const ts = Date.now();
  const prompt = buildHeartbeatPrompt(checklistContent);

  await enqueue(HEARTBEAT_SOURCE, prompt, {
    checklistPath: HEARTBEAT_CHECKLIST_PATH,
    ts,
  });

  lastHeartbeatTs = ts;
  watchdogAlarmFired = false;

  try {
    await writeTripwire(ts);
  } catch (error) {
    console.error("[heartbeat] failed to write tripwire", {
      path: TRIPWIRE_PATH,
      error,
    });
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

export function filterHeartbeatResponse(response: unknown, context?: { source?: unknown }): boolean {
  const source = typeof context?.source === "string" ? context.source : undefined;
  if (source !== HEARTBEAT_SOURCE) return false;

  if (typeof response !== "string") return false;

  const trimmed = response.trim();
  const heartBeatOkAtStart = trimmed.startsWith(HEARTBEAT_OK);
  const heartBeatOkAtEnd = trimmed.endsWith(HEARTBEAT_OK);

  let suppressed = trimmed === HEARTBEAT_OK;
  if (!suppressed && (heartBeatOkAtStart || heartBeatOkAtEnd)) {
    const withoutOk = trimmed.replace(HEARTBEAT_OK, "").trim();
    suppressed = withoutOk.length <= 300;
  }

  if (suppressed) {
    console.log("[heartbeat] received HEARTBEAT_OK; suppressing outbound response routing");
  }

  return suppressed;
}

export function startHeartbeatRunner(): HeartbeatRunner {
  lastHeartbeatTs = Date.now();
  watchdogAlarmFired = false;

  const heartbeatTimer: TimerHandle = setInterval(async () => {
    await runHeartbeat();
  }, FIFTEEN_MINUTES_MS);

  const watchdogTimer: TimerHandle = setInterval(() => {
    runWatchdog();
  }, FIVE_MINUTES_MS);

  // ── Hourly batch digest flush ─────────────────────────
  // Flushes accumulated BATCHED-tier events as a single digest.
  // Runs independently of heartbeat — digest only fires when
  // there are events to report.
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
