import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  defaultOpenCodeDatabasePath,
  OPENCODE_ENCODER_VERSION,
  OPENCODE_SOURCE_SCHEMA_VERSION,
  OpenCodeReadError,
  OpenCodeSchemaError,
  OpenCodeUnsupportedVersionError,
  openCodeDryRunReceipt,
  readOpenCodeSource,
  SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
} from "../src/opencode-source.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const textDecoder = new TextDecoder();

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

const observedSchema = `
  CREATE TABLE project (id TEXT PRIMARY KEY);
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    workspace_id TEXT,
    path TEXT,
    agent TEXT,
    model TEXT,
    cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL,
    tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    metadata TEXT,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
  );
  CREATE INDEX session_project_idx ON session(project_id);
  CREATE INDEX session_parent_idx ON session(parent_id);
  CREATE INDEX session_workspace_idx ON session(workspace_id);
  CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
  );
  CREATE INDEX message_session_time_created_id_idx
    ON message(session_id, time_created, id);
  CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
  );
  CREATE INDEX part_session_idx ON part(session_id);
  CREATE INDEX part_message_id_id_idx ON part(message_id, id);
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    seq INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
  );
  CREATE INDEX session_message_time_created_idx ON session_message(time_created);
  CREATE INDEX session_message_session_time_created_id_idx
    ON session_message(session_id, time_created, id);
  CREATE INDEX session_message_session_type_seq_idx
    ON session_message(session_id, type, seq);
  CREATE UNIQUE INDEX session_message_session_seq_idx
    ON session_message(session_id, seq);
`;

interface Fixture {
  readonly databasePath: string;
  readonly root: string;
  readonly writer: DatabaseSync;
}

const insertSession = (
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly parentId?: string;
    readonly timeCreated: number;
  },
) => {
  database
    .prepare(
      `INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version,
        time_created, time_updated, time_archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      "project-private-marker",
      input.parentId ?? null,
      "private-slug-marker",
      "/private/path/DO_NOT_LEAK_DIRECTORY",
      "private project name marker",
      "1.18.23",
      input.timeCreated,
      input.timeCreated + 1,
      input.id.includes("root") ? 9_999 : null,
    );
};

const insertMessage = (
  database: DatabaseSync,
  input: {
    readonly completed?: number;
    readonly id: string;
    readonly role: "assistant" | "user";
    readonly sessionId: string;
    readonly summary?: boolean;
    readonly timeCreated: number;
    readonly timeUpdated?: number;
  },
) => {
  const data = {
    role: input.role,
    time: {
      created: input.timeCreated,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  };
  database
    .prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      input.id,
      input.sessionId,
      input.timeCreated,
      input.timeUpdated ?? input.timeCreated + 10,
      JSON.stringify(data),
    );
};

const insertPart = (
  database: DatabaseSync,
  input: {
    readonly data: Readonly<Record<string, unknown>>;
    readonly id: string;
    readonly messageId: string;
    readonly sessionId: string;
  },
) => {
  database
    .prepare(
      `INSERT INTO part (
        id, message_id, session_id, time_created, time_updated, data
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.messageId, input.sessionId, 1, 2, JSON.stringify(input.data));
};

const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-source-fixture-"));
  const databasePath = path.join(root, "opencode.db");
  const writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA synchronous = NORMAL");
  writer.exec("PRAGMA busy_timeout = 2500");
  writer.exec(observedSchema);
  writer.prepare("INSERT INTO project (id) VALUES (?)").run("project-private-marker");

  const rootSessionId = "ses-root-private-marker";
  const childSessionId = "ses-child-private-marker";
  insertSession(writer, { id: rootSessionId, timeCreated: 100 });
  insertSession(writer, {
    id: childSessionId,
    parentId: rootSessionId,
    timeCreated: 200,
  });

  insertMessage(writer, {
    completed: 175,
    id: "msg-a-tie-private-marker",
    role: "assistant",
    sessionId: rootSessionId,
    timeCreated: 100,
    timeUpdated: 150,
  });
  insertPart(writer, {
    data: { text: "assistant visible text marker", type: "text" },
    id: "prt-assistant",
    messageId: "msg-a-tie-private-marker",
    sessionId: rootSessionId,
  });

  insertMessage(writer, {
    id: "msg-z-tie-private-marker",
    role: "user",
    sessionId: rootSessionId,
    timeCreated: 100,
  });
  insertPart(writer, {
    data: { text: "multi part second marker", type: "text" },
    id: "prt-z-second",
    messageId: "msg-z-tie-private-marker",
    sessionId: rootSessionId,
  });
  insertPart(writer, {
    data: { text: "multi part first marker", type: "text" },
    id: "prt-a-first",
    messageId: "msg-z-tie-private-marker",
    sessionId: rootSessionId,
  });

  insertMessage(writer, {
    id: "msg-0-imported-private-marker",
    role: "user",
    sessionId: rootSessionId,
    timeCreated: 300,
  });
  insertPart(writer, {
    data: { text: "imported later visible marker", type: "text" },
    id: "prt-imported-visible",
    messageId: "msg-0-imported-private-marker",
    sessionId: rootSessionId,
  });
  for (const [index, type] of [
    "reasoning",
    "tool",
    "patch",
    "step-start",
    "step-finish",
    "compaction",
  ].entries()) {
    insertPart(writer, {
      data: {
        credential: "credential-private-marker",
        text: `excluded-${type}-private-marker`,
        type,
      },
      id: `prt-internal-${index}`,
      messageId: "msg-0-imported-private-marker",
      sessionId: rootSessionId,
    });
  }

  const excludedMessages = [
    {
      id: "msg-summary-private-marker",
      part: { text: "summary-private-marker", type: "text" },
      role: "assistant" as const,
      summary: true,
    },
    {
      id: "msg-synthetic-private-marker",
      part: { synthetic: true, text: "synthetic-private-marker", type: "text" },
      role: "user" as const,
    },
    {
      id: "msg-ignored-private-marker",
      part: { ignored: true, text: "ignored-private-marker", type: "text" },
      role: "user" as const,
    },
    {
      id: "msg-empty-private-marker",
      part: { text: "   ", type: "text" },
      role: "assistant" as const,
    },
    {
      id: "msg-reasoning-only-private-marker",
      part: { text: "reasoning-only-private-marker", type: "reasoning" },
      role: "assistant" as const,
    },
  ];
  for (const [index, excluded] of excludedMessages.entries()) {
    insertMessage(writer, {
      id: excluded.id,
      role: excluded.role,
      sessionId: rootSessionId,
      ...(excluded.summary === undefined ? {} : { summary: excluded.summary }),
      timeCreated: 400 + index,
    });
    insertPart(writer, {
      data: excluded.part,
      id: `prt-excluded-${index}`,
      messageId: excluded.id,
      sessionId: rootSessionId,
    });
  }

  insertMessage(writer, {
    id: "msg-child-private-marker",
    role: "assistant",
    sessionId: childSessionId,
    timeCreated: 50,
  });
  insertPart(writer, {
    data: { text: "child visible text marker 🐀", type: "text" },
    id: "prt-child",
    messageId: "msg-child-private-marker",
    sessionId: childSessionId,
  });

  return { databasePath, root, writer };
};

const decodeStream = (bytes: Uint8Array) => {
  const text = textDecoder.decode(bytes);
  expect(text.length === 0 || text.endsWith("\n")).toBe(true);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
};

describe("OpenCode read-only source", () => {
  it("reads observed materialized tables when session_message is empty", async () => {
    const fixture = await createFixture();
    try {
      const snapshot = readOpenCodeSource(fixture.databasePath);
      expect(snapshot).toMatchObject({
        databaseUserVersion: 0,
        encoderVersion: OPENCODE_ENCODER_VERSION,
        schemaFingerprint: SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
        schemaVersion: OPENCODE_SOURCE_SCHEMA_VERSION,
        inventory: {
          childSessionCount: 1,
          eligibleMessageCount: 4,
          messageCount: 9,
          rootSessionCount: 1,
          sessionCount: 2,
          sessionMessageCount: 0,
          streamCount: 2,
        },
      });
      expect(snapshot.inventory.partCount).toBeGreaterThan(snapshot.inventory.eligibleMessageCount);
      expect(snapshot.streams.every((stream) => stream.finality === "open")).toBe(true);
    } finally {
      fixture.writer.close();
    }
  });

  it("orders sessions, messages, and text parts by the source contracts", async () => {
    const fixture = await createFixture();
    try {
      const snapshot = readOpenCodeSource(fixture.databasePath);
      const rootRecords = decodeStream(snapshot.streams[0]?.canonicalBytes ?? new Uint8Array());
      expect(rootRecords.map((record) => record.messageId)).toEqual([
        "msg-a-tie-private-marker",
        "msg-z-tie-private-marker",
        "msg-0-imported-private-marker",
      ]);
      expect(Object.keys(rootRecords[0] ?? {})).toEqual([
        "schemaVersion",
        "sessionRef",
        "messageId",
        "role",
        "occurredAt",
        "parts",
      ]);
      expect(rootRecords.map((record) => record.occurredAt)).toEqual([175, 100, 300]);
      expect(rootRecords[1]?.parts).toEqual([
        { partId: "prt-a-first", text: "multi part first marker" },
        { partId: "prt-z-second", text: "multi part second marker" },
      ]);
      const firstPart = (rootRecords[1]?.parts as readonly unknown[] | undefined)?.[0];
      expect(
        Object.keys((firstPart as Readonly<Record<string, unknown>> | undefined) ?? {}),
      ).toEqual(["partId", "text"]);
      const childRecords = decodeStream(snapshot.streams[1]?.canonicalBytes ?? new Uint8Array());
      expect(childRecords).toHaveLength(1);
      expect(childRecords[0]?.occurredAt).toBe(60);
      const childStream = snapshot.streams[1];
      const childText = textDecoder.decode(childStream?.canonicalBytes);
      expect(childStream?.byteCount).toBe(Buffer.byteLength(childText, "utf8"));
      expect(childStream?.byteCount).toBeGreaterThan(childText.length);
    } finally {
      fixture.writer.close();
    }
  });

  it("excludes internal, synthetic, ignored, summary, and empty content without placeholders", async () => {
    const fixture = await createFixture();
    try {
      const snapshot = readOpenCodeSource(fixture.databasePath);
      const canonical = snapshot.streams
        .map((stream) => textDecoder.decode(stream.canonicalBytes))
        .join("");
      for (const marker of [
        "reasoning-private-marker",
        "credential-private-marker",
        "summary-private-marker",
        "synthetic-private-marker",
        "ignored-private-marker",
        "reasoning-only-private-marker",
        "step-start",
        "step-finish",
        "compaction",
        "patch",
        "tool",
      ]) {
        expect(canonical).not.toContain(marker);
      }
      expect(canonical).toContain("imported later visible marker");
    } finally {
      fixture.writer.close();
    }
  });

  it("produces repeatable canonical bytes, hashes, identities, and parent edges", async () => {
    const fixture = await createFixture();
    try {
      const adapterInstanceIdentityHash = "a".repeat(64);
      const first = readOpenCodeSource(fixture.databasePath, { adapterInstanceIdentityHash });
      const second = readOpenCodeSource(fixture.databasePath, { adapterInstanceIdentityHash });
      const otherAdapter = readOpenCodeSource(fixture.databasePath, {
        adapterInstanceIdentityHash: "b".repeat(64),
      });
      expect(openCodeDryRunReceipt(first)).toEqual(openCodeDryRunReceipt(second));
      expect(first.streams.map((stream) => [...stream.canonicalBytes])).toEqual(
        second.streams.map((stream) => [...stream.canonicalBytes]),
      );
      const root = first.streams[0];
      const child = first.streams[1];
      expect(root?.sessionIdentityHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(child?.parentSessionIdentityHash).toBe(root?.sessionIdentityHash);
      expect(root?.prefixHash).toBe(root?.segmentHash);
      expect(root?.byteCount).toBe(root?.canonicalBytes.byteLength);
      expect(otherAdapter.streams[0]?.prefixHash).toBe(root?.prefixHash);
      expect(otherAdapter.streams[0]?.sessionIdentityHash).toBe(root?.sessionIdentityHash);
      expect(otherAdapter.streams[0]?.streamIdentityHash).not.toBe(root?.streamIdentityHash);
    } finally {
      fixture.writer.close();
    }
  });

  it("reads while a WAL writer transaction is active", async () => {
    const fixture = await createFixture();
    try {
      const beforeCount = Number(
        (fixture.writer.prepare("SELECT COUNT(*) AS count FROM message").get() as { count: number })
          .count,
      );
      fixture.writer.exec("BEGIN IMMEDIATE TRANSACTION");
      insertMessage(fixture.writer, {
        id: "msg-uncommitted-private-marker",
        role: "user",
        sessionId: "ses-root-private-marker",
        timeCreated: 901,
      });
      const snapshot = readOpenCodeSource(fixture.databasePath);
      expect(snapshot.inventory.messageCount).toBe(beforeCount);
      fixture.writer.exec("ROLLBACK");
    } finally {
      try {
        fixture.writer.exec("ROLLBACK");
      } catch {
        // The assertion path already rolled the transaction back.
      }
      fixture.writer.close();
    }
  });

  it("does not mutate the database or write normalized transcript files", async () => {
    const fixture = await createFixture();
    fixture.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    fixture.writer.close();
    const beforeBytes = new Uint8Array(await readFile(fixture.databasePath));
    const beforeStat = await stat(fixture.databasePath);
    readOpenCodeSource(fixture.databasePath);

    const afterBytes = new Uint8Array(await readFile(fixture.databasePath));
    const afterStat = await stat(fixture.databasePath);
    const afterFiles = await readdir(fixture.root);
    expect(sha256(afterBytes)).toBe(sha256(beforeBytes));
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    // SQLite may create its normal WAL shared-memory sidecars for a read-only
    // connection. The adapter itself must not create any other source artifact.
    expect(
      afterFiles.every((name) =>
        ["opencode.db", "opencode.db-shm", "opencode.db-wal"].includes(name),
      ),
    ).toBe(true);
    expect(afterFiles.some((name) => name.endsWith(".jsonl") || name.includes("normalized"))).toBe(
      false,
    );
  });

  it("rejects a source database that is not in WAL mode", async () => {
    const fixture = await createFixture();
    fixture.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    fixture.writer.exec("PRAGMA journal_mode = DELETE");
    fixture.writer.close();
    expect(() => readOpenCodeSource(fixture.databasePath)).toThrow(OpenCodeReadError);
  });

  it("rejects unsupported schema fingerprints and database versions", async () => {
    const schemaFixture = await createFixture();
    try {
      schemaFixture.writer.exec("ALTER TABLE message ADD COLUMN drift TEXT");
      expect(() => readOpenCodeSource(schemaFixture.databasePath)).toThrow(OpenCodeSchemaError);
    } finally {
      schemaFixture.writer.close();
    }

    const versionFixture = await createFixture();
    try {
      versionFixture.writer.exec("PRAGMA user_version = 2");
      expect(() => readOpenCodeSource(versionFixture.databasePath)).toThrow(
        OpenCodeUnsupportedVersionError,
      );
    } finally {
      versionFixture.writer.close();
    }
  });

  it("prints only metadata counts, hashes, and versions for an explicit fixture path", async () => {
    const fixture = await createFixture();
    try {
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(packageRoot, "src", "cli.ts"),
          "opencode",
          "dry-run",
          "--database",
          fixture.databasePath,
          "--json",
        ],
        { cwd: packageRoot, encoding: "utf8" },
      );
      const receipt = JSON.parse(output) as Readonly<Record<string, unknown>>;
      expect(receipt).toMatchObject({
        encoderVersion: OPENCODE_ENCODER_VERSION,
        receiptVersion: 1,
        schemaFingerprint: SUPPORTED_OPENCODE_SCHEMA_FINGERPRINT,
        schemaVersion: OPENCODE_SOURCE_SCHEMA_VERSION,
      });
      for (const marker of [
        fixture.databasePath,
        fixture.root,
        "project-private-marker",
        "DO_NOT_LEAK_DIRECTORY",
        "private project name marker",
        "ses-root-private-marker",
        "msg-a-tie-private-marker",
        "assistant visible text marker",
        "reasoning-private-marker",
        "credential-private-marker",
      ]) {
        expect(output).not.toContain(marker);
      }
      expect(output).not.toMatch(/\.db|\/private\/|opencode-source-fixture|watermark/u);
    } finally {
      fixture.writer.close();
    }
  });

  it("does not disclose an explicit database path when the CLI read fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-error-private-marker-"));
    const missingPath = path.join(root, "missing-private-marker.db");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(packageRoot, "src", "cli.ts"),
        "opencode",
        "dry-run",
        "--database",
        missingPath,
        "--json",
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(root);
    expect(result.stderr).not.toContain(missingPath);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "opencode-source-read-failed",
      phase: "open",
      receiptVersion: 1,
    });
  });

  it("resolves the default database path without reading it", () => {
    expect(defaultOpenCodeDatabasePath()).toMatch(/\.local\/share\/opencode\/opencode\.db$/u);
  });
});
