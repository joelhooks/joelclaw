import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decide } from "./decide";
import type {
  CapturedPayload,
  CellEvent,
  Decision,
  Fact,
  OwedChange,
  OwedMarkerState,
  RunState,
  ShadowVerdict,
  Step,
} from "./types";

/*
 * The outbox: a SQLite file of its own, never sessions.db. Every save is
 * one BEGIN IMMEDIATE that reads a run's state, decides and writes the
 * decision; the drain reads due markers from it after each commit.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS captured (
  run_id TEXT PRIMARY KEY,
  arrival_seq INTEGER NOT NULL UNIQUE,
  session_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  writer INTEGER NOT NULL DEFAULT 0 CHECK (writer IN (0, 1)),
  arrived_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS owed (
  run_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('append', 'otel')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('owed', 'dead')),
  reason TEXT,
  replay TEXT,
  owed_since INTEGER NOT NULL,
  dead_at INTEGER,
  alerted_at INTEGER,
  PRIMARY KEY (run_id, step)
) STRICT;
CREATE INDEX IF NOT EXISTS owed_due ON owed(state, next_at);
CREATE TABLE IF NOT EXISTS verdicts (
  run_id TEXT PRIMARY KEY,
  verdict TEXT NOT NULL CHECK (verdict IN ('appended', 'already_indexed', 'conflict')),
  observed TEXT NOT NULL,
  matched TEXT,
  matched_run_id TEXT,
  chunk_count INTEGER NOT NULL,
  turn_count INTEGER NOT NULL,
  format TEXT NOT NULL,
  computed_chunk_count INTEGER NOT NULL,
  computed_turn_count INTEGER NOT NULL,
  computed_format TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  decided_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS verdicts_decided_at ON verdicts(decided_at);
CREATE TABLE IF NOT EXISTS otel_pending (
  run_id TEXT NOT NULL,
  step TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (run_id, step)
) STRICT;
CREATE TABLE IF NOT EXISTS handbacks (
  run_id TEXT PRIMARY KEY REFERENCES captured(run_id),
  event_json TEXT NOT NULL,
  handed_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS cell_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

export function openOutbox(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, readwrite: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // A 202 promises a durable save, not merely a process-crash-safe WAL write.
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA);
  // Only the outbox migrates. Historical shadow rows must remain read-only
  // across cutover; writer debts must survive rollback without a fake verdict.
  db.transaction(() => {
    const columns = db.query("PRAGMA table_info(captured)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "writer")) {
      db.exec(
        "ALTER TABLE captured ADD COLUMN writer INTEGER NOT NULL DEFAULT 0 CHECK (writer IN (0, 1))",
      );
    }
  }).immediate();
  return db;
}

interface VerdictRow {
  run_id: string;
  verdict: ShadowVerdict["verdict"];
  observed: ShadowVerdict["observed"];
  matched: ShadowVerdict["matched"];
  matched_run_id: string | null;
  chunk_count: number;
  turn_count: number;
  format: ShadowVerdict["format"];
  computed_chunk_count: number;
  computed_turn_count: number;
  computed_format: ShadowVerdict["format"];
  source_identity: string;
  duration_ms: number;
  decided_at: number;
}

export function readVerdict(db: Database, runId: string): ShadowVerdict | null {
  return (
    (db.query("SELECT * FROM verdicts WHERE run_id = ?").get(runId) as VerdictRow | null) ?? null
  );
}

/** Read what the fold needs about one run. */
export function readRunState(db: Database, runId: string): RunState {
  const captured = db
    .query("SELECT session_key, payload_json, writer FROM captured WHERE run_id = ?")
    .get(runId) as { session_key: string; payload_json: string; writer: number } | null;
  const owed = new Map<Step, OwedMarkerState>();
  for (const row of db
    .query("SELECT step, attempts, state FROM owed WHERE run_id = ?")
    .all(runId) as Array<{ step: Step; attempts: number; state: "owed" | "dead" }>) {
    owed.set(row.step, { attempts: row.attempts, state: row.state });
  }
  const otelPending = new Set(
    (
      db.query("SELECT step FROM otel_pending WHERE run_id = ?").all(runId) as Array<{ step: Step }>
    ).map((row) => row.step),
  );
  return {
    captured: captured
      ? {
          session_key: captured.session_key,
          payload: JSON.parse(captured.payload_json) as CapturedPayload,
          writer: captured.writer === 1,
        }
      : null,
    owed,
    verdict: readVerdict(db, runId),
    otelPending,
  };
}

function writeFact(db: Database, fact: Fact): void {
  switch (fact.kind) {
    case "captured":
      // Arrival order is an explicit sequence: rowids may renumber on VACUUM.
      db.query(
        `INSERT OR IGNORE INTO captured (run_id, arrival_seq, session_key, payload_json, arrived_at, writer)
         VALUES (?, (SELECT COALESCE(MAX(arrival_seq), 0) + 1 FROM captured), ?, ?, ?, ?)`,
      ).run(
        fact.run_id,
        fact.session_key,
        JSON.stringify(fact.payload),
        fact.arrived_at,
        fact.writer ? 1 : 0,
      );
      return;
    case "writer_adopted":
      db.query("UPDATE captured SET writer = 1 WHERE run_id = ?").run(fact.run_id);
      return;
    case "verdict": {
      const v = fact.verdict;
      db.query(
        `INSERT OR IGNORE INTO verdicts (run_id, verdict, observed, matched, matched_run_id,
           chunk_count, turn_count, format, computed_chunk_count, computed_turn_count,
           computed_format, source_identity, duration_ms, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        v.run_id,
        v.verdict,
        v.observed,
        v.matched,
        v.matched_run_id,
        v.chunk_count,
        v.turn_count,
        v.format,
        v.computed_chunk_count,
        v.computed_turn_count,
        v.computed_format,
        v.source_identity,
        v.duration_ms,
        v.decided_at,
      );
      return;
    }
    case "otel_pending":
      db.query(
        "INSERT OR IGNORE INTO otel_pending (run_id, step, event_json) VALUES (?, ?, ?)",
      ).run(fact.run_id, fact.step, JSON.stringify(fact.event));
      return;
    case "otel_shipped":
      db.query("DELETE FROM otel_pending WHERE run_id = ? AND step = ?").run(
        fact.run_id,
        fact.step,
      );
      return;
  }
}

function writeOwed(db: Database, change: OwedChange): void {
  switch (change.kind) {
    case "owe":
      db.query(
        `INSERT OR IGNORE INTO owed (run_id, step, attempts, next_at, state, owed_since)
         VALUES (?, ?, 0, ?, 'owed', ?)`,
      ).run(change.run_id, change.step, change.next_at, change.next_at);
      return;
    case "revive":
      db.query(
        `UPDATE owed SET state = 'owed', attempts = 0, next_at = ?, owed_since = ?,
           reason = NULL, replay = NULL, dead_at = NULL, alerted_at = NULL
         WHERE run_id = ? AND step = ?`,
      ).run(change.next_at, change.next_at, change.run_id, change.step);
      return;
    case "retry":
      db.query(
        "UPDATE owed SET attempts = ?, next_at = ?, reason = ? WHERE run_id = ? AND step = ? AND state = 'owed'",
      ).run(change.attempts, change.next_at, change.reason, change.run_id, change.step);
      return;
    case "dead":
      db.query(
        `UPDATE owed SET state = 'dead', attempts = ?, reason = ?, replay = ?, dead_at = ?
         WHERE run_id = ? AND step = ?`,
      ).run(change.attempts, change.reason, change.replay, change.at, change.run_id, change.step);
      return;
    case "settled":
      db.query("DELETE FROM owed WHERE run_id = ? AND step = ?").run(change.run_id, change.step);
      return;
  }
}

function writeDecision(db: Database, facts: readonly Fact[], owed: readonly OwedChange[]): void {
  for (const fact of facts) writeFact(db, fact);
  for (const change of owed) writeOwed(db, change);
}

/** Write one decision in one BEGIN IMMEDIATE: all of it, or none of it. */
export function apply(db: Database, facts: readonly Fact[], owed: readonly OwedChange[]): void {
  db.transaction(() => writeDecision(db, facts, owed)).immediate();
}

function runIdOf(event: CellEvent): string {
  return event.type === "captured" ? event.payload.run_id : event.run_id;
}

/** Operator replay: owe the run's steps again. Never touches blobs or sessions.db. */
export function replay(db: Database, runId: string, now: number): boolean {
  return fold(db, { type: "replayed", run_id: runId, at: now }).owed.length > 0;
}

/**
 * The single save: read the run's state, decide and apply, all inside one
 * BEGIN IMMEDIATE, so nothing interleaves between the read and the write.
 */
export function fold(db: Database, event: CellEvent): Decision {
  return db
    .transaction(() => {
      // A handed-back run belongs to Inngest, including operator replays.
      if (
        (event.type === "replayed" && isHandedBack(db, event.run_id)) ||
        (event.type === "captured" && isHandedBack(db, event.payload.run_id))
      )
        return { facts: [], owed: [] };
      const decision = decide(readRunState(db, runIdOf(event)), event);
      writeDecision(db, decision.facts, decision.owed);
      return decision;
    })
    .immediate();
}

/** Transfer ownership is durable before the first network send. */
export function isHandedBack(db: Database, runId: string): boolean {
  return db.query("SELECT 1 FROM handbacks WHERE run_id = ?").get(runId) !== null;
}

export interface DueMarker {
  run_id: string;
  step: Step;
  attempts: number;
  session_key: string;
  writer: number;
}

/**
 * The oldest due marker whose session isn't in flight, in arrival order.
 * It never waits for a gap: an earlier run still backing off doesn't hold
 * back a later one. A run's otel waits until its append is no longer owed.
 */
export function nextDueMarker(
  db: Database,
  now: number,
  inFlightSessions: readonly string[],
  steps: readonly Step[],
  allowWriter = true,
): DueMarker | null {
  if (steps.length === 0) return null;
  return (
    (db
      .query(
        `SELECT o.run_id, o.step, o.attempts, c.session_key, c.writer
         FROM owed o JOIN captured c ON c.run_id = o.run_id
         WHERE o.state = 'owed' AND o.next_at <= ?
           AND (o.step <> 'append' OR c.writer = 0 OR ? = 1)
           AND NOT (o.step = 'append' AND EXISTS (
             SELECT 1 FROM handbacks h WHERE h.run_id = o.run_id))
           AND o.step IN (SELECT value FROM json_each(?))
           AND c.session_key NOT IN (SELECT value FROM json_each(?))
           AND NOT (o.step = 'otel' AND EXISTS (
             SELECT 1 FROM owed a WHERE a.run_id = o.run_id AND a.step = 'append'))
         ORDER BY c.arrival_seq, CASE o.step WHEN 'append' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(
        now,
        allowWriter ? 1 : 0,
        JSON.stringify(steps),
        JSON.stringify(inFlightSessions),
      ) as DueMarker | null) ?? null
  );
}

/** When the next backed-off marker comes due, if any. */
export function nextWakeAt(db: Database, allowWriter = true): number | null {
  const row = db
    .query(`SELECT MIN(o.next_at) AS at FROM owed o
    JOIN captured c ON c.run_id = o.run_id WHERE o.state = 'owed'
      AND (o.step <> 'append' OR ((c.writer = 0 OR ? = 1)
        AND NOT EXISTS (SELECT 1 FROM handbacks h WHERE h.run_id = o.run_id)))
      AND NOT (o.step = 'otel' AND EXISTS (
        SELECT 1 FROM owed a WHERE a.run_id = o.run_id AND a.step = 'append'))`)
    .get(allowWriter ? 1 : 0) as { at: number | null };
  return row.at;
}

export function readCapturedEntry(
  db: Database,
  runId: string,
): { payload: CapturedPayload; writer: boolean } | null {
  const row = db.query("SELECT payload_json, writer FROM captured WHERE run_id = ?").get(runId) as {
    payload_json: string;
    writer: number;
  } | null;
  return row
    ? { payload: JSON.parse(row.payload_json) as CapturedPayload, writer: row.writer === 1 }
    : null;
}

export function readCaptured(db: Database, runId: string): CapturedPayload | null {
  return readCapturedEntry(db, runId)?.payload ?? null;
}

export function readOtelPending(db: Database, runId: string) {
  return (
    db
      .query("SELECT step, event_json FROM otel_pending WHERE run_id = ? ORDER BY step")
      .all(runId) as Array<{
      step: Step;
      event_json: string;
    }>
  ).map((row) => ({
    step: row.step,
    event: JSON.parse(row.event_json) as Record<string, unknown>,
  }));
}

export function readCellState<T>(db: Database, key: string): T | null {
  const row = db.query("SELECT value_json FROM cell_state WHERE key = ?").get(key) as {
    value_json: string;
  } | null;
  return row ? (JSON.parse(row.value_json) as T) : null;
}

export function writeCellState(db: Database, key: string, value: unknown, now: number): void {
  if (value === null) {
    db.query("DELETE FROM cell_state WHERE key = ?").run(key);
    return;
  }
  db.query(
    `INSERT INTO cell_state (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}

export const WAL_PAUSE_KEY = "wal_paused";

export interface WalPause {
  since: number;
  wal_bytes: number;
  limit_bytes: number;
  reason: string;
}

export interface CellHealth {
  ok: boolean;
  mode: "shadow" | "cell";
  depth: number;
  oldest_owed_age_ms: number | null;
  dead: number;
  verdicts: number;
  wal_paused: WalPause | null;
}

export function readHealth(
  db: Database,
  now: number,
  mode: "shadow" | "cell" = "shadow",
): CellHealth {
  const owed = db
    .query("SELECT COUNT(*) AS depth, MIN(owed_since) AS oldest FROM owed WHERE state = 'owed'")
    .get() as { depth: number; oldest: number | null };
  const dead = db.query("SELECT COUNT(*) AS n FROM owed WHERE state = 'dead'").get() as {
    n: number;
  };
  const verdicts = db.query("SELECT COUNT(*) AS n FROM verdicts").get() as { n: number };
  return {
    ok: true,
    mode,
    depth: owed.depth,
    oldest_owed_age_ms: owed.oldest === null ? null : Math.max(0, now - owed.oldest),
    dead: dead.n,
    verdicts: verdicts.n,
    wal_paused: readCellState<WalPause>(db, WAL_PAUSE_KEY),
  };
}
