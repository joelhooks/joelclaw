import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { queryUsageRollup, queryUsageTotals, type UsageRollupRow, type UsageTotals } from "../../lib/clickhouse-usage-query";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const HOME_DIR = process.env.HOME ?? "/Users/joel";
const GATEWAY_SEND_MESSAGE_EVENT = "gateway/send.message";
const REPORT_HOURS = Number.parseInt(process.env.JOELCLAW_DAILY_TOKEN_REPORT_HOURS ?? "24", 10);
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.JOELCLAW_DAILY_TOKEN_REPORT_TIMEOUT_MS ?? "45000", 10);

type CommandResult = {
  ok: boolean;
  command: string;
  json?: Record<string, unknown>;
  error?: string;
};

type AutomationHealth = {
  sessions: number;
  activeNames: Array<{ name: string; count: number }>;
  credits: Array<{ hasCredits?: boolean; unlimited?: boolean; balance?: number }>;
};

function safePositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
}

function compact(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function parseFirstJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    // continue
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function runJsonCommand(args: string[]): CommandResult {
  const command = args.join(" ");
  try {
    const proc = Bun.spawnSync(args, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
      env: { ...process.env, TERM: "dumb" },
    });
    const stdout = readText(proc.stdout);
    const stderr = readText(proc.stderr);
    const json = parseFirstJsonObject(stdout);

    if (proc.exitCode !== 0) {
      return {
        ok: false,
        command,
        json,
        error: compact(stderr || stdout || `exit ${proc.exitCode}`),
      };
    }

    return { ok: true, command, json };
  } catch (error) {
    return {
      ok: false,
      command,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type UsageSummary = {
  ok: boolean;
  totals: UsageTotals;
  topModels: string[];
  topComponents: string[];
  perMachine: Array<{ machine: string; totalTokens: number }>;
  warning?: string;
};

const EMPTY_USAGE_TOTALS: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costTotal: 0,
  usageMissing: 0,
  usageCoveragePct: 0,
};

function sumTokensBy(rows: readonly UsageRollupRow[], key: (row: UsageRollupRow) => string): Array<[string, number]> {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const bucket = key(row) || "unknown";
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + row.totalTokens);
  }
  return [...buckets.entries()].sort((a, b) => b[1] - a[1]);
}

function formatTokens(value: number): string {
  return String(Math.round(value));
}

function summarizeUsage(totals: UsageTotals, rows: readonly UsageRollupRow[]): UsageSummary {
  return {
    ok: true,
    totals,
    topModels: sumTokensBy(rows, (row) => row.model)
      .slice(0, 5)
      .map(([model, tokens]) => `${model} (${formatTokens(tokens)}tok)`),
    topComponents: sumTokensBy(rows, (row) => row.component)
      .slice(0, 5)
      .map(([component, tokens]) => `${component} (${formatTokens(tokens)}tok)`),
    perMachine: sumTokensBy(rows, (row) => row.systemId)
      .map(([machine, totalTokens]) => ({ machine, totalTokens })),
  };
}

function unavailableUsage(error: unknown): UsageSummary {
  return {
    ok: false,
    totals: EMPTY_USAGE_TOTALS,
    topModels: [],
    topComponents: [],
    perMachine: [],
    warning: compact(error instanceof Error ? error.message : String(error)),
  };
}

function summarizeRuns(result: CommandResult): {
  ok: boolean;
  counts: Record<string, number>;
  warning?: string;
} {
  if (!result.ok || !result.json) {
    return { ok: false, counts: {}, warning: result.error ?? "Inngest runs unavailable" };
  }

  const source = record(result.json.result) ?? record(result.json) ?? {};
  const runs = array(source.runs ?? source.data ?? source.items);
  const counts: Record<string, number> = {};
  for (const item of runs) {
    const itemRecord = record(item) ?? {};
    const status = String(itemRecord.status ?? itemRecord.state ?? "unknown").toLowerCase();
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return { ok: true, counts };
}

function walkRecentFiles(root: string, cutoffMs: number, limit = 200): string[] {
  const output: string[] = [];
  const visit = (dir: string) => {
    if (output.length >= limit) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (output.length >= limit) break;
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (stat.mtimeMs >= cutoffMs) visit(path);
      } else if (stat.isFile() && stat.mtimeMs >= cutoffMs && path.endsWith(".jsonl")) {
        output.push(path);
      }
    }
  };

  if (existsSync(root)) visit(root);
  return output;
}

function scanCodexAutomationHealth(hours: number): AutomationHealth {
  const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
  const files = walkRecentFiles(join(HOME_DIR, ".codex", "sessions"), cutoffMs, 300);
  const names = new Map<string, number>();
  const credits: AutomationHealth["credits"] = [];

  for (const file of files) {
    const fileName = file.split("/").pop() ?? "unknown";
    const name = fileName.replace(/\.jsonl$/u, "").replace(/^\d{4}-\d{2}-\d{2}T[^_]+_?/u, "") || "codex-session";
    names.set(name, (names.get(name) ?? 0) + 1);

    if (credits.length >= 8) continue;
    try {
      const text = readFileSync(file, "utf8");
      const creditMatch = text.match(/"has_credits"\s*:\s*(true|false)[\s\S]{0,400}?"balance"\s*:\s*([0-9.]+)/u);
      if (creditMatch) {
        credits.push({
          hasCredits: creditMatch[1] === "true",
          balance: Number.parseFloat(creditMatch[2] ?? "0"),
        });
      }
    } catch {
      // ignore unreadable session files
    }
  }

  return {
    sessions: files.length,
    activeNames: [...names.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    credits,
  };
}

function formatCurrency(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "unknown";
  return entries.map(([key, count]) => `${key}:${count}`).join(" ");
}

function buildReportText(input: {
  hours: number;
  usage: UsageSummary;
  runs: ReturnType<typeof summarizeRuns>;
  automations: AutomationHealth;
}): string {
  const creditSummary = input.automations.credits.length > 0
    ? input.automations.credits.map((item) => `credits=${item.hasCredits ?? "?"} balance=${item.balance ?? "?"}`).join("; ")
    : "no credit samples";
  const automationSummary = input.automations.activeNames.length > 0
    ? input.automations.activeNames.map((item) => `${item.name}:${item.count}`).join(", ")
    : "none seen";
  const totals = input.usage.totals;
  const perMachine = input.usage.perMachine.length > 0
    ? input.usage.perMachine.map((item) => `${item.machine}: ${formatTokens(item.totalTokens)}tok`).join(", ")
    : "unknown";

  return [
    `📊 joelclaw daily token report (${input.hours}h)`,
    `LLM calls: ${totals.calls} | tokens in/out/total: ${formatTokens(totals.inputTokens)}/${formatTokens(totals.outputTokens)}/${formatTokens(totals.totalTokens)} | est cost: ${formatCurrency(totals.costTotal)} | usage coverage: ${totals.usageCoveragePct}%`,
    input.usage.warning ? `ClickHouse warning: ${input.usage.warning}` : undefined,
    `Top models: ${input.usage.topModels.join(", ") || "unknown"}`,
    `Top components: ${input.usage.topComponents.join(", ") || "unknown"}`,
    `Per machine: ${perMachine}`,
    `Inngest runs: ${formatCounts(input.runs.counts)}`,
    input.runs.warning ? `Inngest warning: ${input.runs.warning}` : undefined,
    `Codex Desktop automation sessions: ${input.automations.sessions} (${automationSummary})`,
    `Codex credit samples: ${creditSummary}`,
    "Guardrail: backup/self-healing backup retries should show deterministic-guardrail, not openai-codex.",
  ].filter(Boolean).join("\n");
}

export const dailyTokenUsageReport = inngest.createFunction(
  {
    id: "system/token-usage.daily-report",
    name: "Daily Token Usage Report",
    retries: 1,
  },
  [{ cron: "TZ=America/Los_Angeles 15 8 * * *" }, { event: "system/token-usage.report.requested" }],
  async ({ step }) => {
    const hours = safePositiveInt(REPORT_HOURS, 24);

    const usage = await step.run("collect-clickhouse-usage", async (): Promise<UsageSummary> => {
      try {
        const [totals, rows] = await Promise.all([
          queryUsageTotals({ hours }),
          queryUsageRollup({ hours }),
        ]);
        return summarizeUsage(totals, rows);
      } catch (error) {
        return unavailableUsage(error);
      }
    });
    const runsResult = await step.run("collect-inngest-runs", async () =>
      runJsonCommand(["joelclaw", "runs", "--hours", String(hours), "--count", "500"])
    );
    const automations = await step.run("scan-codex-automation-health", async () => scanCodexAutomationHealth(hours));

    const runs = summarizeRuns(runsResult);
    const text = buildReportText({ hours, usage, runs, automations });

    await emitOtelEvent({
      level: usage.ok ? "info" : "warn",
      source: "worker",
      component: "token-usage-report",
      action: "system.token-usage.daily-report",
      success: usage.ok,
      error: usage.warning,
      metadata: {
        hours,
        usage,
        runs,
        automations,
      },
    });

    await step.sendEvent("send-token-usage-report", {
      name: GATEWAY_SEND_MESSAGE_EVENT,
      data: {
        channel: "telegram",
        text,
      },
    });

    return {
      status: "sent",
      hours,
      usage,
      runs,
      automations,
    };
  }
);
