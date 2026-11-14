import type { Database } from "bun:sqlite";
import type { CapturedPayload } from "./types";

export interface HandbackEvent {
  id: string;
  name: "memory/run.captured";
  data: CapturedPayload;
}

export interface HandbackReport {
  dry_run: boolean;
  runs: string[];
  sent: string[];
  failed: string[];
}

/**
 * State flow: cell-owned -> transfer-pending -> handed-back.
 * Commit transfer-pending before I/O, excluding the run from the cell drain.
 * A crash/ambiguous send retries the stored event with its original run id.
 * Inngest's event dedupe and memory's idempotent append handle at-least-once I/O.
 */
export async function handback(
  db: Database,
  options: {
    dryRun: boolean;
    send: (event: HandbackEvent) => Promise<void>;
    now?: () => number;
  },
): Promise<HandbackReport> {
  const candidates = () =>
    db
      .query(`
    SELECT c.run_id, c.payload_json FROM captured c
    JOIN owed o ON o.run_id = c.run_id AND o.step = 'append'
    LEFT JOIN handbacks h ON h.run_id = c.run_id
    WHERE h.run_id IS NULL ORDER BY c.arrival_seq
  `)
      .all() as Array<{ run_id: string; payload_json: string }>;
  if (!options.dryRun) {
    db.transaction(() => {
      for (const row of candidates()) {
        const event: HandbackEvent = {
          id: row.run_id,
          name: "memory/run.captured",
          data: JSON.parse(row.payload_json) as CapturedPayload,
        };
        db.query("INSERT OR IGNORE INTO handbacks (run_id, event_json) VALUES (?, ?)").run(
          row.run_id,
          JSON.stringify(event),
        );
      }
    }).immediate();
  }
  const pending = db
    .query(`
    SELECT h.run_id, h.event_json FROM handbacks h
    JOIN captured c ON c.run_id = h.run_id WHERE h.handed_at IS NULL
    ORDER BY c.arrival_seq
  `)
    .all() as Array<{ run_id: string; event_json: string }>;
  const report: HandbackReport = {
    dry_run: options.dryRun,
    runs: [
      ...(options.dryRun ? candidates().map((row) => row.run_id) : []),
      ...pending.map((row) => row.run_id),
    ],
    sent: [],
    failed: [],
  };
  if (options.dryRun) return report;
  for (const row of pending) {
    try {
      await options.send(JSON.parse(row.event_json) as HandbackEvent);
      db.transaction(() => {
        db.query("UPDATE handbacks SET handed_at = ? WHERE run_id = ? AND handed_at IS NULL").run(
          (options.now ?? Date.now)(),
          row.run_id,
        );
        db.query("DELETE FROM owed WHERE run_id = ? AND step = 'append'").run(row.run_id);
        // No fake append verdict: Inngest owns the outcome now. An in-flight
        // append that committed first may still have real telemetry to ship.
        db.query(`DELETE FROM owed WHERE run_id = ? AND step = 'otel'
          AND NOT EXISTS (SELECT 1 FROM otel_pending WHERE run_id = ?)`).run(
          row.run_id,
          row.run_id,
        );
      }).immediate();
      report.sent.push(row.run_id);
    } catch {
      // Never print a transport URL: it may include the event key.
      report.failed.push(row.run_id);
    }
  }
  return report;
}

/** Explicit operator-only adapter; serve never opens a second Inngest sender. */
export function createHandbackSender(
  env: Record<string, string | undefined> = process.env,
  doFetch: typeof fetch = fetch,
): (event: HandbackEvent) => Promise<void> {
  const base = env.INNGEST_URL ?? env.INNGEST_BASE_URL;
  const key = env.INNGEST_EVENT_KEY;
  return async (event) => {
    if (!base || !key) throw new Error("handback needs INNGEST_URL and INNGEST_EVENT_KEY");
    const response = await doFetch(`${base.replace(/\/+$/u, "")}/e/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`handback rejected: HTTP ${response.status}`);
    }
    const ack = (await response.json()) as { status?: number; ids?: unknown };
    if (
      (ack.status !== undefined && ack.status !== 200) ||
      !Array.isArray(ack.ids) ||
      ack.ids.length === 0
    ) {
      throw new Error("handback was not acknowledged");
    }
  };
}
