import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";

// ── Config ─────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_S = 300;
const DEFAULT_RUNTIME_MONITOR_INTERVAL_S = 5;
const DEFAULT_RUNTIME_MONITOR_TIMEOUT_S = 0;
const DEFAULT_JOBS_LOOKBACK_HOURS = 1;
const DEFAULT_JOBS_RUN_COUNT = 10;
const COMPLETED_LINGER_MS = 15_000;
const WIDGET_KEY = "job-monitor";
const OTEL_SOURCE = "gateway";
const OTEL_COMPONENT = "job-monitor";

// ── Types ──────────────────────────────────────────────

type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout";
const TERMINAL: Set<RunStatus> = new Set(["completed", "failed", "cancelled", "timeout"]);

type MonitorSeverity = "healthy" | "degraded" | "down";
type RuntimeMonitorStatus = MonitorSeverity | "starting" | "stopped" | "timeout";
const RUNTIME_TERMINAL: Set<RuntimeMonitorStatus> = new Set(["stopped", "timeout"]);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface TrackedRun {
  runId: string;
  eventName: string;
  functionName: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  currentStep: string | null;
  stepCount: number;
  error: string | null;
  output: string | null;
}

interface RunSnapshot {
  [key: string]: JsonValue;
  runId: string;
  eventName: string;
  functionName: string;
  status: RunStatus;
  elapsedMs: number;
  currentStep: string | null;
  stepCount: number;
  error: string | null;
  output: string | null;
}

interface RuntimeJobsSnapshot {
  [key: string]: JsonValue;
  checkedAt?: string;
  overall?: {
    status?: string;
    summary?: string;
  };
  queue?: {
    status?: string;
    depth?: number;
    activePauses?: Array<{ family?: string }>;
  };
  restate?: { status?: string };
  dkron?: { status?: string };
  inngest?: {
    status?: string;
    recentRuns?: {
      count?: number;
      byStatus?: Record<string, number>;
    };
  };
}

interface RuntimeMonitorState {
  monitorId: string;
  status: RuntimeMonitorStatus;
  startedAt: number;
  finishedAt: number | null;
  intervalMs: number;
  timeoutMs: number;
  reportBack: boolean;
  snapshot: RuntimeJobsSnapshot | null;
  error: string | null;
  lastReportedStatus: RuntimeMonitorStatus | null;
}

interface RuntimeMonitorSnapshot {
  [key: string]: JsonValue;
  monitorId: string;
  status: RuntimeMonitorStatus;
  elapsedMs: number;
  checkedAt: string | null;
  summary: string;
  queueDepth: number;
  activePauseCount: number;
  restateStatus: string;
  dkronStatus: string;
  inngestStatus: string;
  reportBack: boolean;
  pollSeconds: number;
  error: string | null;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: JsonValue | undefined;
};

// ── CLI helpers ────────────────────────────────────────

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("joelclaw", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout, stderr: err.message, code: 1 }));
  });
}

function parseJson(raw: string): any {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.result ?? parsed;
  } catch {
    return null;
  }
}

async function emitOtel(
  action: string,
  metadata: Record<string, unknown>,
  options: { level?: "info" | "warn" | "error"; success?: boolean; error?: string | null } = {},
): Promise<void> {
  const args = [
    "otel",
    "emit",
    action,
    "--source",
    OTEL_SOURCE,
    "--component",
    OTEL_COMPONENT,
    "--success",
    options.success === false ? "false" : "true",
    "--level",
    options.level ?? "info",
    "--metadata",
    JSON.stringify(metadata),
  ];

  if (options.error) {
    args.push("--error", options.error);
  }

  await runCli(args);
}

// ── Formatting ─────────────────────────────────────────

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function snipError(e: string | null): string {
  if (!e) return "unknown error";
  const c = e.replace(/\s+/g, " ").trim();
  return c.length > 70 ? c.slice(0, 67) + "…" : c;
}

function snipSummary(summary: string | null | undefined, max = 120): string {
  if (!summary) return "waiting for first snapshot…";
  const compact = summary.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function snapshot(run: TrackedRun): RunSnapshot {
  return {
    runId: run.runId,
    eventName: run.eventName,
    functionName: run.functionName,
    status: run.status,
    elapsedMs: (run.finishedAt ?? Date.now()) - run.startedAt,
    currentStep: run.currentStep,
    stepCount: run.stepCount,
    error: run.error,
    output: run.output,
  };
}

function normalizeMonitorSeverity(value: unknown): MonitorSeverity {
  return value === "down" || value === "degraded" ? value : "healthy";
}

function runtimeStatusIcon(status: RuntimeMonitorStatus): string {
  if (status === "healthy") return "●";
  if (status === "degraded") return "◐";
  if (status === "down") return "✗";
  if (status === "timeout") return "◌";
  if (status === "stopped") return "◦";
  return "◆";
}

function runtimeStatusColor(status: RuntimeMonitorStatus): "success" | "warning" | "error" | "muted" {
  if (status === "healthy") return "success";
  if (status === "degraded") return "warning";
  if (status === "down" || status === "timeout") return "error";
  return "muted";
}

function runtimeMonitorSnapshot(state: RuntimeMonitorState): RuntimeMonitorSnapshot {
  const overall = state.snapshot?.overall;
  const queue = state.snapshot?.queue;
  const inngest = state.snapshot?.inngest;
  return {
    monitorId: state.monitorId,
    status: state.status,
    elapsedMs: (state.finishedAt ?? Date.now()) - state.startedAt,
    checkedAt: typeof state.snapshot?.checkedAt === "string" ? state.snapshot.checkedAt : null,
    summary: snipSummary(typeof overall?.summary === "string" ? overall.summary : state.error),
    queueDepth: typeof queue?.depth === "number" ? queue.depth : 0,
    activePauseCount: Array.isArray(queue?.activePauses) ? queue.activePauses.length : 0,
    restateStatus: typeof state.snapshot?.restate?.status === "string" ? state.snapshot.restate.status : "unknown",
    dkronStatus: typeof state.snapshot?.dkron?.status === "string" ? state.snapshot.dkron.status : "unknown",
    inngestStatus: typeof inngest?.status === "string" ? inngest.status : "unknown",
    reportBack: state.reportBack,
    pollSeconds: Math.max(1, Math.round(state.intervalMs / 1000)),
    error: state.error,
  };
}

// ── Extension ──────────────────────────────────────────

export default function jobMonitor(pi: ExtensionAPI) {
  const runs = new Map<string, TrackedRun>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const lingerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let runtimeMonitor: RuntimeMonitorState | null = null;
  let runtimeTimer: ReturnType<typeof setInterval> | null = null;
  let runtimeLingerTimer: ReturnType<typeof setTimeout> | null = null;
  let widgetTui: { requestRender(): void } | null = null;

  // ── Widget ───────────────────────────────────────────

  const refreshWidget = () => widgetTui?.requestRender();

  const renderRuntimeWidget = (theme: any, now: number): string[] => {
    if (!runtimeMonitor) return [];
    if (RUNTIME_TERMINAL.has(runtimeMonitor.status)) {
      const finishedAt = runtimeMonitor.finishedAt;
      if (!finishedAt || now - finishedAt >= COMPLETED_LINGER_MS) return [];
    }

    const snap = runtimeMonitorSnapshot(runtimeMonitor);
    const icon = runtimeStatusIcon(runtimeMonitor.status);
    const color = runtimeStatusColor(runtimeMonitor.status);
    const head = `${theme.fg(color, icon)} ${theme.fg("accent", "jobs")}`
      + ` ${theme.fg("muted", runtimeMonitor.status)}`
      + ` ${theme.fg("dim", `${fmtElapsed(snap.elapsedMs)} · ${snap.pollSeconds}s poll`)}`;
    const metrics = [
      `queue ${snap.queueDepth}`,
      `pauses ${snap.activePauseCount}`,
      `restate ${snap.restateStatus}`,
      `dkron ${snap.dkronStatus}`,
      `inngest ${snap.inngestStatus}`,
    ].join(" · ");

    return [
      `${theme.fg("borderAccent", "╭─")} ${head}`,
      `${theme.fg("borderMuted", "│")} ${theme.fg("muted", metrics)}`,
      `${theme.fg("borderMuted", "│")} ${theme.fg(color, snipSummary(snap.summary))}`,
      `${theme.fg("borderAccent", "╰─")} ${theme.fg("dim", snap.checkedAt ?? "waiting for first snapshot…")}`,
    ];
  };

  const renderRunLines = (theme: any, now: number): string[] => {
    const visible = [...runs.values()].filter((r) => {
      if (!TERMINAL.has(r.status)) return true;
      return r.finishedAt ? now - r.finishedAt < COMPLETED_LINGER_MS : false;
    });

    return visible.map((r) => {
      const elapsed = fmtElapsed((r.finishedAt ?? now) - r.startedAt);
      if (r.status === "completed") {
        return `${theme.fg("success", "✓")} ${theme.fg("text", r.functionName)} ${theme.fg("dim", `${elapsed} · ${r.stepCount} steps`)}`;
      }
      if (r.status === "failed" || r.status === "timeout") {
        return `${theme.fg("error", "✗")} ${theme.fg("text", r.functionName)} ${theme.fg("dim", elapsed)} ${theme.fg("error", snipError(r.error))}`;
      }
      if (r.status === "cancelled") {
        return `${theme.fg("warning", "◌")} ${theme.fg("text", r.functionName)} ${theme.fg("dim", elapsed)} ${theme.fg("warning", "cancelled")}`;
      }
      const step = r.currentStep ? `step: ${r.currentStep}` : "starting…";
      return `${theme.fg("warning", "◆")} ${theme.fg("text", r.functionName)} ${theme.fg("dim", elapsed)} ${theme.fg("muted", step)}`;
    });
  };

  const renderWidget = (theme: any): string[] => {
    const now = Date.now();
    const runtimeLines = renderRuntimeWidget(theme, now);
    const runLines = renderRunLines(theme, now);
    if (runtimeLines.length === 0 && runLines.length === 0) return [];
    if (runtimeLines.length > 0 && runLines.length > 0) {
      return [...runtimeLines, theme.fg("dim", ""), ...runLines];
    }
    return [...runtimeLines, ...runLines];
  };

  // ── Inngest run polling ──────────────────────────────

  async function pollRun(run: TrackedRun, timeoutS: number): Promise<void> {
    if (TERMINAL.has(run.status)) return;

    if (Date.now() - run.startedAt > timeoutS * 1000) {
      run.error = `Timed out after ${timeoutS}s`;
      finishRun(run, "timeout");
      return;
    }

    const { stdout, code } = await runCli(["run", run.runId]);
    if (code !== 0) {
      refreshWidget();
      return;
    }
    const data = parseJson(stdout);
    if (!data?.run) {
      refreshWidget();
      return;
    }

    const apiStatus: string = data.run.status ?? "";
    if (apiStatus === "COMPLETED") {
      run.functionName = data.run.functionName || run.functionName;
      run.output = typeof data.run.output === "string" ? data.run.output : JSON.stringify(data.run.output ?? null);
      run.stepCount = countSteps(data.trace);
      finishRun(run, "completed");
    } else if (apiStatus === "FAILED") {
      run.functionName = data.run.functionName || run.functionName;
      run.error = extractError(data);
      run.stepCount = countSteps(data.trace);
      finishRun(run, "failed");
    } else if (apiStatus === "CANCELLED") {
      run.functionName = data.run.functionName || run.functionName;
      finishRun(run, "cancelled");
    } else {
      run.functionName = data.run.functionName || run.functionName;
      run.status = apiStatus === "RUNNING" ? "running" : "queued";
      run.currentStep = findCurrentStep(data.trace);
      run.stepCount = countSteps(data.trace);
      refreshWidget();
    }
  }

  function finishRun(run: TrackedRun, status: RunStatus): void {
    run.status = status;
    run.finishedAt = Date.now();
    stopPolling(run.runId);
    refreshWidget();
    sendRunMessage(run);

    lingerTimers.set(
      run.runId,
      setTimeout(() => {
        lingerTimers.delete(run.runId);
        runs.delete(run.runId);
        refreshWidget();
      }, COMPLETED_LINGER_MS),
    );
  }

  function startPolling(run: TrackedRun, timeoutS: number): void {
    timers.set(
      run.runId,
      setInterval(() => void pollRun(run, timeoutS), POLL_INTERVAL_MS),
    );
    void pollRun(run, timeoutS);
  }

  function stopPolling(runId: string): void {
    const t = timers.get(runId);
    if (t) {
      clearInterval(t);
      timers.delete(runId);
    }
  }

  // ── Runtime monitor polling ──────────────────────────

  function sendRuntimeMessage(state: RuntimeMonitorState, reason: "started" | "state_changed" | "stopped" | "timeout"): void {
    if (!state.reportBack) return;
    const snap = runtimeMonitorSnapshot(state);
    const icon = runtimeStatusIcon(state.status);
    const text = `${icon} jobs ${state.status} · ${snap.summary}`;
    const triggerTurn = state.status !== "healthy" || reason === "timeout" || reason === "state_changed";

    pi.sendMessage(
      { customType: "runtime-jobs-monitor-update", content: text, display: false, details: { ...snap, reason } },
      { triggerTurn, deliverAs: "followUp" },
    );
  }

  async function stopRuntimeMonitor(status: RuntimeMonitorStatus, error?: string | null): Promise<void> {
    if (!runtimeMonitor) return;
    if (runtimeTimer) {
      clearInterval(runtimeTimer);
      runtimeTimer = null;
    }
    runtimeMonitor.status = status;
    runtimeMonitor.error = error ?? runtimeMonitor.error;
    runtimeMonitor.finishedAt = Date.now();
    refreshWidget();

    await emitOtel(
      status === "timeout" ? "runtime.monitor.timeout" : "runtime.monitor.stopped",
      runtimeMonitorSnapshot(runtimeMonitor),
      {
        level: status === "timeout" ? "warn" : "info",
        success: status !== "timeout",
        error: runtimeMonitor.error,
      },
    );

    sendRuntimeMessage(runtimeMonitor, status === "timeout" ? "timeout" : "stopped");

    if (runtimeLingerTimer) clearTimeout(runtimeLingerTimer);
    runtimeLingerTimer = setTimeout(() => {
      runtimeLingerTimer = null;
      runtimeMonitor = null;
      refreshWidget();
    }, COMPLETED_LINGER_MS);
  }

  async function pollRuntimeMonitor(): Promise<void> {
    if (!runtimeMonitor || RUNTIME_TERMINAL.has(runtimeMonitor.status)) return;

    const monitorId = runtimeMonitor.monitorId;

    if (runtimeMonitor.timeoutMs > 0 && Date.now() - runtimeMonitor.startedAt > runtimeMonitor.timeoutMs) {
      await stopRuntimeMonitor("timeout", `Timed out after ${Math.round(runtimeMonitor.timeoutMs / 1000)}s`);
      return;
    }

    const { stdout, stderr, code } = await runCli([
      "jobs",
      "status",
      "--hours",
      String(DEFAULT_JOBS_LOOKBACK_HOURS),
      "--count",
      String(DEFAULT_JOBS_RUN_COUNT),
    ]);

    if (!runtimeMonitor || runtimeMonitor.monitorId !== monitorId || RUNTIME_TERMINAL.has(runtimeMonitor.status)) {
      return;
    }

    if (code !== 0) {
      const previous = runtimeMonitor.status;
      runtimeMonitor.status = "down";
      runtimeMonitor.error = stderr || stdout || "joelclaw jobs status failed";
      refreshWidget();
      if (previous !== runtimeMonitor.status) {
        await emitOtel("runtime.monitor.state_changed", runtimeMonitorSnapshot(runtimeMonitor), {
          level: "error",
          success: false,
          error: runtimeMonitor.error,
        });
        sendRuntimeMessage(runtimeMonitor, "state_changed");
      }
      return;
    }

    const data = parseJson(stdout) as RuntimeJobsSnapshot | null;
    if (!runtimeMonitor || runtimeMonitor.monitorId !== monitorId || RUNTIME_TERMINAL.has(runtimeMonitor.status)) {
      return;
    }

    if (!data?.overall) {
      const previous = runtimeMonitor.status;
      runtimeMonitor.status = "down";
      runtimeMonitor.error = "jobs status returned no overall payload";
      refreshWidget();
      if (previous !== runtimeMonitor.status) {
        await emitOtel("runtime.monitor.state_changed", runtimeMonitorSnapshot(runtimeMonitor), {
          level: "error",
          success: false,
          error: runtimeMonitor.error,
        });
        sendRuntimeMessage(runtimeMonitor, "state_changed");
      }
      return;
    }

    const nextStatus = normalizeMonitorSeverity(data.overall.status);
    const previous = runtimeMonitor.status;
    runtimeMonitor.snapshot = data;
    runtimeMonitor.status = nextStatus;
    runtimeMonitor.error = null;
    refreshWidget();

    if (runtimeMonitor.lastReportedStatus === null) {
      runtimeMonitor.lastReportedStatus = nextStatus;
      await emitOtel("runtime.monitor.started", runtimeMonitorSnapshot(runtimeMonitor), {
        level: nextStatus === "healthy" ? "info" : nextStatus === "degraded" ? "warn" : "error",
        success: nextStatus === "healthy",
      });
      if (nextStatus !== "healthy") {
        sendRuntimeMessage(runtimeMonitor, "started");
      }
      return;
    }

    if (previous !== nextStatus) {
      runtimeMonitor.lastReportedStatus = nextStatus;
      await emitOtel("runtime.monitor.state_changed", runtimeMonitorSnapshot(runtimeMonitor), {
        level: nextStatus === "healthy" ? "info" : nextStatus === "degraded" ? "warn" : "error",
        success: nextStatus === "healthy",
      });
      sendRuntimeMessage(runtimeMonitor, "state_changed");
    }
  }

  function startRuntimeMonitor(intervalS: number, timeoutS: number, reportBack: boolean): RuntimeMonitorState {
    if (runtimeLingerTimer) {
      clearTimeout(runtimeLingerTimer);
      runtimeLingerTimer = null;
    }
    if (runtimeTimer) {
      clearInterval(runtimeTimer);
      runtimeTimer = null;
    }

    runtimeMonitor = {
      monitorId: randomUUID(),
      status: "starting",
      startedAt: Date.now(),
      finishedAt: null,
      intervalMs: Math.max(1, intervalS) * 1000,
      timeoutMs: timeoutS > 0 ? timeoutS * 1000 : 0,
      reportBack,
      snapshot: null,
      error: null,
      lastReportedStatus: null,
    };

    runtimeTimer = setInterval(() => void pollRuntimeMonitor(), runtimeMonitor.intervalMs);
    void pollRuntimeMonitor();
    refreshWidget();
    return runtimeMonitor;
  }

  // ── Trace helpers ────────────────────────────────────

  function flattenSpans(span: any): any[] {
    if (!span) return [];
    const out: any[] = [];
    const visit = (s: any) => {
      if (!s.isRoot && s.name) out.push(s);
      for (const c of s.childrenSpans ?? []) visit(c);
    };
    if (span.isRoot) {
      for (const c of span.childrenSpans ?? []) visit(c);
    } else {
      visit(span);
    }
    return out;
  }

  function countSteps(trace: any): number {
    return flattenSpans(trace).length;
  }

  function findCurrentStep(trace: any): string | null {
    const spans = flattenSpans(trace);
    const active = spans.find((s) => s.status === "RUNNING" || s.status === "QUEUED");
    if (active) return active.name ?? active.stepID ?? null;
    const completed = spans.filter((s) => s.status === "COMPLETED");
    return completed.length > 0 ? (completed[completed.length - 1].name ?? null) : null;
  }

  function extractError(data: any): string | null {
    if (data.errors) {
      for (const key of Object.keys(data.errors)) {
        const e = data.errors[key]?.error;
        if (e?.message) return e.message;
      }
    }
    if (data.run?.output) return typeof data.run.output === "string" ? data.run.output : JSON.stringify(data.run.output);
    return null;
  }

  // ── Messages ─────────────────────────────────────────

  function sendRunMessage(run: TrackedRun): void {
    const snap = snapshot(run);
    const isError = run.status === "failed" || run.status === "timeout";
    const hasOtherPolling = [...timers.keys()].some((id) => id !== run.runId);
    const icon = run.status === "completed" ? "✓" : "✗";
    const text = `${icon} ${run.functionName} ${run.status} in ${fmtElapsed(snap.elapsedMs)}`;

    pi.sendMessage(
      { customType: "inngest-run-complete", content: text, display: false, details: snap },
      { triggerTurn: isError || !hasOtherPolling, deliverAs: "followUp" },
    );
  }

  // ── Lifecycle ────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        widgetTui = tui;
        return {
          render: () => renderWidget(theme),
          invalidate: () => {},
          dispose: () => { widgetTui = null; },
        };
      });
    }
  });

  pi.on("session_shutdown", async () => {
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
    for (const t of lingerTimers.values()) clearTimeout(t);
    lingerTimers.clear();
    runs.clear();
    if (runtimeTimer) clearInterval(runtimeTimer);
    runtimeTimer = null;
    if (runtimeLingerTimer) clearTimeout(runtimeLingerTimer);
    runtimeLingerTimer = null;
    runtimeMonitor = null;
  });

  // ── inngest_send ─────────────────────────────────────

  pi.registerTool({
    name: "inngest_send",
    label: "Inngest Send",
    description:
      "Send an Inngest event and optionally monitor created runs. " +
      "Returns immediately with a task ID. The result is reported back automatically when the task finishes. " +
      "Use inngest_runs to check status of running tasks.",
    parameters: Type.Object({
      event: Type.String({ description: 'Event name, e.g. "video/download"' }),
      data: Type.Optional(Type.String({ description: "JSON data payload. Defaults to {}" })),
      follow: Type.Optional(Type.Boolean({ description: "Follow run lifecycle. Defaults to true" })),
      timeout: Type.Optional(Type.Number({ description: "Follow timeout in seconds. Defaults to 300" })),
    }),

    async execute(_toolCallId, params): Promise<ToolResult> {
      const follow = params.follow ?? true;
      const timeoutS = params.timeout ?? DEFAULT_TIMEOUT_S;

      if (params.data) {
        try { JSON.parse(params.data); } catch {
          return { content: [{ type: "text", text: `Invalid JSON: ${params.data}` }], details: undefined };
        }
      }

      const args = ["send", params.event];
      if (params.data) args.push("-d", params.data);
      const { stdout, stderr, code } = await runCli(args);

      if (code !== 0) {
        return {
          content: [{ type: "text", text: `joelclaw send failed (exit ${code}): ${stderr || stdout}` }],
          details: undefined,
        };
      }

      const result = parseJson(stdout);
      const eventIds: string[] = result?.response?.ids ?? result?.ids ?? [];
      const eventId = eventIds[0];

      if (!eventId) {
        return {
          content: [{ type: "text", text: `Sent ${params.event} (no event ID returned)` }],
          details: undefined,
        };
      }

      if (!follow) {
        return {
          content: [{ type: "text", text: `Sent ${params.event} → event ${eventId}` }],
          details: { event: params.event, eventId, follow: false },
        };
      }

      const resolveRuns = async (retries = 3): Promise<string[]> => {
        for (let i = 0; i < retries; i++) {
          const { stdout: evOut } = await runCli(["event", eventId]);
          const evData = parseJson(evOut);
          const runList: any[] = evData?.runs ?? [];
          if (runList.length > 0) return runList.map((r: any) => r.id);
          if (i < retries - 1) await new Promise((r) => setTimeout(r, 1500));
        }
        return [];
      };

      const runIds = await resolveRuns();

      for (const runId of runIds) {
        const run: TrackedRun = {
          runId,
          eventName: params.event,
          functionName: "(resolving)",
          status: "queued",
          startedAt: Date.now(),
          finishedAt: null,
          currentStep: null,
          stepCount: 0,
          error: null,
          output: null,
        };
        runs.set(runId, run);
        startPolling(run, timeoutS);
      }
      refreshWidget();

      const text = runIds.length > 0
        ? `Sent ${params.event} → ${runIds.length} run${runIds.length === 1 ? "" : "s"} (monitoring)`
        : `Sent ${params.event} → event ${eventId} (no runs triggered)`;

      return {
        content: [{ type: "text", text }],
        details: { event: params.event, eventId, runIds, follow },
      };
    },

    renderCall(args, theme) {
      const data = args.data ? ` ${theme.fg("dim", args.data)}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("inngest_send"))} ${theme.fg("muted", args.event)}${data}`, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const text = result.content[0];
      const t = text?.type === "text" ? text.text : "";
      return new Text(theme.fg("muted", t), 0, 0);
    },
  });

  // ── inngest_runs ─────────────────────────────────────

  pi.registerTool({
    name: "inngest_runs",
    label: "Inngest Runs",
    description: "Show tracked Inngest runs or details for a specific run.",
    parameters: Type.Object({
      run_id: Type.Optional(Type.String({ description: "Specific run ID for detailed view" })),
    }),

    async execute(_toolCallId, params): Promise<ToolResult> {
      if (params.run_id) {
        const run = runs.get(params.run_id);
        if (!run) {
          return { content: [{ type: "text", text: `Run not tracked: ${params.run_id}` }], details: undefined };
        }
        return {
          content: [{ type: "text", text: `${run.functionName} ${run.status}` }],
          details: { run: snapshot(run) },
        };
      }

      const snaps = [...runs.values()].map(snapshot).sort((a, b) => b.elapsedMs - a.elapsedMs);
      const running = snaps.filter((r) => !TERMINAL.has(r.status)).length;
      const done = snaps.length - running;
      return {
        content: [{ type: "text", text: `${snaps.length} tracked · ${running} running · ${done} done` }],
        details: { runs: snaps },
      };
    },

    renderCall(args, theme) {
      const suffix = args.run_id ? ` ${theme.fg("muted", args.run_id)}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("inngest_runs"))}${suffix}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { run?: RunSnapshot; runs?: RunSnapshot[] } | undefined;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const all = details.run ? [details.run] : (details.runs ?? []);
      if (all.length === 0) return new Text(theme.fg("dim", "No tracked runs"), 0, 0);

      const lines: string[] = [];
      for (const r of all.slice(0, expanded ? all.length : 5)) {
        const icon = r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "◆";
        lines.push(`${icon} ${r.functionName} ${r.status} · ${fmtElapsed(r.elapsedMs)} · ${r.runId}`);
        if (expanded && r.error) lines.push(`  error: ${snipError(r.error)}`);
      }
      if (!expanded && all.length > 5) lines.push(`… ${all.length - 5} more`);
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── runtime_jobs_monitor ─────────────────────────────

  pi.registerTool({
    name: "runtime_jobs_monitor",
    label: "Runtime Jobs Monitor",
    description:
      "Start, inspect, or stop an asynchronous runtime workload monitor. " +
      "Polls `joelclaw jobs status`, renders a persistent TUI widget, emits OTEL on state changes, and sends follow-up summaries when runtime health changes.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("start"),
        Type.Literal("status"),
        Type.Literal("stop"),
      ], { description: "Monitor action. Defaults to start." })),
      interval: Type.Optional(Type.Number({ description: "Poll interval in seconds. Defaults to 5." })),
      timeout: Type.Optional(Type.Number({ description: "Optional stop timeout in seconds. Defaults to 0 (until stopped)." })),
      report: Type.Optional(Type.Boolean({ description: "Send follow-up summaries on state changes. Defaults to true." })),
    }),

    async execute(_toolCallId, params): Promise<ToolResult> {
      const action = params.action ?? "start";

      if (action === "status") {
        if (!runtimeMonitor) {
          return {
            content: [{ type: "text", text: "Runtime jobs monitor inactive" }],
            details: { active: false },
          };
        }
        return {
          content: [{ type: "text", text: `Runtime jobs monitor ${runtimeMonitor.status}` }],
          details: { active: true, monitor: runtimeMonitorSnapshot(runtimeMonitor) },
        };
      }

      if (action === "stop") {
        if (!runtimeMonitor) {
          return {
            content: [{ type: "text", text: "Runtime jobs monitor already inactive" }],
            details: { active: false },
          };
        }
        await stopRuntimeMonitor("stopped");
        return {
          content: [{ type: "text", text: "Stopped runtime jobs monitor" }],
          details: { active: false },
        };
      }

      const intervalS = typeof params.interval === "number" && Number.isFinite(params.interval)
        ? Math.max(1, Math.floor(params.interval))
        : DEFAULT_RUNTIME_MONITOR_INTERVAL_S;
      const timeoutS = typeof params.timeout === "number" && Number.isFinite(params.timeout)
        ? Math.max(0, Math.floor(params.timeout))
        : DEFAULT_RUNTIME_MONITOR_TIMEOUT_S;
      const reportBack = typeof params.report === "boolean" ? params.report : true;

      const monitor = startRuntimeMonitor(intervalS, timeoutS, reportBack);
      return {
        content: [{ type: "text", text: `Started runtime jobs monitor (${intervalS}s poll${timeoutS > 0 ? `, ${timeoutS}s timeout` : ""})` }],
        details: { active: true, monitor: runtimeMonitorSnapshot(monitor) },
      };
    },

    renderCall(args, theme) {
      const action = args.action ?? "start";
      const suffix = action === "start"
        ? ` ${theme.fg("dim", `${args.interval ?? DEFAULT_RUNTIME_MONITOR_INTERVAL_S}s poll`)}`
        : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("runtime_jobs_monitor"))} ${theme.fg("muted", action)}${suffix}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { active?: boolean; monitor?: RuntimeMonitorSnapshot } | undefined;
      if (!details?.monitor) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "Runtime jobs monitor", 0, 0);
      }

      const monitor = details.monitor;
      const color = runtimeStatusColor(monitor.status);
      const root = new Container();
      root.addChild(new Text(`${theme.fg(color, runtimeStatusIcon(monitor.status))} ${theme.fg("accent", "jobs")} ${theme.fg("muted", monitor.status)} ${theme.fg("dim", fmtElapsed(monitor.elapsedMs))}`, 0, 0));
      root.addChild(new Text(theme.fg("muted", `queue ${monitor.queueDepth} · pauses ${monitor.activePauseCount} · restate ${monitor.restateStatus} · dkron ${monitor.dkronStatus} · inngest ${monitor.inngestStatus}`), 0, 0));
      if (expanded) {
        root.addChild(new Spacer(1));
        root.addChild(new Text(theme.fg(color, monitor.summary), 0, 0));
        if (monitor.checkedAt) root.addChild(new Text(theme.fg("dim", `checked: ${monitor.checkedAt}`), 0, 0));
        if (monitor.error) root.addChild(new Text(theme.fg("error", `error: ${monitor.error}`), 0, 0));
      }
      return root;
    },
  });

  // ── Message renderers ────────────────────────────────

  pi.registerMessageRenderer<RunSnapshot>("inngest-run-complete", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return new Text(typeof message.content === "string" ? message.content : "Inngest run", 0, 0);

    const icon = d.status === "completed" ? "✓" : "✗";
    const color = d.status === "completed" ? "success" : "error";
    const root = new Container();
    root.addChild(
      new Text(`${theme.fg(color, icon)} ${theme.fg("accent", d.functionName)} ${theme.fg("muted", d.status)} ${theme.fg("dim", fmtElapsed(d.elapsedMs))}`, 0, 0),
    );
    if (expanded) {
      root.addChild(new Spacer(1));
      root.addChild(new Text(theme.fg("muted", `run: ${d.runId}`), 0, 0));
      root.addChild(new Text(theme.fg("muted", `event: ${d.eventName}`), 0, 0));
      if (d.stepCount) root.addChild(new Text(theme.fg("dim", `${d.stepCount} steps`), 0, 0));
      if (d.error) root.addChild(new Text(theme.fg("error", `error: ${d.error}`), 0, 0));
      if (d.output) root.addChild(new Text(theme.fg("dim", `output: ${d.output.slice(0, 200)}`), 0, 0));
    }
    return root;
  });

  pi.registerMessageRenderer<RuntimeMonitorSnapshot & { reason?: string }>("runtime-jobs-monitor-update", (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) return new Text(typeof message.content === "string" ? message.content : "Runtime jobs monitor", 0, 0);

    const color = runtimeStatusColor(d.status);
    const root = new Container();
    root.addChild(
      new Text(`${theme.fg(color, runtimeStatusIcon(d.status))} ${theme.fg("accent", "jobs")} ${theme.fg("muted", d.status)} ${theme.fg("dim", fmtElapsed(d.elapsedMs))}`, 0, 0),
    );
    root.addChild(new Text(theme.fg(color, d.summary), 0, 0));
    if (expanded) {
      root.addChild(new Spacer(1));
      root.addChild(new Text(theme.fg("muted", `queue ${d.queueDepth} · pauses ${d.activePauseCount}`), 0, 0));
      root.addChild(new Text(theme.fg("muted", `restate ${d.restateStatus} · dkron ${d.dkronStatus} · inngest ${d.inngestStatus}`), 0, 0));
      if (d.checkedAt) root.addChild(new Text(theme.fg("dim", `checked: ${d.checkedAt}`), 0, 0));
      if (d.error) root.addChild(new Text(theme.fg("error", `error: ${d.error}`), 0, 0));
    }
    return root;
  });
}
