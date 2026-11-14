import type { Database } from "bun:sqlite";
import { AGE_ALERT_MS } from "./config";
import { readCellState, writeCellState } from "./outbox";

/*
 * Alerts are plain lines on stdout for the desk to relay; the cell has no
 * messaging client. Each dead row alerts once. The age alarm alerts once
 * per stuck marker and re-arms when the oldest marker changes or recovers.
 */

const AGE_ALERT_KEY = "age_alert";

interface AgeAlertState {
  run_id: string;
  step: string;
  owed_since: number;
}

export function collectAlerts(db: Database, now: number): string[] {
  return db
    .transaction(() => {
      const lines: string[] = [];
      const dead = db
        .query(
          `SELECT run_id, step, reason, replay FROM owed WHERE state = 'dead' AND alerted_at IS NULL
           ORDER BY dead_at, run_id`,
        )
        .all() as Array<{
        run_id: string;
        step: string;
        reason: string | null;
        replay: string | null;
      }>;
      for (const row of dead) {
        lines.push(
          `capture-cell dead: run ${row.run_id} step ${row.step}: ${row.reason ?? "unknown"}. Revive with: ${row.replay ?? `capture-cell replay ${row.run_id}`}`,
        );
        db.query("UPDATE owed SET alerted_at = ? WHERE run_id = ? AND step = ?").run(
          now,
          row.run_id,
          row.step,
        );
      }

      const oldest = db
        .query(
          `SELECT run_id, step, owed_since, (SELECT COUNT(*) FROM owed WHERE state = 'owed') AS depth
           FROM owed WHERE state = 'owed' ORDER BY owed_since LIMIT 1`,
        )
        .get() as { run_id: string; step: string; owed_since: number; depth: number } | null;
      const alerted = readCellState<AgeAlertState>(db, AGE_ALERT_KEY);
      if (oldest && now - oldest.owed_since > AGE_ALERT_MS) {
        const same =
          alerted?.run_id === oldest.run_id &&
          alerted.step === oldest.step &&
          alerted.owed_since === oldest.owed_since;
        if (!same) {
          lines.push(
            `capture-cell stalled: oldest owed marker (run ${oldest.run_id}, step ${oldest.step}) is ${Math.round((now - oldest.owed_since) / 60_000)} min old; ${oldest.depth} owed`,
          );
          writeCellState(
            db,
            AGE_ALERT_KEY,
            { run_id: oldest.run_id, step: oldest.step, owed_since: oldest.owed_since },
            now,
          );
        }
      } else if (alerted) {
        writeCellState(db, AGE_ALERT_KEY, null, now);
      }
      return lines;
    })
    .immediate();
}
