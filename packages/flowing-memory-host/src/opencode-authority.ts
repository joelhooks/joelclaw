import { PgClient } from "@effect/sql-pg";
import {
  AdmissionCommandFactV1Schema,
  AdmissionWakeV1Schema,
  decodeDomain,
  encodeDomain,
  RawCaptureSourceCoordinatesV1Schema,
  RuntimeIdentityV1Schema,
} from "@joelclaw-memory/domain";
import {
  canonicalJson,
  encodedJsonHash,
  PostgresAdmissionLedger,
  PostgresAdmissionLedgerLive,
  PostgresMigrationClientLive,
  PostgresRuntimeClientLive,
} from "@joelclaw-memory/postgres";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import type {
  OpenCodeAcceptedTailV1,
  OpenCodeAdmissionAuthority,
  OpenCodeAuthorityPreflightV1,
} from "./opencode-producer.js";

interface MigrationRow {
  readonly migration_registered: boolean;
  readonly runtime_constraint_definition: string | null;
}

interface ColumnRow {
  readonly column_name: string;
  readonly data_type: string;
  readonly is_not_null: boolean;
  readonly table_name: string;
}

interface ForeignKeyRow {
  readonly initially_deferred: boolean;
  readonly is_deferrable: boolean;
  readonly source_columns: readonly string[];
  readonly source_table: string;
  readonly target_columns: readonly string[];
  readonly target_table: string;
}

interface PrivilegeRow {
  readonly readable: boolean;
  readonly writable: boolean;
}

export interface OpenCodeTailRowV1 {
  readonly adapter_stream_id_hash: string;
  readonly admission_seq: string;
  readonly capture_event_id: string;
  readonly command: unknown;
  readonly command_fingerprint: string;
  readonly command_hash: string;
  readonly command_kind: string;
  readonly conversation_id: string;
  readonly current_privacy: "private" | "public" | "sensitive" | null;
  readonly current_tail_window_seq: string;
  readonly disabled_from_byte: string | null;
  readonly disposition: string;
  readonly from_byte: string;
  readonly outbox_admission_seq: string;
  readonly outbox_payload: unknown;
  readonly outbox_payload_hash: string;
  readonly outbox_source_stream_id: string;
  readonly outbox_topic: string;
  readonly outbox_wake_key: string;
  readonly outbox_window_seq: string;
  readonly predecessor_prefix_hash: string | null;
  readonly predecessor_to_byte_exclusive: string | null;
  readonly previous_prefix_hash: string | null;
  readonly raw_segment_hash: string;
  readonly runtime: string;
  readonly runtime_identity: unknown;
  readonly runtime_identity_hash: string;
  readonly runtime_identity_proof_hash: string;
  readonly scope_project: string;
  readonly scope_workstream: string;
  readonly source: unknown;
  readonly source_hash: string;
  readonly source_prefix_hash: string;
  readonly source_stream_id: string;
  readonly to_byte_exclusive: string;
  readonly window_seq: string;
}

export class OpenCodeAuthorityError extends Error {
  readonly _tag = "OpenCodeAuthorityError";
  readonly code = "opencode-authority-unavailable";

  constructor() {
    super("OpenCode admission authority is unavailable");
  }
}

export class OpenCodeAuthorityCorruptTailError extends Error {
  readonly _tag = "OpenCodeAuthorityCorruptTailError";
  readonly code = "opencode-authority-corrupt-tail";

  constructor() {
    super("OpenCode admission authority returned a corrupt tail");
  }
}

const authorityLayer = PostgresAdmissionLedgerLive.pipe(
  Layer.provideMerge(PostgresRuntimeClientLive),
);

export interface LiveOpenCodeAuthority {
  readonly authority: OpenCodeAdmissionAuthority;
  readonly dispose: () => Promise<void>;
}

const asSafeInteger = (value: string | null) => {
  if (value === null) throw new OpenCodeAuthorityCorruptTailError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OpenCodeAuthorityCorruptTailError();
  }
  return parsed;
};

const decodeCanonicalStored = <T, E>(
  schema: Schema.Codec<T, E>,
  value: unknown,
  expectedHash: string,
) => {
  try {
    const decoded = decodeDomain(schema)(value);
    const encoded = encodeDomain(schema)(decoded);
    if (
      expectedHash !== encodedJsonHash(value) ||
      canonicalJson(encoded) !== canonicalJson(value)
    ) {
      throw new OpenCodeAuthorityCorruptTailError();
    }
    return decoded;
  } catch (error) {
    if (error instanceof OpenCodeAuthorityCorruptTailError) throw error;
    throw new OpenCodeAuthorityCorruptTailError();
  }
};

const sameScope = (
  left: { readonly project: string; readonly workstream: string },
  right: { readonly project: string; readonly workstream: string },
) => left.project === right.project && left.workstream === right.workstream;

export const decodeOpenCodeTailRow = (row: OpenCodeTailRowV1): OpenCodeAcceptedTailV1 => {
  const command = decodeCanonicalStored(
    AdmissionCommandFactV1Schema,
    row.command,
    row.command_hash,
  );
  if (command._tag === "finalize") throw new OpenCodeAuthorityCorruptTailError();
  const fact = command._tag === "accept" ? command.acceptance : command.receipt;
  const source = decodeCanonicalStored(
    RawCaptureSourceCoordinatesV1Schema,
    row.source,
    row.source_hash,
  );
  const runtime = decodeCanonicalStored(
    RuntimeIdentityV1Schema,
    row.runtime_identity,
    row.runtime_identity_hash,
  );
  const outbox = decodeCanonicalStored(
    AdmissionWakeV1Schema,
    row.outbox_payload,
    row.outbox_payload_hash,
  );
  const factId =
    command._tag === "accept" ? command.acceptance.acceptanceId : command.receipt.exclusionId;
  const expectedTopic = command._tag === "accept" ? "accepted-run.v1" : "semantic-excluded.v1";
  const expectedWakeTag = command._tag === "accept" ? "acceptedRun" : "semanticExcluded";
  const expectedDisposition =
    command._tag === "accept" ? new Set(["admitted", "replay"]) : new Set(["excluded", "replay"]);
  const admissionSeq = asSafeInteger(row.admission_seq);
  const windowSeq = asSafeInteger(row.window_seq);
  const fromByte = asSafeInteger(row.from_byte);
  const toByteExclusive = asSafeInteger(row.to_byte_exclusive);
  const disabledFromByte =
    row.disabled_from_byte === null ? undefined : asSafeInteger(row.disabled_from_byte);
  const commandFingerprint = encodedJsonHash(["admission-command:v1", row.command]);
  const wakeKey = encodedJsonHash([
    "admission-wake:v1",
    expectedTopic,
    fact.source.sourceStreamId,
    factId,
  ]);
  const sourceAliasesMatch =
    source.sourceStreamId === row.source_stream_id &&
    source.fromByte === fromByte &&
    source.toByteExclusive === toByteExclusive &&
    source.rawSegmentHash === row.raw_segment_hash &&
    source.sourcePrefixHash === row.source_prefix_hash &&
    (source.previousPrefixHash ?? null) === row.previous_prefix_hash;
  const sourceMatchesFact =
    source.sourceStreamId === fact.source.sourceStreamId &&
    source.adapterStreamIdHash === fact.source.adapterStreamIdHash &&
    source.coverage === fact.source.coverage &&
    source.fromByte === fact.source.fromByte &&
    source.toByteExclusive === fact.source.toByteExclusive &&
    source.rawByteCount === fact.source.rawByteCount &&
    source.rawRunId === fact.source.rawRunId &&
    source.rawSegmentHash === fact.source.rawSegmentHash &&
    source.sourcePrefixHash === fact.source.sourcePrefixHash &&
    source.previousPrefixHash === fact.source.previousPrefixHash;
  const continuityMatches =
    fromByte === 0
      ? row.previous_prefix_hash === null &&
        row.predecessor_to_byte_exclusive === null &&
        row.predecessor_prefix_hash === null
      : row.previous_prefix_hash !== null &&
        asSafeInteger(row.predecessor_to_byte_exclusive) === fromByte &&
        row.predecessor_prefix_hash === row.previous_prefix_hash;
  const projectionStateMatches =
    fact.projection.decision === "disabled"
      ? disabledFromByte !== undefined && disabledFromByte <= source.fromByte
      : disabledFromByte === undefined;

  if (
    row.runtime !== "opencode" ||
    runtime.runtime !== "opencode" ||
    row.runtime_identity_proof_hash !== runtime.identityProofHash ||
    row.conversation_id !== runtime.conversationId ||
    row.adapter_stream_id_hash !== fact.source.adapterStreamIdHash ||
    fact.runtime.identityProofHash !== runtime.identityProofHash ||
    fact.runtime.adapterInstanceIdHash !== runtime.adapterInstanceIdHash ||
    fact.runtime.conversationId !== runtime.conversationId ||
    row.source_stream_id !== fact.source.sourceStreamId ||
    row.scope_project !== fact.scope.scope.project ||
    row.scope_workstream !== fact.scope.scope.workstream ||
    !sameScope(fact.scope.scope, {
      project: row.scope_project,
      workstream: row.scope_workstream,
    }) ||
    row.current_privacy !== fact.privacy.tier ||
    asSafeInteger(row.current_tail_window_seq) !== windowSeq ||
    !sourceAliasesMatch ||
    !sourceMatchesFact ||
    !continuityMatches ||
    !projectionStateMatches ||
    row.command_kind !== command._tag ||
    !expectedDisposition.has(row.disposition) ||
    row.capture_event_id !== factId ||
    row.command_fingerprint !== commandFingerprint ||
    asSafeInteger(row.outbox_admission_seq) !== admissionSeq ||
    asSafeInteger(row.outbox_window_seq) !== windowSeq ||
    row.outbox_source_stream_id !== row.source_stream_id ||
    row.outbox_topic !== expectedTopic ||
    outbox._tag !== expectedWakeTag ||
    outbox.captureEventId !== factId ||
    outbox.sourceStreamId !== row.source_stream_id ||
    row.outbox_wake_key !== wakeKey
  ) {
    throw new OpenCodeAuthorityCorruptTailError();
  }

  return {
    ...(disabledFromByte === undefined ? {} : { disabledFromByte }),
    factId,
    privacy: fact.privacy.tier,
    project: fact.scope.scope.project,
    projection: fact.projection.decision,
    sourcePrefixHash: source.sourcePrefixHash,
    sourceStreamId: source.sourceStreamId,
    toByteExclusive: source.toByteExclusive,
    ...(command._tag === "accept"
      ? { toTurn: command.acceptance.toTurn, transcriptHash: command.acceptance.transcriptHash }
      : {}),
    workstream: fact.scope.scope.workstream,
  };
};

const requiredColumns = [
  ["fm_streams", "source_stream_id", "text", true],
  ["fm_streams", "runtime", "text", true],
  ["fm_streams", "conversation_id", "text", true],
  ["fm_streams", "runtime_identity_proof_hash", "text", true],
  ["fm_streams", "adapter_stream_id_hash", "text", true],
  ["fm_streams", "scope_project", "text", true],
  ["fm_streams", "scope_workstream", "text", true],
  ["fm_streams", "runtime_identity_hash", "text", true],
  ["fm_streams", "runtime_identity", "jsonb", true],
  ["fm_streams", "current_tail_window_seq", "bigint", false],
  ["fm_streams", "current_privacy", "text", false],
  ["fm_streams", "disabled_from_byte", "bigint", false],
  ["fm_streams", "finality_event_id", "text", false],
  ["fm_streams", "finality_hash", "text", false],
  ["fm_streams", "finality", "jsonb", false],
  ["fm_streams", "revision", "bigint", true],
  ["fm_streams", "updated_at", "timestamp with time zone", true],
  ["fm_source_windows", "window_seq", "bigint", true],
  ["fm_source_windows", "source_stream_id", "text", true],
  ["fm_source_windows", "from_byte", "bigint", true],
  ["fm_source_windows", "to_byte_exclusive", "bigint", true],
  ["fm_source_windows", "raw_segment_hash", "text", true],
  ["fm_source_windows", "source_prefix_hash", "text", true],
  ["fm_source_windows", "previous_prefix_hash", "text", false],
  ["fm_source_windows", "source_hash", "text", true],
  ["fm_source_windows", "source", "jsonb", true],
  ["fm_admissions", "admission_seq", "bigint", true],
  ["fm_admissions", "invocation_id", "text", true],
  ["fm_admissions", "command_fingerprint", "text", true],
  ["fm_admissions", "source_stream_id", "text", true],
  ["fm_admissions", "command_kind", "text", true],
  ["fm_admissions", "disposition", "text", true],
  ["fm_admissions", "code", "text", false],
  ["fm_admissions", "capture_event_id", "text", true],
  ["fm_admissions", "window_seq", "bigint", false],
  ["fm_admissions", "command_hash", "text", true],
  ["fm_admissions", "command", "jsonb", true],
  ["fm_admissions", "decision_hash", "text", true],
  ["fm_admissions", "decision", "jsonb", true],
  ["fm_admissions", "occurred_at", "timestamp with time zone", true],
  ["fm_outbox", "outbox_seq", "bigint", true],
  ["fm_outbox", "wake_key", "text", true],
  ["fm_outbox", "admission_seq", "bigint", true],
  ["fm_outbox", "source_stream_id", "text", true],
  ["fm_outbox", "window_seq", "bigint", true],
  ["fm_outbox", "topic", "text", true],
  ["fm_outbox", "payload_hash", "text", true],
  ["fm_outbox", "payload", "jsonb", true],
] as const;

const requiredForeignKeys = [
  ["fm_source_windows", ["source_stream_id"], "fm_streams", ["source_stream_id"], false, false],
  [
    "fm_source_windows",
    ["source_stream_id", "from_byte", "previous_prefix_hash"],
    "fm_source_windows",
    ["source_stream_id", "to_byte_exclusive", "source_prefix_hash"],
    true,
    true,
  ],
  [
    "fm_streams",
    ["current_tail_window_seq", "source_stream_id"],
    "fm_source_windows",
    ["window_seq", "source_stream_id"],
    false,
    false,
  ],
  ["fm_admissions", ["source_stream_id"], "fm_streams", ["source_stream_id"], false, false],
  [
    "fm_admissions",
    ["window_seq", "source_stream_id"],
    "fm_source_windows",
    ["window_seq", "source_stream_id"],
    false,
    false,
  ],
  ["fm_outbox", ["admission_seq"], "fm_admissions", ["admission_seq"], false, false],
  [
    "fm_outbox",
    ["window_seq", "source_stream_id"],
    "fm_source_windows",
    ["window_seq", "source_stream_id"],
    false,
    false,
  ],
] as const;

const runtimeConstraintCompatible = (definition: string | null) => {
  if (definition === null) return false;
  const normalized = definition.replaceAll(/\s+/gu, "");
  return (
    normalized ===
    "CHECK((runtime=ANY(ARRAY['pi'::text,'claude'::text,'codex'::text,'cursor'::text,'grok'::text,'opencode'::text])))"
  );
};

const schemaCompatible = (columns: readonly ColumnRow[], keys: readonly ForeignKeyRow[]) => {
  const columnSet = new Set(
    columns.map((row) =>
      JSON.stringify([row.table_name, row.column_name, row.data_type, row.is_not_null]),
    ),
  );
  const keySet = new Set(
    keys.map((row) =>
      JSON.stringify([
        row.source_table,
        [...row.source_columns],
        row.target_table,
        [...row.target_columns],
        row.is_deferrable,
        row.initially_deferred,
      ]),
    ),
  );
  return (
    requiredColumns.every((column) => columnSet.has(JSON.stringify(column))) &&
    requiredForeignKeys.every((key) => keySet.has(JSON.stringify(key)))
  );
};

export const makeLiveOpenCodeAuthority = (): LiveOpenCodeAuthority => {
  const runtime = ManagedRuntime.make(authorityLayer);
  const migrationRuntime = ManagedRuntime.make(PostgresMigrationClientLive);

  const preflight = async (input: {
    readonly requireWrite: boolean;
  }): Promise<OpenCodeAuthorityPreflightV1> => {
    try {
      const [catalog, privileges] = await Promise.all([
        migrationRuntime.runPromise(
          Effect.gen(function* migrationPreflight() {
            const sql = yield* PgClient.PgClient;
            const [migration] = yield* sql<MigrationRow>`
              SELECT
                EXISTS (
                  SELECT 1 FROM public.joelclaw_memory_migrations
                  WHERE migration_id = 4 AND name = 'opencode_runtime'
                ) AS migration_registered,
                (
                  SELECT pg_get_constraintdef(constraint_row.oid)
                  FROM pg_catalog.pg_constraint AS constraint_row
                  WHERE constraint_row.conrelid = 'public.fm_streams'::regclass
                    AND constraint_row.conname = 'fm_streams_runtime_check'
                    AND constraint_row.contype = 'c'
                  LIMIT 1
                ) AS runtime_constraint_definition
            `;
            const columns = yield* sql<ColumnRow>`
              SELECT table_row.relname AS table_name,
                     attribute.attname AS column_name,
                     pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
                     attribute.attnotnull AS is_not_null
              FROM pg_catalog.pg_class AS table_row
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = table_row.relnamespace
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = table_row.oid
              WHERE namespace.nspname = 'public'
                AND table_row.relname IN ('fm_streams', 'fm_source_windows', 'fm_admissions', 'fm_outbox')
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
            `;
            const keys = yield* sql<ForeignKeyRow>`
              SELECT source_table.relname AS source_table,
                     target_table.relname AS target_table,
                     jsonb_agg(source_attribute.attname ORDER BY key_columns.ordinality) AS source_columns,
                     jsonb_agg(target_attribute.attname ORDER BY key_columns.ordinality) AS target_columns,
                     constraint_row.condeferrable AS is_deferrable,
                     constraint_row.condeferred AS initially_deferred
              FROM pg_catalog.pg_constraint AS constraint_row
              JOIN pg_catalog.pg_class AS source_table ON source_table.oid = constraint_row.conrelid
              JOIN pg_catalog.pg_class AS target_table ON target_table.oid = constraint_row.confrelid
              JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
                WITH ORDINALITY AS key_columns(source_attnum, target_attnum, ordinality) ON true
              JOIN pg_catalog.pg_attribute AS source_attribute
                ON source_attribute.attrelid = constraint_row.conrelid
               AND source_attribute.attnum = key_columns.source_attnum
              JOIN pg_catalog.pg_attribute AS target_attribute
                ON target_attribute.attrelid = constraint_row.confrelid
               AND target_attribute.attnum = key_columns.target_attnum
              WHERE constraint_row.contype = 'f'
                AND source_table.relname IN ('fm_streams', 'fm_source_windows', 'fm_admissions', 'fm_outbox')
              GROUP BY source_table.relname, target_table.relname,
                       constraint_row.condeferrable, constraint_row.condeferred,
                       constraint_row.oid
            `;
            return { columns, keys, migration };
          }),
        ),
        runtime.runPromise(
          Effect.gen(function* runtimePreflight() {
            const sql = yield* PgClient.PgClient;
            const [row] = yield* sql<PrivilegeRow>`
              SELECT
                has_schema_privilege(current_user, 'public', 'USAGE')
                AND has_table_privilege(current_user, 'public.fm_streams', 'SELECT')
                AND has_table_privilege(current_user, 'public.fm_source_windows', 'SELECT')
                AND has_table_privilege(current_user, 'public.fm_admissions', 'SELECT')
                AND has_table_privilege(current_user, 'public.fm_outbox', 'SELECT') AS readable,
                has_table_privilege(current_user, 'public.fm_streams', 'INSERT')
                AND has_table_privilege(current_user, 'public.fm_source_windows', 'INSERT')
                AND has_table_privilege(current_user, 'public.fm_admissions', 'INSERT')
                AND has_table_privilege(current_user, 'public.fm_outbox', 'INSERT')
                AND has_column_privilege(current_user, 'public.fm_streams', 'current_tail_window_seq', 'UPDATE')
                AND has_column_privilege(current_user, 'public.fm_streams', 'current_privacy', 'UPDATE')
                AND has_column_privilege(current_user, 'public.fm_streams', 'disabled_from_byte', 'UPDATE')
                AND has_column_privilege(current_user, 'public.fm_streams', 'finality_event_id', 'UPDATE')
                AND has_column_privilege(current_user, 'public.fm_streams', 'finality_hash', 'UPDATE')
                AND has_column_privilege(current_user, 'public.fm_streams', 'finality', 'UPDATE')
                AND has_column_privilege(current_user, 'public.fm_streams', 'revision', 'UPDATE')
                AND has_column_privilege(current_user, 'public.fm_streams', 'updated_at', 'UPDATE')
                AND has_sequence_privilege(current_user, 'public.fm_source_windows_window_seq_seq', 'USAGE')
                AND has_sequence_privilege(current_user, 'public.fm_admissions_admission_seq_seq', 'USAGE')
                AND has_sequence_privilege(current_user, 'public.fm_outbox_outbox_seq_seq', 'USAGE') AS writable
            `;
            if (row === undefined) throw new OpenCodeAuthorityError();
            return row;
          }),
        ),
      ]);
      const migration = catalog.migration;
      if (migration === undefined) throw new OpenCodeAuthorityError();
      return {
        migrationCompatible:
          migration.migration_registered && schemaCompatible(catalog.columns, catalog.keys),
        readable: privileges.readable,
        runtimeCompatible: runtimeConstraintCompatible(migration.runtime_constraint_definition),
        writable: input.requireWrite ? privileges.writable : true,
      };
    } catch {
      throw new OpenCodeAuthorityError();
    }
  };

  const readTail = (sourceStreamId: string): Promise<OpenCodeAcceptedTailV1 | undefined> =>
    runtime.runPromise(
      Effect.gen(function* readTailEffect() {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<OpenCodeTailRowV1>`
          SELECT
            s.runtime,
            s.conversation_id,
            s.runtime_identity,
            s.runtime_identity_hash,
            s.runtime_identity_proof_hash,
            s.adapter_stream_id_hash,
            s.scope_project,
            s.scope_workstream,
            s.current_tail_window_seq::text,
            s.current_privacy,
            s.disabled_from_byte::text,
            w.window_seq::text,
            w.source_stream_id,
            w.from_byte::text,
            w.to_byte_exclusive::text,
            w.raw_segment_hash,
            w.source_prefix_hash,
            w.previous_prefix_hash,
            w.source_hash,
            w.source,
            predecessor.to_byte_exclusive::text AS predecessor_to_byte_exclusive,
            predecessor.source_prefix_hash AS predecessor_prefix_hash,
            a.admission_seq::text,
            a.command_kind,
            a.disposition,
            a.capture_event_id,
            a.command_fingerprint,
            a.command_hash,
            a.command,
            o.admission_seq::text AS outbox_admission_seq,
            o.source_stream_id AS outbox_source_stream_id,
            o.window_seq::text AS outbox_window_seq,
            o.topic AS outbox_topic,
            o.wake_key AS outbox_wake_key,
            o.payload_hash AS outbox_payload_hash,
            o.payload AS outbox_payload
          FROM public.fm_streams AS s
          LEFT JOIN public.fm_source_windows AS w
            ON w.window_seq = s.current_tail_window_seq
           AND w.source_stream_id = s.source_stream_id
          LEFT JOIN public.fm_source_windows AS predecessor
            ON predecessor.source_stream_id = w.source_stream_id
           AND predecessor.to_byte_exclusive = w.from_byte
           AND predecessor.source_prefix_hash = w.previous_prefix_hash
          LEFT JOIN LATERAL (
            SELECT admission_seq, command_kind, disposition, capture_event_id,
                   command_fingerprint, command_hash, command
            FROM public.fm_admissions
            WHERE source_stream_id = s.source_stream_id
              AND command_kind IN ('accept', 'exclude')
              AND window_seq = w.window_seq
              AND disposition IN ('admitted', 'excluded', 'replay')
            ORDER BY admission_seq DESC
            LIMIT 1
          ) AS a ON true
          LEFT JOIN public.fm_outbox AS o
            ON o.admission_seq = a.admission_seq
           AND o.source_stream_id = s.source_stream_id
           AND o.window_seq = w.window_seq
          WHERE s.source_stream_id = ${sourceStreamId}
          ORDER BY o.outbox_seq
          LIMIT 2
        `;
        if (rows.length > 1) throw new OpenCodeAuthorityCorruptTailError();
        const row = rows[0];
        return row === undefined ? undefined : decodeOpenCodeTailRow(row);
      }).pipe(
        Effect.mapError((error) =>
          error instanceof OpenCodeAuthorityCorruptTailError ? error : new OpenCodeAuthorityError(),
        ),
      ),
    );

  const authority: OpenCodeAdmissionAuthority = {
    admit: (command) =>
      runtime.runPromise(
        Effect.flatMap(PostgresAdmissionLedger, (service) => service.admit(command)),
      ),
    preflight,
    readTail,
  };

  return {
    authority,
    dispose: async () => {
      await Promise.all([runtime.dispose(), migrationRuntime.dispose()]);
    },
  };
};
