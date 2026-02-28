// Session Lifecycle - auto-briefing, pre-compaction flush, shutdown handoff, session naming.
//
// Eliminates manual continuation prompts by automatically injecting
// system context at session start, preserving key context before
// compaction, and writing handoff notes on session end.
//
// Hooks:
//   session_start          - initialize session tracking state
//   before_agent_start     - inject briefing (first turn) + system prompt awareness (every turn)
//   session_before_compact - flush metadata to daily log before summarization
//   session_shutdown       - auto-name session, write handoff to daily log
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

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Paths ───────────────────────────────────────────────────────────

const HOME = os.homedir();
const VAULT = path.join(HOME, "Vault");
const MEMORY_MD = path.join(HOME, ".joelclaw", "workspace", "MEMORY.md");
const MEMORY_DIR = path.join(HOME, ".joelclaw", "workspace", "memory");
const SLOG_PATH = path.join(VAULT, "system", "system-log.jsonl");
const PROJECTS_DIR = path.join(VAULT, "Projects");

// ── Helpers ─────────────────────────────────────────────────────────

function readSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
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
  // Reads keys from ~/.config/inngest/env (created during Inngest setup).
  // Falls back silently if Inngest isn't running — events are best-effort.
  const envPath = path.join(os.homedir(), ".config/inngest/env");
  let eventKey = process.env.INNGEST_EVENT_KEY || "";
  const baseUrl = process.env.INNGEST_BASE_URL || "http://localhost:8288";

  if (!eventKey) {
    try {
      const envContent = fs.readFileSync(envPath, "utf-8");
      const match = envContent.match(/INNGEST_EVENT_KEY=(\S+)/);
      if (match) eventKey = match[1];
    } catch {}
  }

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
      return {
        systemPrompt,
        message: {
          customType: "slog-nudge",
          content:
            "🪵 BEFORE your final response: Did you install, configure, fix, remove, or change any tool/service/infra this turn? If yes → `slog write` NOW, not later. The user should never have to remind you. If NOTHING changed (no installs, no config, no fixes, no infra) → do NOT mention slog at all. No \"no slog needed\" or \"no infra changed\" filler.\n📐 joelclaw work should be backed by an ADR. If there isn't one, ask why. Keep ADRs groomed — update status, mark superseded, close what's done.\n📋 For non-trivial tasks: ack and summarize your plan BEFORE starting work, then pause ~10 seconds for a possible course-correction. This is NOT a permission gate — proceed after the pause. It's just a window for Joel to intervene if the direction is wrong. Trivial tasks (quick lookups, small edits) don't need this.",
          display: false,
        },
      };
    }
    hasBriefed = true;

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

  // ── session_before_compact: flush to daily log ──────────────

  pi.on("session_before_compact", async (event) => {
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
