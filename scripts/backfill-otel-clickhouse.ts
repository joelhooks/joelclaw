#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const TYPESENSE_URL = (process.env.TYPESENSE_URL ?? "http://localhost:8108").replace(/\/+$/u, "");
const CLICKHOUSE_URL = (process.env.CLICKHOUSE_URL ?? "http://localhost:8123").replace(/\/+$/u, "");
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? "joelclaw";
const CLICKHOUSE_TABLE = process.env.CLICKHOUSE_OTEL_TABLE ?? "otel_events";
const BATCH_SIZE = Number(process.env.OTEL_BACKFILL_BATCH_SIZE ?? 5_000);

type TypesenseDoc = {
  id?: string;
  timestamp?: number | string;
  sessionId?: string;
  systemId?: string;
  level?: string;
  source?: string;
  component?: string;
  action?: string;
  success?: boolean;
  duration_ms?: number;
  error?: string;
  metadata_json?: string;
  metadata_keys?: string[];
  search_text?: string;
};

function requireTypesenseApiKey(): string {
  if (process.env.TYPESENSE_API_KEY) return process.env.TYPESENSE_API_KEY;
  const leased = spawnSync("secrets", ["lease", "typesense_api_key", "--ttl", "15m"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const key = leased.stdout.trim();
  if (leased.status === 0 && key) return key;
  throw new Error("TYPESENSE_API_KEY missing and agent-secrets lease failed");
}

function clickhouseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.CLICKHOUSE_USER) headers["X-ClickHouse-User"] = process.env.CLICKHOUSE_USER;
  if (process.env.CLICKHOUSE_PASSWORD) headers["X-ClickHouse-Key"] = process.env.CLICKHOUSE_PASSWORD;
  return headers;
}

function sqlIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`Invalid identifier: ${value}`);
  return value;
}

function formatTimestamp(value: number | string | undefined): string {
  const numeric = typeof value === "string" ? Number(value) : value;
  const ms = typeof numeric === "number" && Number.isFinite(numeric)
    ? numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
    : Date.now();
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function parseMetadata(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toClickHouseRow(doc: TypesenseDoc): Record<string, unknown> {
  const metadata = parseMetadata(doc.metadata_json);
  const metadataJson = JSON.stringify(metadata);
  const searchText = doc.search_text || [doc.source, doc.component, doc.action, doc.error, metadataJson].filter(Boolean).join(" ");
  return {
    id: doc.id ?? crypto.randomUUID(),
    timestamp: formatTimestamp(doc.timestamp),
    sessionId: doc.sessionId ?? null,
    systemId: doc.systemId ?? null,
    level: doc.level ?? "info",
    source: doc.source ?? "unknown",
    component: doc.component ?? "unknown",
    action: doc.action ?? "unknown",
    success: doc.success === false ? 0 : 1,
    duration_ms: typeof doc.duration_ms === "number" ? doc.duration_ms : null,
    error: doc.error ?? "",
    metadata_json: metadataJson,
    metadata_keys: Array.isArray(doc.metadata_keys) ? doc.metadata_keys : Object.keys(metadata),
    search_text: searchText,
  };
}

async function clickhouse(sql: string): Promise<void> {
  const resp = await fetch(CLICKHOUSE_URL, { method: "POST", headers: clickhouseHeaders(), body: sql });
  if (!resp.ok) throw new Error(`ClickHouse query failed (${resp.status}): ${await resp.text()}`);
}

async function ensureSchema(): Promise<void> {
  const database = sqlIdent(CLICKHOUSE_DATABASE);
  const table = `${database}.${sqlIdent(CLICKHOUSE_TABLE)}`;
  await clickhouse(`CREATE DATABASE IF NOT EXISTS ${database}`);
  await clickhouse(`CREATE TABLE IF NOT EXISTS ${table}
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
TTL toDateTime(timestamp) + INTERVAL ${Number(process.env.OTEL_CLICKHOUSE_TTL_DAYS ?? 180)} DAY DELETE`);
}

async function insertBatch(rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const table = `${sqlIdent(CLICKHOUSE_DATABASE)}.${sqlIdent(CLICKHOUSE_TABLE)}`;
  const query = `INSERT INTO ${table} (id,timestamp,sessionId,systemId,level,source,component,action,success,duration_ms,error,metadata_json,metadata_keys,search_text) FORMAT JSONEachRow`;
  const resp = await fetch(`${CLICKHOUSE_URL}/?query=${encodeURIComponent(query)}`, {
    method: "POST",
    headers: clickhouseHeaders(),
    body: rows.map((row) => JSON.stringify(row)).join("\n"),
  });
  if (!resp.ok) throw new Error(`ClickHouse insert failed (${resp.status}): ${await resp.text()}`);
}

async function* linesFromStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      if (line) yield line;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) yield tail;
}

async function exportTypesenseStream(): Promise<ReadableStream<Uint8Array>> {
  const resp = await fetch(`${TYPESENSE_URL}/collections/otel_events/documents/export`, {
    headers: { "X-TYPESENSE-API-KEY": requireTypesenseApiKey() },
  });
  if (!resp.ok) throw new Error(`Typesense export failed (${resp.status}): ${await resp.text()}`);
  if (!resp.body) throw new Error("Typesense export response had no body");
  return resp.body;
}

async function main(): Promise<void> {
  await ensureSchema();
  const stream = await exportTypesenseStream();
  let batch: Record<string, unknown>[] = [];
  let inserted = 0;
  for await (const line of linesFromStream(stream)) {
    batch.push(toClickHouseRow(JSON.parse(line) as TypesenseDoc));
    if (batch.length >= BATCH_SIZE) {
      await insertBatch(batch);
      inserted += batch.length;
      console.log(JSON.stringify({ ok: true, inserted }));
      batch = [];
    }
  }
  await insertBatch(batch);
  inserted += batch.length;
  console.log(JSON.stringify({ ok: true, inserted, done: true }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }));
  process.exit(1);
});
