import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendSessionCapture, writeRunBlob } from "@joelclaw/memory";
import { Hono } from "hono";
import {
  DEFAULT_RUN_CAPTURE_MAX_INLINE_BYTES,
  type RunCaptureRouteDependencies,
  registerRunCaptureRoute,
} from "./run-capture";

let fixtureRoot: string | undefined;
let cursorRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  if (cursorRoot) rmSync(cursorRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
  cursorRoot = undefined;
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

function fixtureApp(
  options: {
    maxInlineBytes?: number;
    maxClaimCheckBytes?: number;
    claimCheckSpoolDir?: string;
    sourceCursorClaimDir?: string;
    writeRunBlob?: RunCaptureRouteDependencies["writeRunBlob"];
    authenticate?: () => Promise<{ user_id: string; machine_id: string; did: null } | null>;
  } = {},
) {
  fixtureRoot = mkdtempSync(join(tmpdir(), "run-capture-route-"));
  cursorRoot = mkdtempSync(join(tmpdir(), "run-capture-cursors-"));
  process.env.MEMORY_RUN_STORE = fixtureRoot;
  const claimCheckSpoolDir = options.claimCheckSpoolDir ?? join(fixtureRoot, "capture-spool");
  const sourceCursorClaimDir = options.sourceCursorClaimDir ?? cursorRoot;
  const events: unknown[] = [];
  const app = new Hono();
  registerRunCaptureRoute(app, {
    authenticate:
      options.authenticate ?? (async () => ({ user_id: "user", machine_id: "machine", did: null })),
    maxInlineBytes: options.maxInlineBytes,
    maxClaimCheckBytes: options.maxClaimCheckBytes,
    claimCheckSpoolDir,
    sourceCursorClaimDir,
    writeRunBlob: options.writeRunBlob ?? writeRunBlob,
    sendCaptured: async (event) => {
      events.push(event);
    },
    now: () => Date.UTC(2026, 0, 2),
  });
  return { app, events, claimCheckSpoolDir, runStoreDir: fixtureRoot, sourceCursorClaimDir };
}

function legacyCursorClaimPath(
  runStoreDir: string,
  userId: string,
  sourceIdentity: string,
  fromOffset: number,
): string {
  const key = createHash("sha256")
    .update(JSON.stringify([sourceIdentity, fromOffset]))
    .digest("hex");
  return join(runStoreDir, userId, ".source-cursors", `${key}.json`);
}

function claimCheckBody(runId: string, jsonl: string, path: string): Record<string, unknown> {
  const body: Record<string, unknown> = { ...captureBody(runId, jsonl) };
  delete body.jsonl;
  body.jsonl_path = path;
  return body;
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

describe("POST /api/runs payload limits", () => {
  test("rejects source-cursor claim storage under a protected harness path", () => {
    expect(() =>
      fixtureApp({ sourceCursorClaimDir: join(homedir(), ".pi", "agent", "sessions") }),
    ).toThrow("outside protected harness paths");
  });

  test("keeps the default above measured v12 segment sizes", () => {
    expect(DEFAULT_RUN_CAPTURE_MAX_INLINE_BYTES).toBe(10_000_000);
  });

  test("rejects an oversized Content-Length before auth or JSON parsing", async () => {
    let authCalls = 0;
    const { app, events } = fixtureApp({
      maxInlineBytes: 128,
      authenticate: async () => {
        authCalls += 1;
        return { user_id: "user", machine_id: "machine", did: null };
      },
    });
    const rawBody = JSON.stringify(captureBody("8".repeat(26), "x".repeat(512)));
    const response = await app.request("/api/runs", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(rawBody)),
      },
      body: rawBody,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "run_capture_payload_too_large", max_bytes: 128 },
    });
    expect(authCalls).toBe(0);
    expect(events).toHaveLength(0);
  });

  test("bounds chunked bodies even without Content-Length", async () => {
    const { app, events } = fixtureApp({ maxInlineBytes: 128 });
    const rawBody = JSON.stringify(captureBody("9".repeat(26), "x".repeat(512)));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(rawBody));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/runs", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture",
        "Content-Type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
    expect(events).toHaveLength(0);
  });
});

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
    expect((await post(app, captureBody(suffixRunId, suffixText, prefix.to_offset))).status).toBe(
      202,
    );

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
      (db.query("PRAGMA index_list(runs)").all() as Array<{ name: string }>).map((row) => row.name),
    ).toContain("runs_ended_at_idx");
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

  test("stores new cursor claims outside runs-dev", async () => {
    const { app, runStoreDir, sourceCursorClaimDir } = fixtureApp();
    const sourceIdentity = `sha256:${"c".repeat(64)}`;
    const offset = 512;
    const response = await post(app, {
      ...captureBody("8".repeat(26), "same\n", offset),
      source_identity: sourceIdentity,
    });
    const key = createHash("sha256")
      .update(JSON.stringify([sourceIdentity, offset]))
      .digest("hex");
    const userKey = createHash("sha256").update("user").digest("hex");

    expect(response.status).toBe(202);
    expect(existsSync(join(sourceCursorClaimDir, userKey, `${key}.json`))).toBe(true);
    expect(existsSync(join(runStoreDir, "user", ".source-cursors", `${key}.json`))).toBe(false);
  });

  test("releases a failed legacy cursor claim without deleting its runs-dev record", async () => {
    const { app, runStoreDir } = fixtureApp();
    const reusedRunId = "6".repeat(26);
    const first = captureBody(reusedRunId, "same\n", 0);
    expect((await post(app, first)).status).toBe(202);

    const legacyPath = legacyCursorClaimPath(runStoreDir, "user", first.source_identity, 100);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({ run_id: reusedRunId, started_at: first.started_at }),
    );

    const conflict = await post(app, captureBody(reusedRunId, "same\n", 100));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "run_blob_conflict" },
    });
    expect(existsSync(legacyPath)).toBe(true);
    expect((await post(app, captureBody("7".repeat(26), "same\n", 100))).status).toBe(202);
    expect(existsSync(legacyPath)).toBe(true);
  });

  test("returns 409 for divergent bytes under one Run ID", async () => {
    const { app, events } = fixtureApp();
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
  });

  test("accepts Cursor, Grok, and OpenCode runtime capture events", async () => {
    const { app, events } = fixtureApp();
    const runtimes = ["cursor", "grok", "opencode"] as const;

    for (const [index, agent_runtime] of runtimes.entries()) {
      const jsonl = `${JSON.stringify({
        type: "message",
        message: { role: "user", content: `${agent_runtime} fixture` },
      })}\n`;
      const runId = String(index + 1).repeat(26);
      const body: Record<string, unknown> = {
        ...captureBody(runId, jsonl),
        agent_runtime,
        source_identity: `sha256:${createHash("sha256").update(agent_runtime).digest("hex")}`,
      };
      const response = await post(app, body);
      expect(response.status).toBe(202);
    }

    expect(events).toHaveLength(runtimes.length);
    expect(
      events.map((event) => (event as { data: { agent_runtime: string } }).data.agent_runtime),
    ).toEqual([...runtimes]);
  });
});

describe("POST /api/runs claim checks", () => {
  test("hash-verifies a spool file before staging and accepting it", async () => {
    let writeCalls = 0;
    const { app, events, claimCheckSpoolDir } = fixtureApp({
      writeRunBlob: (...args) => {
        writeCalls += 1;
        return writeRunBlob(...args);
      },
    });
    mkdirSync(claimCheckSpoolDir, { recursive: true, mode: 0o700 });
    const jsonl = `${JSON.stringify({ type: "message", message: { role: "user", content: "spool 🧀" } })}\n`;
    const sourcePath = join(claimCheckSpoolDir, "capture.jsonl");
    writeFileSync(sourcePath, jsonl, { mode: 0o600 });

    const response = await post(app, claimCheckBody("8".repeat(26), jsonl, sourcePath));
    const result = await response.json();
    const event = events[0] as {
      data: { jsonl_path: string; jsonl_bytes: number; jsonl_sha256: string };
    };

    expect(response.status).toBe(202);
    expect(result).toMatchObject({
      ok: true,
      jsonl_bytes: Buffer.byteLength(jsonl),
      jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
    });
    expect(event.data.jsonl_path).not.toBe(sourcePath);
    expect(event.data.jsonl_bytes).toBe(Buffer.byteLength(jsonl));
    expect(event.data.jsonl_sha256).toBe(createHash("sha256").update(jsonl).digest("hex"));
    expect(readFileSync(event.data.jsonl_path, "utf8")).toBe(jsonl);
    expect(readFileSync(sourcePath, "utf8")).toBe(jsonl);
    expect(writeCalls).toBe(1);
  });

  test("rejects a digest mismatch before writing a Run blob or emitting an event", async () => {
    let writeCalls = 0;
    const { app, events, claimCheckSpoolDir } = fixtureApp({
      writeRunBlob: (...args) => {
        writeCalls += 1;
        return writeRunBlob(...args);
      },
    });
    mkdirSync(claimCheckSpoolDir, { recursive: true, mode: 0o700 });
    const jsonl = `${JSON.stringify({ type: "message" })}\n`;
    const sourcePath = join(claimCheckSpoolDir, "capture.jsonl");
    writeFileSync(sourcePath, jsonl, { mode: 0o600 });
    const body = claimCheckBody("9".repeat(26), jsonl, sourcePath);
    body.jsonl_sha256 = "0".repeat(64);

    const response = await post(app, body);

    expect(response.status).toBe(400);
    expect(writeCalls).toBe(0);
    expect(events).toHaveLength(0);
  });

  test("rejects files outside the spool root and symlinks escaping it", async () => {
    let writeCalls = 0;
    const { app, events, claimCheckSpoolDir } = fixtureApp({
      writeRunBlob: (...args) => {
        writeCalls += 1;
        return writeRunBlob(...args);
      },
    });
    mkdirSync(claimCheckSpoolDir, { recursive: true, mode: 0o700 });
    const jsonl = `${JSON.stringify({ type: "message" })}\n`;
    const outsidePath = join(fixtureRoot as string, "outside.jsonl");
    const symlinkPath = join(claimCheckSpoolDir, "escape.jsonl");
    writeFileSync(outsidePath, jsonl, { mode: 0o600 });
    symlinkSync(outsidePath, symlinkPath);

    const outside = await post(app, claimCheckBody("1".repeat(26), jsonl, outsidePath));
    const symlink = await post(app, claimCheckBody("2".repeat(26), jsonl, symlinkPath));

    expect(outside.status).toBe(400);
    expect(symlink.status).toBe(400);
    expect(writeCalls).toBe(0);
    expect(events).toHaveLength(0);
  });

  test("accepts legacy claim-check files with a digest and no cursor fields", async () => {
    const { app, events, claimCheckSpoolDir } = fixtureApp();
    mkdirSync(claimCheckSpoolDir, { recursive: true, mode: 0o700 });
    const jsonl = `${JSON.stringify({ type: "message", message: { role: "user", content: "legacy" } })}\n`;
    const sourcePath = join(claimCheckSpoolDir, "legacy.jsonl");
    writeFileSync(sourcePath, jsonl, { mode: 0o600 });
    const body = claimCheckBody("5".repeat(26), jsonl, sourcePath);
    delete body.from_offset;
    delete body.to_offset;
    delete body.source_identity;

    const response = await post(app, body);
    const event = events[0] as { data: { jsonl_sha256: string; source_identity?: string } };

    expect(response.status).toBe(202);
    expect(event.data.jsonl_sha256).toBe(createHash("sha256").update(jsonl).digest("hex"));
    expect(event.data.source_identity).toBeUndefined();
  });

  test("enforces a byte cap and rejects ambiguous inline-plus-path bodies", async () => {
    const { app, events, claimCheckSpoolDir } = fixtureApp({ maxClaimCheckBytes: 4 });
    mkdirSync(claimCheckSpoolDir, { recursive: true, mode: 0o700 });
    const jsonl = `${JSON.stringify({ x: 1 })}\n`;
    const sourcePath = join(claimCheckSpoolDir, "capture.jsonl");
    writeFileSync(sourcePath, jsonl, { mode: 0o600 });

    const oversized = await post(app, claimCheckBody("3".repeat(26), jsonl, sourcePath));
    const ambiguous = await post(app, {
      ...captureBody("4".repeat(26), jsonl),
      jsonl_path: sourcePath,
    });

    expect(oversized.status).toBe(400);
    expect(ambiguous.status).toBe(400);
    expect(events).toHaveLength(0);
  });
});
