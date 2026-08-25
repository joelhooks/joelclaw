import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
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

afterAll(async () => {
  if (priorMigrationUrl === undefined) delete process.env.JOELCLAW_MEMORY_MIGRATION_DATABASE_URL;
  else process.env.JOELCLAW_MEMORY_MIGRATION_DATABASE_URL = priorMigrationUrl;
  if (priorRuntimeUrl === undefined) delete process.env.JOELCLAW_MEMORY_RUNTIME_DATABASE_URL;
  else process.env.JOELCLAW_MEMORY_RUNTIME_DATABASE_URL = priorRuntimeUrl;
  await cluster.stop();
});

describe.sequential("OpenCode producer with isolated PostgreSQL 17", () => {
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
