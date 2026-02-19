import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";

// ── Config ─────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_S = 300;
const COMPLETED_LINGER_MS = 15_000;
const WIDGET_KEY = "inngest-monitor";

// ── Types ──────────────────────────────────────────────

type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timeout";
const TERMINAL: Set<RunStatus> = new Set(["completed", "failed", "cancelled", "timeout"]);

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

// Serializable subset for tool results (no timer handles)
interface RunSnapshot {
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
    // joelclaw outputs HATEOAS JSON — extract the result
    const parsed = JSON.parse(raw);
    return parsed?.result ?? parsed;
  } catch {
    return null;
  }
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

// ── Extension ──────────────────────────────────────────

export default function inngestMonitor(pi: ExtensionAPI) {
  const runs = new Map<string, TrackedRun>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const lingerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let widgetTui: { requestRender(): void } | null = null;

  // ── Widget ───────────────────────────────────────────

  const refreshWidget = () => widgetTui?.requestRender();

  const renderWidget = (theme: any): string[] => {
    const now = Date.now();
    const visible = [...runs.values()].filter((r) => {
      if (!TERMINAL.has(r.status)) return true;
      return r.finishedAt ? now - r.finishedAt < COMPLETED_LINGER_MS : false;
    });
    if (visible.length === 0) return [];

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
      // running / queued
      const step = r.currentStep ? `step: ${r.currentStep}` : "starting…";
      return `${theme.fg("warning", "◆")} ${theme.fg("text", r.functionName)} ${theme.fg("dim", elapsed)} ${theme.fg("muted", step)}`;
    });
  };

  // ── Polling via CLI ──────────────────────────────────

  async function pollRun(run: TrackedRun, timeoutS: number): Promise<void> {
    if (TERMINAL.has(run.status)) return;

    // Timeout check
    if (Date.now() - run.startedAt > timeoutS * 1000) {
      run.error = `Timed out after ${timeoutS}s`;
      finishRun(run, "timeout");
      return;
    }

    const { stdout, code } = await runCli(["run", run.runId]);
    if (code !== 0) {
      // CLI error (Inngest down, run not found yet, etc.) — keep polling
      refreshWidget();
      return;
    }
    const data = parseJson(stdout);
    if (!data?.run) {
      // Run not yet visible — keep polling
      refreshWidget();
      return;
    }

    const apiStatus: string = data.run.status ?? "";
    if (apiStatus === "COMPLETED") {
      run.functionName = data.run.functionName || run.functionName;
      run.output = typeof data.run.output === "string" ? data.run.output : JSON.stringify(data.run.output ?? null);
      // Count steps from trace
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
      // RUNNING or QUEUED
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
    sendMessage(run);

    // Linger then prune
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
    // First poll immediately
    void pollRun(run, timeoutS);
  }

  function stopPolling(runId: string): void {
    const t = timers.get(runId);
    if (t) { clearInterval(t); timers.delete(runId); }
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
    // Fallback: last completed step
    const completed = spans.filter((s) => s.status === "COMPLETED");
    return completed.length > 0 ? (completed[completed.length - 1].name ?? null) : null;
  }

  function extractError(data: any): string | null {
    // Check errors map from CLI
    if (data.errors) {
      for (const key of Object.keys(data.errors)) {
        const e = data.errors[key]?.error;
        if (e?.message) return e.message;
      }
    }
    // Fallback to run output
    if (data.run?.output) return typeof data.run.output === "string" ? data.run.output : JSON.stringify(data.run.output);
    return null;
  }

  // ── Messages ─────────────────────────────────────────

  function sendMessage(run: TrackedRun): void {
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

    async execute(_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: any }> {
      const follow = params.follow ?? true;
      const timeoutS = params.timeout ?? DEFAULT_TIMEOUT_S;

      // Validate JSON
      if (params.data) {
        try { JSON.parse(params.data); } catch {
          return { content: [{ type: "text", text: `Invalid JSON: ${params.data}` }], details: undefined };
        }
      }

      // Fire via CLI
      const args = ["send", params.event];
      if (params.data) args.push("-d", params.data);
      const { stdout, stderr, code } = await runCli(args);

      if (code !== 0) {
        return {
          content: [{ type: "text" as const, text: `joelclaw send failed (exit ${code}): ${stderr || stdout}` }],
          details: undefined,
        };
      }

      const result = parseJson(stdout);
      const eventIds: string[] = result?.response?.ids ?? result?.ids ?? [];
      const eventId = eventIds[0];

      if (!eventId) {
        return {
          content: [{ type: "text" as const, text: `Sent ${params.event} (no event ID returned)` }],
          details: undefined,
        };
      }

      if (!follow) {
        return {
          content: [{ type: "text" as const, text: `Sent ${params.event} → event ${eventId}` }],
          details: { event: params.event, eventId, follow: false },
        };
      }

      // Resolve event → runs via CLI (may need a moment for runs to appear)
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

      // Track runs
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
        content: [{ type: "text" as const, text }],
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

    async execute(_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: any }> {
      if (params.run_id) {
        const run = runs.get(params.run_id);
        if (!run) {
          return { content: [{ type: "text", text: `Run not tracked: ${params.run_id}` }], details: undefined };
        }
        return {
          content: [{ type: "text" as const, text: `${run.functionName} ${run.status}` }],
          details: { run: snapshot(run) },
        };
      }

      const snaps = [...runs.values()].map(snapshot).sort((a, b) => b.elapsedMs - a.elapsedMs);
      const running = snaps.filter((r) => !TERMINAL.has(r.status)).length;
      const done = snaps.length - running;
      return {
        content: [{ type: "text" as const, text: `${snaps.length} tracked · ${running} running · ${done} done` }],
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

  // ── Message renderer ─────────────────────────────────

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
}
