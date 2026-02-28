/**
 * inbox-watcher — Background agent dispatch + file-based result inbox.
 *
 * Dispatches work to Inngest via system/agent.requested events.
 * Watches ~/.joelclaw/workspace/inbox/ for result files.
 * Shows live status in a compact widget.
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

interface InboxPayload {
  status?: string;
  task?: string;
  result?: string;
  error?: string;
  tool?: string;
  requestId?: string;
  sessionId?: string;
}

type RequestStatus = "dispatched" | "done" | "error";

interface TrackedRequest {
  requestId: string;
  task: string;
  tool: BackgroundTool;
  status: RequestStatus;
  dispatchedAt: number;
  completedAt: number | null;
  result: string | null;
  error: string | null;
}

type BackgroundTool = "codex" | "claude" | "pi";

type ThemeLike = {
  fg: (token: string, text: string) => string;
  bold: (text: string) => string;
};

const HOME = os.homedir();
const INBOX_DIR = path.join(HOME, ".joelclaw", "workspace", "inbox");
const ACK_DIR = path.join(INBOX_DIR, "ack");
const DEFAULT_INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const DEFAULT_INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "37aa349b89692d657d276a40e0e47a15";
const BACKGROUND_TOOLS = ["codex", "claude", "pi"] as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;
const COMPLETED_LINGER_MS = 30_000;

const tracked = new Map<string, TrackedRequest>();
let widgetTui: { requestRender: () => void } | null = null;
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;
let stateVersion = 0;

/** Session-scoped routing state — set on session_start */
let currentSessionId: string | null = null;
let isGatewaySession = false;

let cachedWidgetWidth: number | null = null;
let cachedWidgetVersion = -1;
let cachedWidgetLines: string[] | null = null;

function nowMs(): number {
  return Date.now();
}

function elapsedSecondsSince(ts: number): number {
  return Math.max(0, Math.round((nowMs() - ts) / 1000));
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s}s`;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

function preview(text: unknown, max = 180): string {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return "(no result)";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shortRequestId(requestId: string | undefined): string {
  if (!requestId) return "req_unknown";
  return requestId.slice(0, 12);
}

function invalidateWidgetCache(): void {
  cachedWidgetWidth = null;
  cachedWidgetVersion = -1;
  cachedWidgetLines = null;
}

function bumpState(requestRender = true): void {
  stateVersion += 1;
  invalidateWidgetCache();
  if (requestRender) widgetTui?.requestRender();
}

function visibleRequests(now = nowMs()): TrackedRequest[] {
  return [...tracked.values()].filter((req) => {
    if (req.status === "dispatched") return true;
    if (!req.completedAt) return false;
    return now - req.completedAt <= COMPLETED_LINGER_MS;
  });
}

function countsFor(list: TrackedRequest[]): { running: number; done: number; failed: number } {
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const req of list) {
    if (req.status === "dispatched") running += 1;
    else if (req.status === "done") done += 1;
    else failed += 1;
  }
  return { running, done, failed };
}

function rowPreview(req: TrackedRequest): string {
  if (req.status === "error" && req.error) {
    return firstNonEmptyLine(req.error) || "failed";
  }
  return firstNonEmptyLine(req.task) || "(no task)";
}

function rowIcon(req: TrackedRequest, theme: ThemeLike): string {
  if (req.status === "dispatched") {
    return theme.fg("warning", SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]);
  }
  if (req.status === "done") return theme.fg("success", "✓");
  return theme.fg("error", "✗");
}

function padRight(text: string, width: number): string {
  const delta = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(delta)}`;
}

function padLeft(text: string, width: number): string {
  const delta = Math.max(0, width - visibleWidth(text));
  return `${" ".repeat(delta)}${text}`;
}

function borderTop(width: number, title: string, theme: ThemeLike): string {
  const inner = Math.max(0, width - 2);
  const head = `─ ${title} `;
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(head)));
  const line = `╭${head}${fill}╮`;
  return truncateToWidth(theme.fg("border", line), width);
}

function borderBottom(width: number, summary: string, theme: ThemeLike): string {
  const inner = Math.max(0, width - 2);
  const label = `─ ${summary} `;
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(label)));
  const line = `╰${label}${fill}╯`;
  return truncateToWidth(theme.fg("border", line), width);
}

function wrapBorderRow(innerText: string, width: number, theme: ThemeLike): string {
  const inner = Math.max(0, width - 2);
  const clipped = truncateToWidth(innerText, inner);
  const padded = padRight(clipped, inner);
  const row = `${theme.fg("border", "│")}${padded}${theme.fg("border", "│")}`;
  return truncateToWidth(row, width);
}

function renderTaskRow(req: TrackedRequest, width: number, theme: ThemeLike): string {
  const inner = Math.max(0, width - 2);

  const ridWidth = 12;
  const toolWidth = 6;
  const elapsedWidth = 5;

  const icon = rowIcon(req, theme);
  const rid = theme.fg("text", padRight(shortRequestId(req.requestId), ridWidth));
  const tool = theme.fg("dim", padRight(req.tool, toolWidth));
  const elapsed = theme.fg("muted", padLeft(formatElapsed(elapsedSecondsSince(req.dispatchedAt)), elapsedWidth));

  const fixedPlain = `x ${"x".repeat(ridWidth)} ${"x".repeat(toolWidth)} ${"x".repeat(elapsedWidth)} `;
  const previewWidth = Math.max(0, inner - visibleWidth(fixedPlain));

  const ageSinceComplete = req.completedAt ? nowMs() - req.completedAt : 0;
  const olderDone = req.status !== "dispatched" && ageSinceComplete > COMPLETED_LINGER_MS * 0.66;
  const previewColor = req.status === "error" ? "error" : olderDone ? "dim" : "muted";
  const previewText = theme.fg(previewColor, truncateToWidth(rowPreview(req), previewWidth));

  const composed = `${icon} ${rid} ${tool} ${elapsed} ${previewText}`;
  return wrapBorderRow(composed, width, theme);
}

function renderWidget(theme: ThemeLike, width: number): string[] {
  const w = Math.max(2, width);
  const visible = visibleRequests();
  if (visible.length === 0) return [];

  const sorted = [...visible].sort((a, b) => b.dispatchedAt - a.dispatchedAt);
  const counts = countsFor(sorted);

  const lines: string[] = [];
  lines.push(borderTop(w, theme.fg("accent", "background agents"), theme));

  for (const req of sorted) {
    lines.push(renderTaskRow(req, w, theme));
  }

  const footer = theme.fg(
    "dim",
    `${counts.running} running · ${counts.done} done · ${counts.failed} failed`,
  );
  lines.push(borderBottom(w, footer, theme));

  return lines.map((line) => truncateToWidth(line, width));
}

function renderWidgetCached(theme: ThemeLike, width: number): string[] {
  if (cachedWidgetLines && cachedWidgetWidth === width && cachedWidgetVersion === stateVersion) {
    return cachedWidgetLines;
  }
  const lines = renderWidget(theme, width);
  cachedWidgetLines = lines;
  cachedWidgetWidth = width;
  cachedWidgetVersion = stateVersion;
  return lines;
}

function ensureSpinnerInterval(): void {
  if (spinnerInterval) return;

  spinnerInterval = setInterval(() => {
    const visible = visibleRequests();
    const hasRunning = visible.some((req) => req.status === "dispatched");

    if (visible.length === 0) {
      stopSpinnerInterval();
      bumpState(true);
      return;
    }

    if (hasRunning) {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      bumpState(true);
      return;
    }

    // Keep repainting once per second while only completed linger items are shown.
    const shouldPulse = Math.floor(nowMs() / 1000) !== Math.floor((nowMs() - SPINNER_INTERVAL_MS) / 1000);
    if (shouldPulse) bumpState(true);
  }, SPINNER_INTERVAL_MS);
}

function stopSpinnerInterval(): void {
  if (!spinnerInterval) return;
  clearInterval(spinnerInterval);
  spinnerInterval = null;
}

function ensureDirs(): void {
  try {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.mkdirSync(ACK_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function moveToAck(filename: string): void {
  try {
    fs.renameSync(path.join(INBOX_DIR, filename), path.join(ACK_DIR, filename));
  } catch {
    // ignore
  }
}

function buildResultSummary(req: TrackedRequest | undefined, payload: InboxPayload): {
  status: "completed" | "failed";
  elapsed: string;
  output: string;
} {
  const status: "completed" | "failed" = payload.error ? "failed" : "completed";
  const startedAt = req?.dispatchedAt ?? nowMs();
  const elapsed = formatElapsed(elapsedSecondsSince(startedAt));
  const output = payload.error || payload.result || "";
  return { status, elapsed, output };
}

function processInboxFile(pi: ExtensionAPI, filename: string): void {
  if (!filename.endsWith(".json")) return;
  const filePath = path.join(INBOX_DIR, filename);

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  let payload: InboxPayload;
  try {
    payload = JSON.parse(raw) as InboxPayload;
  } catch {
    return;
  }

  // ── Session routing: only deliver to the session that dispatched ──
  // If payload has a sessionId, only the matching session picks it up.
  // If payload has no sessionId (Inngest-originated), only gateway picks it up.
  // Locally-tracked requests (dispatched from THIS session) always deliver.
  const trackedReq = payload.requestId ? tracked.get(payload.requestId) : undefined;
  const isLocallyTracked = !!trackedReq;

  if (!isLocallyTracked) {
    const payloadSessionId = payload.sessionId;
    if (payloadSessionId) {
      // Has a sessionId — only deliver to matching session
      if (payloadSessionId !== currentSessionId) return;
    } else {
      // No sessionId (Inngest dispatch) — only gateway picks it up
      if (!isGatewaySession) return;
    }
  }

  if (payload.requestId && trackedReq) {
    trackedReq.status = payload.error ? "error" : "done";
    trackedReq.completedAt = nowMs();
    trackedReq.result = payload.result || null;
    trackedReq.error = payload.error || null;
    bumpState(true);
    ensureSpinnerInterval();
  }

  const summary = buildResultSummary(trackedReq, payload);
  const rid = shortRequestId(payload.requestId);
  const task = payload.task || trackedReq?.task || "(no task)";
  const tool = payload.tool || trackedReq?.tool || "pi";

  pi.sendMessage(
    {
      customType: "background-result",
      content: `${summary.status === "failed" ? "Failed" : "Completed"} ${rid} (${tool}) in ${summary.elapsed}\nTask: ${task}\nResult: ${preview(summary.output)}`,
      display: false,
      details: {
        requestId: payload.requestId,
        status: summary.status,
        task,
        tool,
        elapsed: summary.elapsed,
        result: summary.output,
      },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );

  moveToAck(filename);
}

function inngestEventUrl(): string {
  return `${DEFAULT_INNGEST_URL.replace(/\/+$/, "")}/e/${DEFAULT_INNGEST_EVENT_KEY}`;
}

function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 21)}`;
}

function extractSessionId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;

  const fromCtx = (ctx as { sessionId?: unknown }).sessionId;
  if (typeof fromCtx === "string" && fromCtx.trim()) return fromCtx.trim();

  const sessionManager = (ctx as { sessionManager?: { getSessionName?: () => string } }).sessionManager;
  if (sessionManager?.getSessionName) {
    try {
      const value = sessionManager.getSessionName();
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // ignore
    }
  }

  return undefined;
}

function renderResultHeader(
  reqId: string,
  tool: string,
  status: "dispatched" | "completed" | "failed",
  elapsed: string,
  theme: ThemeLike,
): string {
  const icon =
    status === "dispatched"
      ? theme.fg("warning", SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length])
      : status === "completed"
        ? theme.fg("success", "✓")
        : theme.fg("error", "✗");

  const statusColor = status === "failed" ? "error" : "dim";
  return `${icon} ${theme.fg("text", shortRequestId(reqId))}  ${theme.fg("dim", tool)}  ${theme.fg(statusColor, status)}  ${theme.fg("muted", elapsed)}`;
}

function makeBorderedBlock(text: string, width: number, theme: ThemeLike): string[] {
  const w = Math.max(2, width);
  const inner = Math.max(0, w - 2);
  const lines = text.split("\n");

  const out: string[] = [];
  out.push(theme.fg("border", `╭${"─".repeat(inner)}╮`));
  for (const raw of lines) {
    const clipped = truncateToWidth(raw, inner);
    const padded = padRight(clipped, inner);
    out.push(`${theme.fg("border", "│")}${theme.fg("muted", padded)}${theme.fg("border", "│")}`);
  }
  out.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
  return out;
}

export default function (pi: ExtensionAPI) {
  let watcher: fs.FSWatcher | null = null;

  pi.on("session_start", async (_event, ctx) => {
    // Capture session identity for inbox routing
    try {
      currentSessionId = ctx.sessionManager.getSessionId() ?? null;
    } catch {
      currentSessionId = null;
    }
    isGatewaySession = process.env.GATEWAY_ROLE === "central";
    ctx.ui.setWidget("background-agents", (tui, theme) => {
      widgetTui = tui;
      return {
        render: (width: number) => renderWidgetCached(theme as ThemeLike, width),
        invalidate: () => {
          invalidateWidgetCache();
        },
        dispose: () => {
          stopSpinnerInterval();
          widgetTui = null;
          invalidateWidgetCache();
        },
      };
    });

    ensureDirs();

    try {
      for (const filename of fs.readdirSync(INBOX_DIR)) {
        processInboxFile(pi, filename);
      }
    } catch {
      // ignore
    }

    if (!watcher) {
      try {
        watcher = fs.watch(INBOX_DIR, (eventType, filename) => {
          if (eventType !== "rename") return;
          const name = filename?.toString();
          if (!name?.endsWith(".json")) return;
          processInboxFile(pi, name);
        });
      } catch {
        // ignore
      }
    }

    ensureSpinnerInterval();
  });

  pi.on("session_shutdown", () => {
    stopSpinnerInterval();
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      watcher = null;
    }
  });

  pi.registerTool({
    name: "background_agent",
    label: "Background Agent",
    description: "Dispatch background work by sending system/agent.requested to Inngest and returning immediately.",
    parameters: Type.Object({
      task: Type.String({ description: "Task prompt for the background agent." }),
      tool: Type.Optional(StringEnum(BACKGROUND_TOOLS, { default: "codex" })),
      cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 600).", default: 600 })),
      model: Type.Optional(Type.String({ description: "Optional model override for the target agent." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const task = params.task?.trim();
      if (!task) {
        return {
          content: [{ type: "text", text: "background_agent: `task` is required." }],
          isError: true,
          details: undefined,
        };
      }

      const tool = (params.tool || "codex") as BackgroundTool;
      const timeout = params.timeout ?? 600;
      const requestId = generateRequestId();
      const sessionId = extractSessionId(ctx);
      const cwd = params.cwd?.trim() || (ctx as { cwd?: string }).cwd || undefined;
      const model = params.model?.trim() || undefined;

      tracked.set(requestId, {
        requestId,
        task,
        tool,
        status: "dispatched",
        dispatchedAt: nowMs(),
        completedAt: null,
        result: null,
        error: null,
      });

      ensureSpinnerInterval();
      bumpState(true);

      const data: Record<string, unknown> = { requestId, task, tool, timeout };
      if (cwd) data.cwd = cwd;
      if (model) data.model = model;
      if (sessionId) data.sessionId = sessionId;

      fetch(inngestEventUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "system/agent.requested", data }),
      }).catch(() => {
        // background dispatch failures are reflected by timeout/error downstream
      });

      return {
        content: [{ type: "text", text: `Dispatched ${shortRequestId(requestId)} (${tool}). Status in widget.` }],
        details: { requestId, tool, task },
      };
    },

    renderCall(args, theme) {
      const tool = args.tool || "codex";
      const reqId = shortRequestId((args as any).requestId || "");
      const top =
        theme.fg("toolTitle", theme.bold("◆ background_agent")) +
        "  " +
        theme.fg("dim", `${tool} · `) +
        theme.fg("muted", reqId);
      const taskLine = truncateToWidth((args.task || "").trim(), 90);
      const body = theme.fg("dim", `  ${taskLine || "(no task)"}`);
      return new Text(`${top}\n${body}`, 0, 0);
    },

    renderResult(result, options, theme) {
      const details = (result.details || {}) as {
        requestId?: string;
        tool?: string;
      };

      const requestId = details.requestId;
      if (!requestId) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      const trackedReq = tracked.get(requestId);
      const status: "dispatched" | "completed" | "failed" =
        !trackedReq || trackedReq.status === "dispatched"
          ? "dispatched"
          : trackedReq.status === "done"
            ? "completed"
            : "failed";

      const elapsed = trackedReq
        ? formatElapsed(elapsedSecondsSince(trackedReq.dispatchedAt))
        : "0s";

      const header = renderResultHeader(
        requestId,
        details.tool || trackedReq?.tool || "pi",
        status,
        elapsed,
        theme as ThemeLike,
      );

      const expandedBody = trackedReq?.error || trackedReq?.result;
      if (options.expanded && expandedBody) {
        const block = expandedBody.length > 500 ? `${expandedBody.slice(0, 500)}…` : expandedBody;
        return new Text(`${header}\n${theme.fg("muted", block)}`, 0, 0);
      }

      return new Text(header, 0, 0);
    },
  });

  pi.registerMessageRenderer<any>("background-result", (message, { expanded }, theme) => {
    const d = message.details as
      | {
          requestId?: string;
          tool?: string;
          status?: "completed" | "failed";
          elapsed?: string;
          task?: string;
          result?: string;
        }
      | undefined;

    if (!d) return undefined;

    const requestId = d.requestId || "req_unknown";
    const tool = d.tool || "pi";
    const status = d.status === "failed" ? "failed" : "completed";
    const elapsed = d.elapsed || "0s";

    const icon = status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const head = `${icon} ${theme.fg("text", shortRequestId(requestId))}  ${theme.fg("dim", tool)}  ${theme.fg(status === "failed" ? "error" : "dim", status)}  ${theme.fg("muted", elapsed)}`;

    if (!expanded) {
      const collapsedPreviewSource = d.status === "failed" ? d.result || d.task || "" : d.task || d.result || "";
      const collapsedPreview = firstNonEmptyLine(collapsedPreviewSource);
      const shortPreview = truncateToWidth(collapsedPreview || "(no details)", 40);
      return new Text(`${head}  ${theme.fg("muted", shortPreview)}`, 0, 0);
    }

    const full = d.result?.trim() || "(no result)";
    return {
      render: (width: number) => {
        const w = Math.max(2, width);
        const lines: string[] = [truncateToWidth(head, w)];
        lines.push(...makeBorderedBlock(full, w, theme as ThemeLike).map((line) => truncateToWidth(line, w)));
        return lines;
      },
      invalidate: () => {},
    };
  });
}
