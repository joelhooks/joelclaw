import { type ClickHouseConfig, resolveClickHouseConfig } from "../observability/clickhouse-store";

const DEFAULT_QUERY_URL = "http://192.168.1.163:8123";
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 365;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;
const QUERY_TIMEOUT_MS = 15_000;
const ROUTER_RESULT_ACTION = "model_router.result";
const AGENT_USAGE_ACTION = "agent_usage.turn";

export type UsageRollupRow = {
  day: string;
  component: string;
  action: string;
  model: string;
  provider: string;
  systemId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costTotal: number;
  usageMissing: number;
};

export type UsageTotals = {
  calls: number;
  /** model_router.result rows only — the denominator for usageCoveragePct */
  routerCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costTotal: number;
  usageMissing: number;
  usageCoveragePct: number;
};

export type UsageSource = "router" | "agents" | "all";

export type UsageQueryOptions = {
  hours?: number;
  component?: string;
  model?: string;
  systemId?: string;
  limit?: number;
  /** router = infer() model_router.result; agents = passive agent_usage.turn tailers; default router */
  source?: UsageSource;
};

export function resolveUsageQueryConfig(env: NodeJS.ProcessEnv = process.env): ClickHouseConfig {
  const base = resolveClickHouseConfig(env);
  const url = (env.CLICKHOUSE_QUERY_URL ?? env.CLICKHOUSE_URL ?? DEFAULT_QUERY_URL).replace(/\/+$/u, "");
  return { ...base, url };
}

function sqlIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Invalid ClickHouse identifier: ${value}`);
  }
  return value;
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function coerceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tableName(config: ClickHouseConfig): string {
  return `${sqlIdent(config.database)}.${sqlIdent(config.table)}`;
}

function actionCondition(source: UsageSource | undefined): string {
  if (source === "agents") return `action = ${sqlString(AGENT_USAGE_ACTION)}`;
  if (source === "all") {
    return `action IN (${sqlString(ROUTER_RESULT_ACTION)}, ${sqlString(AGENT_USAGE_ACTION)})`;
  }
  return `action = ${sqlString(ROUTER_RESULT_ACTION)}`;
}

function buildWhereClause(opts: UsageQueryOptions): string {
  const hours = boundedInt(opts.hours, DEFAULT_HOURS, 1, MAX_HOURS);
  const conditions = [
    actionCondition(opts.source),
    `timestamp > now() - INTERVAL ${hours} HOUR`,
  ];
  if (opts.component) conditions.push(`component = ${sqlString(opts.component)}`);
  if (opts.model) conditions.push(`JSONExtractString(metadata_json, 'model') = ${sqlString(opts.model)}`);
  if (opts.systemId) conditions.push(`coalesce(systemId, 'unknown') = ${sqlString(opts.systemId)}`);
  return conditions.join(" AND ");
}

const USAGE_SUMS = `
  sum(JSONExtractFloat(metadata_json, 'usage', 'inputTokens')) AS inputTokens,
  sum(JSONExtractFloat(metadata_json, 'usage', 'outputTokens')) AS outputTokens,
  sum(JSONExtractFloat(metadata_json, 'usage', 'totalTokens')) AS totalTokens,
  sum(JSONExtractFloat(metadata_json, 'usage', 'cacheReadTokens')) AS cacheReadTokens,
  sum(JSONExtractFloat(metadata_json, 'usage', 'cacheWriteTokens')) AS cacheWriteTokens,
  sum(JSONExtractFloat(metadata_json, 'usage', 'costTotal')) AS costTotal,
  countIf(action = ${sqlString(ROUTER_RESULT_ACTION)} AND JSONExtractBool(metadata_json, 'usageCaptured') != 1) AS usageMissing`;

function buildRollupSql(opts: UsageQueryOptions = {}, config = resolveUsageQueryConfig()): string {
  const limit = boundedInt(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return `SELECT
  toString(toDate(timestamp)) AS day,
  component,
  action,
  JSONExtractString(metadata_json, 'model') AS model,
  JSONExtractString(metadata_json, 'provider') AS provider,
  coalesce(systemId, 'unknown') AS systemId,
  count() AS calls,${USAGE_SUMS}
FROM ${tableName(config)}
WHERE ${buildWhereClause(opts)}
GROUP BY day, component, action, model, provider, systemId
ORDER BY totalTokens DESC
LIMIT ${limit}
FORMAT JSONEachRow`;
}

function buildTotalsSql(opts: UsageQueryOptions = {}, config = resolveUsageQueryConfig()): string {
  return `SELECT
  count() AS calls,
  countIf(action = ${sqlString(ROUTER_RESULT_ACTION)}) AS routerCalls,${USAGE_SUMS}
FROM ${tableName(config)}
WHERE ${buildWhereClause(opts)}
FORMAT JSONEachRow`;
}

function parseJsonEachRow(body: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function toRollupRow(raw: Record<string, unknown>): UsageRollupRow {
  return {
    day: coerceString(raw.day),
    component: coerceString(raw.component),
    action: coerceString(raw.action),
    model: coerceString(raw.model),
    provider: coerceString(raw.provider),
    systemId: coerceString(raw.systemId) || "unknown",
    calls: coerceNumber(raw.calls),
    inputTokens: coerceNumber(raw.inputTokens),
    outputTokens: coerceNumber(raw.outputTokens),
    totalTokens: coerceNumber(raw.totalTokens),
    cacheReadTokens: coerceNumber(raw.cacheReadTokens),
    cacheWriteTokens: coerceNumber(raw.cacheWriteTokens),
    costTotal: coerceNumber(raw.costTotal),
    usageMissing: coerceNumber(raw.usageMissing),
  };
}

async function runSelect(sql: string, config: ClickHouseConfig): Promise<Record<string, unknown>[]> {
  const headers: Record<string, string> = {};
  if (config.username) headers["X-ClickHouse-User"] = config.username;
  if (config.password) headers["X-ClickHouse-Key"] = config.password;

  const resp = await fetch(config.url, {
    method: "POST",
    headers,
    body: sql,
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ClickHouse usage query failed (${resp.status}): ${body}`);
  }
  return parseJsonEachRow(await resp.text());
}

export async function queryUsageRollup(
  opts: UsageQueryOptions = {},
  config = resolveUsageQueryConfig(),
): Promise<UsageRollupRow[]> {
  const rows = await runSelect(buildRollupSql(opts, config), config);
  return rows.map(toRollupRow);
}

export async function queryUsageTotals(
  opts: UsageQueryOptions = {},
  config = resolveUsageQueryConfig(),
): Promise<UsageTotals> {
  const rows = await runSelect(buildTotalsSql(opts, config), config);
  const raw = rows[0] ?? {};
  const calls = coerceNumber(raw.calls);
  const routerCalls = coerceNumber(raw.routerCalls);
  const usageMissing = coerceNumber(raw.usageMissing);
  return {
    calls,
    routerCalls,
    inputTokens: coerceNumber(raw.inputTokens),
    outputTokens: coerceNumber(raw.outputTokens),
    totalTokens: coerceNumber(raw.totalTokens),
    costTotal: coerceNumber(raw.costTotal),
    usageMissing,
    // Coverage is a router-only metric: agent_usage.turn rows always carry usage.
    usageCoveragePct: routerCalls > 0 ? Math.round(((routerCalls - usageMissing) / routerCalls) * 1000) / 10 : 0,
  };
}

export const __usageQueryTestables = {
  boundedInt,
  buildRollupSql,
  buildTotalsSql,
  buildWhereClause,
  coerceNumber,
  parseJsonEachRow,
  resolveUsageQueryConfig,
  sqlString,
  toRollupRow,
};
