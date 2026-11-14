import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSessionCapture } from "@joelclaw/memory";
import type { AppendObservation, CapturedPayload } from "../src/types";

/** Synthetic fixtures only: never a copy of a real sessions.db. */

export function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "capture-cell-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function createSessionsDb(path: string, journalMode: "WAL" | "DELETE" = "WAL"): void {
  const db = new Database(path, { create: true, readwrite: true, strict: true });
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL,
      agent_runtime TEXT NOT NULL, conversation_id TEXT, parent_run_id TEXT,
      source_identity TEXT NOT NULL, prefix_group_identity TEXT NOT NULL,
      verdict TEXT NOT NULL, started_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL, jsonl_path TEXT NOT NULL, jsonl_bytes INTEGER NOT NULL,
      jsonl_sha256 TEXT NOT NULL, turn_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
      from_offset INTEGER, to_offset INTEGER, tags_json TEXT NOT NULL DEFAULT '[]'
    ) STRICT;
    CREATE INDEX runs_source_cursor ON runs(source_identity, from_offset);
    CREATE INDEX runs_ended_at_idx ON runs(ended_at);
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      chunk_idx INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      started_at INTEGER NOT NULL, token_count INTEGER NOT NULL,
      UNIQUE(run_id, chunk_idx)
    ) STRICT;
    CREATE VIRTUAL TABLE chunk_fts USING fts5(
      text, content='chunks', content_rowid='rowid', tokenize='unicode61'
    );
  `);
  db.close(false);
}

export function turnLines(count: number, startMinute = 0, day = "2026-01-01"): string {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const minute = String(startMinute + index).padStart(2, "0");
    const role = index % 2 === 0 ? "user" : "assistant";
    lines.push(
      JSON.stringify({
        type: role,
        timestamp: `${day}T00:${minute}:00Z`,
        message: { role, content: `${role} turn ${startMinute + index} about capture cells` },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

export const SOURCE = `sha256:${"c".repeat(64)}`;

export function writeCapture(
  root: string,
  runId: string,
  jsonl: string,
  cursor: { source_identity?: string; from_offset?: number } = {},
): CapturedPayload {
  const dir = join(root, "runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.jsonl`);
  writeFileSync(path, jsonl);
  const bytes = Buffer.byteLength(jsonl);
  const payload: CapturedPayload = {
    run_id: runId,
    user_id: "user",
    machine_id: "machine",
    agent_runtime: "claude-code",
    jsonl_path: path,
    jsonl_bytes: bytes,
    jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
    started_at: Date.UTC(2026, 0, 1),
    tags: [],
  };
  if (cursor.source_identity !== undefined) {
    payload.source_identity = cursor.source_identity;
    payload.from_offset = cursor.from_offset ?? 0;
    payload.to_offset = (cursor.from_offset ?? 0) + bytes;
  }
  return payload;
}

/** Index a capture the way the Inngest writer does: the real append. */
export function indexWithWriter(
  sessionsDbPath: string,
  payload: CapturedPayload,
  capturedAt = Date.now(),
) {
  return appendSessionCapture({
    databasePath: sessionsDbPath,
    capturePath: payload.jsonl_path,
    runId: payload.run_id,
    userId: payload.user_id,
    machineId: payload.machine_id,
    agentRuntime: payload.agent_runtime,
    sourceIdentity: payload.source_identity,
    fromOffset: payload.from_offset,
    toOffset: payload.to_offset,
    tags: payload.tags,
    startedAt: payload.started_at,
    capturedAt,
    jsonlPath: payload.jsonl_path,
    jsonlBytes: payload.jsonl_bytes,
    jsonlSha256: payload.jsonl_sha256,
  });
}

export function capturedPayload(
  runId: string,
  overrides: Partial<CapturedPayload> = {},
): CapturedPayload {
  return {
    run_id: runId,
    user_id: "user",
    machine_id: "machine",
    agent_runtime: "pi",
    jsonl_path: `/runs/${runId}.jsonl`,
    jsonl_bytes: 10,
    jsonl_sha256: "a".repeat(64),
    started_at: 1,
    ...overrides,
  };
}

export const OBSERVED_APPENDED: AppendObservation = {
  observed: "appended",
  matched: null,
  matched_run_id: null,
  chunk_count: 2,
  turn_count: 3,
  format: "claude-code",
  computed_chunk_count: 2,
  computed_turn_count: 3,
  computed_format: "claude-code",
  source_identity: SOURCE,
  duration_ms: 4,
};
