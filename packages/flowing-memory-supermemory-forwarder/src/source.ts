import { Schema } from "effect";
import { Pool, type PoolClient } from "pg";

import {
  assessRecord,
  type Boundary,
  BoundarySchema,
  type ForwarderPolicy,
  type SourceRecord,
  SourceRecordSchema,
} from "./domain.js";

export interface SourceBatch {
  readonly candidates: readonly SourceRecord[];
  readonly commits: readonly Boundary[];
}

export interface SourceBaseline {
  readonly boundary: Boundary;
  readonly commitIds: readonly string[];
}

export interface EligibilityCounts {
  readonly allowedScope: number;
  readonly currentTotal: number;
  readonly exportEligibleUpperBound: number;
  readonly privateRows: number;
  readonly projectionLinked: number;
  readonly publicRows: number;
  readonly schemaSupported: number;
  readonly sensitiveRows: number;
  readonly strictEligible: number;
  readonly strictExcluded: number;
  readonly exportableEvidence: number;
}

export interface FlowingMemorySource {
  initialBaseline(): Promise<SourceBaseline>;
  listUnseenCommits(seenCommitIds: readonly string[], limit: number): Promise<SourceBatch>;
  activeCommittedRecords(recordIds: readonly string[]): Promise<readonly SourceRecord[]>;
  eligibilityCounts(policy: ForwarderPolicy): Promise<EligibilityCounts>;
  close(): Promise<void>;
}

const BoundaryRowSchema = Schema.Struct({
  commit_created_at: Schema.String,
  commit_id: Schema.String,
});

const CandidateRowSchema = Schema.Struct({
  body: Schema.NullOr(Schema.Unknown),
  commit_created_at: Schema.String,
  commit_id: Schema.String,
  content_hash: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  ordinal: Schema.NullOr(Schema.String),
  privacy: Schema.NullOr(Schema.String),
  record_id: Schema.NullOr(Schema.String),
  referenced_record_id: Schema.NullOr(Schema.String),
  schema_version: Schema.NullOr(Schema.Number),
  scope_project: Schema.NullOr(Schema.String),
  scope_workstream: Schema.NullOr(Schema.String),
});

const EligibilityRowSchema = Schema.Struct({
  allowed_scope: Schema.String,
  current_total: Schema.String,
  export_eligible_upper_bound: Schema.String,
  exportable_evidence: Schema.String,
  private_rows: Schema.String,
  projection_linked: Schema.String,
  public_rows: Schema.String,
  schema_supported: Schema.String,
  sensitive_rows: Schema.String,
});

const decodeBoundary = (value: unknown): Boundary => {
  const row = Schema.decodeUnknownSync(BoundaryRowSchema)(value);
  return Schema.decodeUnknownSync(BoundarySchema)({
    commitCreatedAt: row.commit_created_at,
    commitId: row.commit_id,
  });
};

const decodeCandidateRows = (rows: readonly unknown[]): SourceBatch => {
  const candidates: SourceRecord[] = [];
  const commits = new Map<string, Boundary>();
  for (const raw of rows) {
    const row = Schema.decodeUnknownSync(CandidateRowSchema)(raw);
    commits.set(row.commit_id, decodeBoundary(row));
    if (row.record_id === null) {
      if (row.referenced_record_id !== null) {
        throw new Error("projection commit references a missing memory record");
      }
      continue;
    }
    if (
      row.body === null ||
      row.content_hash === null ||
      row.kind === null ||
      row.ordinal === null ||
      row.privacy === null ||
      row.schema_version === null ||
      row.scope_project === null ||
      row.scope_workstream === null
    ) {
      throw new Error("projection commit references an incomplete memory record");
    }
    candidates.push(
      Schema.decodeUnknownSync(SourceRecordSchema)({
        body: row.body,
        commitCreatedAt: row.commit_created_at,
        commitId: row.commit_id,
        contentHash: row.content_hash,
        kind: row.kind,
        ordinal: Number(row.ordinal),
        privacy: row.privacy,
        recordId: row.record_id,
        schemaVersion: row.schema_version,
        scopeProject: row.scope_project,
        scopeWorkstream: row.scope_workstream,
      }),
    );
  }
  return { candidates, commits: [...commits.values()] };
};

const committedRowsQuery = async (
  client: Pool | PoolClient,
  input: { readonly recordIds?: readonly string[]; readonly seenCommitIds?: readonly string[]; readonly limit: number },
) => {
  const byRecords = input.recordIds !== undefined;
  return client.query({
    values: [byRecords ? input.recordIds : (input.seenCommitIds ?? []), Math.max(1, Math.floor(input.limit))],
    text: `
      WITH commits AS MATERIALIZED (
        SELECT commit.commit_id, commit.created_at, commit.record_ids
        FROM fm_projection_commits AS commit
        ${
          byRecords
            ? `WHERE EXISTS (
                 SELECT 1 FROM unnest(commit.record_ids) AS requested(record_id)
                 WHERE requested.record_id = ANY($1::text[])
               )`
            : "WHERE NOT (commit.commit_id = ANY($1::text[]))"
        }
        ORDER BY commit.created_at, commit.commit_id COLLATE "C"
        LIMIT $2
      )
      SELECT commit.created_at::text AS commit_created_at,
             commit.commit_id,
             expanded.ordinality::text AS ordinal,
             expanded.record_id AS referenced_record_id,
             record.record_id,
             record.kind,
             record.schema_version,
             record.scope_project,
             record.scope_workstream,
             record.privacy,
             record.content_hash,
             record.body
      FROM commits AS commit
      LEFT JOIN LATERAL unnest(commit.record_ids) WITH ORDINALITY
        AS expanded(record_id, ordinality) ON true
      LEFT JOIN fm_memory_records AS record
        ON record.record_id = expanded.record_id
      ${
        byRecords
          ? `JOIN fm_scope_heads AS head
               ON head.scope_project = record.scope_project
              AND head.scope_workstream = record.scope_workstream
              AND head.head->'recordIds' ? record.record_id
             WHERE record.record_id = ANY($1::text[])`
          : ""
      }
      ORDER BY commit.created_at, commit.commit_id COLLATE "C", expanded.ordinality
    `,
  });
};

export class PostgresFlowingMemorySource implements FlowingMemorySource {
  readonly #pool: Pool;

  constructor(databaseUrl: string) {
    this.#pool = new Pool({
      application_name: "flowing-memory-supermemory-forwarder",
      connectionString: databaseUrl,
      max: 2,
    });
  }

  async initialBaseline(): Promise<SourceBaseline> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const commits = await client.query<{ readonly commit_id: string }>({
        text: "SELECT commit_id FROM fm_projection_commits ORDER BY commit_id COLLATE \"C\"",
      });
      const latest = await client.query({
        text: `
          SELECT created_at::text AS commit_created_at, commit_id
          FROM fm_projection_commits
          ORDER BY created_at DESC, commit_id COLLATE "C" DESC
          LIMIT 1
        `,
      });
      const row = latest.rows[0];
      if (row === undefined) throw new Error("cannot initialize: no projection commit boundary exists");
      await client.query("COMMIT");
      return {
        boundary: decodeBoundary(row),
        commitIds: commits.rows.map((item) => item.commit_id),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listUnseenCommits(seenCommitIds: readonly string[], limit: number): Promise<SourceBatch> {
    const result = await committedRowsQuery(this.#pool, { seenCommitIds, limit });
    return decodeCandidateRows(result.rows);
  }

  async activeCommittedRecords(recordIds: readonly string[]): Promise<readonly SourceRecord[]> {
    if (recordIds.length === 0) return [];
    const result = await committedRowsQuery(this.#pool, {
      recordIds,
      limit: recordIds.length,
    });
    return decodeCandidateRows(result.rows).candidates;
  }

  async eligibilityCounts(policy: ForwarderPolicy): Promise<EligibilityCounts> {
    const allowedScopes = JSON.stringify(policy.allowedScopes);
    const result = await this.#pool.query({
      values: [allowedScopes, policy.allowedPrivacy],
      text: `
        WITH current_records AS MATERIALIZED (
          SELECT record.*,
                 EXISTS (
                   SELECT 1 FROM fm_projection_commits AS commit
                   WHERE record.record_id = ANY(commit.record_ids)
                 ) AS projection_linked,
                 (
                   (record.kind = 'observation' AND record.schema_version = 2)
                   OR (record.kind = 'reflection' AND record.schema_version = 1)
                 ) AS schema_supported,
                 (
                   jsonb_typeof(record.body->'evidence') = 'array'
                   AND jsonb_array_length(record.body->'evidence') > 0
                   AND NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(record.body->'evidence') AS evidence(value)
                     WHERE evidence.value->>'privacy' NOT IN ('public', 'private')
                        OR NOT (evidence.value->>'privacy' = ANY($2::text[]))
                        OR evidence.value->'scope'->>'project' <> record.scope_project
                        OR evidence.value->'scope'->>'workstream' <> record.scope_workstream
                   )
                 ) AS exportable_evidence,
                 EXISTS (
                   SELECT 1 FROM jsonb_array_elements($1::jsonb) AS allowed(scope)
                   WHERE allowed.scope->>'project' = record.scope_project
                     AND allowed.scope->>'workstream' = record.scope_workstream
                 ) AS allowed_scope
          FROM fm_scope_heads AS head
          CROSS JOIN LATERAL jsonb_array_elements_text(head.head->'recordIds') AS active(record_id)
          JOIN fm_memory_records AS record ON record.record_id = active.record_id
        )
        SELECT count(*)::text AS current_total,
               count(*) FILTER (WHERE projection_linked)::text AS projection_linked,
               count(*) FILTER (WHERE schema_supported)::text AS schema_supported,
               count(*) FILTER (WHERE privacy = 'public')::text AS public_rows,
               count(*) FILTER (WHERE privacy = 'private')::text AS private_rows,
               count(*) FILTER (WHERE privacy = 'sensitive')::text AS sensitive_rows,
               count(*) FILTER (WHERE exportable_evidence)::text AS exportable_evidence,
               count(*) FILTER (WHERE allowed_scope)::text AS allowed_scope,
               count(*) FILTER (
                 WHERE projection_linked AND schema_supported
                   AND privacy <> 'sensitive' AND privacy = ANY($2::text[])
                   AND exportable_evidence AND allowed_scope
               )::text AS export_eligible_upper_bound
        FROM current_records
      `,
    });
    const row = Schema.decodeUnknownSync(EligibilityRowSchema)(result.rows[0]);
    const currentIds = await this.#pool.query<{ readonly record_id: string }>({
      text: `
        SELECT DISTINCT record.record_id
        FROM fm_scope_heads AS head
        CROSS JOIN LATERAL jsonb_array_elements_text(head.head->'recordIds') AS active(record_id)
        JOIN fm_memory_records AS record ON record.record_id = active.record_id
        ORDER BY record.record_id
      `,
    });
    const currentCommitted = await this.activeCommittedRecords(
      currentIds.rows.map((item) => item.record_id),
    );
    const strictEligible = currentCommitted.filter(
      (record) => assessRecord(record, policy)._tag === "Eligible",
    ).length;
    return {
      allowedScope: Number(row.allowed_scope),
      currentTotal: Number(row.current_total),
      exportEligibleUpperBound: Number(row.export_eligible_upper_bound),
      exportableEvidence: Number(row.exportable_evidence),
      privateRows: Number(row.private_rows),
      projectionLinked: Number(row.projection_linked),
      publicRows: Number(row.public_rows),
      schemaSupported: Number(row.schema_supported),
      sensitiveRows: Number(row.sensitive_rows),
      strictEligible,
      strictExcluded: currentCommitted.length - strictEligible,
    };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
