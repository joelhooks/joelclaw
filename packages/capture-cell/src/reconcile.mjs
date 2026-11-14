import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reconcileFailure, logReconcileFailure } from "./reconcile-error.mjs";

const TEN_MINUTES = 600_000;
export const DEFAULT_WAIT_ALARM_MS = 7_200_000;
const LEASE_MS = 120_000;
const BATCH = 200;
const TERMINAL = new Set(["indexed", "empty", "gave_up"]);

/**
 * Lifecycle sketch (XState v5 terms, persisted in SQLite):
 * waiting -- RESERVE --> sending -- ACCEPTED --> resent -- DUE --> waiting
 * sending -- CRASH/UNKNOWN --> sending (same attempt, payload and event id)
 * waiting -- WAIT_CEILING --> waiting (wait_alarmed latch, alarm only)
 * wait_alarmed -- TICK --> waiting (never resend, even if PG history expires)
 * any nonterminal -- INDEXED/EMPTY --> indexed/empty
 * waiting -- ATTEMPTS_EXHAUSTED --> gave_up; any -- INVALID_BLOB --> gave_up
 * Pass alarm: clear -- FAILED_WITH_PENDING --> latched (same durable alarm path)
 * latched -- FAILED --> latched; latched -- SUCCESS --> clear. No resend effect.
 * A pass lease excludes other writers. Its owner renews before each bounded
 * external call and fences every state write. A crash leaves the reserved
 * event intact. Every POST reservation counts against the three-send ceiling,
 * including a crash or unknown HTTP outcome. Unknown outcomes reuse that id.
 */
export function openReconcileState(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") chmodSync(file, 0o600);
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS reconcile_runs (
      run_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('waiting','sending','resent','indexed','empty','gave_up')),
      attempts INTEGER NOT NULL DEFAULT 0,
      classification TEXT NOT NULL,
      event_json TEXT,
      next_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      handled_at INTEGER,
      alarm_reason TEXT,
      alarmed_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS reconcile_lease (
      id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires_at INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO reconcile_lease VALUES (1,NULL,0);
    CREATE TABLE IF NOT EXISTS reconcile_pass_alarm (
      id INTEGER PRIMARY KEY CHECK(id=1),
      failed_alarmed INTEGER NOT NULL DEFAULT 0 CHECK(failed_alarmed IN (0,1)),
      failure_json TEXT, alarmed_at INTEGER
    ) STRICT;
    INSERT OR IGNORE INTO reconcile_pass_alarm(id) VALUES (1);
  `);
  // Additive migration keeps existing receipts and the original state CHECK.
  // Serialize schema inspection too, so concurrent first opens cannot race.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare("PRAGMA table_info(reconcile_runs)")
        .all()
        .some((column) => column.name === "wait_alarmed")
    )
      db.exec(
        "ALTER TABLE reconcile_runs ADD COLUMN wait_alarmed INTEGER NOT NULL DEFAULT 0 CHECK(wait_alarmed IN (0,1))",
      );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  return db;
}

export function openReconcileSource(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 3000; PRAGMA query_only = ON");
  return db;
}

export function classifyCapture(rows) {
  // A completed empty capture is not a loss, even if a duplicate failed.
  if (rows.some((row) => row.status === "Completed" && row.output?.chunks_indexed === 0))
    return "empty";
  // A queued/running run has no finish. Completed nonempty runs wait for the
  // index to become visible. Unknown statuses fail closed, not as missing.
  if (rows.some((row) => row.has_run && !["Failed", "Cancelled"].includes(row.status)))
    return "waiting";
  return rows.length === 0 ? "missing_event" : "missing_run";
}

function payloadOf(value, runId) {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !data ||
    data.run_id !== runId ||
    typeof data.user_id !== "string" ||
    !data.user_id ||
    typeof data.machine_id !== "string" ||
    !data.machine_id ||
    typeof data.agent_runtime !== "string" ||
    !data.agent_runtime ||
    typeof data.jsonl_path !== "string" ||
    !data.jsonl_path ||
    !Number.isSafeInteger(data.jsonl_bytes) ||
    data.jsonl_bytes < 0 ||
    typeof data.jsonl_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(data.jsonl_sha256)
  )
    throw new Error("invalid_payload");
  return data;
}

/** Stream from one descriptor: no whole-transcript allocation or modification. */
export async function verifyReconcileBlob(data) {
  const file = await open(data.jsonl_path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== data.jsonl_bytes) throw new Error("blob_mismatch");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const after = await file.stat();
    if (
      bytes !== data.jsonl_bytes ||
      hash.digest("hex") !== data.jsonl_sha256 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error("blob_mismatch");
  } finally {
    await file.close();
  }
}

const indexed = (db, runId) =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM runs WHERE run_id=? UNION ALL SELECT 1 FROM skipped_runs WHERE run_id=? LIMIT 1",
      )
      .get(runId, runId),
  );

/**
 * All inputs are explicit. The cell and index handles MUST be read-only.
 * lookup receives up to 200 ids, never one expensive Postgres scan per run.
 * @param {{cell: DatabaseSync, index: DatabaseSync, state: DatabaseSync,
 * lookup: (ids: string[]) => Promise<object[]>, send: (event: object) => Promise<void>,
 * telemetry: import('@joelclaw/telemetry').TelemetryEmitter,
 * load: () => number, now?: () => number, log?: (line: string) => void,
 * limit?: number, loadLimit?: number, waitAlarmMs?: number, apply?: boolean}} deps
 */
export async function reconcileCaptures(deps) {
  const {
    cell,
    index,
    state,
    lookup,
    send,
    telemetry,
    load,
    now = Date.now,
    log = console.log,
    limit = 20,
    loadLimit = 40,
    waitAlarmMs = DEFAULT_WAIT_ALARM_MS,
    apply = false,
  } = deps;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid_limit");
  if (!Number.isFinite(loadLimit) || loadLimit <= 0) throw new Error("invalid_load_limit");
  if (!Number.isSafeInteger(waitAlarmMs) || waitAlarmMs <= 0)
    throw new Error("invalid_wait_alarm_ms");
  const counts = {
    found: 0,
    resent: 0,
    empty: 0,
    waiting: 0,
    wait_alarmed: 0,
    gave_up: 0,
    indexed: 0,
    would_resend: 0,
    attempted: 0,
    failed: 0,
    skipped: null,
  };
  const oneMinuteLoad = load();
  if (!Number.isFinite(oneMinuteLoad) || oneMinuteLoad > loadLimit) {
    counts.skipped = "load";
    log("capture.reconcile.skipped reason=load");
    telemetry.emit("capture.reconcile.skipped", "Load gate", {
      reason: "load",
      load: oneMinuteLoad,
    });
    return counts;
  }
  const owner = randomUUID();
  if (
    apply &&
    !state
      .prepare(`UPDATE reconcile_lease SET owner=?,expires_at=?
      WHERE id=1 AND expires_at<=?`)
      .run(owner, now() + LEASE_MS, now()).changes
  ) {
    counts.skipped = "locked";
    log("capture.reconcile.skipped reason=locked");
    telemetry.emit("capture.reconcile.skipped", "Pass lease held", { reason: "locked" });
    return counts;
  }
  const renew = () => {
    if (
      apply &&
      !state
        .prepare(`UPDATE reconcile_lease SET expires_at=?
        WHERE id=1 AND owner=? AND expires_at>?`)
        .run(now() + LEASE_MS, owner, now()).changes
    )
      throw new Error("lease_lost");
  };
  const save = (runId, status, classification, extra = {}) => {
    if (!apply) return;
    renew();
    const old = state.prepare("SELECT * FROM reconcile_runs WHERE run_id=?").get(runId);
    state
      .prepare(`INSERT INTO reconcile_runs
      (run_id,state,attempts,classification,event_json,next_at,created_at,updated_at,handled_at,alarm_reason,wait_alarmed)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      state=excluded.state,attempts=excluded.attempts,classification=excluded.classification,
      event_json=excluded.event_json,next_at=excluded.next_at,updated_at=excluded.updated_at,
      handled_at=excluded.handled_at,alarm_reason=excluded.alarm_reason,wait_alarmed=excluded.wait_alarmed`)
      .run(
        runId,
        status,
        extra.attempts ?? old?.attempts ?? 0,
        classification,
        extra.event_json ?? old?.event_json ?? null,
        extra.next_at ?? 0,
        old?.created_at ?? now(),
        now(),
        TERMINAL.has(status) ? now() : null,
        extra.alarm_reason ??
          (old?.wait_alarmed && !TERMINAL.has(status) ? old.alarm_reason : null),
        TERMINAL.has(status) ? 0 : (extra.wait_alarmed ?? old?.wait_alarmed ?? 0),
      );
  };
  let pendingCandidates = 0,
    passFailure;
  const readIndex = (runId) => {
    try {
      return indexed(index, runId);
    } catch (error) {
      throw reconcileFailure(error, "index");
    }
  };
  const recordFailure = (error) => {
    const failure = reconcileFailure(error);
    if (!failure.logged) {
      logReconcileFailure(failure, log);
      failure.logged = true;
      telemetry.emit("capture.reconcile.failed", "Reconciliation pass failed", {
        level: "error",
        ...failure.failure,
      });
    }
    if (apply && pendingCandidates > 0) {
      try {
        renew();
        state
          .prepare(`UPDATE reconcile_pass_alarm SET failed_alarmed=1,failure_json=?,alarmed_at=NULL
          WHERE id=1 AND failed_alarmed=0`)
          .run(JSON.stringify(failure.failure));
      } catch {
        // Lost leases and unwritable state cannot safely persist an alarm.
        // Keep the original diagnostic instead of hiding it behind that failure.
        log("capture.reconcile.alarm_persist_failed");
      }
    }
    return failure;
  };
  const giveUp = (runId, reason) => {
    counts.gave_up++;
    save(runId, "gave_up", reason, { alarm_reason: reason });
  };
  try {
    let cursor = 0;
    outer: for (;;) {
      renew();
      const batch = cell
        .prepare(`SELECT c.run_id,c.payload_json,c.arrival_seq
        FROM captured c JOIN verdicts v ON v.run_id=c.run_id
        WHERE v.verdict='appended' AND c.arrived_at<? AND v.decided_at<? AND c.arrival_seq>?
        ORDER BY c.arrival_seq LIMIT ?`)
        .all(now() - TEN_MINUTES, now() - TEN_MINUTES, cursor, BATCH);
      if (!batch.length) break;
      cursor = batch.at(-1).arrival_seq;
      const candidates = [];
      for (const row of batch) {
        if (!/^[a-zA-Z0-9._:-]{1,200}$/u.test(row.run_id)) throw new Error("invalid_run_id");
        const old = state.prepare("SELECT * FROM reconcile_runs WHERE run_id=?").get(row.run_id);
        if (TERMINAL.has(old?.state)) continue;
        pendingCandidates++;
        if (readIndex(row.run_id)) {
          pendingCandidates--;
          save(row.run_id, "indexed", "indexed");
          counts.indexed++;
          continue;
        }
        if ((old?.next_at ?? 0) > now()) continue;
        candidates.push({ ...row, old });
      }
      if (!candidates.length) continue;
      renew();
      // Any query/parse/schema failure aborts the pass. Never treat it as []:
      // "could not read Postgres" is not proof that events are missing.
      let observations;
      try {
        observations = await lookup(candidates.map((row) => row.run_id));
      } catch (error) {
        throw reconcileFailure(error, "pg");
      }
      renew();
      for (const row of candidates) {
        const { run_id: runId, old } = row;
        if (readIndex(runId)) {
          save(runId, "indexed", "indexed");
          counts.indexed++;
          continue;
        }
        counts.found++;
        const events = observations.filter((event) => event.run_id === runId);
        const classification = classifyCapture(events);
        if (classification === "empty") {
          save(runId, "empty", "empty");
          counts.empty++;
          continue;
        }
        if (classification === "waiting" || old?.wait_alarmed) {
          const overCeiling = now() - (old?.created_at ?? now()) >= waitAlarmMs;
          const newlyAlarmed = overCeiling && !old?.wait_alarmed;
          save(runId, "waiting", "waiting", {
            next_at: now() + TEN_MINUTES,
            ...(newlyAlarmed ? { wait_alarmed: 1, alarm_reason: "wait_ceiling_exceeded" } : {}),
          });
          counts.waiting++;
          if (newlyAlarmed) counts.wait_alarmed++;
          continue;
        }
        // Unknown transport outcomes retry the reserved event, not a fresh id.
        if ((old?.attempts ?? 0) >= 3) {
          giveUp(runId, "attempts_exhausted");
          continue;
        }
        let event;
        try {
          const data = payloadOf(
            old?.state === "sending"
              ? JSON.parse(old.event_json).data
              : (events[0]?.event_data ?? row.payload_json),
            runId,
          );
          event = {
            name: "memory/run.captured",
            data,
            id:
              old?.state === "sending"
                ? JSON.parse(old.event_json).id
                : `reconcile:${runId}:${(old?.attempts ?? 0) + 1}`,
          };
          await verifyReconcileBlob(data);
        } catch {
          giveUp(runId, "blob_or_payload_invalid");
          continue;
        }
        renew();
        // The index writer may have won while the blob was being hashed.
        if (readIndex(runId)) {
          save(runId, "indexed", "indexed");
          counts.indexed++;
          continue;
        }
        if (!apply) {
          counts.would_resend++;
        } else {
          save(runId, "sending", classification, {
            event_json: JSON.stringify(event),
            attempts: (old?.attempts ?? 0) + 1,
          });
          counts.attempted++;
          try {
            await send(event);
          } catch (error) {
            passFailure ??= reconcileFailure(error, "post");
            // An HTTP timeout may have been accepted. Keep this attempt's id.
            save(runId, "sending", "send_unknown", { next_at: now() + TEN_MINUTES });
            counts.failed++;
            if (counts.attempted >= limit) break outer;
            continue;
          }
          save(runId, "resent", classification, { next_at: now() + TEN_MINUTES });
          counts.resent++;
        }
        if (counts.attempted + counts.would_resend >= limit) break outer;
      }
    }
    if (passFailure) recordFailure(passFailure);
    else if (apply) {
      renew();
      state.exec(
        `UPDATE reconcile_pass_alarm SET failed_alarmed=0,failure_json=NULL,alarmed_at=NULL WHERE id=1`,
      );
    }
    for (const action of ["found", "resent", "empty", "waiting", "wait_alarmed", "gave_up"])
      telemetry.emit(`capture.reconcile.${action}`, "Capture reconciliation pass", { ...counts });
    log(`capture.reconcile.pass ${JSON.stringify(counts)}`);
    return counts;
  } catch (error) {
    throw recordFailure(error);
  } finally {
    if (apply)
      state
        .prepare("UPDATE reconcile_lease SET owner=NULL,expires_at=0 WHERE id=1 AND owner=?")
        .run(owner);
  }
}

/** Separate durable alarms from pass counters; acknowledge only after OTEL succeeds. */
export async function flushReconcileAlarms(state, telemetry, flush, log = console.log) {
  const alarms = state
    .prepare(`SELECT run_id,attempts,alarm_reason FROM reconcile_runs
    WHERE alarm_reason IS NOT NULL AND alarmed_at IS NULL`)
    .all();
  for (const row of alarms) {
    log(
      `notifyAgent capture.reconcile.gave_up run_id=${row.run_id} reason=${row.alarm_reason} attempts=${row.attempts}`,
    );
    telemetry.emit("capture.reconcile.gave_up", "Capture reconciliation alarm", {
      ...row,
      level: "error",
    });
  }
  const passAlarm = state
    .prepare(`SELECT failure_json FROM reconcile_pass_alarm
    WHERE id=1 AND failed_alarmed=1 AND alarmed_at IS NULL`)
    .get();
  if (passAlarm) {
    log("notifyAgent capture.reconcile.gave_up scope=pass reason=pass_failed attempts=0");
    telemetry.emit("capture.reconcile.gave_up", "Capture reconciliation alarm", {
      scope: "pass",
      alarm_reason: "pass_failed",
      level: "error",
      ...JSON.parse(passAlarm.failure_json),
    });
  }
  await flush();
  if (passAlarm)
    state
      .prepare(`UPDATE reconcile_pass_alarm SET alarmed_at=?
      WHERE id=1 AND failed_alarmed=1 AND alarmed_at IS NULL`)
      .run(Date.now());
  for (const row of alarms)
    state
      .prepare(`UPDATE reconcile_runs SET alarmed_at=?
    WHERE run_id=? AND alarm_reason=? AND alarmed_at IS NULL`)
      .run(Date.now(), row.run_id, row.alarm_reason);
}

export function assertSeparateReconcilePaths(cell, index, state) {
  if (new Set([cell, index, state].map((file) => resolve(file))).size !== 3)
    throw new Error("database_paths_must_differ");
}
