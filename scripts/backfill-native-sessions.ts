#!/usr/bin/env bun
/**
 * Import native Cursor ACP stores and Grok sessions through Central's
 * canonical /api/runs capture boundary.
 *
 * Dry-run is the default. Cursor reads its native store.db. Grok reads the
 * native session_search.sqlite index first; filesystem scraping is disabled
 * unless --allow-grok-filesystem-fallback is explicit. Applied imports keep a
 * namespaced watermark and send only an append-only JSONL tail when the source
 * is a stable prefix of the prior import.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { chunkTurns, detectFormat, extractTurns, parseJsonl } from "../packages/memory/src/chunking";

type NativeRuntime = "cursor" | "grok";
type NativeJsonlFormatVersion = 1 | 2;
type GrokIndexStatus = "missing" | "empty" | "ready" | "unsupported";

type CursorMeta = {
  agentId?: string;
  cwd?: string;
  name?: string;
  createdAt?: number;
};

type CursorBlob = {
  role?: string;
  content?: unknown;
  id?: string;
};

type GrokIndexRow = {
  sessionId: string;
  sourcePath: string;
  updatedAt: number;
};

type GrokIndexScan = {
  status: GrokIndexStatus;
  path: string;
  table?: string;
  detail: string;
  rows: readonly GrokIndexRow[];
};

type NativeSession = {
  runtime: NativeRuntime;
  sessionId: string;
  sourcePath: string;
  cwd?: string;
  startedAt: number;
  updatedAt: number;
  jsonl: string;
  jsonlFormatVersion?: NativeJsonlFormatVersion;
  jsonlTimestamp?: number;
};

type WatermarkEntry = {
  updatedAt: number;
  jsonlBytes: number;
  jsonlSha256: string;
  sourceIdentity: string;
  jsonlFormatVersion?: NativeJsonlFormatVersion;
  jsonlTimestamp?: number;
};

type WatermarkState = {
  version: 1;
  entries: Record<string, WatermarkEntry>;
};

type Args = {
  runtime: NativeRuntime | "all";
  cursorRoot: string;
  cursorCliRoot: string;
  cursorTranscript?: string;
  grokRoot: string;
  grokHistory?: string;
  grokIndexPath: string;
  grokTable?: string;
  grokSessionColumn?: string;
  grokPathColumn?: string;
  grokUpdatedColumn?: string;
  grokFilesystemFallback: boolean;
  watermarkPath?: string;
  centralUrl: string;
  authPath: string;
  machine?: string;
  sessionId?: string;
  since: number;
  until: number;
  limit: number;
  httpTimeoutMs: number;
  apply: boolean;
  summaryOnly: boolean;
};

type Discovery = {
  sessions: readonly NativeSession[];
  warnings: readonly string[];
  grokIndex: GrokIndexScan;
};

const home = homedir();
const defaultCentralUrl = process.env.JOELCLAW_CENTRAL_URL ?? "http://127.0.0.1:3111";

function usage(): never {
  console.error(`Usage: bun scripts/backfill-native-sessions.ts [options]

Dry-run is the default. Use --apply to POST normalized native sessions to Central.
Grok is index-only by default. Pass --allow-grok-filesystem-fallback only when
its native index is unavailable and you explicitly accept a filesystem scan.

Options:
  --runtime <cursor|grok|all>  Native runtime to import (default: all)
  --cursor-root <path>         Cursor ACP root (default: ~/.cursor/acp-sessions)
  --cursor-cli-root <path>     Cursor Agent transcript root (default: ~/.cursor/projects)
  --cursor-transcript <path>   One exact Cursor Agent JSONL transcript
  --grok-root <path>           Grok sessions root (default: ~/.grok/sessions)
  --grok-history <path>        One exact Grok chat_history.jsonl transcript
  --grok-index <path>          Grok SQLite index (default: ~/.grok/session_search.sqlite)
  --grok-table <name>          Explicit Grok index table (otherwise auto-detect)
  --grok-session-column <name> Explicit session id column
  --grok-path-column <name>    Explicit native history path column
  --grok-updated-column <name> Explicit updated/watermark column
  --allow-grok-filesystem-fallback
                               Explicitly scan chat_history.jsonl if index is unavailable
  --watermark-path <path>      Append-only import watermark JSON
  --central-url <url>          Central capture URL (default: JOELCLAW_CENTRAL_URL or localhost)
  --auth-path <path>           Capture auth JSON (default: ~/.joelclaw/auth.json)
  --machine <id>               Override machine_id instead of auth.machine_id
  --session-id <id>            Include one exact native session
  --since <iso|ms>             Include sessions at/after this timestamp
  --until <iso|ms>             Include sessions before this timestamp (default: now)
  --limit <n>                  Maximum sessions (0 = all)
  --http-timeout-ms <n>        Per-Run POST timeout (default: 750)
  --apply                      POST the planned sessions to Central
  --summary-only               Print one compact final summary`);
  process.exit(2);
}

function parseTime(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  if (/^\d+$/u.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${value}`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    runtime: "all",
    cursorRoot: join(home, ".cursor/acp-sessions"),
    cursorCliRoot: join(home, ".cursor/projects"),
    grokRoot: join(home, ".grok/sessions"),
    grokIndexPath: join(home, ".grok/session_search.sqlite"),
    grokFilesystemFallback: false,
    centralUrl: defaultCentralUrl,
    authPath: join(home, ".joelclaw/auth.json"),
    since: 0,
    until: Date.now() + 1,
    limit: 0,
    httpTimeoutMs: Number(process.env.JOELCLAW_CAPTURE_HTTP_TIMEOUT_MS ?? 750),
    apply: false,
    summaryOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index] ?? usage();
    if (arg === "--runtime") {
      const value = next();
      if (value !== "all" && value !== "cursor" && value !== "grok") usage();
      args.runtime = value;
    } else if (arg === "--cursor-root") args.cursorRoot = resolve(next());
    else if (arg === "--cursor-cli-root") args.cursorCliRoot = resolve(next());
    else if (arg === "--cursor-transcript") args.cursorTranscript = resolve(next());
    else if (arg === "--grok-root") args.grokRoot = resolve(next());
    else if (arg === "--grok-history") args.grokHistory = resolve(next());
    else if (arg === "--grok-index") args.grokIndexPath = resolve(next());
    else if (arg === "--grok-table") args.grokTable = next();
    else if (arg === "--grok-session-column") args.grokSessionColumn = next();
    else if (arg === "--grok-path-column") args.grokPathColumn = next();
    else if (arg === "--grok-updated-column") args.grokUpdatedColumn = next();
    else if (arg === "--allow-grok-filesystem-fallback") args.grokFilesystemFallback = true;
    else if (arg === "--watermark-path") args.watermarkPath = resolve(next());
    else if (arg === "--central-url") args.centralUrl = next();
    else if (arg === "--auth-path") args.authPath = resolve(next());
    else if (arg === "--machine") args.machine = next();
    else if (arg === "--session-id") args.sessionId = next();
    else if (arg === "--since") args.since = parseTime(next(), args.since);
    else if (arg === "--until") args.until = parseTime(next(), args.until);
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--http-timeout-ms") args.httpTimeoutMs = Number(next());
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--summary-only") args.summaryOnly = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }

  if (!Number.isSafeInteger(args.limit) || args.limit < 0) usage();
  if (!Number.isSafeInteger(args.httpTimeoutMs) || args.httpTimeoutMs <= 0) usage();
  return args;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeMachineId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function sourceIdentity(
  runtime: NativeRuntime,
  machine: string,
  sessionId: string,
  sourcePath: string,
  generation?: string,
): string {
  const parts = generation === undefined
    ? [runtime, machine, sessionId, sourcePath]
    : [runtime, machine, sessionId, sourcePath, generation];
  return `sha256:${sha256(JSON.stringify(parts))}`;
}

function runId(
  runtime: NativeRuntime,
  machine: string,
  sessionId: string,
  sourcePath: string,
  identity: string,
  fromOffset: number,
  jsonlSha256: string,
): string {
  return sha256(
    JSON.stringify([
      "native-session",
      runtime,
      machine,
      sessionId,
      sourcePath,
      identity,
      fromOffset,
      jsonlSha256,
    ]),
  ).slice(0, 26);
}

function decodeCwd(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function listFiles(root: string, fileName: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === fileName) paths.push(path);
    }
  };
  visit(root);
  return paths;
}

function listCursorCliTranscripts(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        basename(entry.name, ".jsonl") === basename(directory) &&
        dirname(directory).endsWith("agent-transcripts")
      ) {
        paths.push(path);
      }
    }
  };
  visit(root);
  return paths.sort((left, right) => left.localeCompare(right));
}

function parseCursorStore(storePath: string): readonly CursorBlob[] {
  if (!existsSync(storePath)) return [];
  const database = new Database(storePath, { readonly: true });
  try {
    const rows = database
      .query("SELECT rowid, data FROM blobs ORDER BY rowid")
      .all() as Array<{ rowid: number; data: Uint8Array }>;
    const messages: CursorBlob[] = [];
    for (const row of rows) {
      try {
        const value = JSON.parse(Buffer.from(row.data).toString("utf8")) as CursorBlob;
        if (value.role === "user" || value.role === "assistant" || value.role === "tool") {
          messages.push(value);
        }
      } catch {
        // Binary DAG nodes and encrypted/non-message blobs are not transcript turns.
      }
    }
    return messages;
  } finally {
    database.close();
  }
}

function cursorSession(metaPath: string, legacyTimestamp?: number): NativeSession | undefined {
  let metadata: CursorMeta;
  try {
    metadata = JSON.parse(readFileSync(metaPath, "utf8")) as CursorMeta;
  } catch {
    return undefined;
  }
  const sessionId = metadata.agentId ?? metaPath.split("/").at(-2);
  if (!sessionId) return undefined;
  const storePath = join(dirname(metaPath), "store.db");
  const messages = parseCursorStore(storePath);
  if (messages.length === 0) return undefined;
  const metadataStat = statSync(metaPath);
  const timestamp = metadata.createdAt ?? metadataStat.mtimeMs;
  const startedAt = Number.isFinite(timestamp) ? timestamp : metadataStat.mtimeMs;
  const compatibilityTimestamp =
    typeof legacyTimestamp === "number" && Number.isFinite(legacyTimestamp)
      ? legacyTimestamp
      : undefined;
  const jsonl =
    messages
      .map((message) =>
        JSON.stringify({
          type: "message",
          message: {
            role: message.role === "tool" ? "toolResult" : message.role,
            content: message.content,
          },
          ...(message.id ? { id: message.id } : {}),
          ...(compatibilityTimestamp === undefined
            ? {}
            : { timestamp: new Date(compatibilityTimestamp).toISOString() }),
        }),
      )
      .join("\n") + "\n";
  return {
    runtime: "cursor",
    sessionId,
    sourcePath: metaPath,
    cwd: metadata.cwd,
    startedAt,
    updatedAt: metadataStat.mtimeMs,
    jsonl,
    jsonlFormatVersion: compatibilityTimestamp === undefined ? 2 : 1,
    jsonlTimestamp: compatibilityTimestamp,
  };
}

function cursorCliSession(historyPath: string): NativeSession | undefined {
  const sessionId = basename(historyPath, ".jsonl");
  if (!sessionId) return undefined;
  const entries: string[] = [];
  for (const line of readFileSync(historyPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { role?: string; message?: { content?: unknown } };
      if (value.role !== "user" && value.role !== "assistant") continue;
      entries.push(
        JSON.stringify({
          type: "message",
          message: {
            role: value.role,
            content: value.message?.content ?? [],
          },
        }),
      );
    } catch {
      // Native Cursor Agent readers also skip malformed JSONL rows.
    }
  }
  if (entries.length === 0) return undefined;
  const metadata = statSync(historyPath);
  return {
    runtime: "cursor",
    sessionId,
    sourcePath: historyPath,
    startedAt: metadata.birthtimeMs || metadata.mtimeMs,
    updatedAt: metadata.mtimeMs,
    jsonl: `${entries.join("\n")}\n`,
    jsonlFormatVersion: 2,
  };
}

function grokSession(
  historyPath: string,
  sessionIdOverride?: string,
  updatedAtOverride?: number,
): NativeSession | undefined {
  const parts = historyPath.split("/");
  const sessionsIndex = parts.lastIndexOf("sessions");
  const indexedSessionId = sessionsIndex >= 0 ? parts[sessionsIndex + 2] : undefined;
  const sessionId = sessionIdOverride ?? indexedSessionId ?? basename(dirname(historyPath));
  const cwd = sessionsIndex >= 0 ? decodeCwd(parts[sessionsIndex + 1]) : undefined;
  const entries: string[] = [];
  for (const line of readFileSync(historyPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { type?: string; content?: unknown };
      if (
        value.type === "user" ||
        value.type === "assistant" ||
        value.type === "tool_result" ||
        value.type === "backend_tool_call" ||
        (value.type === "reasoning" && value.content !== undefined)
      ) {
        entries.push(JSON.stringify(value));
      }
    } catch {
      // Preserve no malformed line; the native reader also treats it as non-evidence.
    }
  }
  if (entries.length === 0) return undefined;
  const metadata = statSync(historyPath);
  return {
    runtime: "grok",
    sessionId,
    sourcePath: historyPath,
    cwd,
    startedAt: metadata.mtimeMs,
    updatedAt: updatedAtOverride ?? metadata.mtimeMs,
    jsonl: `${entries.join("\n")}\n`,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`unsafe SQLite identifier: ${value}`);
  }
  return `"${value}"`;
}

const TABLE_CANDIDATES = ["sessions", "session", "documents", "history", "chat_history"];
const SESSION_COLUMNS = ["session_id", "id", "conversation_id"];
const PATH_COLUMNS = ["path", "source_path", "history_path", "chat_history_path", "file_path"];
const UPDATED_COLUMNS = ["updated_at", "last_updated", "modified_at", "mtime_ms", "timestamp"];

function chooseColumn(columns: readonly string[], candidates: readonly string[], explicit?: string): string | undefined {
  if (explicit) return columns.includes(explicit) ? explicit : undefined;
  return candidates.find((candidate) => columns.includes(candidate));
}

function grokHistoryPath(root: string, rawPath: string): string | undefined {
  const resolvedRoot = resolve(root);
  const candidate = resolve(rawPath.startsWith("/") ? rawPath : join(resolvedRoot, rawPath));
  const within = (parent: string, child: string) => {
    const relative = child.slice(parent.length);
    return child === parent || (child.startsWith(`${parent}/`) && !relative.startsWith("/../"));
  };
  if (!within(resolvedRoot, candidate)) return undefined;
  try {
    const realRoot = realpathSync(resolvedRoot);
    const candidateMetadata = statSync(candidate);
    const history = candidateMetadata.isDirectory()
      ? join(candidate, "chat_history.jsonl")
      : candidate;
    if (!history.endsWith("/chat_history.jsonl") || !statSync(history).isFile()) {
      return undefined;
    }
    const realHistory = realpathSync(history);
    return within(realRoot, realHistory) ? realHistory : undefined;
  } catch {
    // An indexed path that disappeared or escaped its root is unusable.
    return undefined;
  }
}

function readGrokIndex(args: Args): GrokIndexScan {
  if (!existsSync(args.grokIndexPath)) {
    return {
      status: "missing",
      path: args.grokIndexPath,
      detail: "native Grok SQLite index is missing",
      rows: [],
    };
  }

  const database = new Database(args.grokIndexPath, { readonly: true });
  try {
    const rawTables = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as unknown[];
    const tableNames = rawTables
      .map((value) => record(value)?.name)
      .filter((value): value is string => typeof value === "string");
    const orderedTables = args.grokTable
      ? [args.grokTable]
      : [...TABLE_CANDIDATES, ...tableNames.filter((table) => !TABLE_CANDIDATES.includes(table))];
    let emptyCandidate: GrokIndexScan | undefined;

    for (const table of orderedTables) {
      if (!tableNames.includes(table)) continue;
      const columns = database
        .query(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all() as unknown[];
      const names = columns
        .map((value) => record(value)?.name)
        .filter((value): value is string => typeof value === "string");
      const sessionColumn = chooseColumn(names, SESSION_COLUMNS, args.grokSessionColumn);
      const pathColumn = chooseColumn(names, PATH_COLUMNS, args.grokPathColumn);
      const updatedColumn = chooseColumn(names, UPDATED_COLUMNS, args.grokUpdatedColumn);
      if (!sessionColumn || !pathColumn || !updatedColumn) continue;

      const rows = database
        .query(
          `SELECT ${quoteIdentifier(sessionColumn)} AS session_id,
             ${quoteIdentifier(pathColumn)} AS source_path,
             ${quoteIdentifier(updatedColumn)} AS updated_at
           FROM ${quoteIdentifier(table)}
           WHERE ${quoteIdentifier(pathColumn)} IS NOT NULL
           ORDER BY ${quoteIdentifier(updatedColumn)} ASC
           LIMIT 100000`,
        )
        .all() as unknown[];
      const parsed: GrokIndexRow[] = [];
      for (const value of rows) {
        const item = record(value);
        const sessionId = stringValue(item?.session_id);
        const rawPath = stringValue(item?.source_path);
        const updatedAt = numberValue(item?.updated_at);
        const sourcePath = rawPath ? grokHistoryPath(args.grokRoot, rawPath) : undefined;
        if (!sessionId || !sourcePath || updatedAt === undefined) continue;
        parsed.push({ sessionId, sourcePath, updatedAt });
      }
      if (parsed.length > 0) {
        return {
          status: "ready",
          path: args.grokIndexPath,
          table,
          detail: `using ${table}.${sessionColumn}/${pathColumn}/${updatedColumn}`,
          rows: parsed,
        };
      }
      emptyCandidate ??= {
        status: "empty",
        path: args.grokIndexPath,
        table,
        detail: `recognized ${table}, but it contains no usable native history rows`,
        rows: [],
      };
    }

    if (emptyCandidate) return emptyCandidate;
    return {
      status: "unsupported",
      path: args.grokIndexPath,
      detail: "no table with session id, native path, and updated watermark columns was recognized",
      rows: [],
    };
  } finally {
    database.close();
  }
}

function readMachineId(path: string): string | undefined {
  try {
    const value = record(JSON.parse(readFileSync(path, "utf8")));
    const machine = value?.machine_id;
    return typeof machine === "string" && machine.trim() ? machine : undefined;
  } catch {
    return undefined;
  }
}

function watermarkPath(args: Args, machine: string): string {
  return (
    args.watermarkPath ??
    join(home, ".joelclaw/capture", safeMachineId(machine), "native-backfill", "watermark.json")
  );
}

function loadWatermark(path: string): WatermarkState {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const parsed = record(JSON.parse(readFileSync(path, "utf8")));
    const entries = record(parsed?.entries);
    if (parsed?.version !== 1 || !entries) return { version: 1, entries: {} };
    const valid: Record<string, WatermarkEntry> = {};
    for (const [key, value] of Object.entries(entries)) {
      const item = record(value);
      const updatedAt = item?.updatedAt;
      const jsonlBytes = item?.jsonlBytes;
      const jsonlSha256 = item?.jsonlSha256;
      const sourceIdentity = item?.sourceIdentity;
      const jsonlFormatVersion = item?.jsonlFormatVersion;
      const jsonlTimestamp = item?.jsonlTimestamp;
      if (
        typeof updatedAt === "number" &&
        typeof jsonlBytes === "number" &&
        Number.isSafeInteger(jsonlBytes) &&
        typeof jsonlSha256 === "string" &&
        typeof sourceIdentity === "string" &&
        (jsonlFormatVersion === undefined || jsonlFormatVersion === 1 || jsonlFormatVersion === 2) &&
        (jsonlTimestamp === undefined || typeof jsonlTimestamp === "number")
      ) {
        valid[key] = {
          updatedAt,
          jsonlBytes,
          jsonlSha256,
          sourceIdentity,
          jsonlFormatVersion,
          jsonlTimestamp,
        };
      }
    }
    return { version: 1, entries: valid };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveWatermark(path: string, state: WatermarkState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function watermarkKey(session: NativeSession, machine: string): string {
  return `${machine}:${session.runtime}:${session.sessionId}:${resolve(session.sourcePath)}`;
}

function cursorSessionId(metaPath: string): string | undefined {
  try {
    const metadata = JSON.parse(readFileSync(metaPath, "utf8")) as CursorMeta;
    return metadata.agentId ?? metaPath.split("/").at(-2);
  } catch {
    return metaPath.split("/").at(-2);
  }
}

function legacyCursorTimestamp(
  metaPath: string,
  machine: string,
  watermark: WatermarkState,
): number | undefined {
  const sessionId = cursorSessionId(metaPath);
  if (!sessionId) return undefined;
  const key = `${machine}:cursor:${sessionId}:${resolve(metaPath)}`;
  const previous = watermark.entries[key];
  if (previous?.jsonlFormatVersion === 2) return undefined;
  return previous?.jsonlTimestamp ?? previous?.updatedAt;
}

function discover(args: Args, machine: string, watermark: WatermarkState): Discovery {
  const sessions: NativeSession[] = [];
  const warnings: string[] = [];
  let grokIndex: GrokIndexScan = {
    status: "missing",
    path: args.grokIndexPath,
    detail: "not requested",
    rows: [],
  };

  if (args.runtime === "all" || args.runtime === "cursor") {
    const cursorSessionIds = new Set<string>();
    const cursorCliPaths = args.cursorTranscript
      ? [args.cursorTranscript]
      : listCursorCliTranscripts(args.cursorCliRoot);
    for (const historyPath of cursorCliPaths) {
      const session = cursorCliSession(historyPath);
      if (!session) continue;
      sessions.push(session);
      cursorSessionIds.add(session.sessionId);
    }
    for (const metaPath of listFiles(args.cursorRoot, "meta.json")) {
      const session = cursorSession(metaPath, legacyCursorTimestamp(metaPath, machine, watermark));
      if (!session || cursorSessionIds.has(session.sessionId)) continue;
      sessions.push(session);
    }
  }

  if (args.runtime === "all" || args.runtime === "grok") {
    const exactGrokHistory = args.grokHistory
      ? grokHistoryPath(args.grokRoot, args.grokHistory)
      : undefined;
    grokIndex = args.grokHistory
      ? {
          status: exactGrokHistory ? "ready" : "unsupported",
          path: args.grokHistory,
          detail: exactGrokHistory
            ? "exact Grok history path"
            : "exact Grok history is outside the configured native root",
          rows: [],
        }
      : readGrokIndex(args);
    if (args.grokHistory) {
      const session = exactGrokHistory
        ? grokSession(exactGrokHistory, args.sessionId)
        : undefined;
      if (session) sessions.push(session);
      else warnings.push("exact Grok history is unavailable or has no supported turns");
    } else if (grokIndex.rows.length > 0) {
      for (const row of grokIndex.rows) {
        const session = grokSession(row.sourcePath, row.sessionId, row.updatedAt);
        if (session) sessions.push(session);
        else warnings.push(`indexed Grok history disappeared or has no supported turns: ${row.sourcePath}`);
      }
    } else if (args.grokFilesystemFallback) {
      warnings.push(
        `Grok native index ${grokIndex.status}; explicit filesystem fallback scanned chat_history.jsonl`,
      );
      for (const historyPath of listFiles(args.grokRoot, "chat_history.jsonl")) {
        const session = grokSession(historyPath);
        if (session) sessions.push(session);
      }
    } else {
      warnings.push(
        `Grok import blocked: ${grokIndex.detail}. Re-run with --allow-grok-filesystem-fallback only after accepting a filesystem scan.`,
      );
    }
  }

  const filtered = sessions
    .filter((session) => args.sessionId === undefined || session.sessionId === args.sessionId)
    .filter((session) => session.startedAt >= args.since && session.startedAt < args.until)
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(0, args.limit === 0 ? undefined : args.limit);
  return { sessions: filtered, warnings, grokIndex };
}

function loadAuth(path: string): { token: string; machine_id: string; user_id: string } {
  const auth = record(JSON.parse(readFileSync(path, "utf8")));
  const token = auth?.token;
  const machineId = auth?.machine_id;
  const userId = auth?.user_id;
  if (typeof token !== "string" || typeof machineId !== "string" || typeof userId !== "string") {
    throw new Error(`capture auth is incomplete: ${path}`);
  }
  return { token, machine_id: machineId, user_id: userId };
}

function previousFor(
  session: NativeSession,
  machine: string,
  watermark: WatermarkState,
): WatermarkEntry | undefined {
  return watermark.entries[watermarkKey(session, machine)];
}

function preparePayload(
  session: NativeSession,
  machine: string,
  previous: WatermarkEntry | undefined,
): {
  skipped: boolean;
  identity: string;
  fromOffset: number;
  toOffset: number;
  bodyJsonl: string;
  bodySha256: string;
  fullBytes: number;
  fullSha256: string;
} {
  const full = Buffer.from(session.jsonl, "utf8");
  const fullBytes = full.byteLength;
  const fullSha256 = sha256(full);
  if (previous && previous.jsonlBytes === fullBytes && previous.jsonlSha256 === fullSha256) {
    return {
      skipped: true,
      identity: previous.sourceIdentity,
      fromOffset: fullBytes,
      toOffset: fullBytes,
      bodyJsonl: "",
      bodySha256: sha256(""),
      fullBytes,
      fullSha256,
    };
  }

  const appendable =
    previous !== undefined &&
    previous.jsonlBytes >= 0 &&
    previous.jsonlBytes <= fullBytes &&
    sha256(full.subarray(0, previous.jsonlBytes)) === previous.jsonlSha256;
  const fromOffset = appendable ? previous.jsonlBytes : 0;
  const payload = full.subarray(fromOffset);
  const identity = appendable
    ? previous.sourceIdentity
    : sourceIdentity(session.runtime, machine, session.sessionId, resolve(session.sourcePath), fullSha256);
  return {
    skipped: false,
    identity,
    fromOffset,
    toOffset: fromOffset + payload.byteLength,
    bodyJsonl: payload.toString("utf8"),
    bodySha256: sha256(payload),
    fullBytes,
    fullSha256,
  };
}

function planRow(
  session: NativeSession,
  machine: string,
  previous?: WatermarkEntry,
): Record<string, unknown> {
  const entries = parseJsonl(session.jsonl);
  const format = detectFormat(entries);
  const turns = extractTurns(entries, format);
  const chunks = chunkTurns(turns);
  const payload = preparePayload(session, machine, previous);
  return {
    runtime: session.runtime,
    session_id: session.sessionId,
    source_path: session.sourcePath,
    cwd: session.cwd ?? null,
    machine,
    started_at: new Date(session.startedAt).toISOString(),
    updated_at: new Date(session.updatedAt).toISOString(),
    jsonl_bytes: payload.fullBytes,
    from_offset: payload.fromOffset,
    delta_bytes: payload.bodyJsonl.length > 0 ? Buffer.byteLength(payload.bodyJsonl) : 0,
    watermark: payload.skipped ? "unchanged" : previous ? "append-or-new-generation" : "new",
    format,
    turns: turns.length,
    chunks: chunks.length,
  };
}

async function postSession(
  session: NativeSession,
  args: Args,
  auth: { token: string; machine_id: string; user_id: string },
  previous?: WatermarkEntry,
): Promise<{ status: string; runId: string; chunks: number; watermark: WatermarkEntry }> {
  const machine = args.machine ?? auth.machine_id;
  const path = resolve(session.sourcePath);
  const prepared = preparePayload(session, machine, previous);
  if (prepared.skipped) {
    return {
      status: "unchanged",
      runId: "",
      chunks: 0,
      watermark: {
        updatedAt: session.updatedAt,
        jsonlBytes: prepared.fullBytes,
        jsonlSha256: prepared.fullSha256,
        sourceIdentity: prepared.identity,
        jsonlFormatVersion: session.jsonlFormatVersion,
        jsonlTimestamp: session.jsonlTimestamp,
      },
    };
  }

  const id = runId(
    session.runtime,
    machine,
    session.sessionId,
    path,
    prepared.identity,
    prepared.fromOffset,
    prepared.bodySha256,
  );
  const eventId = `native:${session.sessionId}:${prepared.identity}:${prepared.fromOffset}:${prepared.bodySha256.slice(0, 16)}`;
  const body = {
    run_id: id,
    agent_runtime: session.runtime,
    started_at: Math.trunc(session.startedAt),
    conversation_id: session.sessionId,
    source_session_id: session.sessionId,
    event_id: eventId,
    source_identity: prepared.identity,
    from_offset: prepared.fromOffset,
    to_offset: prepared.toOffset,
    jsonl_sha256: prepared.bodySha256,
    tags: [
      "captured",
      "backfill",
      `runtime:${session.runtime}`,
      `machine:${machine}`,
      `host:${hostname()}`,
      `session:${session.sessionId}`,
      `source:${basename(path)}`,
      `from-offset:${prepared.fromOffset}`,
    ],
    jsonl: prepared.bodyJsonl,
  };
  let response: Response;
  try {
    response = await fetch(`${args.centralUrl.replace(/\/$/u, "")}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `sha256:${sha256(JSON.stringify([machine, eventId]))}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.httpTimeoutMs),
    });
  } catch {
    throw new Error("native capture POST failed: network");
  }
  const payload = (await response.json().catch(() => ({}))) as {
    status?: unknown;
    run_id?: unknown;
    to_offset?: unknown;
  };
  if (!response.ok) {
    throw new Error(`native capture POST failed: http-${response.status}`);
  }
  if (
    (payload.status !== "accepted" && payload.status !== "accepted_prefix") ||
    typeof payload.run_id !== "string" ||
    payload.run_id.length === 0 ||
    !Number.isSafeInteger(payload.to_offset)
  ) {
    throw new Error("native capture POST failed: invalid-receipt");
  }
  const acceptedOffset = Number(payload.to_offset);
  if (
    acceptedOffset <= prepared.fromOffset ||
    acceptedOffset > prepared.toOffset ||
    (payload.status === "accepted" && acceptedOffset !== prepared.toOffset)
  ) {
    throw new Error("native capture POST failed: invalid-receipt");
  }
  const full = Buffer.from(session.jsonl, "utf8");
  const acceptedDelta = full.subarray(prepared.fromOffset, acceptedOffset).toString("utf8");
  const acceptedEntries = parseJsonl(acceptedDelta);
  const turns = extractTurns(acceptedEntries, detectFormat(acceptedEntries));
  return {
    status: payload.status,
    runId: payload.run_id,
    chunks: chunkTurns(turns).length,
    watermark: {
      updatedAt: session.updatedAt,
      jsonlBytes: acceptedOffset,
      jsonlSha256: sha256(full.subarray(0, acceptedOffset)),
      sourceIdentity: prepared.identity,
      jsonlFormatVersion: session.jsonlFormatVersion,
      jsonlTimestamp: session.jsonlTimestamp,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const auth = args.apply ? loadAuth(args.authPath) : undefined;
  const machine = args.machine ?? auth?.machine_id ?? readMachineId(args.authPath) ?? "<auth.machine_id>";
  const resolvedWatermarkPath = watermarkPath(args, machine);
  const watermark = loadWatermark(resolvedWatermarkPath);
  const discovery = discover(args, machine, watermark);
  const sessions = discovery.sessions;
  const rows = sessions.map((session) => planRow(session, machine, previousFor(session, machine, watermark)));
  const blockedGrok =
    (args.runtime === "grok" || args.runtime === "all") &&
    !args.grokFilesystemFallback &&
    discovery.grokIndex.status !== "ready";
  const summary = {
    ok: !blockedGrok,
    mode: args.apply ? "apply" : "dry-run",
    runtime: args.runtime,
    machine,
    watermark_path: resolvedWatermarkPath,
    grok_index: {
      status: discovery.grokIndex.status,
      path: discovery.grokIndex.path,
      table: discovery.grokIndex.table,
      detail: discovery.grokIndex.detail,
      indexed_rows: discovery.grokIndex.rows.length,
      filesystem_fallback: args.grokFilesystemFallback,
    },
    warnings: discovery.warnings,
    discovered: sessions.length,
    by_runtime: {
      cursor: sessions.filter((session) => session.runtime === "cursor").length,
      grok: sessions.filter((session) => session.runtime === "grok").length,
    },
    turns: rows.reduce((sum, row) => sum + Number(row.turns ?? 0), 0),
    chunks: rows.reduce((sum, row) => sum + Number(row.chunks ?? 0), 0),
    jsonl_bytes: rows.reduce((sum, row) => sum + Number(row.jsonl_bytes ?? 0), 0),
    sessions: rows,
  };

  if (!args.apply) {
    if (!summary.ok) {
      console.error(
        JSON.stringify({
          ok: false,
          action: "memory.native_capture.discovery",
          error: "native-source-unavailable",
          metadata: {
            runtime: args.runtime,
            grok_index_status: discovery.grokIndex.status,
          },
        }),
      );
      process.exitCode = 2;
      return;
    }
    console.log(
      args.summaryOnly
        ? JSON.stringify({
            ok: true,
            mode: summary.mode,
            runtime: summary.runtime,
            discovered: summary.discovered,
            by_runtime: summary.by_runtime,
            turns: summary.turns,
            chunks: summary.chunks,
            jsonl_bytes: summary.jsonl_bytes,
          })
        : JSON.stringify(summary, null, 2),
    );
    return;
  }

  if (!summary.ok && args.runtime !== "all") {
    console.error(
      JSON.stringify({
        action: "memory.native_capture.runtime",
        success: false,
        error: "native-source-unavailable",
        metadata: {
          runtime: args.runtime,
          grok_index_status: discovery.grokIndex.status,
        },
      }),
    );
    process.exitCode = 2;
    return;
  }

  const liveAuth = auth!;
  let accepted = 0;
  let skipped = 0;
  let errors = blockedGrok ? 1 : 0;
  const receipts: Array<Record<string, unknown>> = [];
  for (const session of sessions) {
    try {
      const previous = previousFor(session, machine, watermark);
      const receipt = await postSession(session, args, liveAuth, previous);
      if (receipt.status === "unchanged") skipped += 1;
      else accepted += 1;
      watermark.entries[watermarkKey(session, machine)] = receipt.watermark;
      saveWatermark(resolvedWatermarkPath, watermark);
      const sessionIdentitySha256 = sha256(session.sessionId);
      receipts.push({
        ...receipt,
        watermark: undefined,
        runtime: session.runtime,
        session_identity_sha256: sessionIdentitySha256,
      });
      if (!args.summaryOnly) {
        console.log(
          JSON.stringify({
            phase: receipt.status,
            runtime: session.runtime,
            session_identity_sha256: sessionIdentitySha256,
            run_id: receipt.runId,
            chunks: receipt.chunks,
          }),
        );
      }
    } catch (error) {
      errors += 1;
      const detail = error instanceof Error ? error.message : String(error);
      const errorCode =
        /^native capture POST failed: ([a-z0-9-]+)$/u.exec(detail)?.[1] ??
        "session-failed";
      receipts.push({
        runtime: session.runtime,
        session_identity_sha256: sha256(session.sessionId),
        error: errorCode,
      });
      if (!args.summaryOnly) {
        console.error(
          JSON.stringify({
            action: "memory.native_capture.session",
            success: false,
            error: errorCode,
            metadata: {
              runtime: session.runtime,
              session_identity_sha256: sha256(session.sessionId),
            },
          }),
        );
      }
    }
  }

  const result = {
    ...summary,
    ok: summary.ok && errors === 0,
    accepted,
    skipped,
    errors,
    receipts,
  };
  if (errors > 0) {
    console.error(
      JSON.stringify({
        ok: false,
        action: "memory.native_capture.runtime",
        error: blockedGrok ? "runtime-partially-unavailable" : "session-failed",
        metadata: {
          runtime: args.runtime,
          discovered: result.discovered,
          accepted,
          skipped,
          errors,
        },
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (args.summaryOnly) {
    console.log(JSON.stringify({
      ok: true,
      mode: result.mode,
      runtime: result.runtime,
      discovered: result.discovered,
      accepted,
      skipped,
      errors,
    }));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    const errorCode = /capture auth is incomplete/iu.test(detail)
      ? "auth-invalid"
      : "runtime-failed";
    console.error(
      JSON.stringify({
        action: "memory.native_capture.runtime",
        success: false,
        error: errorCode,
      }),
    );
    process.exitCode = 1;
  });
}

export const __test = {
  cursorCliSession,
  decodeCwd,
  detectFormat,
  discover,
  grokHistoryPath,
  grokSession,
  parseArgs,
  planRow,
  postSession,
  preparePayload,
  readGrokIndex,
};
