import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSessionCapture, type SessionCaptureAppendInput } from "../src/session-index";

let testDirectory = "";
let databasePath = "";

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), "session-index-test-"));
  databasePath = join(testDirectory, "sessions.db");
  const db = new Database(databasePath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL,
      agent_runtime TEXT NOT NULL, conversation_id TEXT, parent_run_id TEXT,
      source_identity TEXT NOT NULL, prefix_group_identity TEXT NOT NULL,
      verdict TEXT NOT NULL, started_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL, jsonl_path TEXT NOT NULL, jsonl_bytes INTEGER NOT NULL,
      jsonl_sha256 TEXT NOT NULL, turn_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL
    ) STRICT;
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
});

afterEach(() => {
  rmSync(testDirectory, { recursive: true, force: true });
});

function conversationJsonl(contents: string[]): string {
  const lines = ['{"type":"session","version":3}'];
  contents.forEach((content, index) => {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: new Date(1_721_238_660_000 + index * 1000).toISOString(),
        message: { role: index % 2 === 0 ? "user" : "assistant", content },
      }),
    );
  });
  return `${lines.join("\n")}\n`;
}

function captureInput(runId: string, jsonl: string): SessionCaptureAppendInput {
  const capturePath = join(testDirectory, `${runId}.jsonl`);
  writeFileSync(capturePath, jsonl);
  return {
    databasePath,
    capturePath,
    runId,
    userId: "joel",
    machineId: "test-machine",
    agentRuntime: "pi",
    sourceIdentity: `sha256:${"b".repeat(64)}`,
    fromOffset: 0,
    toOffset: Buffer.byteLength(jsonl),
    startedAt: 1_721_238_660_000,
    capturedAt: 1_721_238_700_000,
    jsonlPath: capturePath,
    jsonlBytes: Buffer.byteLength(jsonl),
    jsonlSha256: createHash("sha256").update(jsonl).digest("hex"),
  };
}

function storedTextBytes(runId: string): number {
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    const rows = db.query("SELECT text FROM chunks WHERE run_id = ?").all(runId) as Array<{
      text: string;
    }>;
    return rows.reduce((sum, row) => sum + Buffer.byteLength(row.text, "utf8"), 0);
  } finally {
    db.close(false);
  }
}

describe("appendSessionCapture text_bytes", () => {
  test("reports the UTF-8 bytes of the inserted chunk text", () => {
    const result = appendSessionCapture(
      captureInput("run-ascii", conversationJsonl(["hello there", "general kenobi", "ok"])),
    );

    expect(result.status).toBe("appended");
    expect(result.chunk_count).toBe(3);
    expect(result.turn_count).toBe(3);
    expect(result.text_bytes).toBeGreaterThan(0);
    expect(result.text_bytes).toBe(storedTextBytes("run-ascii"));
  });

  test("counts bytes, not UTF-16 code units, for multi-byte text", () => {
    const result = appendSessionCapture(
      captureInput(
        "run-utf8",
        conversationJsonl(["héllo 🐀 rat", "日本語のテキスト", "naïve café ✓"]),
      ),
    );

    const db = new Database(databasePath, { readonly: true, strict: true });
    const texts = (
      db.query("SELECT text FROM chunks WHERE run_id = ?").all("run-utf8") as Array<{
        text: string;
      }>
    ).map((row) => row.text);
    db.close(false);
    const codeUnits = texts.reduce((sum, text) => sum + text.length, 0);

    expect(result.status).toBe("appended");
    expect(result.text_bytes).toBe(storedTextBytes("run-utf8"));
    expect(result.text_bytes).toBeGreaterThan(codeUnits);
  });

  test("reports zero for an already-indexed replay", () => {
    const input = captureInput("run-replay", conversationJsonl(["first", "second"]));
    const first = appendSessionCapture(input);
    const replay = appendSessionCapture(input);

    expect(first.text_bytes).toBe(storedTextBytes("run-replay"));
    expect(replay).toMatchObject({
      status: "already_indexed",
      chunk_count: 2,
      turn_count: 0,
      text_bytes: 0,
    });
  });

  test("reports zero for a fresh Run ID at an indexed source cursor", () => {
    const jsonl = conversationJsonl(["first", "second"]);
    appendSessionCapture(captureInput("run-cursor-a", jsonl));
    const replay = appendSessionCapture(captureInput("run-cursor-b", jsonl));

    expect(replay).toMatchObject({
      status: "already_indexed",
      run_id: "run-cursor-a",
      turn_count: 0,
      text_bytes: 0,
    });
  });
});
