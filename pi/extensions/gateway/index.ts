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

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import Redis from "ioredis";
import {
  injectGatewayBehaviorContract,
  parseBehaviorDirectivesFromPrompt,
  renderGatewayBehaviorContractBlock,
} from "./behavior-contract";

// Lightweight OTEL emitter for gateway context — avoid pulling full @joelclaw/telemetry
// which may not be resolvable in the pi extension runtime.
function emitGatewayOtel(opts: {
  level: string;
  component: string;
  action: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}): void {
  const args = [
    "otel", "emit", opts.action,
    "--source", "gateway",
    "--component", opts.component,
    "--level", opts.level,
    "--success", opts.success ? "true" : "false",
    "--json",
  ];
  if (opts.metadata && Object.keys(opts.metadata).length > 0) {
    args.push("--metadata", JSON.stringify(opts.metadata));
  }
  const child = spawn("joelclaw", args, {
    stdio: ["ignore", "ignore", "ignore"],
    shell: false,
  });
  child.on("error", () => {});
}

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
const BEHAVIOR_CONTRACT_KEY = "joelclaw:gateway:behavior:contract";

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

const CONTEXT_BUFFER_KEY = "joelclaw:gateway:context-buffer";
const CONTEXT_BUFFER_MAX_EVENTS = 50;
const CONTEXT_BUFFER_TTL_SECONDS = 24 * 60 * 60; // 24h

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
let typesenseApiKey = ""; // leased at startup for context gathering

let drainDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ── Types ───────────────────────────────────────────────────────────
interface SystemEvent {
  id: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  ts: number;
}

// ADR-0235: Demand-driven context buffer — events accumulate silently,
// surface only when operator sends a message or something is critical.
interface ContextBufferEntry {
  type: string;
  summary: string;
  ts: number;
  critical: boolean;
}

interface GatewayContextBuffer {
  events: ContextBufferEntry[];
  lastFlushedAt: number;
  eventCount: number;
}

interface ActiveBehaviorContract {
  version: number;
  hash: string;
  directives: Array<{
    type?: string;
    text?: string;
  }>;
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

function captureBehaviorDirectiveViaCli(type: string, text: string): { ok: boolean; error?: string } {
  const result = spawnSync(
    "joelclaw",
    ["gateway", "behavior", "add", "--type", type, "--text", text],
    {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    },
  );

  if (result.error) {
    return { ok: false, error: String(result.error) };
  }

  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return { ok: false, error: stderr || stdout || `exit ${result.status ?? "unknown"}` };
  }

  return { ok: true };
}

function captureBehaviorDirectivesFromPrompt(prompt: string): {
  captured: number;
  failed: number;
  directives: Array<{ type: string; text: string }>;
  errors: string[];
} {
  const directives = parseBehaviorDirectivesFromPrompt(prompt);
  if (directives.length === 0) {
    return { captured: 0, failed: 0, directives: [], errors: [] };
  }

  let captured = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const directive of directives) {
    const result = captureBehaviorDirectiveViaCli(directive.type, directive.text);
    if (result.ok) {
      captured++;
      continue;
    }

    failed++;
    const detail = result.error ?? "unknown error";
    errors.push(`${directive.type}:${detail}`);
    console.warn("[gateway] behavior directive capture failed", {
      type: directive.type,
      text: directive.text,
      detail,
    });
  }

  return { captured, failed, directives, errors };
}

async function readActiveBehaviorContract(): Promise<ActiveBehaviorContract | null> {
  if (!cmd) return null;

  try {
    const raw = await cmd.get(BEHAVIOR_CONTRACT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveBehaviorContract>;
    const directives = Array.isArray(parsed.directives) ? parsed.directives : [];
    if (directives.length === 0) return null;

    return {
      version: Number.isFinite(parsed.version) ? Number(parsed.version) : 0,
      hash: typeof parsed.hash === "string" ? parsed.hash : "",
      directives,
    };
  } catch {
    return null;
  }
}

function applyBehaviorContractInjection(systemPrompt: string, contract: ActiveBehaviorContract | null): {
  systemPrompt: string;
  inserted: boolean;
  placement: "before-role" | "prepend" | "none";
} {
  const block = contract ? renderGatewayBehaviorContractBlock(contract) : "";
  return injectGatewayBehaviorContract(systemPrompt, block);
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

// ADR-0235: Only used for critical event injection and manual /heartbeat command.
function sendAutomatedMessage(prompt: string, reason: string): void {
  if (!piRef || !ctx) return;

  console.log(`[gateway] sending automated message reason=${reason}`);
  if (ctx.isIdle()) {
    piRef.sendUserMessage(prompt);
  } else {
    piRef.sendUserMessage(prompt, { deliverAs: "followUp" });
  }
}

// ── ADR-0235: Demand-driven context buffer ──────────────────────────
// Events accumulate silently. Only critical events break through.
// Buffer is prepended as context when operator sends a message.

function summarizeEvent(event: SystemEvent): string {
  const payload = event.payload ?? {};
  const type = event.type;

  // Extract useful summary from common event types
  if (type === "cron.heartbeat") {
    const status = typeof payload.status === "string" ? payload.status : "ok";
    return `heartbeat: ${status}`;
  }
  if (type === "gateway.batch.digest") {
    const stats = parseDigestStats(event);
    return `batch digest: ${stats.total} events${stats.hasErrors ? " (has errors)" : ""}`;
  }
  if (type === "subscription.updated") {
    const name = typeof payload.name === "string" ? payload.name : "feed";
    const entries = typeof payload.newEntries === "number" ? payload.newEntries : 0;
    return `feed update: ${name} (${entries} new)`;
  }
  if (typeof payload.prompt === "string") {
    return (payload.prompt as string).slice(0, 120);
  }
  if (typeof payload.summary === "string") {
    return (payload.summary as string).slice(0, 120);
  }
  if (typeof payload.detail === "string") {
    return `${type}: ${(payload.detail as string).slice(0, 100)}`;
  }
  return type;
}

async function appendToContextBuffer(events: SystemEvent[], critical: boolean): Promise<void> {
  if (!cmd) return;

  try {
    const raw = await cmd.get(CONTEXT_BUFFER_KEY);
    const buffer: GatewayContextBuffer = raw
      ? JSON.parse(raw)
      : { events: [], lastFlushedAt: Date.now(), eventCount: 0 };

    for (const event of events) {
      buffer.events.push({
        type: event.type,
        summary: summarizeEvent(event),
        ts: event.ts,
        critical,
      });
      buffer.eventCount++;
    }

    // Evict oldest non-critical events if over max
    while (buffer.events.length > CONTEXT_BUFFER_MAX_EVENTS) {
      const oldestNonCriticalIdx = buffer.events.findIndex((e) => !e.critical);
      if (oldestNonCriticalIdx >= 0) {
        buffer.events.splice(oldestNonCriticalIdx, 1);
      } else {
        buffer.events.shift(); // all critical, drop oldest
      }
    }

    await cmd.set(CONTEXT_BUFFER_KEY, JSON.stringify(buffer), "EX", CONTEXT_BUFFER_TTL_SECONDS);
    console.log(`[gateway:buffer] appended ${events.length} event(s), buffer size=${buffer.events.length}, total=${buffer.eventCount}`);
  } catch (err) {
    console.error("[gateway:buffer] append failed:", err);
  }
}

async function readAndFlushContextBuffer(): Promise<string | null> {
  if (!cmd) return null;

  try {
    const raw = await cmd.get(CONTEXT_BUFFER_KEY);
    if (!raw) return null;

    const buffer: GatewayContextBuffer = JSON.parse(raw);
    if (buffer.events.length === 0) return null;

    // Build a concise context block
    const lines: string[] = [
      `## System Activity (${buffer.eventCount} events since last interaction)`,
      "",
    ];

    // Group by type for compact display
    const byType = new Map<string, { count: number; latest: string; hasCritical: boolean }>();
    for (const entry of buffer.events) {
      const existing = byType.get(entry.type);
      if (existing) {
        existing.count++;
        existing.latest = entry.summary;
        if (entry.critical) existing.hasCritical = true;
      } else {
        byType.set(entry.type, { count: 1, latest: entry.summary, hasCritical: entry.critical });
      }
    }

    for (const [type, info] of byType) {
      const marker = info.hasCritical ? "🔴 " : "";
      if (info.count === 1) {
        lines.push(`- ${marker}${info.latest}`);
      } else {
        lines.push(`- ${marker}${type} ×${info.count} (latest: ${info.latest})`);
      }
    }

    // Flush the buffer
    await cmd.del(CONTEXT_BUFFER_KEY);
    console.log(`[gateway:buffer] flushed ${buffer.events.length} events for context injection`);

    return lines.join("\n");
  } catch (err) {
    console.error("[gateway:buffer] flush failed:", err);
    return null;
  }
}

// ── ADR-0235: On-demand system context for operator questions ────────
// When operator asks something, gather live system state so the gateway
// can answer "what's important" / "summarize this week" etc.

function runCliJson(args: string[], timeoutMs = 8000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const child = spawn("joelclaw", [...args, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch { resolve(null); }
    });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

function runCli(args: string[], timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.trim() || null);
    });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

async function searchTypesense(
  host: string,
  apiKey: string,
  collection: string,
  query: string,
  params: Record<string, string> = {},
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const searchParams = new URLSearchParams({ q: query, ...params });
    const url = `${host}/collections/${collection}/documents/search?${searchParams}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      headers: { "X-TYPESENSE-API-KEY": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const hits = Array.isArray(data.hits) ? data.hits : [];
    return hits.map((h: any) => h.document as Record<string, unknown>);
  } catch {
    return null;
  }
}

async function gatherSystemContext(): Promise<string> {
  const startTs = Date.now();
  const sections: string[] = [];

  // Run all queries in parallel — each has its own timeout.
  // slog + otel are fast (<300ms). `joelclaw runs` takes 10-15s so we use
  // `joelclaw status` (570ms) for system health instead.
  const [slogResult, otelResult, statusResult] = await Promise.all([
    runCli(["slog", "tail", "--count", "15"]),
    runCliJson(["otel", "stats", "--hours", "24"]),
    runCliJson(["status"]),
  ]);

  // Recent slog entries
  if (slogResult) {
    try {
      const parsed = JSON.parse(slogResult);
      const entries = (parsed?.result?.entries ?? []) as Array<Record<string, unknown>>;
      if (entries.length > 0) {
        const lines = entries.map((e) => {
          const ts = typeof e.timestamp === "string" ? e.timestamp.slice(5, 16).replace("T", " ") : "";
          return `- ${ts} [${e.action}] ${e.tool}: ${typeof e.detail === "string" ? (e.detail as string).slice(0, 100) : ""}`;
        });
        sections.push(`### Recent System Log\n${lines.join("\n")}`);
      }
    } catch { /* slog output not JSON-parseable, skip */ }
  }

  // OTEL error rate
  if (otelResult) {
    const result = otelResult.result as Record<string, unknown> | undefined;
    if (result) {
      const total = typeof result.total === "number" ? result.total : 0;
      const errors = typeof result.errors === "number" ? result.errors : 0;
      const rate = typeof result.errorRate === "number" ? (result.errorRate * 100).toFixed(1) : "?";
      sections.push(`### Observability (24h)\n- Events: ${total}, Errors: ${errors} (${rate}%)`);
    }
  }

  // System status (fast — ~570ms vs 15s for `runs`)
  if (statusResult) {
    const result = statusResult.result as Record<string, unknown> | undefined;
    if (result) {
      const lines: string[] = [];
      const worker = result.worker as Record<string, unknown> | undefined;
      const inngest = result.inngest as Record<string, unknown> | undefined;
      const redis = result.redis as Record<string, unknown> | undefined;
      const k8s = result.k8s as Record<string, unknown> | undefined;

      if (worker) lines.push(`- Worker: ${worker.status ?? "unknown"} (functions: ${worker.functionCount ?? "?"})`);
      if (inngest) lines.push(`- Inngest: ${inngest.status ?? "unknown"}`);
      if (redis) lines.push(`- Redis: ${redis.status ?? "unknown"}`);
      if (k8s) {
        const pods = Array.isArray(k8s.pods) ? k8s.pods : [];
        const notRunning = (pods as Array<Record<string, unknown>>).filter((p) => p.status !== "Running");
        lines.push(`- K8s: ${pods.length} pods${notRunning.length > 0 ? ` (${notRunning.length} not running)` : " (all running)"}`);
      }
      if (lines.length > 0) {
        sections.push(`### System Status\n${lines.join("\n")}`);
      }
    }
  }

  // ── Business intelligence: thread-oriented momentum + relationships (ADR-0237) ──
  const tsKey = typesenseApiKey || process.env.TYPESENSE_API_KEY || "";
  const tsHost = process.env.TYPESENSE_HOST ?? "http://127.0.0.1:8108";

  if (tsKey) {
    const urgencyEmoji = (urgency: unknown): string => {
      switch (urgency) {
        case "critical": return "🔴";
        case "high": return "🟠";
        case "low": return "🟢";
        default: return "🟡";
      }
    };
    const asStrings = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];

    const conversationThreads = await searchTypesense(tsHost, tsKey, "conversation_threads", "*", {
      sort_by: "last_message_at:desc",
      per_page: "20",
      filter_by: "status:=[active,stale]",
      include_fields: "source,channel_name,message_count,summary,related_projects,related_contacts,vault_gap,vault_gap_signal,urgency,needs_joel,last_message_at,status",
    });

    if (conversationThreads && conversationThreads.length > 0) {
      const projectMomentum = conversationThreads
        .filter((thread) => asStrings(thread.related_projects).length > 0)
        .slice(0, 8)
        .map((thread) => {
          const projects = asStrings(thread.related_projects).slice(0, 2).join(", ");
          const contacts = asStrings(thread.related_contacts).slice(0, 2).join(", ");
          const summary = typeof thread.summary === "string" ? thread.summary.slice(0, 140) : "Untitled thread";
          const tail = [projects ? `→ ${projects}` : "", contacts ? `(${contacts})` : ""]
            .filter(Boolean)
            .join(" ");
          return `- ${urgencyEmoji(thread.urgency)} ${summary}${tail ? ` ${tail}` : ""}`;
        });

      if (projectMomentum.length > 0) {
        sections.push(`### Project Momentum\n${projectMomentum.join("\n")}`);
      }

      const relationshipThreads = conversationThreads
        .filter((thread) => {
          const contacts = asStrings(thread.related_contacts);
          return contacts.length > 0 || thread.source === "email" || thread.needs_joel === true;
        })
        .slice(0, 8)
        .map((thread) => {
          const contacts = asStrings(thread.related_contacts).slice(0, 3).join(", ");
          const summary = typeof thread.summary === "string" ? thread.summary.slice(0, 140) : "Untitled thread";
          const source = thread.source === "email" ? "email" : `#${thread.channel_name ?? "unknown"}`;
          const flags = [contacts, thread.needs_joel === true ? "needs Joel" : ""].filter(Boolean).join(" · ");
          return `- ${urgencyEmoji(thread.urgency)} [${source}] ${summary}${flags ? ` (${flags})` : ""}`;
        });

      if (relationshipThreads.length > 0) {
        sections.push(`### Relationship Threads\n${relationshipThreads.join("\n")}`);
      }

      const momentumRisks = conversationThreads
        .filter((thread) => thread.needs_joel === true || thread.vault_gap === true)
        .slice(0, 8)
        .map((thread) => {
          const summary = typeof thread.summary === "string" ? thread.summary.slice(0, 140) : "Untitled thread";
          const gap = typeof thread.vault_gap_signal === "string" ? thread.vault_gap_signal.slice(0, 120) : "";
          const riskLabel = thread.vault_gap === true ? "vault gap" : "needs Joel";
          return `- ${urgencyEmoji(thread.urgency)} ${summary} — ${riskLabel}${gap ? `: ${gap}` : ""}`;
        });

      if (momentumRisks.length > 0) {
        sections.push(`### Momentum Risks\n${momentumRisks.join("\n")}`);
      }
    } else {
      // Fallback while thread collection is still warming up.
      const [slackResult, emailResult] = await Promise.all([
        searchTypesense(tsHost, tsKey, "slack_messages", "*", {
          sort_by: "timestamp:desc",
          per_page: "15",
          filter_by: `timestamp:>=${Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000)}`,
        }),
        searchTypesense(tsHost, tsKey, "email_threads", "*", {
          per_page: "10",
        }),
      ]);

      if (slackResult && slackResult.length > 0) {
        const byChannel = new Map<string, Array<{ user: string; text: string }>>();
        for (const msg of slackResult) {
          const ch = msg.channel_name ?? msg.channel_id ?? "unknown";
          if (!byChannel.has(ch)) byChannel.set(ch, []);
          byChannel.get(ch)!.push({
            user: msg.user_name ?? "?",
            text: (msg.text ?? "").slice(0, 150),
          });
        }
        const lines: string[] = [];
        for (const [channel, msgs] of byChannel) {
          lines.push(`**#${channel}** (${msgs.length} recent)`);
          for (const m of msgs.slice(0, 3)) {
            lines.push(`  - ${m.user}: ${m.text}`);
          }
        }
        sections.push(`### Recent Slack Activity (7d)\n${lines.join("\n")}`);
      }

      if (emailResult && emailResult.length > 0) {
        const lines = emailResult
          .filter((t: Record<string, unknown>) => t.subject)
          .map((t: Record<string, unknown>) => {
            const subject = (t.subject as string).slice(0, 80);
            const participants = Array.isArray(t.participants) ? (t.participants as string[]).slice(0, 3).join(", ") : "";
            const summary = typeof t.summary === "string" ? (t.summary as string).slice(0, 120) : "";
            return `- **${subject}**${participants ? ` (${participants})` : ""}${summary && summary !== "No actionable follow-up required." ? `\n  ${summary}` : ""}`;
          });
        if (lines.length > 0) {
          sections.push(`### Email Threads\n${lines.join("\n")}`);
        }
      }
    }
  }

  const elapsed = Date.now() - startTs;
  console.log(`[gateway:context] gathered system context in ${elapsed}ms (${sections.length} sections)`);

  if (sections.length === 0) return "";
  return sections.join("\n\n");
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

async function drain(): Promise<void> {
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

    // ── ADR-0235: Demand-driven event routing ────────────────────
    // Events go to context buffer (silent) unless critical.
    // Only critical events break through as proactive LLM messages.

    const criticalEvents = filtered.filter((e) => eventLooksCritical(e));
    const nonCriticalEvents = filtered.filter((e) => !eventLooksCritical(e));

    // Buffer all non-critical events silently (ADR-0235)
    if (nonCriticalEvents.length > 0) {
      await appendToContextBuffer(nonCriticalEvents, false);
      console.log(`[gateway] buffered ${nonCriticalEvents.length} non-critical event(s)`);
    }

    // Only critical events get injected as LLM messages
    if (criticalEvents.length > 0) {
      await appendToContextBuffer(criticalEvents, true);
      sendAutomatedMessage(buildPrompt(criticalEvents), "critical-event");
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

      // Watchdog alarms always break through immediately.
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

    // Lease Typesense API key for context gathering (ADR-0235)
    try {
      const secretResult = spawnSync("secrets", ["lease", "typesense_api_key", "--ttl", "24h"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      if (secretResult.status === 0 && secretResult.stdout?.trim()) {
        try {
          const parsed = JSON.parse(secretResult.stdout.trim());
          typesenseApiKey = parsed?.secret ?? parsed?.value ?? secretResult.stdout.trim();
        } catch {
          typesenseApiKey = secretResult.stdout.trim();
        }
        console.log(`[gateway] leased typesense_api_key for context gathering`);
      }
    } catch {
      console.warn("[gateway] failed to lease typesense_api_key — slack/email context unavailable");
    }

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

  pi.on("before_agent_start", async (event) => {
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const capture = captureBehaviorDirectivesFromPrompt(prompt);

    if (capture.directives.length > 0) {
      emitGatewayOtel({
        level: capture.failed > 0 ? "warn" : "info",
        component: "gateway-behavior",
        action: "behavior.directive.capture",
        success: capture.failed === 0,
        metadata: {
          captured: capture.captured,
          failed: capture.failed,
          directives: capture.directives.map((directive) => ({
            type: directive.type,
            text: directive.text.slice(0, 180),
          })),
          errors: capture.errors,
        },
      });
    }

    const contract = await readActiveBehaviorContract();
    const injected = applyBehaviorContractInjection(event.systemPrompt ?? "", contract);

    if (contract && injected.inserted) {
      emitGatewayOtel({
        level: "info",
        component: "gateway-behavior",
        action: "behavior.contract.injected",
        success: true,
        metadata: {
          behavior_contract_hash: contract.hash,
          behavior_contract_version: contract.version,
          behavior_contract_directives: contract.directives.length,
          placement: injected.placement,
        },
      });
    }

    // ADR-0235: Inject accumulated context buffer when operator sends a message.
    // The prompt is the operator's message — if it looks like an automated injection
    // (starts with known automated prefixes), skip context flush.
    const isOperatorMessage = prompt.length > 0
      && !prompt.startsWith("> ⚡ **Automated gateway")
      && !prompt.startsWith("## 📋 Batch Digest")
      && !prompt.startsWith("HEARTBEAT")
      && !prompt.startsWith("## ⚠️ MISSED HEARTBEAT")
      && !prompt.startsWith("## Gateway Boot")
      && !prompt.startsWith("# Context Recovery")
      && !prompt.startsWith("## Context Refresh");

    let systemPrompt = injected.systemPrompt;
    if (isOperatorMessage) {
      // ADR-0235: Gather context on demand — event buffer + live system state
      const [contextBlock, systemContext] = await Promise.all([
        readAndFlushContextBuffer(),
        gatherSystemContext(),
      ]);

      const contextParts: string[] = [];
      if (contextBlock) contextParts.push(contextBlock);
      if (systemContext) contextParts.push(systemContext);

      if (contextParts.length > 0) {
        systemPrompt = [
          systemPrompt,
          "",
          "<!-- Demand-driven system context (ADR-0235) -->",
          "<!-- This is live system state. Use it to answer questions about what's happening, -->",
          "<!-- what's important, what failed, what changed. Only mention if relevant. -->",
          ...contextParts,
        ].join("\n");
      }
    }

    return {
      systemPrompt,
    };
  });

  pi.on("agent_end", async (_event, _ctx) => {
    ctx = _ctx;
    if (pendingDrain) void drain();
  });

  // ── ADR-0204: Rolling context refresh + compaction recovery ──────

  let lastRefreshTs = Date.now();
  let gwWarmZoneEntered = false;
  let gwHotZoneEntered = false;
  let gwRecentTopics: string[] = [];
  let gwRecallCache: Array<{ query: string; hits: string[] }> = [];
  let gwRecallInFlight = false;
  let gwCompactionCount = 0;
  let gwLastCompactionTs = 0;
  const GW_COMPACTION_COOLDOWN_MS = 60_000; // skip recovery injection if re-compacting within 60s
  const REFRESH_INTERVAL_MS = 30 * 60_000; // 30 minutes

  /** Run a recall query via joelclaw CLI (fire-and-forget, async). */
  function gwRunRecall(query: string, limit = 5): Promise<{ hits: string[] } | null> {
    return new Promise((resolve) => {
      const child = spawn("joelclaw", ["recall", query, "--limit", String(limit), "--budget", "lean", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb" },
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
      child.on("close", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          const result = parsed.result as Record<string, unknown> | undefined;
          const rawHits = Array.isArray(result?.hits) ? result.hits : [];
          const hits = rawHits
            .slice(0, limit)
            .map((h: unknown) => {
              const r = h as Record<string, unknown>;
              return typeof r?.observation === "string" ? r.observation.trim().slice(0, 250) : "";
            })
            .filter((s: string) => s.length > 0);
          resolve({ hits });
        } catch { resolve(null); }
      });
      child.on("error", () => { clearTimeout(timer); resolve(null); });
    });
  }

  function extractGatewayTopic(content: string): string | null {
    const stripped = content
      .replace(/\n\[thread: [^\]]+\]\s*$/u, "")
      .trim();
    if (stripped.length < 20) return null;

    const automatedPrefixes = [
      "## 📋 Batch Digest",
      "## 🔔 Gateway",
      "> ⚡ **Automated gateway event**",
      "> ⚡ **Automated gateway digest summary**",
      "# Context Recovery",
      "## Context Refresh",
      "## Gateway Recovery",
      "HEARTBEAT",
      "HEARTBEAT_OK",
      "Recovered. Standing by.",
    ];
    if (automatedPrefixes.some((prefix) => stripped.startsWith(prefix))) return null;
    if (/^Noted[.,!\s-]/u.test(stripped)) return null;

    return stripped.slice(0, 100);
  }

  /** Inject a rolling context refresh into the gateway session. */
  async function refreshGatewayContext(): Promise<void> {
    if (gwRecallInFlight) return;

    const topicSeed = gwRecentTopics.slice(-3).join(" ").trim();
    if (!topicSeed) return;

    gwRecallInFlight = true;

    try {
      const query = `gateway ${topicSeed}`.slice(0, 140);

      const result = await gwRunRecall(query, 5);
      gwRecallInFlight = false;
      if (!result || result.hits.length === 0) return;

      gwRecallCache.push({ query, hits: result.hits });
      if (gwRecallCache.length > 3) gwRecallCache.shift();

      const lines = result.hits.slice(0, 5).map((h) => `- ${h}`);
      pi.sendMessage({
        customType: "context-refresh",
        content: `## Context Refresh\n${lines.join("\n")}`,
        display: false,
      });

      lastRefreshTs = Date.now();

      emitGatewayOtel({
        level: "info",
        component: "gateway-context",
        action: "context.refresh.injected",
        success: true,
        metadata: { hitCount: result.hits.length, query: query.slice(0, 80) },
      });
    } catch {
      gwRecallInFlight = false;
    }
  }

  // Periodic refresh timer
  const refreshTimer = setInterval(() => {
    if (Date.now() - lastRefreshTs >= REFRESH_INTERVAL_MS) {
      void refreshGatewayContext();
    }
  }, 60_000); // Check every minute, refresh every 30

  // ── ADR-0209 V3: Thread fade lifecycle ──────────────────────────
  const THREAD_SNAPSHOT_PATH = join(process.env.HOME || "/Users/joel", ".joelclaw", "state", "thread-snapshot.json");

  /** Read thread snapshot from disk (daemon writes it) */
  function readThreadSnapshot(): Array<{
    id: string;
    label: string;
    lastTouchedAt: number;
    lastSummary: string;
    messageCount: number;
    lifecycle: string;
    createdAt: number;
  }> | null {
    try {
      const data = JSON.parse(readFileSync(THREAD_SNAPSHOT_PATH, "utf-8")) as {
        threads?: Array<{
          id: string; label: string; lastTouchedAt: number;
          lastSummary: string; messageCount: number;
          lifecycle: string; createdAt: number;
        }>;
      };
      return data.threads ?? null;
    } catch {
      return null;
    }
  }

  /** ADR-0209 V3: Archive old threads to memory observations */
  let lastFadeCycleTs = 0;
  const FADE_CYCLE_INTERVAL_MS = 5 * 60_000; // every 5 min

  function runFadeCycle(): void {
    const now = Date.now();
    if (now - lastFadeCycleTs < FADE_CYCLE_INTERVAL_MS) return;
    lastFadeCycleTs = now;

    const snapshot = readThreadSnapshot();
    if (!snapshot || snapshot.length === 0) return;

    // Find threads that should be archived (>72h old)
    const COOL_THRESHOLD_MS = 72 * 60 * 60 * 1000;
    const newlyArchived = snapshot.filter(
      (t) => t.lifecycle !== "archived" && (now - t.lastTouchedAt) > COOL_THRESHOLD_MS,
    );

    for (const t of newlyArchived) {
      const durationMins = Math.round((t.lastTouchedAt - t.createdAt) / 60000);
      const observation = `Gateway thread archived: "${t.label}" — ${t.messageCount} messages over ${durationMins}min. ${t.lastSummary || "(no summary)"}`;
      const child = spawn("joelclaw", [
        "memory", "write", observation,
        "--category", "ops",
        "--tags", "adr-0209,thread-archived," + t.label,
      ], { stdio: "ignore", detached: true });
      child.unref();

      emitGatewayOtel({
        level: "info",
        component: "thread-tracker",
        action: "thread.archived",
        success: true,
        metadata: {
          threadId: t.id,
          label: t.label,
          messageCount: t.messageCount,
          durationMins,
        },
      });
    }
  }

  // ADR-0209 V4: Per-turn thread index injection is handled at the daemon level
  // in enqueueToGateway() — it injects formatThreadIndexForPrompt() + current
  // threadId directly into the prompt text. No extension-level injection needed
  // (would duplicate and accumulate in context).

  pi.on("turn_end", async (_event, _ctx) => {
    // ADR-0209 V3: Run fade cycle on every turn (debounced to 5min)
    try { runFadeCycle(); } catch {}

    try {
      ctx = _ctx;
      const usage = _ctx.getContextUsage();
      if (!usage?.percent) return;
      const pct = usage.percent;

      // Track only real conversational topics; skip automated gateway envelopes
      // and terse acknowledgements so rolling recall does not poison the session
      // with unrelated global memory hits.
      if (_event.message?.content) {
        const content = Array.isArray(_event.message.content)
          ? (_event.message.content as Array<Record<string, unknown>>)
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string)
              .join(" ")
          : typeof _event.message.content === "string" ? _event.message.content : "";
        const topic = extractGatewayTopic(content);
        if (topic) {
          gwRecentTopics.push(topic);
          if (gwRecentTopics.length > 5) gwRecentTopics.shift();
        }
      }

      // Warm zone: start caching recall
      if (pct >= 40 && !gwWarmZoneEntered) {
        gwWarmZoneEntered = true;
        void refreshGatewayContext();
      }

      // Hot zone: force refresh if stale
      if (pct >= 60 && !gwHotZoneEntered) {
        gwHotZoneEntered = true;
        void refreshGatewayContext();
      }
    } catch {}
  });

  pi.on("session_compact", async () => {
    gwCompactionCount++;
    const now = Date.now();
    const isRapidRecompaction = gwLastCompactionTs > 0 && (now - gwLastCompactionTs) < GW_COMPACTION_COOLDOWN_MS;
    gwLastCompactionTs = now;

    // Skip recovery injection on rapid re-compaction — the first compaction's
    // recovery pointers are still in context. Injecting again via sendMessage()
    // queues messages → continue() → model response → _checkCompaction → cascade.
    if (isRapidRecompaction) {
      gwWarmZoneEntered = false;
      gwHotZoneEntered = false;
      emitGatewayOtel({
        level: "info",
        component: "gateway-context",
        action: "gateway.compaction.inject.skipped",
        success: true,
        metadata: { gwCompactionCount, reason: "rapid-recompaction", cooldownMs: GW_COMPACTION_COOLDOWN_MS },
      });
      return;
    }

    try {
      // Build pointer from cached recall
      const lines: string[] = ["## Gateway Recovery"];

      // ADR-0209: Inject thread state from snapshot
      try {
        const threadSnapshotPath = join(process.env.HOME || "/Users/joel", ".joelclaw", "state", "thread-snapshot.json");
        const threadData = JSON.parse(readFileSync(threadSnapshotPath, "utf-8")) as {
          threads?: Array<{
            id: string;
            label: string;
            lastTouchedAt: number;
            lastSummary: string;
            messageCount: number;
            lifecycle: string;
          }>;
        };
        const activeThreads = (threadData.threads ?? []).filter(
          (t) => t.lifecycle === "active" || t.lifecycle === "warm",
        );
        if (activeThreads.length > 0) {
          const emoji: Record<string, string> = { active: "🔵", warm: "🟡" };
          lines.push("**Active threads:**");
          for (const t of activeThreads) {
            const age = Math.round((Date.now() - t.lastTouchedAt) / 60000);
            const ageStr = age < 60 ? `${age}m` : `${Math.round(age / 60)}h`;
            const e = emoji[t.lifecycle] ?? "⚪";
            const summary = t.lastSummary ? ` — ${t.lastSummary}` : "";
            lines.push(`- ${e} **${t.label}**${summary} (${ageStr} ago, ${t.messageCount} msgs)`);
          }
        }
      } catch {
        // No thread snapshot available — that's fine
      }
      if (gwRecentTopics.length > 0) {
        lines.push(`**Recent topics:** ${gwRecentTopics.slice(-3).join(" → ").slice(0, 200)}`);
      }
      const allHits: string[] = [];
      const allQueries: string[] = [];
      for (const r of gwRecallCache) {
        allQueries.push(r.query);
        for (const h of r.hits) {
          if (!allHits.includes(h)) allHits.push(h);
        }
      }
      if (allHits.length > 0) {
        lines.push(`**Related memories:**\n${allHits.slice(0, 3).map((h) => `- ${h.slice(0, 150)}`).join("\n")}`);
      }
      if (allQueries.length > 0) {
        lines.push(`**Deeper context:** ${allQueries.slice(0, 2).map((q) => `\`recall "${q}"\``).join(" or ")}`);
      }

      const content = lines.join("\n");

      pi.sendMessage({
        customType: "gateway-recovery",
        content,
        display: false,
      });

      // Reset zone flags
      gwWarmZoneEntered = false;
      gwHotZoneEntered = false;

      emitGatewayOtel({
        level: "info",
        component: "gateway-context",
        action: "gateway.compaction.inject",
        success: true,
        metadata: {
          gwCompactionCount,
          hitsCount: allHits.length,
          queriesCount: allQueries.length,
          contentChars: content.length,
          estimatedTokens: Math.ceil(content.length / 4),
        },
      });
    } catch {}
  });

  pi.on("session_shutdown", async () => {
    stopWatchdog();
    clearInterval(refreshTimer);
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
      await drain();
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
