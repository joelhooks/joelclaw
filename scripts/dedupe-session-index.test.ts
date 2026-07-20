import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(): { root: string; dbPath: string; runStore: string } {
  const root = mkdtempSync(join(tmpdir(), "session-index-dedupe-"));
  roots.push(root);
  const runStore = join(root, "runs");
  mkdirSync(runStore);
  const dbPath = join(root, "sessions.db");
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`CREATE TABLE runs (
    run_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL,
    from_offset INTEGER, to_offset INTEGER, jsonl_path TEXT NOT NULL,
    jsonl_bytes INTEGER NOT NULL, jsonl_sha256 TEXT NOT NULL,
    chunk_count INTEGER NOT NULL, captured_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE chunks (
    rowid INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL, chunk_idx INTEGER NOT NULL,
    role TEXT NOT NULL, text TEXT NOT NULL,
    started_at INTEGER NOT NULL, token_count INTEGER NOT NULL
  ) STRICT;
  CREATE VIRTUAL TABLE chunk_fts USING fts5(text, content='chunks', content_rowid='rowid');
  CREATE TABLE skipped_runs (run_id TEXT PRIMARY KEY) STRICT;`);
  const runs = [
    { id: "small", from: 0, to: 5, body: "abcde", captured: 1 },
    { id: "cover", from: 0, to: 10, body: "abcdefghij", captured: 2 },
    { id: "adjacent", from: 10, to: 13, body: "klm", captured: 3 },
  ];
  for (const run of runs) {
    const path = join(runStore, `${run.id}.jsonl`);
    writeFileSync(path, run.body);
    db.query("INSERT INTO runs VALUES (?, 'source', ?, ?, ?, ?, ?, 1, ?)")
      .run(run.id, run.from, run.to, path, run.body.length, sha256(run.body), run.captured);
    const inserted = db.query("INSERT INTO chunks(chunk_id,run_id,chunk_idx,role,text,started_at,token_count) VALUES (?, ?, 0, 'user', ?, 0, 1)")
      .run(`${run.id}:0`, run.id, run.body);
    db.query("INSERT INTO chunk_fts(rowid,text) VALUES (?, ?)").run(inserted.lastInsertRowid, run.body);
  }
  db.close(false);
  return { root, dbPath, runStore };
}

function runScript(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", join(import.meta.dir, "dedupe-session-index.ts"), ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("dedupe-session-index", () => {
  test("removes only a byte-proven covered Run and preserves adjacent bytes", () => {
    const { root, dbPath, runStore } = fixture();
    const manifest = join(root, "manifest.json");
    const receipt = join(root, "receipt.json");
    const backup = join(root, "sessions.backup.db");

    const plan = runScript(["--db", dbPath, "--run-store", runStore, "--manifest", manifest, "--receipt", receipt]);
    expect(plan.exitCode).toBe(0);
    const planned = JSON.parse(readFileSync(manifest, "utf8")) as {
      removals: Array<{ removed_run_id: string; covering_run_id: string }>;
      unresolved: unknown[];
    };
    expect(planned.removals.map(({ removed_run_id, covering_run_id }) => ({
      removed_run_id,
      covering_run_id,
    }))).toEqual([{ removed_run_id: "small", covering_run_id: "cover" }]);
    expect(planned.unresolved).toEqual([]);

    const applied = runScript([
      "--apply", "--db", dbPath, "--run-store", runStore,
      "--manifest", manifest, "--receipt", receipt, "--backup", backup,
    ]);
    expect(applied.exitCode).toBe(0);
    const appliedReceipt = JSON.parse(readFileSync(receipt, "utf8")) as {
      database_sha256_before: string;
      backup_sha256: string;
      raw_run_jsonl_mutated: boolean;
    };
    expect(appliedReceipt.backup_sha256).toBe(appliedReceipt.database_sha256_before);
    expect(appliedReceipt.raw_run_jsonl_mutated).toBe(false);

    const db = new Database(dbPath, { readwrite: true, strict: true });
    expect(db.query("SELECT run_id FROM runs ORDER BY run_id").all()).toEqual([
      { run_id: "adjacent" },
      { run_id: "cover" },
    ]);
    expect(db.query("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 2 });
    expect(db.query("SELECT count(*) AS n FROM chunk_fts").get()).toEqual({ n: 2 });
    db.close(false);
  });
});
