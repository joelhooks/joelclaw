import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSessionSourceCursor } from "./session-index";
import {
  classifyHistoricalSourceCursorFields,
  isHistoricalRunTimestamp,
  parseHistoricalSourceCursorClaim,
} from "./source-cursor";

const source = `sha256:${"a".repeat(64)}`;

test("historical cursor fields distinguish absent legacy pairs from malformed mixed fields", () => {
  expect(classifyHistoricalSourceCursorFields({})).toEqual({ _tag: "Absent" });
  expect(
    classifyHistoricalSourceCursorFields({ source_identity: null, from_offset: null }),
  ).toEqual({ _tag: "Absent" });
  expect(
    classifyHistoricalSourceCursorFields({ source_identity: undefined, from_offset: null }),
  ).toEqual({ _tag: "Absent" });
  expect(classifyHistoricalSourceCursorFields(null)).toEqual({ _tag: "Invalid" });
  expect(classifyHistoricalSourceCursorFields([])).toEqual({ _tag: "Invalid" });
  expect(
    classifyHistoricalSourceCursorFields({ source_identity: null, from_offset: 0 }),
  ).toEqual({ _tag: "Invalid" });
  expect(
    classifyHistoricalSourceCursorFields({ source_identity: source, from_offset: null }),
  ).toEqual({ _tag: "Invalid" });
  expect(
    classifyHistoricalSourceCursorFields({ source_identity: source, from_offset: 0 }),
  ).toEqual({ _tag: "Valid", sourceIdentity: source, fromOffset: 0 });
});

test("historical claims preserve finite fractional timestamps in the valid Date range", () => {
  expect(isHistoricalRunTimestamp(10.25)).toBe(true);
  expect(isHistoricalRunTimestamp(8_640_000_000_000_000)).toBe(true);
  expect(isHistoricalRunTimestamp(-0.25)).toBe(false);
  expect(isHistoricalRunTimestamp(8_640_000_000_000_001)).toBe(false);
  expect(isHistoricalRunTimestamp(Number.NaN)).toBe(false);
  expect(isHistoricalRunTimestamp(Number.POSITIVE_INFINITY)).toBe(false);
  expect(parseHistoricalSourceCursorClaim({ run_id: "historical", started_at: 10.25 })).toEqual({
    run_id: "historical",
    started_at: 10.25,
  });
  expect(parseHistoricalSourceCursorClaim({ run_id: "historical", started_at: -1 })).toBeNull();
  expect(parseHistoricalSourceCursorClaim("not-an-object")).toBeNull();
});

test("session index source-cursor lookup reads an exact historical fractional timestamp", () => {
  const root = mkdtempSync(join(tmpdir(), "session-source-cursor-"));
  const databasePath = join(root, "sessions.db");
  const db = new Database(databasePath, { create: true, strict: true });
  db.exec(`CREATE TABLE runs (
    run_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source_identity TEXT NOT NULL,
    from_offset INTEGER NOT NULL,
    started_at REAL NOT NULL,
    captured_at INTEGER NOT NULL
  )`);
  db.query(`INSERT INTO runs
    (run_id, user_id, source_identity, from_offset, started_at, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run("historical-run", "user", source, 0, 10.25, 1);
  db.close(false);

  try {
    expect(findSessionSourceCursor(databasePath, "user", source, 0)).toEqual({
      run_id: "historical-run",
      started_at: 10.25,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
