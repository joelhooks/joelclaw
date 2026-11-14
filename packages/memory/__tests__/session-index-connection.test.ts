import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendSessionCapture,
  closeSessionIndexConnections,
  migrateSessionIndex,
  peekSessionIndexConnection,
  readSessionIndexIdentityRows,
  SessionIndexReplacedError,
  sessionIndexConnectionStats,
} from "../src/session-index";

import { acquireSessionIndexConnection } from "../src/session-index-connection";

const roots: string[] = [];
afterEach(() => {
  closeSessionIndexConnections();
  delete process.env.SESSION_INDEX_CACHE_KIB;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function schema(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE runs(run_id TEXT PRIMARY KEY,user_id TEXT,machine_id TEXT,agent_runtime TEXT,conversation_id TEXT,parent_run_id TEXT,source_identity TEXT,prefix_group_identity TEXT,verdict TEXT,started_at INTEGER,captured_at INTEGER,ended_at INTEGER,jsonl_path TEXT,jsonl_bytes INTEGER,jsonl_sha256 TEXT,turn_count INTEGER,chunk_count INTEGER);
 CREATE TABLE chunks(chunk_id TEXT UNIQUE,run_id TEXT REFERENCES runs(run_id),chunk_idx INTEGER,role TEXT,text TEXT,started_at INTEGER,token_count INTEGER);
 CREATE VIRTUAL TABLE chunk_fts USING fts5(text,content='chunks',content_rowid='rowid');`);
  db.close(true);
}
function fixture() {
  const root = mkdtempSync(
    join(process.env.CAPTURE_TEST_ROOT ?? join(homedir(), ".cache"), "index-connection-"),
  );
  roots.push(root);
  const databasePath = join(root, "sessions.db");
  schema(databasePath);
  const capturePath = join(root, "capture.jsonl");
  const blob =
    JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "Synthetic connection fixture" },
    }) + "\n";
  writeFileSync(capturePath, blob);
  const input = {
    databasePath,
    capturePath,
    runId: "r1",
    userId: "synthetic-user",
    machineId: "synthetic-machine",
    agentRuntime: "claude-code",
    startedAt: 1,
    capturedAt: 2,
    jsonlPath: capturePath,
    jsonlBytes: Buffer.byteLength(blob),
    jsonlSha256: createHash("sha256").update(blob).digest("hex"),
  };
  return { input, root };
}
test("reuses one canonical connection, legacy pragmas and bounded cache; schema runs once", () => {
  const f = fixture();
  const before = sessionIndexConnectionStats().opens;
  const first = appendSessionCapture(f.input);
  const db = peekSessionIndexConnection(f.input.databasePath)!;
  expect(first.status).toBe("appended");
  expect(first.turn_count).toBe(1);
  expect(first.text_bytes).toBeGreaterThan(0);
  expect(first.phase_ms.schema_ms).toBeGreaterThan(0);
  const second = appendSessionCapture({ ...f.input, runId: "r2" });
  expect(peekSessionIndexConnection(f.input.databasePath)).toBe(db);
  expect(sessionIndexConnectionStats().opens - before).toBe(1);
  expect(second.phase_ms.schema_ms).toBeUndefined();
  expect(db.query("PRAGMA cache_size").get()).toEqual({ cache_size: -32768 });
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  expect(
    db.query("SELECT name FROM sqlite_master WHERE name='runs_ended_at_idx'").get(),
  ).not.toBeNull();
});
test("conflict keeps a healthy handle; non-domain failure rolls back then drops and reopens", () => {
  const f = fixture();
  appendSessionCapture(f.input);
  const db = peekSessionIndexConnection(f.input.databasePath)!;
  expect(() =>
    appendSessionCapture({ ...f.input, sourceIdentity: "conflicting-source" }),
  ).toThrow();
  expect(peekSessionIndexConnection(f.input.databasePath)).toBe(db);
  db.exec(
    "CREATE TRIGGER fail_chunk BEFORE INSERT ON chunks WHEN new.run_id='fail' BEGIN SELECT RAISE(ABORT,'planted failure'); END",
  );
  expect(() => appendSessionCapture({ ...f.input, runId: "fail" })).toThrow("planted failure");
  expect(peekSessionIndexConnection(f.input.databasePath)).toBeUndefined();
  const result = appendSessionCapture({ ...f.input, runId: "r2" });
  expect(result.status).toBe("appended");
  const reopened = peekSessionIndexConnection(f.input.databasePath)!;
  expect(reopened).not.toBe(db);
  expect(reopened.query("SELECT count(*) AS n FROM runs WHERE run_id='fail'").get()).toEqual({
    n: 0,
  });
  expect(appendSessionCapture(f.input)).toMatchObject({
    status: "already_indexed",
    turn_count: 0,
    text_bytes: 0,
  });
});
test("DB replacement is fenced until explicit lifetime close/restart", () => {
  const f = fixture();
  appendSessionCapture(f.input);
  peekSessionIndexConnection(f.input.databasePath)!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  renameSync(f.input.databasePath, `${f.input.databasePath}.old`);
  schema(f.input.databasePath);
  expect(() => appendSessionCapture({ ...f.input, runId: "r2" })).toThrow(
    SessionIndexReplacedError,
  );
  expect(() => appendSessionCapture({ ...f.input, runId: "r3" })).toThrow(
    SessionIndexReplacedError,
  );
  closeSessionIndexConnections();
  expect(appendSessionCapture({ ...f.input, runId: "r2" }).status).toBe("appended");
});
test("ordinary open skips missing cover, alarms once and needs no schema writer lock", () => {
  const f = fixture();
  const writer = new Database(f.input.databasePath, { readwrite: true });
  writer.exec(`ALTER TABLE runs ADD COLUMN from_offset INTEGER;
    ALTER TABLE runs ADD COLUMN to_offset INTEGER;
    ALTER TABLE runs ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
    CREATE INDEX runs_source_cursor ON runs(source_identity,from_offset);
    CREATE INDEX runs_ended_at_idx ON runs(ended_at);
    BEGIN IMMEDIATE;`);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const phases: Record<string, number> = {};
  let alarms = 0;
  try {
    // With busy_timeout=0 this would fail immediately if open attempted a write lock.
    const db = acquireSessionIndexConnection(f.input.databasePath, 0, phases, () => {
      alarms++;
    });
    expect(db.inTransaction).toBe(false);
    expect(phases.migration_begin_wait_ms).toBeUndefined();
    expect(phases.cursor_index_ms).toBeUndefined();
    expect(
      db.query("SELECT 1 FROM sqlite_master WHERE name='runs_source_cursor_to'").get(),
    ).toBeNull();
    expect(alarms).toBe(1);
    acquireSessionIndexConnection(f.input.databasePath, 0, {}, () => {
      alarms++;
    });
    expect(alarms).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
      action: "capture.session_index.cursor_index_missing",
      command: "capture-intake index-migrate --db <sessions-db>",
    });
  } finally {
    writer.exec("ROLLBACK");
    writer.close(true);
    warn.mockRestore();
  }
  expect(appendSessionCapture(f.input).status).toBe("appended");
  expect(migrateSessionIndex(f.input.databasePath).created).toBe(true);
  closeSessionIndexConnections();
  const healthyWarn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    acquireSessionIndexConnection(f.input.databasePath);
    expect(healthyWarn).not.toHaveBeenCalled();
  } finally {
    healthyWarn.mockRestore();
  }
});
test("ordinary open alarm failure cannot block fallback append", () => {
  const f = fixture();
  expect(
    appendSessionCapture({
      ...f.input,
      onCursorIndexMissing: () => {
        throw new Error("alarm sink down");
      },
    }).status,
  ).toBe("appended");
  expect(
    peekSessionIndexConnection(f.input.databasePath)!
      .query("SELECT 1 FROM sqlite_master WHERE name='runs_source_cursor_to'")
      .get(),
  ).toBeNull();
});
test("covering migration is transactional, idempotent and preserves FULL durability", () => {
  const f = fixture();
  const missing = join(f.root, "not-an-index.db");
  expect(() => migrateSessionIndex(missing)).toThrow();
  expect(existsSync(missing)).toBe(false);
  const first = migrateSessionIndex(f.input.databasePath);
  expect(first.created).toBe(true);
  expect(first.phase_ms.migration_write_lock_ms).toBeGreaterThanOrEqual(
    first.phase_ms.cursor_index_ms!,
  );
  expect(migrateSessionIndex(f.input.databasePath).created).toBe(false);
  const db = new Database(f.input.databasePath, { readwrite: true });
  try {
    // synchronous is connection-local, not a persisted database setting.
    // The cached writer handle is checked separately above.
    expect(
      (db.query("PRAGMA index_info(runs_source_cursor_to)").all() as Array<{ name: string }>).map(
        (x) => x.name,
      ),
    ).toEqual(["source_identity", "from_offset", "to_offset"]);
  } finally {
    db.close(true);
  }
  const broken = join(f.root, "broken.db");
  const bad = new Database(broken, { create: true });
  bad.exec("CREATE TABLE runs(run_id TEXT PRIMARY KEY)");
  bad.close(true);
  expect(() => migrateSessionIndex(broken)).toThrow();
  const checked = new Database(broken, { readonly: true });
  try {
    expect(
      (checked.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(
        (x) => x.name,
      ),
    ).toEqual(["run_id"]);
  } finally {
    checked.close(true);
  }
});
test("overlap predicate equivalence at boundaries and index-only range scan with one winner lookup", () => {
  const f = fixture();
  migrateSessionIndex(f.input.databasePath);
  appendSessionCapture(f.input);
  const db = peekSessionIndexConnection(f.input.databasePath)!;
  const insert = db.query(
    "INSERT INTO runs(run_id, source_identity, from_offset, to_offset) VALUES(?,?,?,?)",
  );
  for (let n = 0; n < 100; n++) insert.run(`range-${n}`, "same-source", n * 10, n * 10 + 7);
  insert.run("null-from", "same-source", null, 10000);
  insert.run("null-to", "same-source", -5, null);
  insert.run("other-source", "other-source", 0, 10000);
  const old = db.query(
    `SELECT run_id FROM runs INDEXED BY runs_source_cursor WHERE source_identity=? AND from_offset IS NOT NULL AND to_offset IS NOT NULL AND from_offset<? AND to_offset>? LIMIT 1`,
  );
  const captured: string[] = [];
  const traced = new Proxy(db, {
    get(target, key) {
      return key === "query"
        ? (sql: string) => {
            captured.push(sql);
            return target.query(sql);
          }
        : Reflect.get(target, key);
    },
  });
  for (const start of [-10, -5, 0, 1, 6, 7, 8, 9, 10, 996, 997, 998, 1000])
    for (const length of [0, 1, 3, 10, 1000]) {
      const result = readSessionIndexIdentityRows(traced, {
        runId: "not-present",
        sourceIdentity: "same-source",
        fromOffset: start,
        toOffset: start + length,
        jsonlBytes: 1,
        jsonlSha256: "unused",
      });
      const expected = old.get("same-source", start + length, start);
      if (result.kind === "cursor")
        expect(result.row.run_id).toBe(
          (
            db
              .query("SELECT run_id FROM runs WHERE source_identity=? AND from_offset=? LIMIT 1")
              .get("same-source", start) as { run_id: string }
          ).run_id,
        );
      else {
        expect(result.kind === "overlap").toBe(Boolean(expected));
        if (result.kind === "overlap")
          expect(result.run_id).toBe((expected as { run_id: string }).run_id);
      }
    }
  const sql = captured.find((x) => x.includes("SELECT rowid FROM runs"))!;
  const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all("same-source", 2001, 2000) as Array<{
    detail: string;
  }>;
  expect(plan.some((x) => x.detail.includes("USING COVERING INDEX runs_source_cursor_to"))).toBe(
    true,
  );
  expect(plan.some((x) => x.detail.includes("INTEGER PRIMARY KEY (rowid=?)"))).toBe(true);
  expect(
    readSessionIndexIdentityRows(db, {
      runId: "not-present",
      sourceIdentity: "same-source",
      fromOffset: 2000,
      toOffset: 2001,
      jsonlBytes: 1,
      jsonlSha256: "unused",
    }),
  ).toEqual({ kind: "none" });
});
test("legacy cache override validates before opening and is fixed for a handle lifetime", () => {
  const f = fixture();
  const before = sessionIndexConnectionStats().opens;
  process.env.SESSION_INDEX_CACHE_KIB = "0";
  expect(() => appendSessionCapture(f.input)).toThrow(RangeError);
  expect(sessionIndexConnectionStats().opens).toBe(before);
  process.env.SESSION_INDEX_CACHE_KIB = "16384";
  appendSessionCapture(f.input);
  const db = peekSessionIndexConnection(f.input.databasePath)!;
  expect(db.query("PRAGMA cache_size").get()).toEqual({ cache_size: -16384 });
  process.env.SESSION_INDEX_CACHE_KIB = "32768";
  appendSessionCapture({ ...f.input, runId: "r2" });
  expect(db.query("PRAGMA cache_size").get()).toEqual({ cache_size: -16384 });
});
