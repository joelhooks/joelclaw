import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

import type { Assessment, Boundary } from "./domain.js";
import { BoundarySchema, correctionMemory } from "./domain.js";

export type DeliveryStatus =
  | "accepted"
  | "delivered"
  | "indeterminate"
  | "pending"
  | "sending"
  | "withheld";

export interface Delivery {
  readonly deliveryId: string;
  readonly marker: string;
  readonly operation: "save";
  readonly payload: string;
  readonly payloadHash: string;
  readonly reconcileCount: number;
  readonly recordId: string;
  readonly status: DeliveryStatus;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly marker: string;
  readonly operation: "save";
  readonly payload: string;
  readonly payload_hash: string;
  readonly reconcile_count: number;
  readonly record_id: string;
  readonly status: DeliveryStatus;
}

const asDelivery = (row: DeliveryRow): Delivery => ({
  deliveryId: row.delivery_id,
  marker: row.marker,
  operation: row.operation,
  payload: row.payload,
  payloadHash: row.payload_hash,
  reconcileCount: row.reconcile_count,
  recordId: row.record_id,
  status: row.status,
});

export class ForwarderStateStore {
  readonly #database: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS seen_commits (
        commit_id TEXT PRIMARY KEY,
        commit_created_at TEXT NOT NULL,
        seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_records (
        record_id TEXT PRIMARY KEY,
        commit_id TEXT NOT NULL,
        commit_created_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        privacy TEXT NOT NULL CHECK (privacy IN ('public', 'private', 'sensitive')),
        disposition TEXT NOT NULL CHECK (disposition IN ('eligible', 'excluded')),
        exclusion_reason TEXT,
        scope_project TEXT NOT NULL,
        scope_workstream TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation = 'save'),
        marker TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'sending', 'accepted', 'indeterminate', 'delivered', 'withheld')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        reconcile_count INTEGER NOT NULL DEFAULT 0,
        remote_document_id TEXT,
        remote_memory_id TEXT,
        remote_status TEXT,
        last_error_code TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE TABLE IF NOT EXISTS supersession_targets (
        source_record_id TEXT NOT NULL,
        target_record_id TEXT NOT NULL,
        PRIMARY KEY (source_record_id, target_record_id)
      ) STRICT;
    `);
    const schemaVersion = this.#database
      .prepare("SELECT value FROM metadata WHERE key = 'state_schema_version'")
      .get() as { readonly value: string } | undefined;
    if (schemaVersion === undefined) {
      const existing = this.#database
        .prepare(`
          SELECT
            (SELECT count(*) FROM metadata) +
            (SELECT count(*) FROM source_records) +
            (SELECT count(*) FROM deliveries) AS count
        `)
        .get() as { readonly count: number };
      if (existing.count > 0) {
        throw new Error("unsupported prototype state schema; initialize a fresh V1 state file");
      }
      this.#database
        .prepare("INSERT INTO metadata (key, value) VALUES ('state_schema_version', '3')")
        .run();
    } else if (schemaVersion.value !== "3") {
      throw new Error("unsupported forwarder state schema version");
    }
  }

  initializeBaseline(boundary: Boundary, commitIds: readonly string[]): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const encoded = JSON.stringify(boundary);
      this.#database
        .prepare("INSERT INTO metadata (key, value) VALUES ('activation_boundary', ?) ON CONFLICT DO NOTHING")
        .run(encoded);
      const insertSeen = this.#database.prepare(`
        INSERT INTO seen_commits (commit_id, commit_created_at)
        VALUES (?, ?) ON CONFLICT DO NOTHING
      `);
      for (const commitId of commitIds) insertSeen.run(commitId, boundary.commitCreatedAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  boundary(): Boundary | null {
    const row = this.#database
      .prepare("SELECT value FROM metadata WHERE key = 'activation_boundary'")
      .get() as { readonly value: string } | undefined;
    return row === undefined
      ? null
      : Schema.decodeUnknownSync(BoundarySchema)(JSON.parse(row.value) as unknown);
  }

  seenCommitIds(): readonly string[] {
    const rows = this.#database
      .prepare("SELECT commit_id FROM seen_commits ORDER BY commit_id")
      .all() as unknown as { readonly commit_id: string }[];
    return rows.map((row) => row.commit_id);
  }

  ingest(assessments: readonly Assessment[], commits: readonly Boundary[]): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const insertSource = this.#database.prepare(`
        INSERT INTO source_records (
          record_id, commit_id, commit_created_at, content_hash, privacy,
          disposition, exclusion_reason, scope_project, scope_workstream
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (record_id) DO UPDATE SET
          disposition = excluded.disposition,
          exclusion_reason = excluded.exclusion_reason
        WHERE source_records.content_hash = excluded.content_hash
      `);
      const insertDelivery = this.#database.prepare(`
        INSERT INTO deliveries (
          delivery_id, record_id, operation, marker, payload, payload_hash, status
        ) VALUES (?, ?, 'save', ?, ?, ?, 'pending')
        ON CONFLICT (delivery_id) DO NOTHING
      `);
      const insertSupersession = this.#database.prepare(`
        INSERT INTO supersession_targets (source_record_id, target_record_id)
        VALUES (?, ?) ON CONFLICT DO NOTHING
      `);
      const insertSeen = this.#database.prepare(`
        INSERT INTO seen_commits (commit_id, commit_created_at)
        VALUES (?, ?) ON CONFLICT DO NOTHING
      `);

      for (const assessment of assessments) {
        if (assessment._tag === "Excluded") {
          const record = assessment.record;
          insertSource.run(
            record.recordId,
            record.commitId,
            record.commitCreatedAt,
            record.contentHash,
            record.privacy,
            "excluded",
            assessment.reason,
            record.scopeProject,
            record.scopeWorkstream,
          );
          continue;
        }
        const memory = assessment.memory;
        insertSource.run(
          memory.recordId,
          memory.commitId,
          memory.commitCreatedAt,
          memory.contentHash,
          memory.privacy,
          "eligible",
          null,
          memory.scopeProject,
          memory.scopeWorkstream,
        );
        insertDelivery.run(
          `save:${memory.recordId}`,
          memory.recordId,
          memory.marker,
          memory.payload,
          memory.payloadHash,
        );
        for (const target of memory.supersedes) insertSupersession.run(memory.recordId, target);
      }
      for (const commit of commits) insertSeen.run(commit.commitId, commit.commitCreatedAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  delivery(deliveryId: string): Delivery | null {
    const row = this.#database
      .prepare(`
        SELECT delivery_id, record_id, operation, marker, payload, payload_hash,
               status, reconcile_count
        FROM deliveries WHERE delivery_id = ?
      `)
      .get(deliveryId) as DeliveryRow | undefined;
    return row === undefined ? null : asDelivery(row);
  }

  deliveryStatus(deliveryId: string): DeliveryStatus | null {
    return this.delivery(deliveryId)?.status ?? null;
  }

  hasPendingDeliveryWork(maxReconcileAttempts: number): boolean {
    return this.pendingDeliveries(maxReconcileAttempts, 1).length > 0;
  }

  pendingDeliveries(maxReconcileAttempts: number, limit = 50): readonly Delivery[] {
    const rows = this.#database
      .prepare(`
        SELECT delivery_id, record_id, operation, marker, payload, payload_hash,
               status, reconcile_count
        FROM deliveries
        WHERE status IN ('pending', 'sending', 'accepted', 'indeterminate')
          AND reconcile_count < ?
        ORDER BY updated_at, delivery_id
        LIMIT ?
      `)
      .all(maxReconcileAttempts, limit) as unknown as DeliveryRow[];
    return rows.map(asDelivery);
  }

  markSending(deliveryId: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE deliveries
        SET status = 'sending', attempt_count = attempt_count + 1,
            last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE delivery_id = ? AND status = 'pending'
      `)
      .run(deliveryId);
    return result.changes === 1;
  }

  markAccepted(deliveryId: string, remoteDocumentId: string | null, remoteStatus: string): void {
    this.#database
      .prepare(`
        UPDATE deliveries
        SET status = 'accepted', remote_document_id = ?, remote_status = ?,
            last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE delivery_id = ?
      `)
      .run(remoteDocumentId, remoteStatus, deliveryId);
  }

  markDelivered(deliveryId: string, remoteMemoryId: string | null): void {
    this.#database
      .prepare(`
        UPDATE deliveries
        SET status = 'delivered', remote_memory_id = ?, remote_status = 'searchable',
            last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE delivery_id = ?
      `)
      .run(remoteMemoryId, deliveryId);
  }

  recordReconciliation(deliveryId: string, errorCode: string | null): number {
    this.#database
      .prepare(`
        UPDATE deliveries
        SET reconcile_count = reconcile_count + 1,
            last_error_code = ?, updated_at = CURRENT_TIMESTAMP
        WHERE delivery_id = ?
      `)
      .run(errorCode, deliveryId);
    const row = this.#database
      .prepare("SELECT reconcile_count FROM deliveries WHERE delivery_id = ?")
      .get(deliveryId) as { readonly reconcile_count: number } | undefined;
    if (row === undefined) throw new Error("delivery disappeared during reconciliation");
    return row.reconcile_count;
  }

  markPending(deliveryId: string, errorCode: string): void {
    this.#database
      .prepare(`
        UPDATE deliveries
        SET status = 'pending', last_error_code = ?, updated_at = CURRENT_TIMESTAMP
        WHERE delivery_id = ? AND status = 'pending'
      `)
      .run(errorCode, deliveryId);
  }

  markIndeterminate(deliveryId: string, errorCode: string): void {
    this.#database
      .prepare(`
        UPDATE deliveries
        SET status = 'indeterminate', last_error_code = ?, updated_at = CURRENT_TIMESTAMP
        WHERE delivery_id = ?
      `)
      .run(errorCode, deliveryId);
  }

  markWithheld(deliveryId: string, errorCode: string): void {
    this.#database
      .prepare(`
        UPDATE deliveries
        SET status = 'withheld', last_error_code = ?, updated_at = CURRENT_TIMESTAMP
        WHERE delivery_id = ? AND status = 'pending'
      `)
      .run(errorCode, deliveryId);
  }

  deliveredSourceRecordIds(): readonly string[] {
    const rows = this.#database
      .prepare(`
        SELECT record_id FROM deliveries
        WHERE delivery_id LIKE 'save:%' AND status = 'delivered'
        ORDER BY record_id
      `)
      .all() as unknown as { readonly record_id: string }[];
    return rows.map((row) => row.record_id);
  }

  queueCorrection(recordId: string, reason: "inactive" | "superseded"): void {
    const source = this.#database
      .prepare("SELECT privacy FROM source_records WHERE record_id = ?")
      .get(recordId) as { readonly privacy: "private" | "public" } | undefined;
    if (source === undefined) return;
    const memory = correctionMemory(recordId, reason, source.privacy);
    this.#database
      .prepare(`
        INSERT INTO deliveries (
          delivery_id, record_id, operation, marker, payload, payload_hash, status
        ) VALUES (?, ?, 'save', ?, ?, ?, 'pending')
        ON CONFLICT (delivery_id) DO NOTHING
      `)
      .run(`correction:${reason}:${recordId}`, recordId, memory.marker, memory.payload, memory.payloadHash);
  }

  queueReadySupersessionCorrections(): number {
    const rows = this.#database
      .prepare(`
        SELECT relation.target_record_id
        FROM supersession_targets AS relation
        JOIN deliveries AS source_delivery
          ON source_delivery.delivery_id = 'save:' || relation.source_record_id
         AND source_delivery.status = 'delivered'
        JOIN deliveries AS target_delivery
          ON target_delivery.delivery_id = 'save:' || relation.target_record_id
         AND target_delivery.status = 'delivered'
        ORDER BY relation.target_record_id
      `)
      .all() as unknown as { readonly target_record_id: string }[];
    for (const row of rows) this.queueCorrection(row.target_record_id, "superseded");
    return rows.length;
  }

  counts(): Readonly<Record<string, number>> {
    const rows = this.#database
      .prepare("SELECT status, count(*) AS count FROM deliveries GROUP BY status ORDER BY status")
      .all() as unknown as { readonly count: number; readonly status: string }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  excludedCounts(): Readonly<Record<string, number>> {
    const rows = this.#database
      .prepare(`
        SELECT exclusion_reason, count(*) AS count
        FROM source_records WHERE disposition = 'excluded'
        GROUP BY exclusion_reason ORDER BY exclusion_reason
      `)
      .all() as unknown as { readonly count: number; readonly exclusion_reason: string }[];
    return Object.fromEntries(rows.map((row) => [row.exclusion_reason, row.count]));
  }

  close(): void {
    this.#database.close();
  }
}
