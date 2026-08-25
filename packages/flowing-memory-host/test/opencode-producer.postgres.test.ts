import { createHash } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { runMemoryMigrations } from "@joelclaw-memory/postgres";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeLiveOpenCodeAuthority } from "../src/opencode-authority.js";
import { reconcileOpenCodeSnapshot } from "../src/opencode-producer.js";
import {
  OPENCODE_ENCODER_VERSION,
  OPENCODE_SOURCE_SCHEMA_VERSION,
  type OpenCodeSourceSnapshotV1,
  type OpenCodeSourceStreamV1,
  SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
} from "../src/opencode-source.js";
import { makeTrustedAdmissionWriter } from "../src/trusted-admission.js";
import { type PostgresTestCluster, startPostgresTestCluster } from "./postgres-test-cluster.js";

const encoder = new TextEncoder();
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const sourceStream = (): OpenCodeSourceStreamV1 => {
  const canonicalBytes = encoder.encode(
    `${JSON.stringify({
      schemaVersion: 1,
      sessionRef: "synthetic-native-session",
      messageId: "synthetic-native-message",
      role: "user",
      occurredAt: 1_700_000_000_000,
      parts: [{ partId: "synthetic-native-part", text: "synthetic accepted body" }],
    })}\n`,
  );
  const prefixHash = sha256(canonicalBytes);
  return {
    byteCount: canonicalBytes.byteLength,
    canonicalBytes,
    eligibleMessageCount: 1,
    finality: "open",
    prefixHash,
    segmentHash: prefixHash,
    sessionIdentityHash: sha256("synthetic-native-session"),
    sourceCreatedAt: 1_700_000_000_000,
    sourceDirectory: "/synthetic/no-repository",
    sourceWorkstream: "default",
    streamIdentityHash: sha256("synthetic-native-stream"),
  };
};

const sourceSnapshot = (stream: OpenCodeSourceStreamV1): OpenCodeSourceSnapshotV1 => ({
  adapterInstanceIdentityHash: "a".repeat(64),
  databaseUserVersion: 0,
  encoderVersion: OPENCODE_ENCODER_VERSION,
  inventory: {
    childSessionCount: 0,
    eligibleMessageCount: 1,
    messageCount: 1,
    partCount: 1,
    rootSessionCount: 1,
    sessionCount: 1,
    sessionMessageCount: 0,
    streamCount: 1,
  },
  schemaFingerprint: SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
  schemaVersion: OPENCODE_SOURCE_SCHEMA_VERSION,
  streams: [stream],
});

let cluster: PostgresTestCluster;
const priorMigrationUrl = process.env.JOELCLAW_MEMORY_MIGRATION_DATABASE_URL;
const priorRuntimeUrl = process.env.JOELCLAW_MEMORY_RUNTIME_DATABASE_URL;

beforeAll(async () => {
  cluster = await startPostgresTestCluster();
  const migrationLayer = PgClient.layer({ url: Redacted.make(cluster.migrationUrl) });
  await Effect.runPromise(Effect.scoped(runMemoryMigrations.pipe(Effect.provide(migrationLayer))));
  process.env.JOELCLAW_MEMORY_MIGRATION_DATABASE_URL = cluster.migrationUrl;
  process.env.JOELCLAW_MEMORY_RUNTIME_DATABASE_URL = cluster.runtimeUrl;
}, 30_000);

const runAdminSql = (statement: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* adminStatement() {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(statement);
      }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(cluster.migrationUrl) }))),
    ),
  );

afterAll(async () => {
  if (priorMigrationUrl === undefined) delete process.env.JOELCLAW_MEMORY_MIGRATION_DATABASE_URL;
  else process.env.JOELCLAW_MEMORY_MIGRATION_DATABASE_URL = priorMigrationUrl;
  if (priorRuntimeUrl === undefined) delete process.env.JOELCLAW_MEMORY_RUNTIME_DATABASE_URL;
  else process.env.JOELCLAW_MEMORY_RUNTIME_DATABASE_URL = priorRuntimeUrl;
  await cluster.stop();
});

describe.sequential("OpenCode producer with isolated PostgreSQL 17", () => {
  it("proves the exact migration, schema, foreign keys, runtime set, and write privileges", async () => {
    const live = makeLiveOpenCodeAuthority();
    const evidenceDirectory = await mkdtemp(path.join(tmpdir(), "opencode-preflight-evidence-"));
    const stream = sourceStream();
    const snapshot = sourceSnapshot(stream);
    const dependencies = {
      authority: live.authority,
      resolveConfig: async () => ({
        adapterInstanceIdHash: snapshot.adapterInstanceIdentityHash,
        canonicalRepository: "github.com/joelclaw/fleet",
        principalIdHash: "b".repeat(64),
        privacy: "private" as const,
        project: "joelclaw-fleet",
        projection: "enabled" as const,
        repositoryHost: "github.com" as const,
        repositoryName: "fleet",
        repositoryOwner: "joelclaw",
        scopeFallbackReason: "no-repository" as const,
        scopeResolution: "fleetFallback" as const,
        workstream: "default",
      }),
      writer: makeTrustedAdmissionWriter({ evidenceDirectory, ledger: live.authority }),
    };
    try {
      await expect(live.authority.preflight({ requireWrite: true })).resolves.toEqual({
        migrationCompatible: true,
        readable: true,
        runtimeCompatible: true,
        writable: true,
      });

      await runAdminSql(
        "UPDATE public.joelclaw_memory_migrations SET name = 'forged' WHERE migration_id = 4",
      );
      expect((await live.authority.preflight({ requireWrite: true })).migrationCompatible).toBe(
        false,
      );
      await runAdminSql(
        "UPDATE public.joelclaw_memory_migrations SET name = 'opencode_runtime' WHERE migration_id = 4",
      );

      await runAdminSql(
        "ALTER TABLE public.fm_admissions RENAME COLUMN command_hash TO forged_hash",
      );
      expect((await live.authority.preflight({ requireWrite: true })).migrationCompatible).toBe(
        false,
      );
      await runAdminSql(
        "ALTER TABLE public.fm_admissions RENAME COLUMN forged_hash TO command_hash",
      );

      await runAdminSql(
        "ALTER TABLE public.fm_outbox DROP CONSTRAINT fm_outbox_admission_seq_fkey",
      );
      expect((await live.authority.preflight({ requireWrite: true })).migrationCompatible).toBe(
        false,
      );
      await runAdminSql(
        "ALTER TABLE public.fm_outbox ADD CONSTRAINT fm_outbox_admission_seq_fkey FOREIGN KEY (admission_seq) REFERENCES public.fm_admissions(admission_seq)",
      );

      await runAdminSql(
        "ALTER TABLE public.fm_streams DROP CONSTRAINT fm_streams_runtime_check, ADD CONSTRAINT fm_streams_runtime_check CHECK (runtime IN ('pi', 'claude', 'codex', 'cursor', 'grok'))",
      );
      expect((await live.authority.preflight({ requireWrite: true })).runtimeCompatible).toBe(
        false,
      );
      await runAdminSql(
        "ALTER TABLE public.fm_streams DROP CONSTRAINT fm_streams_runtime_check, ADD CONSTRAINT fm_streams_runtime_check CHECK (runtime IN ('pi', 'claude', 'codex', 'cursor', 'grok', 'opencode'))",
      );

      await runAdminSql(
        "REVOKE USAGE ON SEQUENCE public.fm_outbox_outbox_seq_seq FROM joelclaw_memory_runtime",
      );
      expect((await live.authority.preflight({ requireWrite: true })).writable).toBe(false);
      await expect(
        reconcileOpenCodeSnapshot(
          snapshot,
          { apply: true, confirmed: true, maxSessions: 1 },
          dependencies,
        ),
      ).rejects.toMatchObject({ code: "runtime-write-unavailable" });
      expect(await readdir(evidenceDirectory)).toEqual([]);
      await runAdminSql(
        "GRANT USAGE ON SEQUENCE public.fm_outbox_outbox_seq_seq TO joelclaw_memory_runtime",
      );
    } finally {
      await runAdminSql(
        "UPDATE public.joelclaw_memory_migrations SET name = 'opencode_runtime' WHERE migration_id = 4",
      ).catch(() => undefined);
      await runAdminSql(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'fm_admissions'
              AND column_name = 'forged_hash'
          ) THEN
            ALTER TABLE public.fm_admissions RENAME COLUMN forged_hash TO command_hash;
          END IF;
        END $$;
      `).catch(() => undefined);
      await runAdminSql(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.fm_outbox'::regclass
              AND conname = 'fm_outbox_admission_seq_fkey'
          ) THEN
            ALTER TABLE public.fm_outbox ADD CONSTRAINT fm_outbox_admission_seq_fkey
              FOREIGN KEY (admission_seq) REFERENCES public.fm_admissions(admission_seq);
          END IF;
        END $$;
      `).catch(() => undefined);
      await runAdminSql(
        "ALTER TABLE public.fm_streams DROP CONSTRAINT IF EXISTS fm_streams_runtime_check, ADD CONSTRAINT fm_streams_runtime_check CHECK (runtime IN ('pi', 'claude', 'codex', 'cursor', 'grok', 'opencode'))",
      ).catch(() => undefined);
      await runAdminSql(
        "GRANT USAGE ON SEQUENCE public.fm_outbox_outbox_seq_seq TO joelclaw_memory_runtime",
      ).catch(() => undefined);
      await live.dispose();
    }
  }, 20_000);

  it("persists one accepted suffix and reads the durable tail on replay", async () => {
    const evidenceDirectory = await mkdtemp(path.join(tmpdir(), "opencode-pg-evidence-"));
    const live = makeLiveOpenCodeAuthority();
    const stream = sourceStream();
    const snapshot = sourceSnapshot(stream);
    const writer = makeTrustedAdmissionWriter({
      evidenceDirectory,
      ledger: live.authority,
    });
    const dependencies = {
      authority: live.authority,
      resolveConfig: async () => ({
        adapterInstanceIdHash: snapshot.adapterInstanceIdentityHash,
        canonicalRepository: "github.com/joelclaw/fleet",
        principalIdHash: "b".repeat(64),
        privacy: "private" as const,
        project: "joelclaw-fleet",
        projection: "enabled" as const,
        repositoryHost: "github.com",
        repositoryName: "fleet",
        repositoryOwner: "joelclaw",
        scopeFallbackReason: "no-repository" as const,
        scopeResolution: "fleetFallback" as const,
        workstream: "default",
      }),
      writer,
    };
    try {
      const first = await reconcileOpenCodeSnapshot(
        snapshot,
        { apply: true, confirmed: true, maxSessions: 1 },
        dependencies,
      );
      expect(first.streams[0]).toMatchObject({ _tag: "settled", disposition: "admitted" });

      const second = await reconcileOpenCodeSnapshot(
        snapshot,
        { apply: true, confirmed: true, maxSessions: 1 },
        dependencies,
      );
      expect(second.counts.noChange).toBe(1);
    } finally {
      await live.dispose();
    }
  }, 20_000);
});
