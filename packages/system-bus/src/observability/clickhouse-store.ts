import { type OtelEvent } from "./otel-event";

const DEFAULT_CLICKHOUSE_URL = "http://localhost:8123";
const DEFAULT_DATABASE = "joelclaw";
const DEFAULT_TABLE = "otel_events";
const DEFAULT_TTL_DAYS = 180;

export type ClickHouseWriteResult = {
  written: boolean;
  error?: string;
};

export type ClickHouseConfig = {
  url: string;
  database: string;
  table: string;
  username?: string;
  password?: string;
  ttlDays: number;
};

export function resolveClickHouseConfig(env: NodeJS.ProcessEnv = process.env): ClickHouseConfig {
  const ttl = Number(env.OTEL_CLICKHOUSE_TTL_DAYS ?? DEFAULT_TTL_DAYS);
  return {
    url: (env.CLICKHOUSE_URL ?? DEFAULT_CLICKHOUSE_URL).replace(/\/+$/u, ""),
    database: env.CLICKHOUSE_DATABASE ?? DEFAULT_DATABASE,
    table: env.CLICKHOUSE_OTEL_TABLE ?? DEFAULT_TABLE,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    ttlDays: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_DAYS,
  };
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

function headers(config: ClickHouseConfig): Record<string, string> {
  const result: Record<string, string> = {};
  if (config.username) result["X-ClickHouse-User"] = config.username;
  if (config.password) result["X-ClickHouse-Key"] = config.password;
  return result;
}

async function postSql(sql: string, config = resolveClickHouseConfig()): Promise<void> {
  const resp = await fetch(config.url, {
    method: "POST",
    headers: headers(config),
    body: sql,
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ClickHouse query failed (${resp.status}): ${body}`);
  }
}

function tableName(config: ClickHouseConfig): string {
  return `${sqlIdent(config.database)}.${sqlIdent(config.table)}`;
}

let schemaReady = false;
let schemaReadyPromise: Promise<void> | null = null;

export function resetClickHouseSchemaCacheForTests(): void {
  schemaReady = false;
  schemaReadyPromise = null;
}

export async function ensureClickHouseOtelSchema(config = resolveClickHouseConfig()): Promise<void> {
  if (schemaReady) return;
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    const database = sqlIdent(config.database);
    const table = tableName(config);
    await postSql(`CREATE DATABASE IF NOT EXISTS ${database}`, config);
    await postSql(`CREATE TABLE IF NOT EXISTS ${table}
(
  id String,
  timestamp DateTime64(3, 'UTC'),
  date Date DEFAULT toDate(timestamp),
  sessionId Nullable(String),
  systemId Nullable(String),
  level LowCardinality(String),
  source LowCardinality(String),
  component LowCardinality(String),
  action String,
  success UInt8,
  duration_ms Nullable(UInt32),
  error String,
  metadata_json String,
  metadata_keys Array(String),
  search_text String,
  received_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (id, timestamp, source, component, action)
TTL toDateTime(timestamp) + INTERVAL ${config.ttlDays} DAY DELETE`, config);

    // Proof tables may already exist with the earlier minimal schema. Make them canonical in-place.
    const migrations = [
      "ADD COLUMN IF NOT EXISTS id String DEFAULT ''",
      "ADD COLUMN IF NOT EXISTS date Date DEFAULT toDate(timestamp)",
      "ADD COLUMN IF NOT EXISTS sessionId Nullable(String)",
      "ADD COLUMN IF NOT EXISTS systemId Nullable(String)",
      "ADD COLUMN IF NOT EXISTS metadata_keys Array(String) DEFAULT []",
      "ADD COLUMN IF NOT EXISTS search_text String DEFAULT ''",
      "ADD COLUMN IF NOT EXISTS received_at DateTime64(3, 'UTC') DEFAULT now64(3)",
    ];
    for (const migration of migrations) {
      await postSql(`ALTER TABLE ${table} ${migration}`, config);
    }
    schemaReady = true;
  })().finally(() => {
    schemaReadyPromise = null;
  });

  return schemaReadyPromise;
}

function formatTimestampMs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export function toClickHouseOtelRow(event: OtelEvent): Record<string, unknown> {
  const metadataJson = safeJson(event.metadata);
  const searchText = [event.source, event.component, event.action, event.error, metadataJson]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ");

  return {
    id: event.id,
    timestamp: formatTimestampMs(event.timestamp),
    sessionId: event.sessionId ?? null,
    systemId: event.systemId ?? null,
    level: event.level,
    source: event.source,
    component: event.component,
    action: event.action,
    success: event.success ? 1 : 0,
    duration_ms: typeof event.duration_ms === "number" ? event.duration_ms : null,
    error: event.error ?? "",
    metadata_json: metadataJson,
    metadata_keys: Object.keys(event.metadata ?? {}),
    search_text: searchText,
  };
}

export async function writeClickHouseOtelEvents(
  events: readonly OtelEvent[],
  config = resolveClickHouseConfig()
): Promise<ClickHouseWriteResult> {
  if (events.length === 0) return { written: true };
  try {
    await ensureClickHouseOtelSchema(config);
    const rows = events.map((event) => JSON.stringify(toClickHouseOtelRow(event))).join("\n");
    const query = `INSERT INTO ${tableName(config)} (id,timestamp,sessionId,systemId,level,source,component,action,success,duration_ms,error,metadata_json,metadata_keys,search_text) FORMAT JSONEachRow`;
    const resp = await fetch(`${config.url}/?query=${encodeURIComponent(query)}`, {
      method: "POST",
      headers: headers(config),
      body: rows,
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { written: false, error: `ClickHouse insert failed (${resp.status}): ${body}` };
    }
    return { written: true };
  } catch (error) {
    return { written: false, error: String(error) };
  }
}

export const __clickHouseStoreTestUtils = {
  formatTimestampMs,
  sqlString,
  toClickHouseOtelRow,
};
