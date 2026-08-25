import { PgClient } from "@effect/sql-pg";
import { AdmissionCommandFactV1Schema, decodeDomain } from "@joelclaw-memory/domain";
import {
  PostgresAdmissionLedger,
  PostgresAdmissionLedgerLive,
  PostgresRuntimeClientLive,
} from "@joelclaw-memory/postgres";
import { Effect, Layer, ManagedRuntime } from "effect";

import type {
  OpenCodeAcceptedTailV1,
  OpenCodeAdmissionAuthority,
  OpenCodeAuthorityPreflightV1,
} from "./opencode-producer.js";

interface PreflightRow {
  readonly migration_compatible: boolean;
  readonly runtime_compatible: boolean;
  readonly writable: boolean;
}

interface TailRow {
  readonly command: unknown;
  readonly source_prefix_hash: string;
  readonly source_stream_id: string;
  readonly to_byte_exclusive: string;
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

const asSafeInteger = (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OpenCodeAuthorityCorruptTailError();
  }
  return parsed;
};

const decodeTail = (row: TailRow): OpenCodeAcceptedTailV1 => {
  const command = decodeDomain(AdmissionCommandFactV1Schema)(row.command);
  if (command._tag === "finalize") throw new OpenCodeAuthorityCorruptTailError();
  const fact = command._tag === "accept" ? command.acceptance : command.receipt;
  const toByteExclusive = asSafeInteger(row.to_byte_exclusive);
  if (
    fact.source.sourceStreamId !== row.source_stream_id ||
    fact.source.toByteExclusive !== toByteExclusive ||
    fact.source.sourcePrefixHash !== row.source_prefix_hash
  ) {
    throw new OpenCodeAuthorityCorruptTailError();
  }
  return {
    factId:
      command._tag === "accept" ? command.acceptance.acceptanceId : command.receipt.exclusionId,
    privacy: fact.privacy.tier,
    project: fact.scope.scope.project,
    sourcePrefixHash: row.source_prefix_hash,
    sourceStreamId: row.source_stream_id,
    toByteExclusive,
    ...(command._tag === "accept"
      ? { toTurn: command.acceptance.toTurn, transcriptHash: command.acceptance.transcriptHash }
      : {}),
    workstream: fact.scope.scope.workstream,
  };
};

export const makeLiveOpenCodeAuthority = (): LiveOpenCodeAuthority => {
  const runtime = ManagedRuntime.make(authorityLayer);

  const preflight = (input: {
    readonly requireWrite: boolean;
  }): Promise<OpenCodeAuthorityPreflightV1> =>
    runtime.runPromise(
      Effect.gen(function* preflightEffect() {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<PreflightRow>`
          SELECT
            (
              to_regclass('public.fm_streams') IS NOT NULL
              AND to_regclass('public.fm_source_windows') IS NOT NULL
              AND to_regclass('public.fm_admissions') IS NOT NULL
              AND to_regclass('public.fm_outbox') IS NOT NULL
            ) AS migration_compatible,
            EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conname = 'fm_streams_runtime_check'
                AND pg_get_constraintdef(oid) LIKE '%opencode%'
            ) AS runtime_compatible,
            (
              has_table_privilege(current_user, 'fm_streams', 'INSERT')
              AND has_table_privilege(current_user, 'fm_source_windows', 'INSERT')
              AND has_table_privilege(current_user, 'fm_admissions', 'INSERT')
              AND has_table_privilege(current_user, 'fm_outbox', 'INSERT')
            ) AS writable
        `;
        const row = rows[0];
        if (row === undefined) return yield* Effect.fail(new OpenCodeAuthorityError());
        return {
          migrationCompatible: row.migration_compatible,
          runtimeCompatible: row.runtime_compatible,
          writable: input.requireWrite ? row.writable : true,
        };
      }).pipe(Effect.mapError(() => new OpenCodeAuthorityError())),
    );

  const readTail = (sourceStreamId: string): Promise<OpenCodeAcceptedTailV1 | undefined> =>
    runtime.runPromise(
      Effect.gen(function* readTailEffect() {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<TailRow>`
          SELECT
            a.command,
            w.source_prefix_hash,
            w.source_stream_id,
            w.to_byte_exclusive::text
          FROM fm_streams AS s
          JOIN fm_source_windows AS w
            ON w.window_seq = s.current_tail_window_seq
           AND w.source_stream_id = s.source_stream_id
          JOIN LATERAL (
            SELECT command
            FROM fm_admissions
            WHERE source_stream_id = s.source_stream_id
              AND command_kind IN ('accept', 'exclude')
              AND window_seq = w.window_seq
              AND disposition IN ('admitted', 'excluded', 'replay')
            ORDER BY admission_seq DESC
            LIMIT 1
          ) AS a ON true
          WHERE s.source_stream_id = ${sourceStreamId}
          LIMIT 1
        `;
        const row = rows[0];
        return row === undefined ? undefined : decodeTail(row);
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
    dispose: () => runtime.dispose(),
  };
};
