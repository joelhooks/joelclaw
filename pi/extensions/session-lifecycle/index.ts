// Session Lifecycle - auto-briefing, pre-compaction flush, shutdown handoff, session naming,
// and compaction recovery pipeline (ADR-0203).
//
// Eliminates manual continuation prompts by automatically injecting
// system context at session start, preserving key context before
// compaction, and writing handoff notes on session end.
//
// ADR-0203 adds three-stage compaction recovery:
//   Stage 1 (turn_end)            - continuous signal extraction at warm/hot context thresholds
//   Stage 2 (turn_end)            - in-memory task checkpoint updated incrementally
//   Stage 3 (session_compact)     - pointer injection after compaction (~100 tokens)
//
// Hooks:
//   session_start              - initialize session tracking state
//   before_agent_start         - inject briefing (first turn) + system prompt awareness (every turn)
//   tool_execution_start       - track file modifications for checkpoint (ADR-0203)
//   turn_end                   - signal extraction + checkpoint update (ADR-0203)
//   session_before_compact     - flush metadata to daily log + final checkpoint (ADR-0203)
//   session_compact            - read checkpoint, inject recovery pointers (ADR-0203)
//   session_shutdown           - auto-name session, write handoff to daily log
//
// Tools:
//   name_session           - LLM-callable tool to set session name mid-conversation
//
// Reads:
//   ~/.joelclaw/workspace/MEMORY.md              - curated long-term memory
//   ~/.joelclaw/workspace/memory/YYYY-MM-DD.md   - today's daily log
//   ~/Vault/system/system-log.jsonl              - recent slog entries
//   ~/Vault/Projects/*/index.md                  - active project status
//
// Writes:
//   ~/.joelclaw/workspace/memory/YYYY-MM-DD.md   - compaction flush + session handoff
//
// External interactions (all via joelclaw CLI):
//   joelclaw otel emit       - telemetry at each threshold crossing
//   joelclaw memory write    - durable observations extracted pre-compaction

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Paths ───────────────────────────────────────────────────────────

const HOME = os.homedir();
const VAULT = path.join(HOME, "Vault");
const MEMORY_MD = path.join(HOME, ".joelclaw", "workspace", "MEMORY.md");
const MEMORY_DIR = path.join(HOME, ".joelclaw", "workspace", "memory");
const SLOG_PATH = path.join(VAULT, "system", "system-log.jsonl");
const PROJECTS_DIR = path.join(VAULT, "Projects");
const JOELCLAW_REPO = path.join(HOME, "Code", "joelhooks", "joelclaw");
const AGENT_MAIL_STEERING_DIR = path.join(HOME, ".joelclaw", "workspace", "agent-mail-steering");
const JOELCLAW_COMMAND_TIMEOUT_MS = 7000;
const AGENT_MAIL_MIN_DAILY_SIGNALS = 2;

// ── Helpers ─────────────────────────────────────────────────────────

function readSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readEnvVarFromFiles(name: string, filePaths: string[]): string {
  const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(name)}=(.+)$`, "m");

  for (const filePath of filePaths) {
    const content = readSafe(filePath);
    if (!content) continue;

    const match = content.match(pattern);
    if (!match) continue;

    const raw = match[1]?.trim() ?? "";
    if (!raw) continue;

    const unquoted = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
    if (unquoted.length > 0) return unquoted;
  }

  return "";
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyLogPath(): string {
  return path.join(MEMORY_DIR, `${todayStr()}.md`);
}

function appendToDaily(text: string): void {
  const p = dailyLogPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, text, "utf-8");
  } catch {}
}

export function emitEvent(name: string, data: Record<string, unknown>): void {
  // Send event to Inngest via HTTP API.
  // Key/base URL resolution order:
  // 1) process env
  // 2) ~/.config/inngest/env
  // 3) ~/.config/system-bus.env
  // 4) ~/Code/joelhooks/joelclaw/packages/system-bus/.env
  // Falls back silently if unresolved — events are best-effort.
  const envPaths = [
    path.join(HOME, ".config", "inngest", "env"),
    path.join(HOME, ".config", "system-bus.env"),
    path.join(JOELCLAW_REPO, "packages", "system-bus", ".env"),
  ];

  const eventKey = process.env.INNGEST_EVENT_KEY || readEnvVarFromFiles("INNGEST_EVENT_KEY", envPaths);
  const baseUrl = process.env.INNGEST_BASE_URL || readEnvVarFromFiles("INNGEST_BASE_URL", envPaths) || "http://localhost:8288";

  if (!eventKey) return; // No key = no Inngest = skip silently

  const payload = JSON.stringify({ name, data });
  const child = spawn(
    "curl",
    [
      "-sf", "-X", "POST",
      `${baseUrl}/e/${eventKey}`,
      "-H", "Content-Type: application/json",
      "-d", payload,
      "--max-time", "5",
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
}

function timeStamp(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function recentSlog(count = 5): string[] {
  const content = readSafe(SLOG_PATH);
  if (!content) return [];
  const lines = content.trim().split("\n").filter(Boolean);
  return lines.slice(-count).map((line) => {
    try {
      const e = JSON.parse(line);
      const ts = e.timestamp?.slice(0, 16) || "?";
      return `- ${ts} \`${e.action}\` **${e.tool}**: ${e.detail}`;
    } catch {
      return `- ${line.slice(0, 100)}`;
    }
  });
}

// ── Daily log filtering ─────────────────────────────────────

const MAX_DAILY_BYTES = 4096; // ~1K tokens — hard cap

/** Extract signal from daily log, skip internal bookkeeping noise. */
function filteredDailyLog(content: string): string {
  // Split into sections by ### headers
  const sections = content.split(/(?=^### )/m).filter(Boolean);

  const keep: string[] = [];

  for (const section of sections) {
    // Always keep: session handoffs
    if (section.startsWith("### 📋")) {
      keep.push(section.trim());
      continue;
    }
    // Keep last few observations (session summaries have useful context)
    if (section.startsWith("### 🔭 Observations")) {
      keep.push(section.trim());
      continue;
    }
    // Skip: compaction dumps, title-gen errors, reflections (derivative of observations)
    if (
      section.startsWith("### ⚡ Compaction") ||
      section.startsWith("### ⚠️ Title gen failed") ||
      section.startsWith("### 🔭 Reflected")
    ) {
      continue;
    }
    // Keep anything else (unknown section types)
    keep.push(section.trim());
  }

  // For observations, only keep the last 3 (most recent context)
  const observations = keep.filter((s) => s.startsWith("### 🔭 Observations"));
  const nonObservations = keep.filter((s) => !s.startsWith("### 🔭 Observations"));
  const recentObs = observations.slice(-3);

  let result = [...nonObservations, ...recentObs].join("\n\n");

  // Hard cap as safety net
  if (result.length > MAX_DAILY_BYTES) {
    result = result.slice(-MAX_DAILY_BYTES);
    // Clean up — don't start mid-line
    const firstNewline = result.indexOf("\n");
    if (firstNewline > 0) {
      result = "…(truncated)\n" + result.slice(firstNewline + 1);
    }
  }

  return result;
}

function activeProjects(): string[] {
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    return dirs
      .filter((d) => d.isDirectory())
      .map((d) => {
        const content = readSafe(path.join(PROJECTS_DIR, d.name, "index.md"));
        if (!content) return null;
        const status = content.match(/status:\s*(.+)/)?.[1]?.trim();
        if (!status || status === "archived" || status === "done") return null;
        const title = content.match(/^#\s+(.+)/m)?.[1] || d.name;
        return `- **${d.name}**: ${title} (${status})`;
      })
      .filter(Boolean) as string[];
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

type JoelclawJsonResult =
  | { ok: true; envelope: Record<string, unknown> }
  | { ok: false; error: string; envelope?: Record<string, unknown> };

async function runJoelclawJsonCommand(args: string[], timeoutMs = JOELCLAW_COMMAND_TIMEOUT_MS): Promise<JoelclawJsonResult> {
  return new Promise((resolve) => {
    const child = spawn("joelclaw", args, {
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const done = (result: JoelclawJsonResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      done({ ok: false, error: error.message });
    });

    child.on("close", (code) => {
      const raw = stdout.trim();
      if (code !== 0 || raw.length === 0) {
        const details = stderr.trim() || raw || `exit ${String(code ?? "?")}`;
        done({ ok: false, error: details });
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        const envelope = asRecord(parsed);
        if (!envelope) {
          done({ ok: false, error: "command returned non-object JSON" });
          return;
        }

        const ok = envelope.ok;
        if (ok === false) {
          const errorRecord = asRecord(envelope.error);
          done({
            ok: false,
            envelope,
            error: asString(errorRecord?.message) ?? "command returned ok=false",
          });
          return;
        }

        done({ ok: true, envelope });
      } catch (error) {
        done({ ok: false, error: `invalid JSON output: ${String(error)}` });
      }
    });
  });
}

type AgentMailSteeringStatus = "good" | "watch" | "poor";

type AgentMailSteeringSnapshot = {
  date: string;
  generatedAt: string;
  promptHash: string;
  mail: {
    locksActive: number;
    locksStale: number;
    announceSignalsTotal: number;
    taskSignalsTotal: number;
    statusSignalsTotal: number;
    handoffSignalsTotal: number;
    coordinationSignalsTotal: number;
    coordinationSignalsDelta: number | null;
    signalsDegraded: boolean;
    degradedReasons: string[];
  };
  otel: {
    available: boolean;
    query: string;
    found: number | null;
    error: string | null;
  };
  effectiveness: {
    score: number;
    status: AgentMailSteeringStatus;
    recommendations: string[];
  };
};

function steeringSnapshotPath(date = todayStr()): string {
  return path.join(AGENT_MAIL_STEERING_DIR, `${date}.json`);
}

function readSteeringSnapshot(date = todayStr()): AgentMailSteeringSnapshot | null {
  const raw = readSafe(steeringSnapshotPath(date));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentMailSteeringSnapshot;
  } catch {
    return null;
  }
}

function readLatestSteeringSnapshotBefore(date: string): AgentMailSteeringSnapshot | null {
  try {
    const entries = fs
      .readdirSync(AGENT_MAIL_STEERING_DIR)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name < `${date}.json`)
      .sort();

    const latest = entries.at(-1);
    if (!latest) return null;

    const raw = readSafe(path.join(AGENT_MAIL_STEERING_DIR, latest));
    if (!raw) return null;

    return JSON.parse(raw) as AgentMailSteeringSnapshot;
  } catch {
    return null;
  }
}

function writeSteeringSnapshot(snapshot: AgentMailSteeringSnapshot): void {
  try {
    fs.mkdirSync(AGENT_MAIL_STEERING_DIR, { recursive: true });
    fs.writeFileSync(
      steeringSnapshotPath(snapshot.date),
      JSON.stringify(snapshot, null, 2) + "\n",
      "utf-8",
    );
  } catch {}
}

type MailSignalSummary = {
  count: number;
  degraded: boolean;
  reason: string | null;
};

function mailSignalSummary(result: JoelclawJsonResult): MailSignalSummary {
  if (!result.ok) {
    return {
      count: 0,
      degraded: true,
      reason: result.error,
    };
  }

  const payload = asRecord(result.envelope.result);
  const count = asNumber(payload?.count) ?? 0;
  const diagnostic = asString(payload?.result);

  if (diagnostic && /error calling tool|database error|failed/i.test(diagnostic)) {
    return {
      count,
      degraded: true,
      reason: diagnostic,
    };
  }

  return {
    count,
    degraded: false,
    reason: null,
  };
}

function appendSteeringSummaryToDaily(snapshot: AgentMailSteeringSnapshot): void {
  const delta = snapshot.mail.coordinationSignalsDelta;
  const lines = [
    `\n### 📡 Agent-mail steering (${timeStamp()})`,
    `status: **${snapshot.effectiveness.status}** (${snapshot.effectiveness.score}/100)`,
    `signals: announce=${snapshot.mail.announceSignalsTotal}, task=${snapshot.mail.taskSignalsTotal}, status=${snapshot.mail.statusSignalsTotal}, handoff=${snapshot.mail.handoffSignalsTotal}, total=${snapshot.mail.coordinationSignalsTotal}${delta === null ? "" : ` (Δ ${delta >= 0 ? "+" : ""}${delta})`}`,
    `locks: active=${snapshot.mail.locksActive}, stale=${snapshot.mail.locksStale}`,
    snapshot.otel.available
      ? `otel(${snapshot.otel.query},24h): found=${snapshot.otel.found ?? 0}`
      : `otel(${snapshot.otel.query},24h): unavailable (${snapshot.otel.error ?? "unknown"})`,
  ];

  if (snapshot.mail.signalsDegraded) {
    const degradedReason = snapshot.mail.degradedReasons.at(0);
    lines.push(`mail-signals: degraded${degradedReason ? ` (${degradedReason.slice(0, 180)})` : ""}`);
  }

  const steering = snapshot.effectiveness.recommendations.at(0);
  if (steering) lines.push(`steering: ${steering}`);

  appendToDaily(lines.join("\n") + "\n");
}

function buildSteeringHint(snapshot: AgentMailSteeringSnapshot | null): string | null {
  if (!snapshot) return null;
  if (snapshot.effectiveness.status === "good") return null;
  const first = snapshot.effectiveness.recommendations.at(0);
  if (!first) return null;
  return `🎯 Today's steering hint: ${first}`;
}

const TURN_REMINDER_LINES = [
  "🪵 BEFORE your final response: Did you install, configure, fix, remove, or change any tool/service/infra this turn? If yes → `slog write` NOW, not later. The user should never have to remind you. If NOTHING changed (no installs, no config, no fixes, no infra) → do NOT mention slog at all. No \"no slog needed\" or \"no infra changed\" filler.",
  "📐 joelclaw work should be backed by an ADR. If there isn't one, ask why. Keep ADRs groomed — update status, mark superseded, close what's done.",
  "📋 For non-trivial tasks: ack and summarize your plan BEFORE starting work, then pause ~10 seconds for a possible course-correction. This is NOT a permission gate — proceed after the pause. It's just a window for Joel to intervene if the direction is wrong. Trivial tasks (quick lookups, small edits) don't need this.",
  "📬 Clawmail protocol is mandatory: use `joelclaw mail` (or `mail_*` wrappers) to announce (`Starting:`/`Task:`/`Status:`/`Done:`), check inbox, reserve edit paths (`joelclaw mail reserve --paths \"...\"`), optionally renew leases when supported by your `joelclaw` build (`joelclaw mail renew ...`), and always release after commit/handoff. Do not call MCP mail endpoints directly.",
  "📡 Daily monitor+steer loop runs once/day using agent mail traffic + OTEL + prompt-hash effectiveness. Apply any steering hint shown below.",
  "If this turn has no coordination risk or file edits, do NOT mention agent mail at all. No filler. No need to reply to this reminder.",
] as const;

const TURN_REMINDER_TEMPLATE = TURN_REMINDER_LINES.join("\n");

function buildTurnReminderContent(snapshot: AgentMailSteeringSnapshot | null): string {
  const lines = [...TURN_REMINDER_LINES];
  const hint = buildSteeringHint(snapshot);
  if (hint) {
    lines.splice(lines.length - 1, 0, hint);
  }
  return lines.join("\n");
}

function promptTemplateHash(promptTemplate: string): string {
  return crypto
    .createHash("sha256")
    .update(promptTemplate)
    .digest("hex")
    .slice(0, 16);
}

async function collectAgentMailSteeringSnapshot(promptTemplate: string): Promise<AgentMailSteeringSnapshot> {
  const date = todayStr();
  const promptHash = promptTemplateHash(promptTemplate);

  const [locksResult, announceResult, taskResult, statusResult, handoffResult, otelResult] = await Promise.all([
    runJoelclawJsonCommand(["mail", "locks", "--project", JOELCLAW_REPO]),
    runJoelclawJsonCommand(["mail", "search", "--project", JOELCLAW_REPO, "--query", "Starting:"]),
    runJoelclawJsonCommand(["mail", "search", "--project", JOELCLAW_REPO, "--query", "Task:"]),
    runJoelclawJsonCommand(["mail", "search", "--project", JOELCLAW_REPO, "--query", "Status:"]),
    runJoelclawJsonCommand(["mail", "search", "--project", JOELCLAW_REPO, "--query", "reserved paths"]),
    runJoelclawJsonCommand(["otel", "search", "mail", "--hours", "24", "--limit", "1"]),
  ]);

  const locksPayload = locksResult.ok ? asRecord(locksResult.envelope.result) : null;
  const lockSummary = asRecord(asRecord(locksPayload?.locks)?.summary);

  const locksActive = asNumber(locksPayload?.count) ?? 0;
  const locksStale = asNumber(lockSummary?.stale) ?? 0;

  const announceSignal = mailSignalSummary(announceResult);
  const taskSignal = mailSignalSummary(taskResult);
  const statusSignal = mailSignalSummary(statusResult);
  const handoffSignal = mailSignalSummary(handoffResult);

  const announceSignalsTotal = announceSignal.count;
  const taskSignalsTotal = taskSignal.count;
  const statusSignalsTotal = statusSignal.count;
  const handoffSignalsTotal = handoffSignal.count;
  const coordinationSignalsTotal = announceSignalsTotal + taskSignalsTotal + statusSignalsTotal + handoffSignalsTotal;
  const signalSummaries = [announceSignal, taskSignal, statusSignal, handoffSignal];
  const mailSignalsDegraded = signalSummaries.some((signal) => signal.degraded);
  const mailSignalDegradedReasons = signalSummaries
    .map((signal) => signal.reason)
    .filter((reason): reason is string => typeof reason === "string" && reason.length > 0);

  const previous = readLatestSteeringSnapshotBefore(date);
  const previousComparable = previous?.promptHash === promptHash
    ? previous.mail.coordinationSignalsTotal
    : null;
  const coordinationSignalsDelta = previousComparable === null
    ? null
    : coordinationSignalsTotal - previousComparable;

  const otelPayload = otelResult.ok ? asRecord(otelResult.envelope.result) : null;
  const otelFound = asNumber(otelPayload?.found);
  const otelErrorRecord = !otelResult.ok ? asRecord(otelResult.envelope?.error) : null;

  const recommendations: string[] = [];
  let score = 100;

  if (locksStale > 0) {
    score -= 60;
    recommendations.push("Stale locks detected. Tighten release discipline in the reminder and enforce explicit release commands at task end.");
  }

  if (locksActive > 0) {
    score -= 15;
    recommendations.push("Active locks are accumulating. Keep leases short and renew only while work is in flight.");
  }

  if (mailSignalsDegraded) {
    score -= 10;
    recommendations.push("Mail search signals are degraded. Fix agent-mail search reliability so daily steering is based on real traffic.");
  }

  if (coordinationSignalsTotal === 0) {
    score -= 30;
    recommendations.push("No coordination mail signals found. Keep announce/status/handoff examples explicit in prompt guidance.");
  } else if (coordinationSignalsDelta !== null && coordinationSignalsDelta < AGENT_MAIL_MIN_DAILY_SIGNALS) {
    score -= 25;
    recommendations.push("Daily coordination signal growth is low. Strengthen prompt wording around status updates and handoffs.");
  }

  if (otelResult.ok) {
    if ((otelFound ?? 0) === 0) {
      score -= 20;
      recommendations.push("OTEL found no mail-related events in the last 24h. Verify telemetry emission and query coverage.");
    }
  } else {
    score -= 10;
    recommendations.push("OTEL query failed. Fix Typesense/OTEL availability so prompt steering has live feedback.");
  }

  score = Math.max(0, Math.min(100, score));

  const status: AgentMailSteeringStatus = score >= 80
    ? "good"
    : score >= 55
      ? "watch"
      : "poor";

  const uniqueRecommendations = [...new Set(recommendations)];

  return {
    date,
    generatedAt: new Date().toISOString(),
    promptHash,
    mail: {
      locksActive,
      locksStale,
      announceSignalsTotal,
      taskSignalsTotal,
      statusSignalsTotal,
      handoffSignalsTotal,
      coordinationSignalsTotal,
      coordinationSignalsDelta,
      signalsDegraded: mailSignalsDegraded,
      degradedReasons: mailSignalDegradedReasons,
    },
    otel: {
      available: otelResult.ok,
      query: "mail",
      found: otelFound,
      error: otelResult.ok ? null : (asString(otelErrorRecord?.message) ?? otelResult.error),
    },
    effectiveness: {
      score,
      status,
      recommendations: status === "good" ? [] : uniqueRecommendations,
    },
  };
}

// ── Compaction Recovery: Typesense Recall (ADR-0203) ────────────
//
// Uses joelclaw recall (Typesense hybrid search: keyword + vector) to
// find relevant memories for the current task. Local Typesense is fast
// (~370ms with lean budget), so we run recall queries asynchronously
// during the warm/hot zones and cache results for post-compaction injection.
//
// No regex extraction — the async Inngest observe pipeline handles
// semantic extraction from session transcripts via LLM. This pipeline
// focuses on RETRIEVAL of existing knowledge, not extraction of new signal.

interface RecallHit {
  observation: string;
  score: number;
  categoryId: string;
}

interface RecallResult {
  query: string;
  hits: RecallHit[];
  found: number;
}

/** Run a recall query via joelclaw CLI. Uses lean budget for speed (~370ms). */
async function runRecall(query: string, limit = 3): Promise<RecallResult | null> {
  if (!query || query.length < 5) return null;
  const result = await runJoelclawJsonCommand(
    ["recall", query, "--limit", String(limit), "--budget", "lean"],
    5000, // tighter timeout for hot-path recall
  );
  if (!result.ok) return null;
  const data = asRecord(result.envelope.result);
  if (!data) return null;
  const rawHits = Array.isArray(data.hits) ? data.hits : [];
  const hits: RecallHit[] = [];
  for (const h of rawHits) {
    const rec = asRecord(h);
    if (!rec) continue;
    const obs = asString(rec.observation);
    const score = asNumber(rec.score);
    if (obs && obs.length > 0 && score !== null) {
      hits.push({
        observation: obs,
        score,
        categoryId: asString(rec.categoryId) ?? "unknown",
      });
    }
  }
  return {
    query: asString(data.query) ?? query,
    hits,
    found: asNumber(data.found) ?? 0,
  };
}

// ── Compaction Recovery: CLI Helpers (ADR-0203) ─────────────────
// All external interactions go through joelclaw CLI — no direct service calls.

function spawnJoelclaw(args: string[]): void {
  const child = spawn("joelclaw", args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TERM: "dumb" },
  });
  child.unref();
}

function emitOtel(action: string, metadata: Record<string, unknown>): void {
  spawnJoelclaw([
    "otel", "emit", action,
    "--source", "interactive",
    "--component", "session-lifecycle",
    "--success", "true",
    "--metadata", JSON.stringify(metadata),
  ]);
}

function writeMemoryObs(observation: string, extraTags: string[]): void {
  spawnJoelclaw([
    "memory", "write", observation,
    "--category", "ops",
    "--tags", ["compaction-extract", ...extraTags].join(","),
  ]);
}

// ── Compaction Recovery: Checkpoint Type (ADR-0203) ─────────────

interface TaskCheckpoint {
  currentTask: string;           // last 3 user msgs joined, ≤500 chars
  filesModified: string[];       // most recent 10
  recallHits: string[];          // actual observations from Typesense
  recallQueries: string[];       // validated queries that returned results
  compactionCount: number;
  contextPercentAtCapture: number;
}

// ── Static system prompt awareness (same every turn → cacheable) ──

function currentTimestamp(): string {
  return new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

const LIFECYCLE_AWARENESS = `
## Session Lifecycle (auto-managed)

This session is managed by the session-lifecycle extension. What's automated:
- **Session briefing**: MEMORY.md, today's daily log, recent slog entries, and active Vault projects were auto-injected at session start as a custom message.
- **Pre-compaction flush**: Before compaction, file operations and session metadata are auto-flushed to the daily log (~/.joelclaw/workspace/memory/YYYY-MM-DD.md).
- **Shutdown handoff**: On session end, a handoff note is auto-written to the daily log and the session is auto-named.

Behavioral rules:
- Do NOT tell the user to "read MEMORY.md first" or write manual continuation/handoff files — it's handled.
- Do NOT re-read MEMORY.md or the daily log unless the user asks or you need to verify something changed mid-session.
- When you make a key decision, learn a hard-won debugging insight, or discover a user preference, call it out explicitly — compaction preserves file metadata but conversation nuance can be lost.
- If the session briefing is present above, treat it as authoritative system state.
- After 2-3 exchanges when the session topic is clear, use the \`name_session\` tool to give this session a descriptive 3-6 word name.
`.trim();

// slog categories/format reference lives in AGENTS.md (shared across all agents).
// Per-turn nudge is injected as a hidden message in before_agent_start (recency-biased).

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let hasBriefed = false;
  let sessionStartTime = Date.now();
  let userMessageCount = 0;
  let firstUserMessage = "";
  let steeringSnapshotCache: AgentMailSteeringSnapshot | null = null;
  let steeringSnapshotPromise: Promise<AgentMailSteeringSnapshot | null> | null = null;

  // ── Compaction Recovery State (ADR-0203) ──────────────────────
  let compactionCount = 0;
  let lastCompactionTs = 0;
  const COMPACTION_COOLDOWN_MS = 60_000; // skip recovery injection if re-compacting within 60s
  let recentUserMessages: string[] = [];
  let trackedFilesModified = new Set<string>();
  let warmZoneEntered = false;
  let hotZoneEntered = false;
  // Recall cache: validated queries + hits from Typesense
  let recallCache: RecallResult[] = [];
  let lastRecallTaskHash = "";
  let recallInFlight = false;
  let taskContextWritten = false;

  /** Build checkpoint from in-memory state (recall cache + tracked files). */
  function buildCheckpoint(contextPercent: number): TaskCheckpoint {
    const task = recentUserMessages.slice(-3).join(" → ").slice(0, 500);

    // Collect validated recall hits and queries from cache
    const recallHits: string[] = [];
    const recallQueries: string[] = [];
    for (const r of recallCache) {
      if (!recallQueries.includes(r.query)) recallQueries.push(r.query);
      for (const h of r.hits) {
        if (!recallHits.includes(h.observation)) recallHits.push(h.observation);
      }
    }

    // Fallback: derive a simple query from task if recall cache is empty
    if (recallQueries.length === 0 && task.length > 10) {
      const fallback = task.slice(0, 100).replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim();
      if (fallback.length > 5) recallQueries.push(fallback);
    }

    return {
      currentTask: task,
      filesModified: [...trackedFilesModified].slice(-10),
      recallHits: recallHits.slice(0, 5),
      recallQueries: recallQueries.slice(0, 3),
      compactionCount,
      contextPercentAtCapture: contextPercent,
    };
  }

  /** Kick off an async recall query against Typesense. Results cached for pointer injection. */
  function triggerRecall(): void {
    const taskHash = recentUserMessages.join("|").slice(0, 200);
    if (taskHash === lastRecallTaskHash || recallInFlight || recentUserMessages.length === 0) return;

    recallInFlight = true;
    lastRecallTaskHash = taskHash;
    const query = recentUserMessages.slice(-2).join(" ").slice(0, 120);

    runRecall(query, 5).then((result) => {
      recallInFlight = false;
      if (result && result.hits.length > 0) {
        recallCache.push(result);
        if (recallCache.length > 3) recallCache.shift();
      }
    }).catch(() => { recallInFlight = false; });
  }

  /** Write task context to durable memory so future sessions can find it. */
  function writeTaskContextToMemory(): void {
    if (taskContextWritten) return;
    const parts: string[] = [];
    const task = recentUserMessages.slice(-3).join(" → ").slice(0, 200);
    if (task.length > 10) parts.push(`Task: ${task}`);
    const files = [...trackedFilesModified].slice(-5);
    if (files.length > 0) parts.push(`Files: ${files.join(", ")}`);
    if (parts.length === 0) return;
    taskContextWritten = true;
    writeMemoryObs(parts.join(". "), ["session-task"]);
  }

  async function ensureDailySteeringSnapshot(): Promise<AgentMailSteeringSnapshot | null> {
    const date = todayStr();
    const expectedPromptHash = promptTemplateHash(TURN_REMINDER_TEMPLATE);

    if (
      steeringSnapshotCache &&
      steeringSnapshotCache.date === date &&
      steeringSnapshotCache.promptHash === expectedPromptHash
    ) {
      return steeringSnapshotCache;
    }

    const existing = readSteeringSnapshot(date);
    if (existing && existing.promptHash === expectedPromptHash) {
      steeringSnapshotCache = existing;
      return existing;
    }

    if (!steeringSnapshotPromise) {
      steeringSnapshotPromise = (async () => {
        try {
          const snapshot = await collectAgentMailSteeringSnapshot(TURN_REMINDER_TEMPLATE);
          writeSteeringSnapshot(snapshot);
          appendSteeringSummaryToDaily(snapshot);
          emitEvent("agent-mail/steering.reviewed", {
            date: snapshot.date,
            generatedAt: snapshot.generatedAt,
            promptHash: snapshot.promptHash,
            status: snapshot.effectiveness.status,
            score: snapshot.effectiveness.score,
            locksActive: snapshot.mail.locksActive,
            locksStale: snapshot.mail.locksStale,
            coordinationSignalsTotal: snapshot.mail.coordinationSignalsTotal,
            coordinationSignalsDelta: snapshot.mail.coordinationSignalsDelta,
            mailSignalsDegraded: snapshot.mail.signalsDegraded,
            mailSignalsDegradedReasons: snapshot.mail.degradedReasons,
            otelAvailable: snapshot.otel.available,
            otelFound: snapshot.otel.found,
            recommendations: snapshot.effectiveness.recommendations,
          });
          steeringSnapshotCache = snapshot;
          return snapshot;
        } catch (error) {
          console.log(`[session-lifecycle] agent-mail steering check failed: ${String(error)}`);
          return null;
        } finally {
          steeringSnapshotPromise = null;
        }
      })();
    }

    return steeringSnapshotPromise;
  }

  // ── name_session tool: let the agent name the session ───────

  pi.registerTool({
    name: "name_session",
    label: "Name Session",
    description:
      "Set a descriptive name for this session (shown in session selector). " +
      "Call this after 2-3 exchanges when the session's purpose is clear. " +
      "Use 3-6 words that capture what's being worked on, e.g. " +
      "'Fix daily log context blowout' or 'K8s article fact checking'.",
    parameters: Type.Object({
      name: Type.String({
        description: "Session name, 3-6 words, specific to the work being done",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const name = params.name.slice(0, 60).trim();
      if (!name) {
        return {
          content: [{ type: "text" as const, text: "Name cannot be empty." }],
          details: null,
        };
      }
      pi.setSessionName(name);
      return {
        content: [
          {
            type: "text" as const,
            text: `Session named: "${name}"`,
          },
        ],
        details: null,
      };
    },
  });

  // ── Global error guard: catch unhandled network errors before they spam the TUI ──
  // ioredis, Langfuse SDK, MCP clients, etc. can all produce unhandled rejections
  // or uncaught exceptions from node:net when services are unreachable.
  const NETWORK_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "EPIPE", "EAI_AGAIN"]);
  const networkErrorSeen = new Set<string>();

  function isNetworkError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = (err as any).code;
    if (typeof code === "string" && NETWORK_ERRORS.has(code)) return true;
    const msg = (err as any).message;
    if (typeof msg === "string" && /internalConnectMultiple|afterConnectMultiple|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(msg)) return true;
    const stack = (err as any).stack;
    if (typeof stack === "string" && /internalConnectMultiple|afterConnectMultiple/.test(stack)) return true;
    return false;
  }

  process.on("unhandledRejection", (reason) => {
    if (isNetworkError(reason)) {
      const code = (reason as any)?.code || "NETWORK";
      if (!networkErrorSeen.has(code)) {
        networkErrorSeen.add(code);
        console.log(`[error-guard] suppressed unhandled network error: ${code}`);
      }
      return; // Swallow — don't let Node.js print the stack trace
    }
    // Non-network errors: let Node.js default behavior handle them
  });

  // ── session_start: reset tracking state ─────────────────────

  pi.on("session_start", async () => {
    hasBriefed = false;
    sessionStartTime = Date.now();
    userMessageCount = 0;
    firstUserMessage = "";
    networkErrorSeen.clear();
    steeringSnapshotPromise = null;
    if (steeringSnapshotCache && steeringSnapshotCache.date !== todayStr()) {
      steeringSnapshotCache = null;
    }

    // ADR-0203: reset compaction recovery state
    compactionCount = 0;
    lastCompactionTs = 0;
    recentUserMessages = [];
    trackedFilesModified = new Set();
    warmZoneEntered = false;
    hotZoneEntered = false;
    recallCache = [];
    lastRecallTaskHash = "";
    recallInFlight = false;
    taskContextWritten = false;
  });

  // ── before_agent_start: briefing + awareness ────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    userMessageCount++;

    // Capture first user message for session naming (used at shutdown fallback)
    if (!firstUserMessage && event.prompt) {
      firstUserMessage =
        typeof event.prompt === "string"
          ? event.prompt.slice(0, 200)
          : "";
    }

    // ADR-0203: track last 3 user messages for task checkpoint
    if (event.prompt && typeof event.prompt === "string") {
      recentUserMessages.push(event.prompt.slice(0, 200));
      if (recentUserMessages.length > 3) recentUserMessages.shift();
    }

    // Every turn: lifecycle awareness + timestamp.
    // Slog reference lives in AGENTS.md (shared across all agents).
    // Slog nudge is injected as a message below (recency-biased, pi-only).
    const systemPrompt =
      event.systemPrompt +
      "\n\n" + LIFECYCLE_AWARENESS +
      "\n\nCurrent date and time: " + currentTimestamp();

    // Post-first turn: terse slog nudge as a message for recency bias.
    // The full SLOG_REMINDER stays in systemPrompt for reference/categories,
    // but this message sits right next to the user prompt where the LLM sees it.
    if (hasBriefed) {
      const steeringSnapshot = await ensureDailySteeringSnapshot();
      return {
        systemPrompt,
        message: {
          customType: "slog-nudge",
          content: buildTurnReminderContent(steeringSnapshot),
          display: false,
        },
      };
    }
    hasBriefed = true;

    // Kick off daily steering collection in the background on first turn.
    void ensureDailySteeringSnapshot();

    // Build briefing from live system state
    const sections: string[] = [];

    const memory = readSafe(MEMORY_MD);
    if (memory) {
      sections.push("## Curated Memory\n\n" + memory.trim());
    }

    const daily = readSafe(dailyLogPath());
    if (daily) {
      const filtered = filteredDailyLog(daily);
      if (filtered) {
        sections.push("## Today's Log\n\n" + filtered);
      }
    }

    const slog = recentSlog(5);
    if (slog.length > 0) {
      sections.push("## Recent System Activity\n\n" + slog.join("\n"));
    }

    const projects = activeProjects();
    if (projects.length > 0) {
      sections.push("## Active Vault Projects\n\n" + projects.join("\n"));
    }

    // Check for pending memory proposals via Redis (with timeout — can't hang the gateway)
    // Dynamic import: ioredis may not be installed — extension loads fine either way.
    let pendingCount = 0;
    try {
      const { default: Redis } = await import("ioredis");
      const redis = new Redis({
        host: "localhost",
        port: 6379,
        connectTimeout: 2000,
        commandTimeout: 2000,
        lazyConnect: true,
        retryStrategy: () => null, // Don't retry — this is a one-shot check
      });
      redis.on("error", () => {}); // Prevent unhandled 'error' event → stderr spew
      await redis.connect();
      pendingCount = await redis.llen("memory:review:pending");
      redis.disconnect();
    } catch {
      // Redis or ioredis unavailable — briefing continues without proposal count
    }

    const pendingLine =
      pendingCount > 0
        ? `📋 ${pendingCount} pending memory proposals — run \`joelclaw review\` or say "review proposals" to see them`
        : null;

    if (sections.length === 0 && !pendingLine) {
      return { systemPrompt };
    }

    const briefingContent = [
      "# Session Briefing (auto-injected)",
      ...sections,
      ...(pendingLine ? [pendingLine] : []),
    ].join("\n\n");

    return {
      systemPrompt,
      message: {
        customType: "session-briefing",
        content: briefingContent,
        display: false,
      },
    };
  });

  // ── tool_execution_start: track files + project-scoped recall (ADR-0203 + ADR-0204) ──

  const injectedScopes = new Set<string>();

  /** Map a file path to a project scope + recall query. */
  function detectProjectScope(filePath: string): { scope: string; query: string } | null {
    const p = filePath.replace(/^\/Users\/joel\/Code\/joelhooks\/joelclaw\//, "");
    if (p.startsWith("packages/system-bus/")) return { scope: "system-bus", query: "system-bus inngest worker functions deployment" };
    if (p.startsWith("packages/gateway/")) return { scope: "gateway", query: "gateway daemon telegram redis event bridge" };
    if (p.startsWith("packages/cli/")) return { scope: "cli", query: "joelclaw CLI effect commands HATEOAS" };
    if (p.startsWith("packages/vault-reader/")) return { scope: "vault-reader", query: "vault reader enrichment context" };
    if (p.startsWith("packages/inference-router/")) return { scope: "inference-router", query: "inference router model selection catalog" };
    if (p.startsWith("apps/web/")) return { scope: "web", query: "joelclaw.com next.js web RSC content" };
    if (p.startsWith("pi/extensions/")) return { scope: "pi-extensions", query: "pi extension hooks lifecycle session" };
    if (p.startsWith("k8s/")) return { scope: "k8s", query: "kubernetes talos colima deploy pods" };
    if (p.startsWith("skills/")) return { scope: "skills", query: "agent skills SKOS taxonomy" };
    return null;
  }

  pi.on("tool_execution_start", async (event) => {
    if ((event.toolName === "edit" || event.toolName === "write") && event.args?.path) {
      const filePath = String(event.args.path);
      trackedFilesModified.add(filePath);

      // ADR-0204: project-scoped recall on first edit in a new scope
      const scope = detectProjectScope(filePath);
      if (scope && !injectedScopes.has(scope.scope)) {
        injectedScopes.add(scope.scope);
        runRecall(scope.query, 5).then((result) => {
          if (!result || result.hits.length === 0) return;
          const lines = result.hits.slice(0, 3).map((h) => `- ${h.observation.slice(0, 200)}`);
          pi.sendMessage(
            {
              customType: "project-context",
              content: `## Project Context: ${scope.scope}\n${lines.join("\n")}`,
              display: false,
            },
          );
          emitOtel("project.context.injected", {
            scope: scope.scope,
            query: scope.query,
            hitCount: result.hits.length,
          });
        }).catch(() => {});
      }
    }
  });

  // ── turn_end: compaction recovery extraction + checkpoint (ADR-0203) ──

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const usage = ctx.getContextUsage();
      if (!usage?.percent) return;
      const pct = usage.percent;

      // Stage 1: Warm zone (40%+) — query Typesense for relevant memories
      if (pct >= 40) {
        if (!warmZoneEntered) {
          warmZoneEntered = true;
          emitOtel("compaction.extract.warm", { percent: pct });
        }
        // Fire async recall against Typesense (lean budget, ~370ms)
        triggerRecall();
      }

      // Stage 2: Hot zone (60%+) — write task context to memory, re-query if stale
      if (pct >= 60) {
        if (!hotZoneEntered) {
          hotZoneEntered = true;
        }
        writeTaskContextToMemory();
        triggerRecall(); // re-query if user messages changed since last recall
        emitOtel("compaction.extract.hot", {
          percent: pct,
          recallHits: recallCache.reduce((n, r) => n + r.hits.length, 0),
          filesCount: trackedFilesModified.size,
        });
      }
    } catch {
      // Recovery pipeline is best-effort — never crash the session
    }
  });

  // ── session_before_compact: flush to daily log ──────────────

  pi.on("session_before_compact", async (event, ctx) => {
    // ADR-0203: final task context write + OTEL checkpoint
    try {
      const usage = ctx.getContextUsage();
      writeTaskContextToMemory();
      emitOtel("compaction.before", {
        compactionCount,
        contextPercent: usage?.percent ?? null,
        contextTokens: usage?.tokens ?? null,
        contextLimit: usage?.limit ?? null,
        recallCacheSize: recallCache.length,
        recallHits: recallCache.reduce((n, r) => n + r.hits.length, 0),
        filesCount: trackedFilesModified.size,
        userMessageCount,
        timeSinceLastCompactionMs: lastCompactionTs > 0 ? Date.now() - lastCompactionTs : null,
        timeSinceSessionStartMs: Date.now() - sessionStartTime,
      });
    } catch {
      // Best-effort — don't block compaction
    }
    const { preparation } = event;

    const msgCount = preparation.messagesToSummarize?.length || 0;
    const tokensBefore = preparation.tokensBefore || 0;
    const fileOps = preparation.fileOps;
    // fileOps has .read (Set) and .edited (Set), not .readFiles/.modifiedFiles
    const readFiles = fileOps?.read ? [...fileOps.read] : [];
    const modifiedFiles = fileOps?.edited ? [...fileOps.edited] : [];

    const lines = [
      `\n### ⚡ Compaction (${timeStamp()})`,
      `${msgCount} messages summarized, ${tokensBefore.toLocaleString()} tokens reclaimed.`,
    ];

    if (modifiedFiles.length > 0) {
      lines.push(`**Modified**: ${modifiedFiles.join(", ")}`);
    }
    if (readFiles.length > 0) {
      const shown = readFiles.slice(0, 10);
      const more = readFiles.length > 10 ? ` (+${readFiles.length - 10} more)` : "";
      lines.push(`**Read**: ${shown.join(", ")}${more}`);
    }
    if (preparation.previousSummary) {
      // Preserve the gist of what was already summarized
      const gist = preparation.previousSummary.slice(0, 300).replace(/\n/g, " ");
      lines.push(`**Prior context**: ${gist}...`);
    }

    appendToDaily(lines.join("\n") + "\n");

    const maybeGetSessionId = (pi as { getSessionId?: () => string | undefined }).getSessionId;
    const existingSessionId = typeof maybeGetSessionId === "function" ? maybeGetSessionId() : undefined;
    const sessionId = existingSessionId || crypto.randomUUID();
    const dedupeKey = crypto
      .createHash("sha256")
      .update(sessionId + "compaction" + Date.now().toString())
      .digest("hex");
    const messages = JSON.stringify(
      (preparation.messagesToSummarize || []).map((message) => {
        const content = "content" in message
          ? (typeof (message as { content: unknown }).content === "string"
            ? (message as { content: string }).content
            : JSON.stringify((message as { content: unknown }).content))
          : "";
        return { role: message.role, content };
      })
    );

    emitEvent("memory/session.compaction.pending", {
      sessionId,
      dedupeKey,
      trigger: "compaction",
      messages,
      messageCount: preparation.messagesToSummarize?.length || 0,
      tokensBefore: preparation.tokensBefore || 0,
      filesRead: readFiles,
      filesModified: modifiedFiles,
      capturedAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    // Return nothing — let default compaction proceed
  });

  // ── session_compact: pointer injection (ADR-0203 Stage 3) ─────

  pi.on("session_compact", async () => {
    compactionCount++;
    const now = Date.now();
    const isRapidRecompaction = lastCompactionTs > 0 && (now - lastCompactionTs) < COMPACTION_COOLDOWN_MS;
    lastCompactionTs = now;

    // Skip recovery injection on rapid re-compaction — the first compaction's
    // recovery pointers are still in context. Injecting again via sendMessage()
    // queues messages → continue() → model response → _checkCompaction → cascade.
    if (isRapidRecompaction) {
      warmZoneEntered = false;
      hotZoneEntered = false;
      emitOtel("compaction.inject.skipped", { compactionCount, reason: "rapid-recompaction" });
      return;
    }

    try {
      const checkpoint = buildCheckpoint(0); // percent irrelevant post-compaction

      // Build pointer message — signposts + real memories from Typesense
      const lines: string[] = ["## Session Recovery"];

      if (checkpoint.currentTask) {
        lines.push(`**Task:** ${checkpoint.currentTask.slice(0, 200)}`);
      }
      if (checkpoint.filesModified.length > 0) {
        lines.push(`**Modified:** ${checkpoint.filesModified.slice(0, 5).join(", ")}`);
      }
      if (checkpoint.recallHits.length > 0) {
        const hitLines = checkpoint.recallHits.slice(0, 3).map((h) => `- ${h.slice(0, 150)}`);
        lines.push(`**Related memories:**\n${hitLines.join("\n")}`);
      }
      if (checkpoint.recallQueries.length > 0) {
        const qs = checkpoint.recallQueries.map((q) => `\`recall "${q}"\``).join(" or ");
        lines.push(`**Deeper context:** ${qs}`);
      }

      const content = lines.join("\n");

      pi.sendMessage(
        { customType: "compaction-recovery", content, display: false },
      );

      emitOtel("compaction.inject", {
        compactionCount,
        filesCount: checkpoint.filesModified.length,
        recallHitsCount: checkpoint.recallHits.length,
        queriesCount: checkpoint.recallQueries.length,
        contentChars: content.length,
        estimatedTokens: Math.ceil(content.length / 4),
        timeSinceSessionStartMs: Date.now() - sessionStartTime,
      });

      // Reset zone flags for next compaction cycle (context drops back down)
      warmZoneEntered = false;
      hotZoneEntered = false;
    } catch {
      // Best-effort — never crash the session
    }
  });

  // ── session_shutdown: auto-name + handoff ───────────────────

  pi.on("session_shutdown", async () => {
    // Fallback: if agent never called name_session, use first user message
    if (!pi.getSessionName() && firstUserMessage) {
      const autoName = firstUserMessage
        .replace(/\n.*/s, "").slice(0, 60).trim();
      if (autoName) pi.setSessionName(autoName);
    }

    // Write handoff to daily log
    const duration = Math.round((Date.now() - sessionStartTime) / 60000);
    const sessionName =
      pi.getSessionName() || firstUserMessage.slice(0, 60) || "unnamed session";

    const handoff = [
      `\n### 📋 Session ended (${timeStamp()})`,
      `**${sessionName}** — ${duration}min, ${userMessageCount} messages`,
    ];

    appendToDaily(handoff.join("\n") + "\n");

    if (userMessageCount >= 5) {
      const maybeGetSessionId = (pi as { getSessionId?: () => string | undefined }).getSessionId;
      const existingSessionId = typeof maybeGetSessionId === "function" ? maybeGetSessionId() : undefined;
      const sessionId = existingSessionId || crypto.randomUUID();
      const dedupeKey = crypto
        .createHash("sha256")
        .update(sessionId + "shutdown" + Date.now().toString())
        .digest("hex");
      const messages = JSON.stringify({
        note: "Session transcript not available at shutdown — use daily log",
        sessionName,
        duration,
        userMessageCount,
      });

      emitEvent("memory/session.ended", {
        sessionId,
        dedupeKey,
        trigger: "shutdown",
        messages,
        messageCount: userMessageCount,
        userMessageCount,
        duration: duration * 60,
        sessionName,
        filesRead: [],
        filesModified: [],
        capturedAt: new Date().toISOString(),
        schemaVersion: 1,
      });
    }
  });
}
