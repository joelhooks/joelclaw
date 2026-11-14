import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { COMPARE_RECHECK_MS } from "./config";
import { ShadowReadTimeoutError } from "./failure";
import type { CapturedPayload, ShadowVerdict } from "./types";

/*
 * compare: does the cell's shadow verdict match what the Inngest writer
 * left in sessions.db? sessions.db records only appended Runs, so the
 * writer's outcome is inferred: a row for the run_id means appended, a row
 * for another run at the same cursor means already_indexed, and no row
 * means a conflict or not yet indexed. Reads are short transactions in
 * batches; nothing is held open between them.
 *
 * Two kinds of mismatch, listed apart:
 * - verdict: the outcome or identity differs (verdict, matched run, source_identity).
 * - computed: the cell's own parse (computed_chunk_count, computed_turn_count)
 *   differs from what the writer stored. The stable-outcome chunk_count is
 *   never compared: when the writer wins the race it is the stored value.
 */

const BATCH = 200;
/** How far before --since a run's last turn may start and still be checked for "unseen". */
export const UNSEEN_ENDED_AT_SLACK_MS = 24 * 60 * 60_000;

interface IndexRow {
  run_id: string;
  chunk_count: number;
  turn_count: number;
  source_identity: string;
  jsonl_sha256: string;
}

export type IndexSide =
  | ({ kind: "run" } & IndexRow)
  | ({ kind: "cursor" } & IndexRow)
  | { kind: "absent" };

export type MismatchKind = "verdict" | "computed";

export interface Mismatch {
  run_id: string;
  kind: MismatchKind;
  reason: string;
  cell: Pick<
    ShadowVerdict,
    | "verdict"
    | "chunk_count"
    | "turn_count"
    | "computed_chunk_count"
    | "computed_turn_count"
    | "source_identity"
  > | null;
  index: IndexSide | null;
}

export interface CompareReport {
  direction?: "cell-to-index" | "index-to-cell";
  since: string;
  verdicts: number;
  matched: number;
  mismatched: number;
  verdict_mismatched: number;
  computed_mismatched: number;
  pending: number;
  unseen: number;
  match_rate: number | null;
  mismatches: Mismatch[];
  pending_runs: string[];
  unseen_runs: string[];
  unseen_scope: string;
}

export type Judgement =
  | { result: "match" }
  | { result: "pending" }
  | { result: "mismatch"; kind: MismatchKind; reason: string };

function diffJudgement(verdictDiffs: unknown[], computedDiffs: unknown[]): Judgement {
  const verdict = verdictDiffs.filter(Boolean);
  const computed = computedDiffs.filter(Boolean);
  if (verdict.length > 0) {
    const also = computed.length > 0 ? `; computed differs: ${computed.join(", ")}` : "";
    return { result: "mismatch", kind: "verdict", reason: `differs: ${verdict.join(", ")}${also}` };
  }
  if (computed.length > 0) {
    return {
      result: "mismatch",
      kind: "computed",
      reason: `computed differs: ${computed.join(", ")}`,
    };
  }
  return { result: "match" };
}

/** The cell's own parse against what the writer stored for the same bytes. */
function computedDiffs(verdict: ShadowVerdict, index: IndexRow): unknown[] {
  return [
    index.chunk_count !== verdict.computed_chunk_count && "chunk_count",
    index.turn_count !== verdict.computed_turn_count && "turn_count",
  ];
}

interface VerdictWithPayload extends ShadowVerdict {
  payload_json: string;
  arrived_at: number;
}

/** Judge one run: match, mismatch with a kind and a reason, or pending a recheck. */
export function judge(
  verdict: ShadowVerdict,
  index: IndexSide,
  now: number,
  cellSha256?: string,
): Judgement {
  const young = now - verdict.decided_at < COMPARE_RECHECK_MS;
  const mismatch = (reason: string): Judgement => ({ result: "mismatch", kind: "verdict", reason });
  if (verdict.verdict === "appended") {
    if (index.kind === "absent") {
      return young ? { result: "pending" } : mismatch("cell appended; index has no row");
    }
    if (index.kind === "cursor") return mismatch("cell appended; index kept another run");
    return diffJudgement(
      [index.source_identity !== verdict.source_identity && "source_identity"],
      computedDiffs(verdict, index),
    );
  }
  if (verdict.verdict === "already_indexed") {
    if (index.kind === "run") return mismatch("cell already_indexed; index appended this run");
    if (index.kind === "absent") return mismatch("cell already_indexed; index has no row");
    // A cursor match may be a prefix of different bytes: compare the parse only for the same bytes.
    const sameBytes = cellSha256 !== undefined && index.jsonl_sha256 === cellSha256;
    return diffJudgement(
      [
        index.run_id !== verdict.matched_run_id && "matched_run_id",
        index.source_identity !== verdict.source_identity && "source_identity",
      ],
      sameBytes ? computedDiffs(verdict, index) : [],
    );
  }
  return index.kind === "run"
    ? mismatch("cell conflict; index appended this run")
    : { result: "match" };
}

function openReadOnly(path: string, timeoutMs: number): Database {
  if (!existsSync(path)) throw new Error("session index not found");
  const db = new Database(path, { readonly: true, strict: true });
  db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
  return db;
}

function readIndexSides(db: Database, verdicts: VerdictWithPayload[]): Map<string, IndexSide> {
  const sides = new Map<string, IndexSide>();
  const columns = "run_id, chunk_count, turn_count, source_identity, jsonl_sha256";
  const byRun = db.query(`SELECT ${columns} FROM runs WHERE run_id = ?`);
  const byCursor = db.query(
    `SELECT ${columns} FROM runs WHERE source_identity = ? AND from_offset = ? LIMIT 1`,
  );
  for (let start = 0; start < verdicts.length; start += BATCH) {
    // One short read transaction per batch.
    db.transaction(() => {
      for (const verdict of verdicts.slice(start, start + BATCH)) {
        const run = byRun.get(verdict.run_id) as IndexRow | null;
        if (run) {
          sides.set(verdict.run_id, { kind: "run", ...run });
          continue;
        }
        const payload = JSON.parse(verdict.payload_json) as CapturedPayload;
        const cursor =
          payload.source_identity !== undefined && payload.from_offset !== undefined
            ? (byCursor.get(payload.source_identity, payload.from_offset) as IndexRow | null)
            : null;
        sides.set(verdict.run_id, cursor ? { kind: "cursor", ...cursor } : { kind: "absent" });
      }
    }).deferred();
  }
  return sides;
}

export function compare(
  outbox: Database,
  sessionsDbPath: string,
  since: number,
  now: number,
  busyTimeoutMs = 3_000,
): CompareReport {
  const verdicts = outbox
    .query(
      `SELECT v.*, c.payload_json, c.arrived_at FROM verdicts v JOIN captured c ON c.run_id = v.run_id
       WHERE c.arrived_at >= ? ORDER BY c.arrival_seq`,
    )
    .all(since) as VerdictWithPayload[];
  const noVerdict = outbox
    .query(
      `SELECT c.run_id, c.arrived_at FROM captured c LEFT JOIN verdicts v ON v.run_id = c.run_id
       WHERE c.arrived_at >= ? AND v.run_id IS NULL ORDER BY c.arrival_seq`,
    )
    .all(since) as Array<{ run_id: string; arrived_at: number }>;
  const seen = new Set(
    (outbox.query("SELECT run_id FROM captured").all() as Array<{ run_id: string }>).map(
      (row) => row.run_id,
    ),
  );

  const db = openReadOnly(sessionsDbPath, busyTimeoutMs);
  let sides: Map<string, IndexSide>;
  let indexedSince: string[];
  try {
    sides = readIndexSides(db, verdicts);
    // ended_at is indexed; captured_at is not. Bound the scan by ended_at.
    indexedSince = [];
    for (const page of readIndexPages(sessionsDbPath, since, busyTimeoutMs)) {
      indexedSince.push(...page.map((row) => row.run_id));
    }
  } finally {
    db.close(false);
  }

  const report: CompareReport = {
    since: new Date(since).toISOString(),
    verdicts: verdicts.length,
    matched: 0,
    mismatched: 0,
    verdict_mismatched: 0,
    computed_mismatched: 0,
    pending: 0,
    unseen: 0,
    match_rate: null,
    mismatches: [],
    pending_runs: [],
    unseen_runs: [],
    unseen_scope: `runs captured since --since whose last turn is at most ${UNSEEN_ENDED_AT_SLACK_MS / 3_600_000} h older`,
  };

  for (const verdict of verdicts) {
    const index = sides.get(verdict.run_id) ?? { kind: "absent" };
    const payload = JSON.parse(verdict.payload_json) as CapturedPayload;
    const judged = judge(verdict, index, now, payload.jsonl_sha256);
    if (judged.result === "match") report.matched += 1;
    else if (judged.result === "pending") {
      report.pending += 1;
      report.pending_runs.push(verdict.run_id);
    } else {
      report.mismatched += 1;
      if (judged.kind === "computed") report.computed_mismatched += 1;
      else report.verdict_mismatched += 1;
      report.mismatches.push({
        run_id: verdict.run_id,
        kind: judged.kind,
        reason: judged.reason,
        cell: {
          verdict: verdict.verdict,
          chunk_count: verdict.chunk_count,
          turn_count: verdict.turn_count,
          computed_chunk_count: verdict.computed_chunk_count,
          computed_turn_count: verdict.computed_turn_count,
          source_identity: verdict.source_identity,
        },
        index,
      });
    }
  }

  // The cell saw these but holds no verdict: owed, backing off, dead, or paused.
  for (const run of noVerdict) {
    if (now - run.arrived_at < COMPARE_RECHECK_MS) {
      report.pending += 1;
      report.pending_runs.push(run.run_id);
    } else {
      report.mismatched += 1;
      report.verdict_mismatched += 1;
      report.mismatches.push({
        run_id: run.run_id,
        kind: "verdict",
        reason: "cell has no verdict",
        cell: null,
        index: null,
      });
    }
  }

  for (const runId of indexedSince) {
    if (seen.has(runId)) continue;
    report.unseen += 1;
    report.unseen_runs.push(runId);
  }

  const judgedCount = report.matched + report.mismatched + report.unseen;
  report.match_rate = judgedCount === 0 ? null : report.matched / judgedCount;
  return report;
}

interface IndexPageRow extends IndexRow {
  rowid: number;
  ended_at: number;
  captured_at: number;
}

/** A new bounded connection/transaction per keyset page; never spans yields. */
export function* readIndexPages(
  path: string,
  since: number,
  timeoutMs: number,
): Generator<IndexPageRow[]> {
  let endedAt = since - UNSEEN_ENDED_AT_SLACK_MS;
  let rowid = 0;
  while (true) {
    const started = performance.now();
    const db = openReadOnly(path, timeoutMs);
    let page: IndexPageRow[];
    try {
      page = db
        .transaction(
          () =>
            db
              .query(`
        SELECT rowid, ended_at, captured_at, run_id, chunk_count, turn_count, source_identity, jsonl_sha256
        FROM runs WHERE (ended_at, rowid) > (?, ?) AND captured_at >= ?
        ORDER BY ended_at, rowid LIMIT ?
      `)
              .all(endedAt, rowid, since, BATCH) as IndexPageRow[],
        )
        .deferred();
    } finally {
      db.close(false);
    }
    if (performance.now() - started > timeoutMs) {
      throw new ShadowReadTimeoutError(performance.now() - started, timeoutMs);
    }
    if (page.length === 0) return;
    const last = page[page.length - 1]!;
    endedAt = last.ended_at;
    rowid = last.rowid;
    yield page;
    if (page.length < BATCH) return;
  }
}

/** Reverse shadow after cutover: start from indexed runs, then inspect the cell. */
export function compareIndexToCell(
  outbox: Database,
  sessionsDbPath: string,
  since: number,
  now: number,
  busyTimeoutMs = 3_000,
): CompareReport {
  const report: CompareReport = {
    direction: "index-to-cell",
    since: new Date(since).toISOString(),
    verdicts: 0,
    matched: 0,
    mismatched: 0,
    verdict_mismatched: 0,
    computed_mismatched: 0,
    pending: 0,
    unseen: 0,
    match_rate: null,
    mismatches: [],
    pending_runs: [],
    unseen_runs: [],
    unseen_scope: `indexed runs captured since --since whose last turn is at most ${UNSEEN_ENDED_AT_SLACK_MS / 3_600_000} h older`,
  };
  const lookup = outbox.query(`SELECT v.*, c.payload_json, c.arrived_at FROM captured c
    LEFT JOIN verdicts v ON v.run_id = c.run_id WHERE c.run_id = ?`);
  for (const page of readIndexPages(sessionsDbPath, since, busyTimeoutMs)) {
    // readIndexPages closed its sessions.db transaction and connection before this loop.
    for (const row of page) {
      report.verdicts += 1;
      const cell = lookup.get(row.run_id) as VerdictWithPayload | null;
      if (!cell) {
        report.unseen += 1;
        report.unseen_runs.push(row.run_id);
        continue;
      }
      const index: IndexSide = { kind: "run", ...row };
      const payload = JSON.parse(cell.payload_json) as CapturedPayload;
      const judged: Judgement = !cell.verdict
        ? now - row.captured_at < COMPARE_RECHECK_MS
          ? { result: "pending" }
          : { result: "mismatch", kind: "verdict", reason: "index has a run; cell has no verdict" }
        : payload.jsonl_sha256 !== row.jsonl_sha256
          ? { result: "mismatch", kind: "verdict", reason: "jsonl_sha256 differs" }
          : judge(cell, index, now, payload.jsonl_sha256);
      if (judged.result === "match") report.matched += 1;
      else if (judged.result === "pending") {
        report.pending += 1;
        report.pending_runs.push(row.run_id);
      } else {
        report.mismatched += 1;
        if (judged.kind === "computed") report.computed_mismatched += 1;
        else report.verdict_mismatched += 1;
        report.mismatches.push({
          run_id: row.run_id,
          kind: judged.kind,
          reason: judged.reason,
          cell: cell.verdict
            ? {
                verdict: cell.verdict,
                chunk_count: cell.chunk_count,
                turn_count: cell.turn_count,
                computed_chunk_count: cell.computed_chunk_count,
                computed_turn_count: cell.computed_turn_count,
                source_identity: cell.source_identity,
              }
            : null,
          index,
        });
      }
    }
  }
  const total = report.matched + report.mismatched + report.unseen;
  report.match_rate = total === 0 ? null : report.matched / total;
  return report;
}

export function formatCompareReport(report: CompareReport): string {
  const rate = report.match_rate === null ? "n/a" : `${(report.match_rate * 100).toFixed(2)}%`;
  const lines = [
    `capture-cell compare since ${report.since}: ${report.verdicts} verdicts, ${report.matched} match, ` +
      `${report.mismatched} mismatch (${report.verdict_mismatched} verdict, ` +
      `${report.computed_mismatched} computed), ${report.unseen} unseen by the cell, ${report.pending} pending ` +
      `(rechecked after ${COMPARE_RECHECK_MS / 60_000} min). Match rate ${rate}.`,
  ];
  const sections: Array<[MismatchKind, string]> = [
    ["verdict", "verdict mismatches:"],
    ["computed", "computed mismatches (the cell's own parse vs the index):"],
  ];
  for (const [kind, heading] of sections) {
    const listed = report.mismatches.filter((mismatch) => mismatch.kind === kind);
    if (listed.length === 0) continue;
    lines.push(heading);
    for (const mismatch of listed) {
      lines.push(
        `  ${mismatch.run_id}: ${mismatch.reason} cell=${JSON.stringify(mismatch.cell)} index=${JSON.stringify(mismatch.index)}`,
      );
    }
  }
  if (report.unseen_runs.length > 0) {
    lines.push(`indexed but never seen by the cell (${report.unseen_scope}):`);
    for (const runId of report.unseen_runs) lines.push(`  ${runId}`);
  }
  if (report.pending_runs.length > 0) {
    lines.push(`pending: ${report.pending_runs.join(", ")}`);
  }
  return lines.join("\n");
}
