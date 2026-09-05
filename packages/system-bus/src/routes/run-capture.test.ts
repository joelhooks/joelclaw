import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionCapture,
  findSessionSourceCursor,
  writeRunBlob,
} from "@joelclaw/memory";
import { Hono } from "hono";
import {
  type RunCaptureFailure,
  type RunCaptureRouteDependencies,
  registerRunCaptureRoute,
  runCaptureFailureTelemetry,
} from "./run-capture";

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
  delete process.env.MEMORY_RUN_STORE;
});

function captureBody(runId: string, jsonl: string, fromOffset = 0) {
  return {
    run_id: runId,
    agent_runtime: "pi" as const,
    started_at: Date.UTC(2026, 0, 1),
    conversation_id: "fixture-session",
    source_identity: `sha256:${"b".repeat(64)}`,
    from_offset: fromOffset,
    to_offset: fromOffset + Buffer.byteLength(jsonl),
    jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
    jsonl,
  };
}

function fixtureApp(findSourceCursor?: RunCaptureRouteDependencies["findSourceCursor"]) {
  fixtureRoot = mkdtempSync(join(tmpdir(), "run-capture-route-"));
  process.env.MEMORY_RUN_STORE = fixtureRoot;
  const events: unknown[] = [];
  const failures: RunCaptureFailure[] = [];
  const app = new Hono();
  registerRunCaptureRoute(app, {
    authenticate: async () => ({ user_id: "user", machine_id: "machine", did: null }),
    writeRunBlob,
    sendCaptured: async (event) => {
      events.push(event);
    },
    emitFailure: async (failure) => {
      failures.push(failure);
    },
    ...(findSourceCursor ? { findSourceCursor } : {}),
    now: () => Date.UTC(2026, 0, 2),
  });
  return { app, events, failures };
}

function createSessionIndex(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL,
      agent_runtime TEXT NOT NULL, conversation_id TEXT, parent_run_id TEXT,
      source_identity TEXT NOT NULL, prefix_group_identity TEXT NOT NULL,
      verdict TEXT NOT NULL, started_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL, jsonl_path TEXT NOT NULL, jsonl_bytes INTEGER NOT NULL,
      jsonl_sha256 TEXT NOT NULL, turn_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
      from_offset INTEGER, to_offset INTEGER, tags_json TEXT NOT NULL DEFAULT '[]'
    ) STRICT;
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      chunk_idx INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      started_at INTEGER NOT NULL, token_count INTEGER NOT NULL,
      UNIQUE(run_id, chunk_idx)
    ) STRICT;
    CREATE VIRTUAL TABLE chunk_fts USING fts5(
      text, content='chunks', content_rowid='rowid', tokenize='unicode61'
    );
  `);
  db.close(false);
}

async function post(app: Hono, body: unknown) {
  return app.request("/api/runs", {
    method: "POST",
    headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/runs redelivery", () => {
  test("accepts exact same-Run same-byte redelivery", async () => {
    const { app, events } = fixtureApp();
    const body = captureBody("a".repeat(26), "one 🧀\n");

    const first = await post(app, body);
    const second = await post(app, body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ status: "accepted", to_offset: body.to_offset });
    expect(events).toHaveLength(2);
  });

  test("returns accepted_prefix without overwriting a stored prefix", async () => {
    const { app, events } = fixtureApp();
    const runId = "c".repeat(26);
    const prefix = captureBody(runId, "one 🧀\n");
    const larger = captureBody(runId, `${prefix.jsonl}two 第二\n`);

    const first = await post(app, prefix);
    const second = await post(app, larger);
    const response = await second.json();

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(response).toMatchObject({
      status: "accepted_prefix",
      run_id: runId,
      to_offset: prefix.to_offset,
    });
    expect(readFileSync(response.jsonl_path, "utf8")).toBe(prefix.jsonl);
    expect(events).toHaveLength(2);
  });

  test("replays commit, lost ack, fresh-ID wider retry, and suffix without duplicate bytes", async () => {
    const { app, events } = fixtureApp();
    const sourceOffset = 1_291_304;
    const prefixText = `${JSON.stringify({ type: "message", message: { role: "assistant", content: "one" } })}\n`;
    const suffixText = `${JSON.stringify({ type: "message", message: { role: "assistant", content: "two" } })}\n`;
    const firstRunId = "e".repeat(26);
    const retryRunId = "f".repeat(26);
    const suffixRunId = "1".repeat(26);
    const prefix = captureBody(firstRunId, prefixText, sourceOffset);

    expect((await post(app, prefix)).status).toBe(202);
    const widerRetry = await post(
      app,
      captureBody(retryRunId, `${prefixText}${suffixText}`, sourceOffset),
    );
    expect(widerRetry.status).toBe(202);
    expect(await widerRetry.json()).toMatchObject({
      status: "accepted_prefix",
      run_id: firstRunId,
      to_offset: prefix.to_offset,
    });
    expect(
      (
        await post(
          app,
          captureBody(suffixRunId, suffixText, prefix.to_offset),
        )
      ).status,
    ).toBe(202);

    expect(events).toHaveLength(3);
    const databasePath = join(fixtureRoot as string, "sessions.db");
    createSessionIndex(databasePath);
    const appendResults = events.map((rawEvent, index) => {
      const event = rawEvent as {
        data: {
          run_id: string;
          user_id: string;
          machine_id: string;
          agent_runtime: string;
          jsonl_path: string;
          jsonl_bytes: number;
          jsonl_sha256: string;
          started_at: number;
          conversation_id?: string;
          source_identity?: string;
          from_offset?: number;
          to_offset?: number;
          tags: string[];
        };
      };
      return appendSessionCapture({
        databasePath,
        capturePath: event.data.jsonl_path,
        runId: event.data.run_id,
        userId: event.data.user_id,
        machineId: event.data.machine_id,
        agentRuntime: event.data.agent_runtime,
        conversationId: event.data.conversation_id,
        sourceIdentity: event.data.source_identity,
        fromOffset: event.data.from_offset,
        toOffset: event.data.to_offset,
        tags: event.data.tags,
        startedAt: event.data.started_at,
        capturedAt: index + 1,
        jsonlPath: event.data.jsonl_path,
        jsonlBytes: event.data.jsonl_bytes,
        jsonlSha256: event.data.jsonl_sha256,
      });
    });
    expect(appendResults.map((result) => result.status)).toEqual([
      "appended",
      "already_indexed",
      "appended",
    ]);

    const db = new Database(databasePath, { readonly: true, strict: true });
    expect(
      db.query("SELECT from_offset, to_offset, jsonl_bytes FROM runs ORDER BY from_offset").all(),
    ).toEqual([
      {
        from_offset: sourceOffset,
        to_offset: prefix.to_offset,
        jsonl_bytes: Buffer.byteLength(prefixText),
      },
      {
        from_offset: prefix.to_offset,
        to_offset: prefix.to_offset + Buffer.byteLength(suffixText),
        jsonl_bytes: Buffer.byteLength(suffixText),
      },
    ]);
    db.close(false);
  });

  test("recovers a source-cursor claim from the indexed pre-sidecar Run", async () => {
    let databasePath = "";
    const { app, events } = fixtureApp((userId, sourceIdentity, fromOffset) =>
      findSessionSourceCursor(databasePath, userId, sourceIdentity, fromOffset),
    );
    databasePath = join(fixtureRoot as string, "sessions.db");
    createSessionIndex(databasePath);
    const source = `sha256:${"c".repeat(64)}`;
    const prefix = "stored-prefix\n";
    const suffix = "new-suffix\n";
    const originalRunId = "b".repeat(26);
    const startedAt = Date.UTC(2025, 11, 1);
    const blob = writeRunBlob("user", originalRunId, startedAt, prefix, {
      run_id: originalRunId,
      user_id: "user",
      machine_id: "machine",
      agent_runtime: "cursor",
      started_at: startedAt,
      source_identity: source,
      from_offset: 0,
      to_offset: Buffer.byteLength(prefix),
    });
    appendSessionCapture({
      databasePath,
      capturePath: blob.jsonl_path,
      runId: originalRunId,
      userId: "user",
      machineId: "machine",
      agentRuntime: "cursor",
      sourceIdentity: source,
      fromOffset: 0,
      toOffset: Buffer.byteLength(prefix),
      startedAt,
      capturedAt: startedAt + 1,
      jsonlPath: blob.jsonl_path,
      jsonlBytes: blob.jsonl_bytes,
      jsonlSha256: blob.jsonl_sha256,
    });
    const markerRoot = join(fixtureRoot as string, "user", ".source-cursors");
    mkdirSync(markerRoot, { recursive: true });
    writeFileSync(
      join(markerRoot, "migration-v1.json"),
      JSON.stringify({ schema_version: 1, complete: true }),
    );

    const replay = await post(app, {
      ...captureBody("c".repeat(26), prefix + suffix),
      agent_runtime: "cursor",
      source_identity: source,
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      run_id: originalRunId,
      status: "accepted_prefix",
      to_offset: Buffer.byteLength(prefix),
    });
    expect(
      (
        await post(app, {
          ...captureBody("d".repeat(26), suffix, Buffer.byteLength(prefix)),
          agent_runtime: "cursor",
          source_identity: source,
        })
      ).status,
    ).toBe(202);
    expect(events).toHaveLength(2);
  });

  test("fails closed when the migration index lookup is unavailable", async () => {
    const { app, events, failures } = fixtureApp(() => {
      throw new Error("private database failure");
    });
    const response = await post(app, captureBody("e".repeat(26), "safe\n"));
    expect(response.status).toBe(500);
    expect(events).toEqual([]);
    expect(failures).toEqual([
      { agentRuntime: "pi", code: "internal_error", stage: "persist" },
    ]);
  });

  test("requires the offline authoritative migration before trusting an index miss", async () => {
    const { app, events } = fixtureApp(() => null);
    const response = await post(app, captureBody("9".repeat(26), "safe\n"));
    expect(response.status).toBe(500);
    expect(events).toEqual([]);
  });

  test("uses the durable sidecar before consulting the migration index", async () => {
    let lookups = 0;
    const { app } = fixtureApp(() => {
      lookups += 1;
      if (lookups > 1) throw new Error("migration index should not be required");
      return null;
    });
    const markerRoot = join(fixtureRoot as string, "user", ".source-cursors");
    mkdirSync(markerRoot, { recursive: true });
    writeFileSync(
      join(markerRoot, "migration-v1.json"),
      JSON.stringify({ schema_version: 1, complete: true }),
    );
    const body = captureBody("f".repeat(26), "safe\n");
    expect((await post(app, body)).status).toBe(202);
    expect((await post(app, body)).status).toBe(202);
    expect(lookups).toBe(1);
  });

  test("accepts exact fresh-ID replay and rejects shorter or divergent cursor reuse", async () => {
    const { app, events } = fixtureApp();
    const original = captureBody("2".repeat(26), "one\ntwo\n", 512);
    expect((await post(app, original)).status).toBe(202);

    const exact = await post(app, captureBody("3".repeat(26), original.jsonl, 512));
    expect(exact.status).toBe(202);
    expect(await exact.json()).toMatchObject({
      status: "accepted_prefix",
      run_id: original.run_id,
      to_offset: original.to_offset,
    });
    expect((await post(app, captureBody("4".repeat(26), "one\n", 512))).status).toBe(409);
    expect((await post(app, captureBody("5".repeat(26), "nope\n", 512))).status).toBe(409);
    expect(events).toHaveLength(2);
  });

  test("rejects cross-cursor Run ID reuse and releases the failed cursor claim", async () => {
    const { app } = fixtureApp();
    const reusedRunId = "6".repeat(26);
    expect((await post(app, captureBody(reusedRunId, "same\n", 0))).status).toBe(202);

    const conflict = await post(app, captureBody(reusedRunId, "same\n", 100));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "run_blob_conflict" },
    });
    expect((await post(app, captureBody("7".repeat(26), "same\n", 100))).status).toBe(202);
  });

  test("returns 409 for divergent bytes under one Run ID", async () => {
    const { app, events, failures } = fixtureApp();
    const runId = "d".repeat(26);
    const first = captureBody(runId, "one\n");
    const divergent = captureBody(runId, "nope\n");

    expect((await post(app, first)).status).toBe(202);
    const conflict = await post(app, divergent);

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      ok: false,
      error: { code: "run_blob_conflict" },
    });
    expect(events).toHaveLength(1);
    expect(failures).toContainEqual({
      agentRuntime: "pi",
      code: "run_blob_conflict",
      stage: "persist",
    });
  });
});

describe("POST /api/runs receiver contract", () => {
  test.each(["cursor", "grok"] as const)(
    "accepts validated %s Runs and preserves receiver identities",
    async (agentRuntime) => {
      const { app, events } = fixtureApp();
      const body = {
        ...captureBody(`${agentRuntime[0]}`.repeat(26), "synthetic\n"),
        agent_runtime: agentRuntime,
        event_id: `fixture:${agentRuntime}:event`,
        source_session_id: `fixture-${agentRuntime}-session`,
      };

      expect((await post(app, body)).status).toBe(202);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "memory/run.captured",
        data: {
          agent_runtime: agentRuntime,
          event_id: body.event_id,
          source_session_id: body.source_session_id,
        },
      });
    },
  );

  test.each([
    { name: "unknown runtime", patch: { agent_runtime: "unknown-runtime" } },
    { name: "invalid run id", patch: { run_id: "../escape" } },
    { name: "partial segment", patch: { to_offset: undefined } },
    { name: "wrong byte range", patch: { to_offset: 1 } },
    { name: "wrong digest", patch: { jsonl_sha256: "0".repeat(64) } },
    { name: "unhashed source", patch: { source_identity: "fixture-session" } },
  ])("rejects $name without storing or publishing", async ({ patch }) => {
    const { app, events, failures } = fixtureApp();
    const response = await post(app, {
      ...captureBody("8".repeat(26), "synthetic\n"),
      ...patch,
    });

    expect(response.status).toBe(400);
    expect(events).toHaveLength(0);
    expect(failures).toEqual([{ code: "invalid_run_capture", stage: "parse" }]);
    expect(JSON.stringify(failures)).not.toContain("synthetic");
  });

  test("emits a bounded unauthorized failure without request details", async () => {
    const failures: RunCaptureFailure[] = [];
    const app = new Hono();
    registerRunCaptureRoute(app, {
      authenticate: async () => null,
      writeRunBlob,
      sendCaptured: async () => undefined,
      emitFailure: async (failure) => {
        failures.push(failure);
      },
    });

    const response = await post(app, {
      ...captureBody("9".repeat(26), "secret-looking-fixture\n"),
      credential: "must-not-leak",
    });
    expect(response.status).toBe(401);
    expect(failures).toEqual([{ code: "unauthorized", stage: "authenticate" }]);
    expect(JSON.stringify(failures)).not.toContain("must-not-leak");
  });

  test("maps failures to the canonical queryable OTEL shape", () => {
    const events = [
      runCaptureFailureTelemetry({
        agentRuntime: "cursor",
        code: "run_blob_conflict",
        stage: "persist",
      }),
      runCaptureFailureTelemetry({ code: "unauthorized", stage: "authenticate" }),
    ];
    expect(events.filter((event) => event.action === "memory.run.capture.failed")).toEqual([
      {
        action: "memory.run.capture.failed",
        component: "run-capture-route",
        error: "run_blob_conflict",
        level: "warn",
        metadata: { agent_runtime: "cursor", stage: "persist" },
        source: "memory",
        success: false,
      },
      {
        action: "memory.run.capture.failed",
        component: "run-capture-route",
        error: "unauthorized",
        level: "warn",
        metadata: { stage: "authenticate" },
        source: "memory",
        success: false,
      },
    ]);
  });

  test("emits a bounded publish failure without exception details", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "run-capture-route-"));
    process.env.MEMORY_RUN_STORE = fixtureRoot;
    const failures: RunCaptureFailure[] = [];
    const app = new Hono();
    registerRunCaptureRoute(app, {
      authenticate: async () => ({ user_id: "user", machine_id: "machine", did: null }),
      writeRunBlob,
      sendCaptured: async () => {
        throw new Error("private publish detail");
      },
      emitFailure: async (failure) => {
        failures.push(failure);
      },
    });

    expect((await post(app, captureBody("a".repeat(26), "synthetic\n"))).status).toBe(500);
    expect(failures).toEqual([
      { agentRuntime: "pi", code: "internal_error", stage: "publish" },
    ]);
    expect(JSON.stringify(failures)).not.toContain("private publish detail");
  });
});
