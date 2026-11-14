import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { NonRetriableError } from "inngest";
import { notifyAgent } from "../../lib/notify-agent";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const execFile = promisify(execFileCallback);

export const DEFECT_WATCH_WEEKLY_CRON = "TZ=UTC 0 14 * * 1";
export const DEFECT_WATCH_FLOOR = "2026-10-17T23:24:46Z";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 120_000;
const STDERR_TAIL_CHARS = 600;

type DefectWatchReport = {
  regressions: unknown[];
  total: number;
  conversations?: Record<string, number>;
  [key: string]: unknown;
};

export type DefectWatchRun =
  | { ok: true; report: DefectWatchReport }
  | { ok: false; reason: string; stderrTail?: string };

export type DefectWatchDependencies = {
  scriptPath: () => string | undefined;
  now: () => Date;
  exec: (scriptPath: string, since: string) => Promise<{ stdout: string }>;
  notify: typeof notifyAgent;
  emit: typeof emitOtelEvent;
};

const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

export function defectWatchSince(now: Date): string {
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const floor = new Date(DEFECT_WATCH_FLOOR);
  return isoSeconds(weekAgo > floor ? weekAgo : floor);
}

export function parseDefectWatch(stdout: string): DefectWatchReport {
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as DefectWatchReport).regressions) ||
    typeof (parsed as DefectWatchReport).total !== "number"
  ) {
    throw new Error("unexpected defect watch output shape");
  }
  return parsed as DefectWatchReport;
}

export function defectWatchSummary(report: DefectWatchReport, now: Date): string {
  const counts = report.conversations ?? {};
  const taper = counts.taper ?? 0;
  const marked = counts.marked ?? 0;
  const regression = counts.regression ?? 0;
  return `defect watch week of ${now.toISOString().slice(0, 10)}: ${report.regressions.length} regressions, ${report.total} stale-tool conversations (taper ${taper}, marked ${marked}, regression ${regression})`;
}

async function runDefectWatch(deps: DefectWatchDependencies): Promise<DefectWatchRun> {
  const scriptPath = deps.scriptPath()?.trim();
  if (!scriptPath) return { ok: false, reason: "DEFECT_WATCH_SCRIPT is not set" };
  try {
    const { stdout } = await deps.exec(scriptPath, defectWatchSince(deps.now()));
    return { ok: true, report: parseDefectWatch(stdout) };
  } catch (error) {
    const failure = error as {
      killed?: boolean;
      code?: unknown;
      stderr?: unknown;
      message?: string;
    };
    const stderr =
      typeof failure.stderr === "string"
        ? failure.stderr.trim().slice(-STDERR_TAIL_CHARS)
        : undefined;
    const reason = failure.killed
      ? "timed out"
      : typeof failure.code === "number"
        ? `exit ${failure.code}`
        : error instanceof SyntaxError || failure.message === "unexpected defect watch output shape"
          ? "bad output"
          : "could not run";
    return { ok: false, reason, stderrTail: stderr || undefined };
  }
}

const defaultDependencies: DefectWatchDependencies = {
  scriptPath: () => process.env.DEFECT_WATCH_SCRIPT,
  now: () => new Date(),
  exec: (scriptPath, since) =>
    execFile("python3", ["-I", scriptPath, "--json", "--since", since], {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }),
  notify: notifyAgent,
  emit: emitOtelEvent,
};

export function createDefectWatchWeeklyFunction(
  deps: DefectWatchDependencies = defaultDependencies,
) {
  return inngest.createFunction(
    {
      id: "defect-watch-weekly",
      name: "Defect Watch Weekly",
      concurrency: { limit: 1 },
      retries: 0,
    },
    { cron: DEFECT_WATCH_WEEKLY_CRON },
    async ({ step }) => {
      const run = await step.run("run-defect-watch", () => runDefectWatch(deps));

      if (!run.ok) {
        await step.run("alarm-defect-watch-failed", () =>
          deps.notify({
            to: "switchboard/ea",
            source: "defect-watch-weekly",
            summary: `defect-watch-weekly failed: ${run.reason}`,
            message: `defect-watch-weekly failed: ${run.reason}${run.stderrTail ? `\nstderr tail:\n${run.stderrTail}` : ""}`,
          }),
        );
        await step.run("emit-defect-watch-failed", () =>
          deps
            .emit({
              level: "error",
              source: "worker",
              component: "defect-watch-weekly",
              action: "defect.watch.weekly",
              success: false,
              error: run.reason,
            })
            .catch(() => undefined),
        );
        throw new NonRetriableError(`defect-watch-weekly failed: ${run.reason}`);
      }

      const { report } = run;
      const regressionCount = report.regressions.length;
      await step.run("notify-defect-watch", () =>
        deps.notify({
          to: "muster/desk",
          cc: ["switchboard/ea"],
          source: "defect-watch-weekly",
          summary: defectWatchSummary(report, deps.now()),
          message: JSON.stringify(report, null, 2),
          quiet: regressionCount === 0,
        }),
      );
      await step.run("emit-defect-watch", () =>
        deps
          .emit({
            level: regressionCount > 0 ? "warn" : "info",
            source: "worker",
            component: "defect-watch-weekly",
            action: "defect.watch.weekly",
            success: true,
            metadata: {
              regressions: regressionCount,
              total: report.total,
              conversations: report.conversations ?? {},
            },
          })
          .catch(() => undefined),
      );

      return {
        status: regressionCount > 0 ? "regressions" : "quiet",
        regressions: regressionCount,
        total: report.total,
      };
    },
  );
}

export const defectWatchWeekly = createDefectWatchWeeklyFunction();
