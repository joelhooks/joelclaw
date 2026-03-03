/**
 * Gateway Extension — Redis event bridge for pi sessions.
 *
 * ADR-0018: Two routing modes:
 *   - Central "gateway" session: receives ALL events (heartbeats + task notifications)
 *   - Satellite sessions: receive only events targeted at them (their background tasks)
 *
 * pushGatewayEvent() routes events:
 *   - type=cron.heartbeat -> gateway only
 *   - type=loop.complete, media.downloaded etc with originSession -> origin + gateway
 *
 * Set GATEWAY_ROLE=central for the always-on session.
 * Satellites register automatically with pid-based IDs.
 *
 * Watchdog (central only): if no heartbeat arrives within 2x the cron interval,
 * inject a "missed heartbeat" alarm. Independent of Inngest — catches Inngest outages.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import Redis from "ioredis";

// ── Config ──────────────────────────────────────────────────────────
// Default: disabled. Only activates when GATEWAY_ROLE is explicitly set.
// "central" = always-on gateway session (receives all events, watchdog, boot prompt)
// "satellite" = receives targeted events (e.g. background task results for this session)
// anything else / unset = no-op, no Redis, no registration, no output
const ROLE = process.env.GATEWAY_ROLE ?? "disabled";
const SESSION_ID = ROLE === "central" ? "gateway" : `pid-${process.pid}`;
const SESSIONS_SET = "joelclaw:gateway:sessions";
const EVENT_LIST = `joelclaw:events:${SESSION_ID}`;
const NOTIFY_CHANNEL = `joelclaw:notify:${SESSION_ID}`;
const VAULT_PATH = process.env.VAULT_PATH ?? join(process.env.HOME ?? "/Users/joel", "Vault");
const HEARTBEAT_PATH = join(VAULT_PATH, "HEARTBEAT.md");
const BOOT_PATH = join(VAULT_PATH, "BOOT.md");

// Watchdog: 2x the 15-min heartbeat interval = 30 min
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
const WATCHDOG_THRESHOLD_MS = 2 * HEARTBEAT_INTERVAL_MS; // 30 min
const WATCHDOG_CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min
const STALE_EVENT_TTL_MS = 5 * 60 * 1000;
const DEDUP_TTL_SECONDS = 30 * 60;
const TODOIST_DEBOUNCE_SECONDS = 5;
const DEDUP_KEY_PREFIX = "joelclaw:gateway:seen";
const DEBOUNCE_KEY_PREFIX = "joelclaw:gateway:debounce";
const DRAIN_DEBOUNCE_MS = 5_000;
const HEARTBEAT_FULL_CHECK_MS = 60 * 60 * 1000;
const AUTO_MESSAGE_DIGEST_ONLY_THRESHOLD = 20;

const redisOpts = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
  lazyConnect: true,
  retryStrategy: (times: number) => Math.min(times * 500, 30_000),
};

// ── State ───────────────────────────────────────────────────────────
let sub: Redis | null = null;
let cmd: Redis | null = null;
let pendingDrain = false;
let draining = false;
let lastDrainTs = 0;
let lastHeartbeatTs = 0;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogAlarmFired = false; // only fire once per missed window
let ctx: ExtensionContext | null = null;
let piRef: ExtensionAPI | null = null;
let lastFullHeartbeatCheckTs = 0;
let automatedInjectedCount = 0;
let drainDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ── Types ───────────────────────────────────────────────────────────
interface SystemEvent {
  id: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  ts: number;
}

interface DrainOptions {
  forceFull?: boolean;
}

// ── Stale Session Cleanup ────────────────────────────────────────────

/**
 * Prune dead pid-* entries from the sessions set.
 * Sessions that crash or get SIGKILL'd never fire session_shutdown,
 * so their registrations leak. This runs on every session_start as a
 * safety net. Only prunes local PIDs (kill -0 check).
 */
async function pruneDeadSessions(redis: Redis): Promise<number> {
  try {
    const members = await redis.smembers(SESSIONS_SET);
    let pruned = 0;
    for (const member of members) {
      if (!member.startsWith("pid-")) continue;
      const pid = parseInt(member.slice(4), 10);
      if (isNaN(pid)) continue;
      try {
        process.kill(pid, 0); // just checks if alive, doesn't send signal
      } catch {
        // Process is dead — remove it
        await redis.srem(SESSIONS_SET, member);
        // Also clean up its event queue
        await redis.del(`joelclaw:events:${member}`);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(`[gateway] pruned ${pruned} dead session(s) from ${SESSIONS_SET}`);
    }
    return pruned;
  } catch (err) {
    console.error("[gateway] prune failed:", err);
    return 0;
  }
}

// ── Core Logic ──────────────────────────────────────────────────────
function readHeartbeat(): string {
  try {
    return readFileSync(HEARTBEAT_PATH, "utf-8");
  } catch {
    return "# Heartbeat\n\n_No HEARTBEAT.md found at ~/Vault/HEARTBEAT.md_";
  }
}

function formatEvents(events: SystemEvent[]): string {
  if (events.length === 0) return "_No pending events._";
  return events
    .map((e) => {
      const time = new Date(e.ts).toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Los_Angeles" });
      const payload = Object.keys(e.payload).length > 0
        ? `\n  ${JSON.stringify(e.payload)}`
        : "";
      return `- **[${time}] ${e.type}** (${e.source})${payload}`;
    })
    .join("\n");
}

function buildPrompt(events: SystemEvent[]): string {
  const isHeartbeatOnly = events.length === 1 && events[0].type === "cron.heartbeat";
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).replace(" ", "T") + " PST";

  // Central session heartbeat: full checklist
  if (ROLE === "central" && isHeartbeatOnly) {
    const heartbeat = readHeartbeat();
    return [
      "HEARTBEAT",
      "",
      `Timestamp: ${ts}`,
      "",
      heartbeat,
    ].join("\n");
  }

  // If any event carries an agent-crafted prompt, use it directly.
  // The event emitter knows the intent — CLI-design principle: producer crafts the prompt.
  const promptEvents = events.filter((e) => typeof e.payload?.prompt === "string" && e.payload.prompt);
  const genericEvents = events.filter((e) => !e.payload?.prompt);

  // Automated message header — prevents confusion with Joel's messages
  const AUTO_HEADER = "> ⚡ **Automated gateway event** — not a human message\n";

  if (promptEvents.length > 0 && genericEvents.length === 0) {
    // All events have agent prompts — use them directly
    const body = promptEvents
      .map((e) => e.payload.prompt as string)
      .join("\n\n---\n\n");
    return AUTO_HEADER + "\n" + body;
  }

  if (promptEvents.length > 0) {
    // Mix of prompted and generic events — section them
    const promptBlock = promptEvents
      .map((e) => e.payload.prompt as string)
      .join("\n\n---\n\n");
    const genericBlock = formatEvents(genericEvents);
    return [
      AUTO_HEADER,
      promptBlock,
      "",
      "---",
      "",
      `## 📋 Batch Digest — ${ts}`,
      "",
      `${genericEvents.length} additional event(s):`,
      genericBlock,
      "",
      "Acknowledge briefly. Only flag if something looks wrong.",
    ].join("\n");
  }

  // No agent prompts — batch digest format
  // Summarize by type instead of listing every event
  const typeCounts = new Map<string, number>();
  for (const e of events) {
    typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
  }
  const summary = Array.from(typeCounts.entries())
    .map(([type, count]) => `- ${type}: ${count}`)
    .join("\n");

  return [
    `## 📋 Batch Digest — ${ts}`,
    "",
    `${events.length} event(s) since last digest:`,
    summary,
    "",
    "Acknowledge briefly. Only flag if something looks wrong.",
  ].join("\n");
}

// ── Gateway Mode ─────────────────────────────────────────────
type GatewayMode = "active" | "sleep";
const MODE_KEY = "joelclaw:mode";

async function getGatewayMode(): Promise<GatewayMode> {
  if (!cmd) return "active";
  const mode = await cmd.get(MODE_KEY);
  if (mode === "sleep" || mode === "active") return mode;
  return "active";
}

async function sleepGateway(): Promise<void> {
  if (!cmd) return;
  await cmd.set(MODE_KEY, "sleep");
  console.log("[gateway] entered sleep mode");
}

async function wakeGateway(): Promise<void> {
  if (!cmd) return;
  await cmd.set(MODE_KEY, "active");
  console.log("[gateway] entered active mode");
}

function filterStaleEvents(events: SystemEvent[]): { fresh: SystemEvent[]; dropped: number } {
  const now = Date.now();
  const fresh: SystemEvent[] = [];
  let dropped = 0;

  for (const evt of events) {
    // Support both ms and epoch-second timestamps if any producers send seconds.
    const ts = Number(evt.ts);
    const tsMs = Number.isFinite(ts) && ts < 1_000_000_000_000 ? ts * 1000 : ts;
    if (Number.isFinite(tsMs) && now - tsMs > STALE_EVENT_TTL_MS) {
      dropped++;
      continue;
    }
    fresh.push(evt);
  }

  return { fresh, dropped };
}

function toMs(ts: number): number {
  const value = Number(ts);
  if (!Number.isFinite(value)) return Date.now();
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isCriticalType(type: string): boolean {
  return /(error|fail|alarm|watchdog|degrad|warn)/i.test(type);
}

function eventLooksCritical(event: SystemEvent): boolean {
  if (isCriticalType(event.type)) return true;
  const payload = asRecord(event.payload);
  const status = asString(payload.status).toLowerCase();
  const severity = asString(payload.severity).toLowerCase();
  if (["error", "failed", "critical", "degraded", "warning", "warn", "unhealthy"].includes(status)) return true;
  if (["error", "critical", "degraded", "warning", "warn"].includes(severity)) return true;
  if (payload.degraded === true || payload.error === true || payload.failed === true) return true;
  const text = [
    asString(payload.prompt),
    asString(payload.message),
    asString(payload.summary),
  ].join(" ").toLowerCase();
  return /(error|failed|degraded|warning|⚠️|watchdog|alarm)/i.test(text);
}

function isHeartbeatDegraded(event: SystemEvent): boolean {
  if (event.type !== "cron.heartbeat") return false;
  return eventLooksCritical(event);
}

function shouldInjectHeartbeat(event: SystemEvent, options: DrainOptions): boolean {
  if (options.forceFull) return true;
  if (isHeartbeatDegraded(event)) return true;
  if (lastFullHeartbeatCheckTs === 0) return true;
  return Date.now() - lastFullHeartbeatCheckTs > HEARTBEAT_FULL_CHECK_MS;
}

function maybeCountFromObject(value: unknown): number {
  const rec = asRecord(value);
  let total = 0;
  for (const key of Object.keys(rec)) {
    const n = asNumber(rec[key]);
    if (n !== null && n >= 0) total += n;
  }
  return total;
}

function parseDigestStats(event: SystemEvent): { total: number; hasErrors: boolean } {
  const payload = asRecord(event.payload);
  const directTotal = asNumber(payload.total)
    ?? asNumber(payload.eventCount)
    ?? asNumber(payload.count)
    ?? asNumber(payload.volume)
    ?? asNumber(payload.batchSize)
    ?? 0;
  const countsTotal = maybeCountFromObject(payload.typeCounts)
    + maybeCountFromObject(payload.counts)
    + maybeCountFromObject(payload.events);
  const total = Math.max(directTotal, countsTotal);

  const errorCount = asNumber(payload.errorCount)
    ?? asNumber(payload.errors)
    ?? asNumber(payload.failureCount)
    ?? asNumber(payload.failures)
    ?? 0;
  const hasKeyedError = Object.keys(payload).some((k) => isCriticalType(k));
  const hasErrorText = eventLooksCritical(event);
  return { total, hasErrors: errorCount > 0 || hasKeyedError || hasErrorText };
}

function buildQuietDigestSummary(events: SystemEvent[]): string {
  const typeCounts = new Map<string, number>();
  let total = 0;
  let hasErrors = false;

  for (const event of events) {
    const stats = parseDigestStats(event);
    total += stats.total;
    if (stats.hasErrors) hasErrors = true;

    const payload = asRecord(event.payload);
    const counts = asRecord(payload.typeCounts);
    for (const [type, value] of Object.entries(counts)) {
      const count = asNumber(value);
      if (count === null || count <= 0) continue;
      typeCounts.set(type, (typeCounts.get(type) || 0) + count);
    }
  }

  const top = Array.from(typeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => `- ${type}: ${count}`)
    .join("\n");

  const volume = total > 0 ? total : events.length;
  return [
    "> ⚡ **Automated gateway digest summary**",
    "",
    `Batch digests received: ${events.length}`,
    `Estimated volume: ${volume}`,
    `Anomalies: ${hasErrors ? "yes" : "no"}`,
    top ? `\nTop event types:\n${top}` : "",
  ].join("\n");
}

function isDigestOnlyMode(): boolean {
  return automatedInjectedCount > AUTO_MESSAGE_DIGEST_ONLY_THRESHOLD;
}

function logAutomationCounter(reason: string): void {
  const mode = isDigestOnlyMode() ? "digest-only" : "active";
  console.log(`[gateway] automated messages injected=${automatedInjectedCount} mode=${mode} reason=${reason}`);
}

function sendAutomatedMessage(prompt: string, reason: string): void {
  if (!piRef || !ctx) return;

  if (ctx.isIdle()) {
    piRef.sendUserMessage(prompt);
  } else {
    piRef.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  automatedInjectedCount++;
  logAutomationCounter(reason);
}

function pickId(sources: Record<string, unknown>[], keys: string[]): string | null {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}

function getTodoistDedupParts(event: SystemEvent): { taskId: string; commentId: string } | null {
  if (!event.type.startsWith("todoist.")) return null;

  const payload = asRecord(event.payload);
  const data = asRecord(payload.data);
  const task = asRecord(payload.task);
  const dataTask = asRecord(data.task);
  const comment = asRecord(payload.comment);
  const dataComment = asRecord(data.comment);

  const taskId = pickId(
    [payload, data, task, dataTask],
    ["taskId", "task_id", "itemId", "item_id", "id"],
  );
  const commentId = pickId(
    [payload, data, comment, dataComment],
    ["commentId", "comment_id", "id"],
  );

  if (!taskId || !commentId) return null;
  return { taskId, commentId };
}

function getDedupKey(event: SystemEvent): string {
  if (event.type === "cron.heartbeat") {
    return `heartbeat:${Math.floor(toMs(event.ts) / 60_000)}`;
  }

  const todoistParts = getTodoistDedupParts(event);
  if (todoistParts) {
    return `${event.type}:${todoistParts.taskId}:${todoistParts.commentId}`;
  }

  return event.id;
}

function getSeenRedisKey(event: SystemEvent): string {
  return `${DEDUP_KEY_PREFIX}:${getDedupKey(event)}`;
}

function getDebounceRedisKey(event: SystemEvent): string | null {
  const todoistParts = getTodoistDedupParts(event);
  if (!todoistParts) return null;
  return `${DEBOUNCE_KEY_PREFIX}:${event.type}:${todoistParts.taskId}:${todoistParts.commentId}`;
}

async function isDuplicate(event: SystemEvent): Promise<boolean> {
  if (!cmd) return false;

  const seenKey = getSeenRedisKey(event);
  const seen = await cmd.exists(seenKey);
  if (seen > 0) {
    console.log(`[gateway] dropped duplicate event: ${getDedupKey(event)} (persisted)`);
    return true;
  }

  const debounceKey = getDebounceRedisKey(event);
  if (!debounceKey) return false;

  const debounced = await cmd.exists(debounceKey);
  if (debounced > 0) {
    console.log(`[gateway] dropped duplicate event: ${getDedupKey(event)} (debounced)`);
    return true;
  }

  return false;
}

async function markProcessed(events: SystemEvent[]): Promise<void> {
  if (!cmd || events.length === 0) return;

  const pipeline = cmd.pipeline();
  for (const event of events) {
    pipeline.set(getSeenRedisKey(event), "1", "EX", DEDUP_TTL_SECONDS);
    const debounceKey = getDebounceRedisKey(event);
    if (debounceKey) {
      pipeline.set(debounceKey, "1", "EX", TODOIST_DEBOUNCE_SECONDS);
    }
  }

  await pipeline.exec();
}

async function drain(options: DrainOptions = {}): Promise<void> {
  if (draining || !cmd || !piRef) return;
  draining = true;

  try {
    const raw = await cmd.lrange(EVENT_LIST, 0, -1);
    if (raw.length === 0) return;

    const parsed: SystemEvent[] = [];
    for (const item of raw.reverse()) {
      try {
        parsed.push(JSON.parse(item) as SystemEvent);
      } catch {}
    }

    if (parsed.length === 0) {
      await cmd.del(EVENT_LIST);
      return;
    }

    const { fresh, dropped } = filterStaleEvents(parsed);
    if (dropped > 0) {
      console.log(`[gateway] dropped ${dropped} stale event(s) older than 5min`);
    }
    if (fresh.length === 0) {
      await cmd.del(EVENT_LIST);
      return;
    }

    // Coalesce heartbeat noise: keep only the latest heartbeat in the queue.
    // Heartbeats are idempotent checklist runs, so older ones add no signal.
    const heartbeatIndices: number[] = [];
    for (let i = 0; i < fresh.length; i++) {
      if (fresh[i].type === "cron.heartbeat") heartbeatIndices.push(i);
    }

    let coalesced = fresh;
    if (heartbeatIndices.length > 1) {
      let keepIdx = heartbeatIndices[0];
      for (const idx of heartbeatIndices.slice(1)) {
        if (fresh[idx].ts >= fresh[keepIdx].ts) keepIdx = idx;
      }
      const droppedHeartbeats = heartbeatIndices.length - 1;
      coalesced = fresh.filter((evt, idx) => evt.type !== "cron.heartbeat" || idx === keepIdx);
      console.log(`[gateway] coalesced ${droppedHeartbeats} heartbeat event(s), kept latest ts=${fresh[keepIdx].ts}`);
    }

    const events: SystemEvent[] = [];
    const seenInBatch = new Set<string>();
    for (const evt of coalesced) {
      const dedupKey = getDedupKey(evt);
      if (seenInBatch.has(dedupKey)) {
        console.log(`[gateway] dropped duplicate event: ${dedupKey} (same drain batch)`);
        continue;
      }
      seenInBatch.add(dedupKey);
      if (await isDuplicate(evt)) continue;
      events.push(evt);
    }

    if (events.length === 0) {
      await cmd.del(EVENT_LIST);
      return;
    }

    // ── Noise suppression ─────────────────────────────────────────
    // Filter out event types that burn tokens without adding signal.
    // todoist.task.completed: echoes from tasks the agent just closed
    // memory.observed: telemetry confirmations, not actionable
    // content.synced: vault sync confirmations
    const SUPPRESSED_TYPES = new Set([
      "todoist.task.completed",
      "memory.observed",
      "content.synced",
      "media.processed", // vision pipeline echo — gateway already has the raw image
    ]);
    const filtered = events.filter((e) => !SUPPRESSED_TYPES.has(e.type));
    if (filtered.length === 0) {
      console.log(`[gateway] suppressed ${events.length} noise event(s): ${events.map((e) => e.type).join(", ")}`);
      await markProcessed(events);
      await cmd.del(EVENT_LIST);
      return;
    }

    // Track heartbeat timing for watchdog + tripwire
    const hasHeartbeat = events.some((e) => e.type === "cron.heartbeat");
    if (hasHeartbeat) {
      lastHeartbeatTs = Date.now();
      watchdogAlarmFired = false; // reset alarm on successful heartbeat
      // Write timestamp file for Layer 2 launchd tripwire (ADR-0037)
      try {
        mkdirSync("/tmp/joelclaw", { recursive: true });
        writeFileSync("/tmp/joelclaw/last-heartbeat.ts", String(lastHeartbeatTs));
      } catch {}
    }

    // ── Sleep Mode Check ──────────────────────────────────────────
    // When gateway is in sleep mode, skip heartbeat and digest events
    // Telegram messages always wake the system
    const mode = await getGatewayMode();
    if (mode === "sleep") {
      const hasSleepHeartbeat = filtered.some((e) => e.type === "cron.heartbeat");
      const hasDigest = filtered.some((e) => e.type === "gateway.batch.digest");
      if ((hasSleepHeartbeat || hasDigest) && !filtered.some((e) => e.source === "telegram")) {
        console.log(`[gateway] suppressed ${filtered.length} event(s) in sleep mode`);
        await markProcessed(events);
        await cmd.del(EVENT_LIST);
        return;
      }
    }

    // Quiet heartbeat mode: only emit healthy heartbeats once per hour unless forced.
    const heartbeatEvents = filtered.filter((e) => e.type === "cron.heartbeat");
    const nonHeartbeatEvents = filtered.filter((e) => e.type !== "cron.heartbeat");
    const injectableHeartbeats = heartbeatEvents.filter((e) => shouldInjectHeartbeat(e, options));
    const suppressedHeartbeats = heartbeatEvents.length - injectableHeartbeats.length;
    if (suppressedHeartbeats > 0) {
      console.log(`[gateway] quiet-heartbeat suppressed ${suppressedHeartbeats} healthy heartbeat event(s)`);
    }
    if (injectableHeartbeats.length > 0) {
      lastFullHeartbeatCheckTs = Date.now();
    }

    // Quiet digest mode: only pass digest anomalies (errors or unusual volume).
    const digestEvents = nonHeartbeatEvents.filter((e) => e.type === "gateway.batch.digest");
    const regularEvents = nonHeartbeatEvents.filter((e) => e.type !== "gateway.batch.digest");
    let injectDigestSummary = false;
    if (digestEvents.length > 0) {
      let digestTotal = 0;
      let digestHasErrors = false;
      for (const event of digestEvents) {
        const stats = parseDigestStats(event);
        digestTotal += stats.total;
        if (stats.hasErrors) digestHasErrors = true;
      }
      const unusualVolume = digestTotal > 50;
      injectDigestSummary = digestHasErrors || unusualVolume;
      if (!injectDigestSummary) {
        console.log(`[gateway] suppressed ${digestEvents.length} quiet digest event(s) total=${digestTotal}`);
      }
    }

    // Session pressure control: after N automated injections, only pass critical events.
    const digestOnlyMode = isDigestOnlyMode();
    const criticalEvents = regularEvents.filter((e) => eventLooksCritical(e));
    const nonCriticalEvents = regularEvents.filter((e) => !eventLooksCritical(e));
    if (digestOnlyMode && nonCriticalEvents.length > 0) {
      console.log(`[gateway] digest-only mode suppressed ${nonCriticalEvents.length} non-critical event(s)`);
    }

    const finalRegularEvents = digestOnlyMode ? criticalEvents : regularEvents;
    const finalEvents = [...finalRegularEvents, ...injectableHeartbeats];
    const shouldInjectDigestSummary = injectDigestSummary && (!digestOnlyMode || digestEvents.some(eventLooksCritical));

    if (finalEvents.length === 0 && !shouldInjectDigestSummary) {
      await markProcessed(events);
      await cmd.del(EVENT_LIST);
      lastDrainTs = Date.now();
      return;
    }

    if (finalEvents.length > 0) {
      sendAutomatedMessage(buildPrompt(finalEvents), "event-drain");
    }
    if (shouldInjectDigestSummary) {
      sendAutomatedMessage(buildQuietDigestSummary(digestEvents), "anomalous-digest");
    }

    await markProcessed(events);
    await cmd.del(EVENT_LIST);
    lastDrainTs = Date.now();
  } catch (err) {
    console.error("[gateway] drain failed:", err);
  } finally {
    draining = false;
    pendingDrain = false;
  }
}

function tryDrain(): void {
  if (!ctx) return;
  if (ctx.isIdle()) {
    void drain();
  } else {
    pendingDrain = true;
  }
}

function scheduleDrain(): void {
  if (drainDebounceTimer) {
    clearTimeout(drainDebounceTimer);
  }
  drainDebounceTimer = setTimeout(() => {
    drainDebounceTimer = null;
    tryDrain();
  }, DRAIN_DEBOUNCE_MS);
}

// ── Watchdog (central only) ─────────────────────────────────────────
function startWatchdog(): void {
  if (ROLE !== "central") return;

  watchdogTimer = setInterval(() => {
    if (!piRef || !ctx) return;
    if (lastHeartbeatTs === 0) return; // haven't seen first heartbeat yet, skip
    if (watchdogAlarmFired) return; // already fired, don't spam

    const elapsed = Date.now() - lastHeartbeatTs;
    if (elapsed > WATCHDOG_THRESHOLD_MS) {
      watchdogAlarmFired = true;
      const mins = Math.round(elapsed / 60_000);
      const alarm = [
        "## ⚠️ MISSED HEARTBEAT",
        "",
        `No heartbeat received in **${mins} minutes** (threshold: ${WATCHDOG_THRESHOLD_MS / 60_000}min).`,
        "",
        "This means the Inngest cron or the worker may be down.",
        "",
        "### Triage",
        "1. `joelclaw worker restart` — restart the Inngest worker",
        "2. `kubectl get pods -n joelclaw` — check if inngest-0 and redis-0 are running",
        "3. `docker logs $(docker ps -q --filter name=inngest) --tail 20` — check Inngest server logs",
        "4. `curl -s http://localhost:3111/ | jq .status` — check worker health",
        "",
        "If the worker is running but heartbeats aren't arriving, check:",
        "- `joelclaw gateway status` — is this session still registered?",
        "- `kubectl exec -n joelclaw redis-0 -- redis-cli ping` — is Redis alive?",
      ].join("\n");

      console.error(`[gateway] WATCHDOG: no heartbeat for ${mins}min, injecting alarm`);

      // Always deliver watchdog alarms, regardless of quiet/digest-only modes.
      if (ctx.isIdle()) {
        piRef.sendUserMessage(alarm);
      } else {
        piRef.sendUserMessage(alarm, { deliverAs: "followUp" });
      }
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ── Extension Entry ─────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // Gate: disabled sessions get no Redis, no registration, no output.
  if (ROLE !== "central" && ROLE !== "satellite") {
    return; // Extension is a complete no-op
  }

  piRef = pi;

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;

    sub = new Redis(redisOpts);
    cmd = new Redis(redisOpts);
    sub.on("error", () => {});
    cmd.on("error", () => {});

    await sub.connect();
    await cmd.connect();

    // Register this session. Central = "gateway", satellite = "pid-XXXX"
    await cmd.sadd(SESSIONS_SET, SESSION_ID);
    // Prune dead pid-* sessions on every startup (ADR-0050)
    await pruneDeadSessions(cmd);
    console.log(`[gateway] registered ${SESSION_ID} (role=${ROLE})`);

    // Subscribe to our channel
    await sub.subscribe(NOTIFY_CHANNEL);
    // Also subscribe to legacy channel during transition
    await sub.subscribe("joelclaw:notify:main");
    sub.on("message", (_channel: string, _message: string) => {
      scheduleDrain();
    });

    ctx.ui.setStatus("gateway", `🔗 ${SESSION_ID}`);

    // Central session: inject boot prompt so it knows its role
    if (ROLE === "central") {
      let bootContent: string;
      try {
        bootContent = readFileSync(BOOT_PATH, "utf-8");
      } catch {
        bootContent = "You are the central gateway session. Respond to heartbeats and system events.";
      }
      setTimeout(() => {
        piRef!.sendUserMessage([
          "## Gateway Boot — Central Session",
          "",
          `Session ID: ${SESSION_ID}`,
          `Role: **${ROLE}**`,
          "",
          bootContent,
        ].join("\n"));
      }, 2000);

      // Start watchdog after a grace period (wait for first heartbeat)
      lastHeartbeatTs = Date.now(); // assume healthy at boot, alarm after 2x interval with no heartbeat
      startWatchdog();
    }

    // Drain legacy "main" list if anything accumulated
    const legacyCount = await cmd.llen("joelclaw:events:main");
    if (legacyCount > 0) {
      const legacyRaw = await cmd.lrange("joelclaw:events:main", 0, -1);
      let droppedLegacyStale = 0;
      for (const item of legacyRaw) {
        try {
          const evt = JSON.parse(item) as SystemEvent;
          const { dropped } = filterStaleEvents([evt]);
          if (dropped > 0) {
            droppedLegacyStale += dropped;
            continue;
          }
        } catch {
          // If parsing fails, keep prior behavior and preserve the item.
        }
        await cmd.lpush(EVENT_LIST, item);
      }
      if (droppedLegacyStale > 0) {
        console.log(`[gateway] dropped ${droppedLegacyStale} stale event(s) older than 5min`);
      }
      await cmd.del("joelclaw:events:main");
    }

    // Initial drain (uses stale filtering in drain())
    const pending = await cmd.llen(EVENT_LIST);
    if (pending > 0) {
      console.log(`[gateway] ${pending} events waiting at startup, draining...`);
      await drain();
    }
  });

  pi.on("agent_end", async (_event, _ctx) => {
    ctx = _ctx;
    if (pendingDrain) void drain();
  });

  pi.on("session_shutdown", async () => {
    stopWatchdog();
    if (drainDebounceTimer) {
      clearTimeout(drainDebounceTimer);
      drainDebounceTimer = null;
    }
    try {
      if (cmd) {
        await cmd.srem(SESSIONS_SET, SESSION_ID);
        await cmd.del(EVENT_LIST);
        console.log(`[gateway] unregistered ${SESSION_ID}`);
      }
      if (sub) {
        sub.unsubscribe();
        sub.disconnect();
        sub = null;
      }
      if (cmd) {
        cmd.disconnect();
        cmd = null;
      }
    } catch {}
  });

  // ── Commands ──────────────────────────────────────────────────────

  pi.registerCommand("heartbeat", {
    description: "Manually trigger a gateway event drain + heartbeat check",
    handler: async (_args, _ctx) => {
      ctx = _ctx;
      if (!cmd) {
        _ctx.ui.notify("Gateway not connected", "error");
        return;
      }
      await drain({ forceFull: true });
      if (lastDrainTs === 0) {
        _ctx.ui.notify("No events — sending heartbeat prompt", "info");
        sendAutomatedMessage(buildPrompt([]), "manual-heartbeat");
      }
    },
  });

  pi.registerCommand("events", {
    description: "Peek at pending gateway events without draining",
    handler: async (_args, _ctx) => {
      if (!cmd) {
        _ctx.ui.notify("Gateway not connected", "error");
        return;
      }
      const raw = await cmd.lrange(EVENT_LIST, 0, -1);
      if (raw.length === 0) {
        _ctx.ui.notify("No pending events", "info");
        return;
      }
      const events = raw.reverse().map((r) => {
        try {
          return JSON.parse(r) as SystemEvent;
        } catch {
          return null;
        }
      }).filter(Boolean) as SystemEvent[];
      _ctx.ui.notify(`${events.length} pending:\n${formatEvents(events)}`, "info");
    },
  });

  pi.registerCommand("send-media", {
    description: "Send a media file to a Telegram chat via the gateway daemon",
    handler: async (args, _ctx) => {
      if (!cmd) {
        _ctx.ui.notify("Gateway not connected", "error");
        return;
      }
      const [filePath, caption] = (args ?? "").split("|").map((s: string) => s.trim());
      if (!filePath) {
        _ctx.ui.notify("Usage: /send-media <path> [| caption]", "error");
        return;
      }
      const event = JSON.stringify({
        id: `media-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "media.outbound",
        source: SESSION_ID,
        payload: { filePath, caption: caption || undefined },
        ts: Date.now(),
      });
      await cmd.lpush("joelclaw:media:outbound", event);
      await cmd.publish("joelclaw:notify:media-outbound", "1");
      _ctx.ui.notify(`📤 Queued: ${filePath}`, "info");
    },
  });

  pi.registerCommand("gateway-id", {
    description: "Show this session's gateway ID and role",
    handler: async (_args, _ctx) => {
      const hbAgo = lastHeartbeatTs > 0
        ? `${Math.round((Date.now() - lastHeartbeatTs) / 60_000)}min ago`
        : "never";
      _ctx.ui.notify(
        `Session: ${SESSION_ID}\nRole: ${ROLE}\nLast heartbeat: ${hbAgo}\nWatchdog: ${watchdogTimer ? "active" : "off"}\nList: ${EVENT_LIST}\nChannel: ${NOTIFY_CHANNEL}`,
        "info",
      );
    },
  });
}
