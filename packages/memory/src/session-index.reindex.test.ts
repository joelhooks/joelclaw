import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  backupSessionIndex,
  resolveReindexPaths,
} from "../../../scripts/reindex-codex-session-chunks";
import { reindexCodexSessionChunks } from "./codex-reindex";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "codex-session-reindex-"));
  roots.push(root);
  const runStore = join(root, "runs");
  const runPath = join(runStore, "user", "2026-09", "codex-run.jsonl");
  mkdirSync(join(runStore, "user", "2026-09"), { recursive: true });
  const jsonl = [
    {
      type: "response_item",
      timestamp: "2026-09-01T00:00:00.000Z",
      payload: { type: "message", role: "user", content: "hello" },
    },
    { type: "event_msg", payload: { type: "user_message", message: "hello" } },
    {
      type: "response_item",
      timestamp: "2026-09-01T00:00:01.000Z",
      payload: { type: "message", role: "assistant", content: "world" },
    },
    { type: "event_msg", payload: { type: "agent_message", message: "world" } },
    {
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "world" },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  writeFileSync(runPath, jsonl);
  const dbPath = join(root, "sessions.db");
  const db = new Database(dbPath, { create: true, strict: true });
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
  db.query(`INSERT INTO runs (
      run_id, user_id, machine_id, agent_runtime, source_identity,
      prefix_group_identity, verdict, started_at, captured_at, ended_at,
      jsonl_path, jsonl_bytes, jsonl_sha256, turn_count, chunk_count,
      from_offset, to_offset, tags_json
    ) VALUES (?, 'user', 'machine', 'codex', 'source', 'source', 'unique_tail',
      1, 2, 3, ?, ?, ?, 5, 5, 0, ?, '[]')`)
    .run(
      "codex-run",
      runPath,
      Buffer.byteLength(jsonl),
      createHash("sha256").update(jsonl).digest("hex"),
      Buffer.byteLength(jsonl),
    );
  const insertChunk = db.prepare(
    "INSERT INTO chunks (chunk_id, run_id, chunk_idx, role, text, started_at, token_count) VALUES (?, 'codex-run', ?, ?, ?, ?, 1)",
  );
  [
    ["user", "hello"],
    ["user", "hello"],
    ["assistant", "world"],
    ["assistant", "world"],
    ["assistant", "world"],
  ].forEach(([role, text], index) => {
    const inserted = insertChunk.run(`codex-run:${index}`, index, role, text, index);
    db.query("INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)").run(
      inserted.lastInsertRowid,
      text,
    );
  });
  db.close(false);
  return { dbPath, runStore, runPath };
};

test("transactionally reindexes old Codex dual representations into canonical chunks", () => {
  const { dbPath, runStore } = fixture();
  const preview = reindexCodexSessionChunks({ databasePath: dbPath, runStorePath: runStore });
  expect(preview).toMatchObject({
    applied: false,
    scanned_runs: 1,
    affected_runs: 1,
    raw_duplicate_representations_before: 3,
    verified_runs_after: 0,
    chunks_before: 5,
    chunks_after: 2,
  });

  const applied = reindexCodexSessionChunks({
    databasePath: dbPath,
    runStorePath: runStore,
    apply: true,
  });
  expect(applied).toMatchObject({
    applied: true,
    affected_runs: 1,
    verified_runs_after: 1,
    chunks_after: 2,
  });
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    expect(
      db.query("SELECT role, text FROM chunks ORDER BY chunk_idx").all(),
    ).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ]);
    expect(
      (db.query("SELECT count(*) AS count FROM chunk_fts WHERE chunk_fts MATCH 'world'").get() as { count: number }).count,
    ).toBe(1);
    expect(
      db.query("SELECT turn_count, chunk_count FROM runs WHERE run_id = 'codex-run'").get(),
    ).toEqual({ turn_count: 2, chunk_count: 2 });
  } finally {
    db.close(false);
  }
});

test("creates a private integrity-checked backup before apply", () => {
  const { dbPath } = fixture();
  const backupPath = join(dirname(dbPath), "private", "sessions.backup.db");
  expect(backupSessionIndex(dbPath, backupPath)).toMatch(/^[0-9a-f]{64}$/u);
  expect(statSync(dirname(backupPath)).mode & 0o777).toBe(0o700);
  expect(statSync(backupPath).mode & 0o777).toBe(0o600);
});

test("prefers canonical SESSION_INDEX_PATH over the compatibility alias", () => {
  expect(
    resolveReindexPaths(
      [],
      {
        SESSION_INDEX_PATH: "/tmp/canonical.db",
        JOELCLAW_SESSIONS_DB: "/tmp/alias.db",
      },
      "/tmp/home",
      new Date("2026-09-05T00:00:00.000Z"),
    ).databasePath,
  ).toBe("/tmp/canonical.db");
});

test("leaves indexed chunks unchanged when raw Run integrity fails", () => {
  const { dbPath, runStore, runPath } = fixture();
  writeFileSync(runPath, "tampered\n");
  expect(() =>
    reindexCodexSessionChunks({ databasePath: dbPath, runStorePath: runStore, apply: true }),
  ).toThrow("codex session reindex failed: source-integrity");
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    expect(
      (db.query("SELECT count(*) AS count FROM chunks").get() as { count: number }).count,
    ).toBe(5);
  } finally {
    db.close(false);
  }
});
