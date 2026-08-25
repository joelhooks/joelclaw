import { createHash } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { reachOpenCodeReadBarrier } from "./opencode-source-barrier.js";

export const OPENCODE_SOURCE_SCHEMA_VERSION =
  "opencode-1.18.23-materialized-session-message-part:v1" as const;
export const OPENCODE_ENCODER_VERSION = "opencode-visible-message-ndjson:v1" as const;
export const OPENCODE_DRY_RUN_RECEIPT_VERSION = 1 as const;
export const SUPPORTED_OPENCODE_DB_USER_VERSION = 0 as const;
export const OPENCODE_BUSY_TIMEOUT_MS = 2_500 as const;

const encoder = new TextEncoder();

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const hashIdentity = (nativeSessionId: string) =>
  sha256(JSON.stringify(["opencode-session-identity:v1", nativeSessionId]));

const hashStreamIdentity = (nativeSessionId: string, adapterInstanceIdentityHash: string) =>
  sha256(
    JSON.stringify([
      "opencode-source-stream:v1",
      OPENCODE_SOURCE_SCHEMA_VERSION,
      OPENCODE_ENCODER_VERSION,
      adapterInstanceIdentityHash,
      nativeSessionId,
    ]),
  );

interface SchemaColumnV1 {
  readonly name: string;
  readonly notNull: 0 | 1;
  readonly primaryKey: 0 | 1;
  readonly type: "INTEGER" | "REAL" | "TEXT";
}

const supportedSchema = {
  message: [
    { name: "id", notNull: 0, primaryKey: 1, type: "TEXT" },
    { name: "session_id", notNull: 1, primaryKey: 0, type: "TEXT" },
    { name: "time_created", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "time_updated", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "data", notNull: 1, primaryKey: 0, type: "TEXT" },
  ],
  part: [
    { name: "id", notNull: 0, primaryKey: 1, type: "TEXT" },
    { name: "message_id", notNull: 1, primaryKey: 0, type: "TEXT" },
    { name: "session_id", notNull: 1, primaryKey: 0, type: "TEXT" },
    { name: "time_created", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "time_updated", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "data", notNull: 1, primaryKey: 0, type: "TEXT" },
  ],
  session: [
    { name: "id", notNull: 0, primaryKey: 1, type: "TEXT" },
    { name: "project_id", notNull: 1, primaryKey: 0, type: "TEXT" },
    { name: "parent_id", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "slug", notNull: 1, primaryKey: 0, type: "TEXT" },
    { name: "directory", notNull: 1, primaryKey: 0, type: "TEXT" },
    { name: "title", notNull: 1, primaryKey: 0, type: "TEXT" },
    { name: "version", notNull: 1, primaryKey: 0, type: "TEXT" },
    { name: "share_url", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "summary_additions", notNull: 0, primaryKey: 0, type: "INTEGER" },
    { name: "summary_deletions", notNull: 0, primaryKey: 0, type: "INTEGER" },
    { name: "summary_files", notNull: 0, primaryKey: 0, type: "INTEGER" },
    { name: "summary_diffs", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "revert", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "permission", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "time_created", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "time_updated", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "time_compacting", notNull: 0, primaryKey: 0, type: "INTEGER" },
    { name: "time_archived", notNull: 0, primaryKey: 0, type: "INTEGER" },
    { name: "workspace_id", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "path", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "agent", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "model", notNull: 0, primaryKey: 0, type: "TEXT" },
    { name: "cost", notNull: 1, primaryKey: 0, type: "REAL" },
    { name: "tokens_input", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "tokens_output", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "tokens_reasoning", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "tokens_cache_read", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "tokens_cache_write", notNull: 1, primaryKey: 0, type: "INTEGER" },
    { name: "metadata", notNull: 0, primaryKey: 0, type: "TEXT" },
  ],
} as const satisfies Readonly<Record<"message" | "part" | "session", readonly SchemaColumnV1[]>>;

export const SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT = sha256(JSON.stringify(supportedSchema));

export type OpenCodeSourcePhase =
  | "close"
  | "configure"
  | "decode"
  | "inventory"
  | "open"
  | "schema"
  | "transaction";

export class OpenCodeUnsupportedVersionError extends Error {
  readonly _tag = "OpenCodeUnsupportedVersionError";
  readonly code = "opencode-source-unsupported-version";

  constructor(readonly detectedVersion: number) {
    super("OpenCode database version is unsupported");
    this.name = this._tag;
  }
}

export class OpenCodeSchemaError extends Error {
  readonly _tag = "OpenCodeSchemaError";
  readonly code = "opencode-source-schema-mismatch";

  constructor(
    readonly detectedSchemaFingerprint: string,
    readonly expectedSchemaFingerprint = SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
  ) {
    super("OpenCode database schema is unsupported");
    this.name = this._tag;
  }
}

export class OpenCodeBusyError extends Error {
  readonly _tag = "OpenCodeBusyError";
  readonly code = "opencode-source-busy";

  constructor(
    readonly phase: OpenCodeSourcePhase,
    readonly timeoutMs: number = OPENCODE_BUSY_TIMEOUT_MS,
  ) {
    super("OpenCode database is busy");
    this.name = this._tag;
  }
}

export class OpenCodeReadError extends Error {
  readonly _tag = "OpenCodeReadError";
  readonly code = "opencode-source-read-failed";

  constructor(
    readonly phase: OpenCodeSourcePhase,
    readonly entityHash?: string,
  ) {
    super("OpenCode database read failed");
    this.name = this._tag;
  }
}

export type OpenCodeSourceError =
  | OpenCodeBusyError
  | OpenCodeReadError
  | OpenCodeSchemaError
  | OpenCodeUnsupportedVersionError;

const isOpenCodeSourceError = (error: unknown): error is OpenCodeSourceError =>
  error instanceof OpenCodeBusyError ||
  error instanceof OpenCodeReadError ||
  error instanceof OpenCodeSchemaError ||
  error instanceof OpenCodeUnsupportedVersionError;

const isBusyFailure = (error: unknown) => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly errcode?: unknown };
  return (
    candidate.errcode === 5 ||
    candidate.errcode === 6 ||
    candidate.code === "SQLITE_BUSY" ||
    candidate.code === "SQLITE_LOCKED"
  );
};

const mapFailure = (
  phase: OpenCodeSourcePhase,
  error: unknown,
  entityHash?: string,
  timeoutMs: number = OPENCODE_BUSY_TIMEOUT_MS,
): OpenCodeSourceError => {
  if (isOpenCodeSourceError(error)) return error;
  if (isBusyFailure(error)) return new OpenCodeBusyError(phase, timeoutMs);
  return new OpenCodeReadError(phase, entityHash);
};

const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined => {
  const candidate = string(value);
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
};

const safeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const singleRow = (rows: readonly unknown[], phase: OpenCodeSourcePhase) => {
  if (rows.length !== 1) throw new OpenCodeReadError(phase);
  const row = object(rows[0]);
  if (row === undefined) throw new OpenCodeReadError(phase);
  return row;
};

const all = (database: DatabaseSync, sql: string, ...parameters: readonly SQLInputValue[]) =>
  database.prepare(sql).all(...parameters) as readonly unknown[];

const scalarCount = (
  database: DatabaseSync,
  sql: string,
  ...parameters: readonly SQLInputValue[]
) => {
  const count = safeInteger(singleRow(all(database, sql, ...parameters), "inventory").count);
  if (count === undefined) throw new OpenCodeReadError("inventory");
  return count;
};

const establishReadSnapshot = (database: DatabaseSync) => {
  const count = safeInteger(
    singleRow(all(database, "SELECT COUNT(*) AS count FROM sqlite_schema"), "transaction").count,
  );
  if (count === undefined) throw new OpenCodeReadError("transaction");
};

const schemaColumns = (database: DatabaseSync, table: "message" | "part" | "session") => {
  const rows = all(database, `PRAGMA table_info("${table}")`);
  return rows.map((raw) => {
    const row = object(raw);
    const name = string(row?.name);
    const type = string(row?.type)?.toUpperCase();
    const notNull = safeInteger(row?.notnull);
    const primaryKey = safeInteger(row?.pk);
    if (
      name === undefined ||
      (type !== "INTEGER" && type !== "REAL" && type !== "TEXT") ||
      (notNull !== 0 && notNull !== 1) ||
      (primaryKey !== 0 && primaryKey !== 1)
    ) {
      throw new OpenCodeReadError("schema");
    }
    return { name, notNull, primaryKey, type } satisfies SchemaColumnV1;
  });
};

const detectedSchemaFingerprint = (database: DatabaseSync) =>
  sha256(
    JSON.stringify({
      message: schemaColumns(database, "message"),
      part: schemaColumns(database, "part"),
      session: schemaColumns(database, "session"),
    }),
  );

interface SessionRowV1 {
  readonly directory: string;
  readonly id: string;
  readonly parentId?: string;
  readonly timeCreated: number;
}

interface MessageRowV1 {
  readonly data: string;
  readonly id: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
}

interface PartRowV1 {
  readonly data: string;
  readonly id: string;
}

const parseSessionRow = (raw: unknown): SessionRowV1 => {
  const row = object(raw);
  const directory = nonEmptyString(row?.directory);
  const id = nonEmptyString(row?.id);
  const parentId = row?.parent_id === null ? undefined : nonEmptyString(row?.parent_id);
  const timeCreated = safeInteger(row?.time_created);
  if (
    directory === undefined ||
    id === undefined ||
    (parentId === undefined && row?.parent_id !== null) ||
    timeCreated === undefined
  ) {
    throw new OpenCodeReadError("decode");
  }
  return { directory, id, ...(parentId === undefined ? {} : { parentId }), timeCreated };
};

const parseMessageRow = (raw: unknown, sessionIdentityHash: string): MessageRowV1 => {
  const row = object(raw);
  const id = nonEmptyString(row?.id);
  const data = nonEmptyString(row?.data);
  const timeCreated = safeInteger(row?.time_created);
  const timeUpdated = safeInteger(row?.time_updated);
  if (
    id === undefined ||
    data === undefined ||
    timeCreated === undefined ||
    timeUpdated === undefined
  ) {
    throw new OpenCodeReadError("decode", sessionIdentityHash);
  }
  return { data, id, timeCreated, timeUpdated };
};

const parsePartRow = (raw: unknown, sessionIdentityHash: string): PartRowV1 => {
  const row = object(raw);
  const id = nonEmptyString(row?.id);
  const data = nonEmptyString(row?.data);
  if (id === undefined || data === undefined) {
    throw new OpenCodeReadError("decode", sessionIdentityHash);
  }
  return { data, id };
};

interface EligiblePartV1 {
  readonly partId: string;
  readonly text: string;
}

interface CanonicalMessageV1 {
  readonly schemaVersion: 1;
  readonly sessionRef: string;
  readonly messageId: string;
  readonly role: "assistant" | "user";
  readonly occurredAt: number;
  readonly parts: readonly EligiblePartV1[];
}

const parseJsonObject = (value: string, entityHash: string) => {
  try {
    const parsed = object(JSON.parse(value));
    if (parsed === undefined) throw new Error("not-object");
    return parsed;
  } catch {
    throw new OpenCodeReadError("decode", entityHash);
  }
};

const eligiblePart = (row: PartRowV1, sessionIdentityHash: string): EligiblePartV1 | undefined => {
  const data = parseJsonObject(row.data, sessionIdentityHash);
  if (data.type !== "text") return undefined;
  if (data.ignored !== undefined && typeof data.ignored !== "boolean") {
    throw new OpenCodeReadError("decode", sessionIdentityHash);
  }
  if (data.synthetic !== undefined && typeof data.synthetic !== "boolean") {
    throw new OpenCodeReadError("decode", sessionIdentityHash);
  }
  const text = string(data.text);
  if (text === undefined) throw new OpenCodeReadError("decode", sessionIdentityHash);
  if (data.ignored === true || data.synthetic === true || text.trim().length === 0)
    return undefined;
  return { partId: row.id, text };
};

const canonicalMessage = (input: {
  readonly message: MessageRowV1;
  readonly parts: readonly PartRowV1[];
  readonly sessionId: string;
  readonly sessionIdentityHash: string;
}): CanonicalMessageV1 | undefined => {
  const data = parseJsonObject(input.message.data, input.sessionIdentityHash);
  const role = data.role;
  if (role !== "assistant" && role !== "user") return undefined;
  if (role === "assistant" && data.summary !== undefined && typeof data.summary !== "boolean") {
    throw new OpenCodeReadError("decode", input.sessionIdentityHash);
  }
  if (role === "assistant" && data.summary === true) return undefined;
  const parts = input.parts.flatMap((part) => {
    const eligible = eligiblePart(part, input.sessionIdentityHash);
    return eligible === undefined ? [] : [eligible];
  });
  if (parts.length === 0) return undefined;

  let occurredAt = input.message.timeCreated;
  if (role === "assistant") {
    const time = object(data.time);
    const completed = safeInteger(time?.completed);
    occurredAt = completed ?? input.message.timeUpdated;
  }

  return {
    schemaVersion: 1,
    sessionRef: input.sessionId,
    messageId: input.message.id,
    role,
    occurredAt,
    parts,
  };
};

const encodeMessages = (messages: readonly CanonicalMessageV1[]) =>
  encoder.encode(
    messages.map((message) => JSON.stringify(message)).join("\n") +
      (messages.length > 0 ? "\n" : ""),
  );

export interface OpenCodeSourceStreamV1 {
  readonly byteCount: number;
  readonly canonicalBytes: Uint8Array;
  readonly eligibleMessageCount: number;
  readonly finality: "open";
  readonly parentSessionIdentityHash?: string;
  readonly prefixHash: string;
  readonly segmentHash: string;
  readonly sessionIdentityHash: string;
  readonly sourceCreatedAt: number;
  readonly sourceDirectory: string;
  readonly streamIdentityHash: string;
}

export interface OpenCodeSourceInventoryV1 {
  readonly childSessionCount: number;
  readonly eligibleMessageCount: number;
  readonly messageCount: number;
  readonly partCount: number;
  readonly rootSessionCount: number;
  readonly sessionCount: number;
  readonly sessionMessageCount: number;
  readonly streamCount: number;
}

export interface OpenCodeSourceSnapshotV1 {
  readonly adapterInstanceIdentityHash: string;
  readonly databaseUserVersion: 0;
  readonly encoderVersion: typeof OPENCODE_ENCODER_VERSION;
  readonly inventory: OpenCodeSourceInventoryV1;
  readonly schemaFingerprint: typeof SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT;
  readonly schemaVersion: typeof OPENCODE_SOURCE_SCHEMA_VERSION;
  readonly streams: readonly OpenCodeSourceStreamV1[];
}

export interface ReadOpenCodeSourceOptionsV1 {
  readonly adapterInstanceIdentityHash?: string;
  readonly busyTimeoutMs?: number;
}

const readSnapshot = (
  database: DatabaseSync,
  adapterInstanceIdentityHash: string,
): OpenCodeSourceSnapshotV1 => {
  const userVersion = safeInteger(
    singleRow(all(database, "PRAGMA user_version"), "schema").user_version,
  );
  if (userVersion === undefined) throw new OpenCodeReadError("schema");
  if (userVersion !== SUPPORTED_OPENCODE_DB_USER_VERSION) {
    throw new OpenCodeUnsupportedVersionError(userVersion);
  }

  const fingerprint = detectedSchemaFingerprint(database);
  if (fingerprint !== SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT) {
    throw new OpenCodeSchemaError(fingerprint);
  }

  const sessionRows = all(
    database,
    "SELECT directory, id, parent_id, time_created FROM session ORDER BY time_created ASC, id ASC",
  ).map(parseSessionRow);
  const messageStatement = database.prepare(
    "SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
  );
  const partStatement = database.prepare(
    "SELECT id, data FROM part WHERE message_id = ? ORDER BY id ASC",
  );

  let messageCount = 0;
  let partCount = 0;
  let eligibleMessageCount = 0;
  const streams: OpenCodeSourceStreamV1[] = [];

  for (const session of sessionRows) {
    const sessionIdentityHash = hashIdentity(session.id);
    const messages = (messageStatement.all(session.id) as readonly unknown[]).map((row) =>
      parseMessageRow(row, sessionIdentityHash),
    );
    messageCount += messages.length;
    const canonicalMessages: CanonicalMessageV1[] = [];
    for (const message of messages) {
      const parts = (partStatement.all(message.id) as readonly unknown[]).map((row) =>
        parsePartRow(row, sessionIdentityHash),
      );
      partCount += parts.length;
      const canonical = canonicalMessage({
        message,
        parts,
        sessionId: session.id,
        sessionIdentityHash,
      });
      if (canonical !== undefined) canonicalMessages.push(canonical);
    }
    eligibleMessageCount += canonicalMessages.length;
    const canonicalBytes = encodeMessages(canonicalMessages);
    const contentHash = sha256(canonicalBytes);
    streams.push({
      byteCount: canonicalBytes.byteLength,
      canonicalBytes,
      eligibleMessageCount: canonicalMessages.length,
      finality: "open",
      ...(session.parentId === undefined
        ? {}
        : { parentSessionIdentityHash: hashIdentity(session.parentId) }),
      prefixHash: contentHash,
      segmentHash: contentHash,
      sessionIdentityHash,
      sourceCreatedAt: session.timeCreated,
      sourceDirectory: session.directory,
      streamIdentityHash: hashStreamIdentity(session.id, adapterInstanceIdentityHash),
    });
  }

  const sessionMessageTableCount = scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'session_message'",
  );
  const sessionMessageCount =
    sessionMessageTableCount === 0
      ? 0
      : scalarCount(database, "SELECT COUNT(*) AS count FROM session_message");
  const rootSessionCount = sessionRows.filter((session) => session.parentId === undefined).length;

  return {
    adapterInstanceIdentityHash,
    databaseUserVersion: SUPPORTED_OPENCODE_DB_USER_VERSION,
    encoderVersion: OPENCODE_ENCODER_VERSION,
    inventory: {
      childSessionCount: sessionRows.length - rootSessionCount,
      eligibleMessageCount,
      messageCount,
      partCount,
      rootSessionCount,
      sessionCount: sessionRows.length,
      sessionMessageCount,
      streamCount: streams.length,
    },
    schemaFingerprint: SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
    schemaVersion: OPENCODE_SOURCE_SCHEMA_VERSION,
    streams,
  };
};

export const defaultOpenCodeDatabasePath = () =>
  path.join(homedir(), ".local", "share", "opencode", "opencode.db");

export const defaultOpenCodeAdapterInstanceIdentityHash = () =>
  sha256(JSON.stringify(["opencode-adapter-instance:v1", hostname(), userInfo().uid]));

export const readOpenCodeSource = (
  databasePath = defaultOpenCodeDatabasePath(),
  options: ReadOpenCodeSourceOptionsV1 = {},
): OpenCodeSourceSnapshotV1 => {
  const timeout = options.busyTimeoutMs ?? OPENCODE_BUSY_TIMEOUT_MS;
  let adapterInstanceIdentityHash: string;
  try {
    adapterInstanceIdentityHash =
      options.adapterInstanceIdentityHash ?? defaultOpenCodeAdapterInstanceIdentityHash();
  } catch {
    throw new OpenCodeReadError("configure");
  }
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30_000 ||
    !/^[a-f0-9]{64}$/u.test(adapterInstanceIdentityHash)
  ) {
    throw new OpenCodeReadError("configure");
  }
  let database: DatabaseSync;
  try {
    // @types/node 22.15 predates the runtime's Node 24 `timeout` option.
    const databaseOptions: NonNullable<ConstructorParameters<typeof DatabaseSync>[1]> & {
      readonly timeout: number;
    } = {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      open: true,
      readOnly: true,
      timeout,
    };
    database = new DatabaseSync(databasePath, databaseOptions);
  } catch (error) {
    throw mapFailure("open", error, undefined, timeout);
  }

  let transactionOpen = false;
  try {
    try {
      database.exec("PRAGMA query_only = ON");
      const queryOnly = safeInteger(
        singleRow(all(database, "PRAGMA query_only"), "configure").query_only,
      );
      const journalMode = string(
        singleRow(all(database, "PRAGMA journal_mode"), "configure").journal_mode,
      );
      const configuredTimeout = safeInteger(
        singleRow(all(database, "PRAGMA busy_timeout"), "configure").timeout,
      );
      if (
        queryOnly !== 1 ||
        journalMode?.toLowerCase() !== "wal" ||
        configuredTimeout !== timeout
      ) {
        throw new OpenCodeReadError("configure");
      }
    } catch (error) {
      throw mapFailure("configure", error, undefined, timeout);
    }

    try {
      database.exec("BEGIN DEFERRED TRANSACTION");
      transactionOpen = true;
    } catch (error) {
      throw mapFailure("transaction", error, undefined, timeout);
    }

    let snapshot: OpenCodeSourceSnapshotV1;
    try {
      establishReadSnapshot(database);
      reachOpenCodeReadBarrier("afterSnapshotEstablished");
      snapshot = readSnapshot(database, adapterInstanceIdentityHash);
    } catch (error) {
      throw mapFailure(
        error instanceof OpenCodeSchemaError || error instanceof OpenCodeUnsupportedVersionError
          ? "schema"
          : "inventory",
        error,
        undefined,
        timeout,
      );
    }

    try {
      database.exec("COMMIT");
      transactionOpen = false;
      reachOpenCodeReadBarrier("afterCommitBeforeClose");
    } catch (error) {
      throw mapFailure("transaction", error, undefined, timeout);
    }
    try {
      database.close();
    } catch (error) {
      throw mapFailure("close", error, undefined, timeout);
    }
    return snapshot;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
        transactionOpen = false;
        reachOpenCodeReadBarrier("afterRollbackBeforeClose");
      } catch {
        // Preserve the bounded source failure. This connection is discarded below.
      }
    }
    try {
      database.close();
    } catch {
      // Preserve the first bounded source failure.
    }
    throw error;
  }
};

export interface OpenCodeDryRunStreamReceiptV1 {
  readonly byteCount: number;
  readonly eligibleMessageCount: number;
  readonly parentSessionIdentityHash?: string;
  readonly prefixHash: string;
  readonly segmentHash: string;
  readonly sessionIdentityHash: string;
  readonly streamIdentityHash: string;
}

export interface OpenCodeDryRunReceiptV1 {
  readonly adapterInstanceIdentityHash: string;
  readonly encoderVersion: typeof OPENCODE_ENCODER_VERSION;
  readonly inventoryHash: string;
  readonly counts: OpenCodeSourceInventoryV1;
  readonly receiptVersion: typeof OPENCODE_DRY_RUN_RECEIPT_VERSION;
  readonly schemaFingerprint: typeof SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT;
  readonly schemaVersion: typeof OPENCODE_SOURCE_SCHEMA_VERSION;
  readonly streamSetHash: string;
  readonly streams: readonly OpenCodeDryRunStreamReceiptV1[];
}

export const openCodeDryRunReceipt = (
  snapshot: OpenCodeSourceSnapshotV1,
): OpenCodeDryRunReceiptV1 => {
  const streams = snapshot.streams.map((stream) => ({
    byteCount: stream.byteCount,
    eligibleMessageCount: stream.eligibleMessageCount,
    ...(stream.parentSessionIdentityHash === undefined
      ? {}
      : { parentSessionIdentityHash: stream.parentSessionIdentityHash }),
    prefixHash: stream.prefixHash,
    segmentHash: stream.segmentHash,
    sessionIdentityHash: stream.sessionIdentityHash,
    streamIdentityHash: stream.streamIdentityHash,
  }));
  return {
    adapterInstanceIdentityHash: snapshot.adapterInstanceIdentityHash,
    encoderVersion: snapshot.encoderVersion,
    inventoryHash: sha256(JSON.stringify(snapshot.inventory)),
    counts: snapshot.inventory,
    receiptVersion: OPENCODE_DRY_RUN_RECEIPT_VERSION,
    schemaFingerprint: snapshot.schemaFingerprint,
    schemaVersion: snapshot.schemaVersion,
    streamSetHash: sha256(JSON.stringify(streams)),
    streams,
  };
};

export interface OpenCodeCliErrorReceiptV1 {
  readonly code: OpenCodeSourceError["code"] | "opencode-source-invalid-command";
  readonly detectedSchemaFingerprint?: string;
  readonly detectedVersion?: number;
  readonly entityHash?: string;
  readonly expectedSchemaFingerprint?: string;
  readonly phase?: OpenCodeSourcePhase;
  readonly receiptVersion: typeof OPENCODE_DRY_RUN_RECEIPT_VERSION;
  readonly timeoutMs?: number;
}

export const openCodeCliErrorReceipt = (error: unknown): OpenCodeCliErrorReceiptV1 => {
  if (error instanceof OpenCodeUnsupportedVersionError) {
    return {
      code: error.code,
      detectedVersion: error.detectedVersion,
      receiptVersion: OPENCODE_DRY_RUN_RECEIPT_VERSION,
    };
  }
  if (error instanceof OpenCodeSchemaError) {
    return {
      code: error.code,
      detectedSchemaFingerprint: error.detectedSchemaFingerprint,
      expectedSchemaFingerprint: error.expectedSchemaFingerprint,
      receiptVersion: OPENCODE_DRY_RUN_RECEIPT_VERSION,
    };
  }
  if (error instanceof OpenCodeBusyError) {
    return {
      code: error.code,
      phase: error.phase,
      receiptVersion: OPENCODE_DRY_RUN_RECEIPT_VERSION,
      timeoutMs: error.timeoutMs,
    };
  }
  if (error instanceof OpenCodeReadError) {
    return {
      code: error.code,
      ...(error.entityHash === undefined ? {} : { entityHash: error.entityHash }),
      phase: error.phase,
      receiptVersion: OPENCODE_DRY_RUN_RECEIPT_VERSION,
    };
  }
  return {
    code: "opencode-source-invalid-command",
    receiptVersion: OPENCODE_DRY_RUN_RECEIPT_VERSION,
  };
};
