import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TelemetryEmitter } from "@joelclaw/telemetry";
import type { CapturedRunEvent } from "./run-capture";

type Entry = {
  key: string;
  event_json: string;
  state: "preparing" | "waiting" | "sending" | "sent" | "gave_up";
  attempts: number;
  due_at: number;
  lease: string | null;
};

type Options = {
  path: string;
  send: (event: CapturedRunEvent & { id: string }) => Promise<unknown>;
  telemetry: TelemetryEmitter;
  now?: () => number;
  maxAttempts?: number;
  sendTimeoutMs?: number;
};

/**
 * Lifecycle sketch (XState v5 terms):
 * preparing -- BLOB_COMMITTED --> waiting -- CLAIM --> sending
 * sending -- SENT --> sent; sending -- FAILED --> waiting (backoff) | gave_up
 * sending -- LEASE_EXPIRED --> sending (new lease); preparing -- TICK --> preparing
 * A durable preparing intent precedes the blob write. Recovery verifies the
 * committed blob and metadata before sending. gave_up retains the payload.
 */
export class RunCaptureOutbox {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly sendTimeoutMs: number;
  private draining = false;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 10_000;
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new Database(options.path, { create: true, strict: true });
    chmodSync(options.path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS run_capture_retry (
        key TEXT PRIMARY KEY, event_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('preparing','waiting','sending','sent','gave_up')),
        attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL,
        lease TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_error TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS run_capture_retry_due ON run_capture_retry(state, due_at);
    `);
  }

  private key(event: CapturedRunEvent): string {
    return createHash("sha256")
      .update(JSON.stringify([event.data.user_id, event.data.run_id]))
      .digest("hex");
  }

  private emit(action: string, key: string, extra: Record<string, unknown> = {}): void {
    try {
      // No raw content, source paths, or transport errors in telemetry.
      this.options.telemetry.emit(`capture.retry.${action}`, "Run capture event outbox", {
        key,
        ...extra,
      });
    } catch {
      // Observability must not change the durable delivery result.
    }
  }

  /** Commit the intent before writing the blob. Failing here must fail ingress. */
  stage(event: CapturedRunEvent): string {
    const key = this.key(event);
    const now = this.now();
    const inserted = this.db
      .query(`INSERT OR IGNORE INTO run_capture_retry
      (key,event_json,state,due_at,created_at,updated_at) VALUES (?,?,'preparing',?,?,?)`)
      .run(key, JSON.stringify(event), now, now, now);
    if (inserted.changes) this.emit("enqueued", key);
    return key;
  }

  /** Replace the planned event with the actual immutable blob, including prefixes. */
  enqueue(event: CapturedRunEvent): string {
    const key = this.stage(event);
    this.db
      .query(`UPDATE run_capture_retry SET event_json=?,state='waiting',due_at=?,updated_at=?,
      attempts=CASE WHEN state='gave_up' THEN 0 ELSE attempts END
      WHERE key=? AND state IN ('preparing','gave_up')`)
      .run(JSON.stringify(event), this.now(), this.now(), key);
    return key;
  }

  /** A rejected conflict must not later publish the proposed (unwritten) bytes. */
  reject(key: string): void {
    const result = this.db
      .query(`UPDATE run_capture_retry SET state='gave_up',last_error='blob_rejected',updated_at=?
      WHERE key=? AND state='preparing'`)
      .run(this.now(), key);
    if (result.changes) this.emit("give_up", key, { reason: "blob_rejected" });
  }

  private read(key: string): Entry | null {
    return this.db.query("SELECT * FROM run_capture_retry WHERE key=?").get(key) as Entry | null;
  }

  private fail(entry: Entry, lease: string | null, reason: string): void {
    const attempts = entry.attempts + 1;
    const gaveUp = attempts >= (this.options.maxAttempts ?? 20);
    const due = this.now() + Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 20));
    const result = this.db
      .query(`UPDATE run_capture_retry SET state=?,attempts=?,due_at=?,lease=NULL,
      last_error=?,updated_at=? WHERE key=? AND lease IS ? AND state IN ('preparing','sending')`)
      .run(
        gaveUp ? "gave_up" : entry.state === "preparing" ? "preparing" : "waiting",
        attempts,
        due,
        reason,
        this.now(),
        entry.key,
        lease,
      );
    if (result.changes) this.emit(gaveUp ? "give_up" : "failed", entry.key, { attempts, reason });
  }

  private recover(entry: Entry): boolean {
    const planned = JSON.parse(entry.event_json) as CapturedRunEvent;
    try {
      const data = planned.data;
      const metadata = JSON.parse(
        readFileSync(data.jsonl_path.replace(/\.jsonl$/u, ".metadata.json"), "utf8"),
      );
      const bytes = readFileSync(data.jsonl_path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      // A same-cursor committed prefix is authoritative. Never infer a commit
      // from a bare blob: the metadata file is the write's completion marker.
      const sameCursor =
        data.source_identity !== undefined &&
        metadata.source_identity === data.source_identity &&
        metadata.from_offset === data.from_offset &&
        metadata.to_offset === (data.from_offset ?? 0) + bytes.length;
      if (
        metadata.run_id !== data.run_id ||
        metadata.user_id !== data.user_id ||
        metadata.machine_id !== data.machine_id ||
        metadata.agent_runtime !== data.agent_runtime ||
        (data.source_identity !== undefined && !sameCursor) ||
        !(digest === data.jsonl_sha256 || (sameCursor && bytes.length <= data.jsonl_bytes))
      ) {
        throw new Error("blob_not_committed");
      }
      this.enqueue({
        ...planned,
        data: {
          ...data,
          jsonl_bytes: bytes.length,
          jsonl_sha256: digest,
          ...(sameCursor ? { to_offset: metadata.to_offset } : {}),
        },
      });
      return true;
    } catch {
      this.fail(entry, null, "blob_not_committed");
      return false;
    }
  }

  /** Returns true only when this immutable event has a durable sent receipt. */
  async deliver(key: string): Promise<boolean> {
    let entry = this.read(key);
    if (!entry) throw new Error("capture retry intent missing");
    if (entry.state === "sent") return true;
    if (entry.due_at > this.now() || entry.state === "gave_up") return false;
    if (entry.state === "preparing") {
      if (!this.recover(entry)) return false;
      entry = this.read(key)!;
    }
    const lease = randomUUID();
    const claimed = this.db
      .query(`UPDATE run_capture_retry SET state='sending',lease=?,due_at=?,updated_at=?
      WHERE key=? AND state IN ('waiting','sending') AND due_at<=?`)
      .run(lease, this.now() + this.sendTimeoutMs + 30_000, this.now(), key, this.now());
    if (!claimed.changes) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const event = JSON.parse(entry.event_json) as CapturedRunEvent;
      await Promise.race([
        this.options.send({ ...event, id: `run-capture:${key}` }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("send_timeout")), this.sendTimeoutMs);
        }),
      ]);
    } catch {
      this.fail({ ...entry, state: "sending" }, lease, "send_failed");
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const result = this.db
      .query(`UPDATE run_capture_retry SET state='sent',lease=NULL,last_error=NULL,updated_at=?
      WHERE key=? AND state='sending' AND lease=?`)
      .run(this.now(), key, lease);
    if (result.changes) this.emit("sent", key, { attempts: entry.attempts + 1 });
    return Boolean(result.changes);
  }

  /** One process-local, bounded pass. SQL leases also protect overlapping processes. */
  async drain(limit = 10): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const rows = this.db
        .query(`SELECT key FROM run_capture_retry
        WHERE state IN ('preparing','waiting','sending') AND due_at<=? ORDER BY due_at,key LIMIT ?`)
        .all(this.now(), limit) as Array<{ key: string }>;
      for (const row of rows) await this.deliver(row.key);
    } finally {
      this.draining = false;
    }
  }

  start(intervalMs = 5_000): () => void {
    const tick = () => {
      void this.drain().catch(() => this.emit("loop_failed", "outbox"));
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  close(): void {
    this.db.close();
  }
}
