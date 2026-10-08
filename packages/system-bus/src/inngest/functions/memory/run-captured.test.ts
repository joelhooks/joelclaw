import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import type { CaptureGrowthCheckReceipt } from "../typesense-recovery-alerts";
import {
  __runCapturedTestUtils,
  memoryRunCaptured,
  runIndexedEventId,
} from "./run-captured";

const originalOtelEnabled = process.env.OTEL_EVENTS_ENABLED;
const originalSessionIndexPath = process.env.SESSION_INDEX_PATH;

let testDirectory = "";
let sessionIndexPath = "";
let indexedEvents: Array<{ id: string; name: string; data: unknown }> = [];
let growthChecks: Array<Record<string, unknown>> = [];
let sendIndexedFailures = 0;

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), "run-captured-test-"));
  sessionIndexPath = join(testDirectory, "sessions.db");
  process.env.SESSION_INDEX_PATH = sessionIndexPath;
  const db = new Database(sessionIndexPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL,
      agent_runtime TEXT NOT NULL, conversation_id TEXT, parent_run_id TEXT,
      source_identity TEXT NOT NULL, prefix_group_identity TEXT NOT NULL,
      verdict TEXT NOT NULL, started_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL, jsonl_path TEXT NOT NULL, jsonl_bytes INTEGER NOT NULL,
      jsonl_sha256 TEXT NOT NULL, turn_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL
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

  process.env.OTEL_EVENTS_ENABLED = "0";
  indexedEvents = [];
  growthChecks = [];
  sendIndexedFailures = 0;
  __runCapturedTestUtils.setDependencies({
    checkCaptureGrowth: async (data): Promise<CaptureGrowthCheckReceipt> => {
      growthChecks.push(data);
      return { checked: true, finding: null, alerted: false };
    },
    sendIndexed: async (event) => {
      if (sendIndexedFailures > 0) {
        sendIndexedFailures -= 1;
        throw new Error("event API unavailable");
      }
      indexedEvents.push(event);
    },
  });
});

afterEach(() => {
  if (originalOtelEnabled === undefined) delete process.env.OTEL_EVENTS_ENABLED;
  else process.env.OTEL_EVENTS_ENABLED = originalOtelEnabled;
  if (originalSessionIndexPath === undefined) delete process.env.SESSION_INDEX_PATH;
  else process.env.SESSION_INDEX_PATH = originalSessionIndexPath;

  __runCapturedTestUtils.resetDependencies();
  rmSync(testDirectory, { recursive: true, force: true });
});

interface CaptureEventData {
  run_id: string;
  user_id: string;
  machine_id: string;
  agent_runtime: string;
  jsonl_path: string;
  jsonl_bytes: number;
  jsonl_sha256: string;
  started_at: number;
  parent_run_id?: string;
  conversation_id?: string;
  tags?: string[];
  from_offset?: number;
  to_offset?: number;
  source_identity?: string;
  jsonl_inline?: string;
}

const spoolDirectory = join(tmpdir(), "joelclaw-memory-run-capture");

function spooledFiles(): string[] {
  return existsSync(spoolDirectory) ? readdirSync(spoolDirectory) : [];
}

async function executeRun(data: CaptureEventData) {
  // Every step.* call is one executor round trip on self-hosted Inngest.
  // The handler must finish without any of them.
  const stepIds: string[] = [];
  const step = new Proxy(
    {},
    {
      get: (_target, method) => (stepId: string) => {
        stepIds.push(`${String(method)}:${stepId}`);
        throw new Error(`unexpected step.${String(method)}("${stepId}")`);
      },
    },
  );

  const result = await (memoryRunCaptured as any).fn({
    event: {
      id: `evt-${data.run_id}`,
      name: "memory/run.captured",
      data,
    },
    step,
  });

  return { result, stepIds };
}

function conversationJsonl(turns: number): string {
  const lines = ['{"type":"session","version":3}'];
  for (let index = 0; index < turns; index += 1) {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: new Date(1_721_238_660_000 + index * 1000).toISOString(),
        message: { role: index % 2 === 0 ? "user" : "assistant", content: `turn ${index}` },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function emptyRunData(): CaptureEventData {
  const jsonl = '{"type":"session","version":3}\n';
  return {
    run_id: "run-empty",
    user_id: "joel",
    machine_id: "flagg",
    agent_runtime: "pi",
    jsonl_path: "/captures/run-empty.jsonl",
    jsonl_bytes: Buffer.byteLength(jsonl),
    jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
    started_at: 1_721_238_660_000,
    parent_run_id: "run-parent",
    conversation_id: "conversation-empty",
    tags: ["capture-outbox"],
    from_offset: 0,
    to_offset: Buffer.byteLength(jsonl),
    source_identity: `sha256:${"a".repeat(64)}`,
    jsonl_inline: jsonl,
  };
}

describe("memory/run.captured", () => {
  test("stores a zero-turn Run in sessions.db without a Typesense step", async () => {
    const { result, stepIds } = await executeRun(emptyRunData());

    expect(result).toEqual({
      run_id: "run-empty",
      chunks_indexed: 0,
      reason: "empty",
      session_index_status: "appended",
      session_index_run_id: "run-empty",
    });
    expect(stepIds).toEqual([]);
    expect(indexedEvents).toEqual([]);

    const db = new Database(sessionIndexPath, { readonly: true, strict: true });
    expect(db.query(`SELECT run_id, user_id, machine_id, agent_runtime, parent_run_id,
      conversation_id, turn_count, chunk_count, tags_json FROM runs WHERE run_id = ?`)
      .get("run-empty")).toEqual({
        run_id: "run-empty",
        user_id: "joel",
        machine_id: "flagg",
        agent_runtime: "pi",
        parent_run_id: "run-parent",
        conversation_id: "conversation-empty",
        turn_count: 0,
        chunk_count: 0,
        tags_json: '["capture-outbox"]',
      });
    db.close(false);
  });

  test("is idempotent across Inngest event redelivery and step retry", async () => {
    const data = emptyRunData();

    const first = await executeRun(data);
    const replay = await executeRun(data);

    expect(first.result).toMatchObject({
      session_index_status: "appended",
      session_index_run_id: "run-empty",
      chunks_indexed: 0,
    });
    expect(replay.result).toMatchObject({
      session_index_status: "already_indexed",
      session_index_run_id: "run-empty",
      chunks_indexed: 0,
    });

    const db = new Database(sessionIndexPath, { readonly: true, strict: true });
    expect(db.query("SELECT count(*) AS count FROM runs WHERE run_id = ?").get("run-empty")).toEqual({
      count: 1,
    });
    expect(db.query("SELECT count(*) AS count FROM chunks WHERE run_id = ?").get("run-empty")).toEqual({
      count: 0,
    });
    expect(
      db.query("SELECT from_offset, to_offset, tags_json FROM runs WHERE run_id = ?").get("run-empty"),
    ).toEqual({
      from_offset: 0,
      to_offset: data.to_offset,
      tags_json: '["capture-outbox"]',
    });
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close(false);
  });

  test("dedupes a fresh Run ID that reuses the same source cursor", async () => {
    const original = emptyRunData();
    await executeRun(original);
    const duplicate = await executeRun({
      ...original,
      run_id: "run-fresh-overlap",
    });

    expect(duplicate.result).toMatchObject({
      session_index_status: "already_indexed",
      session_index_run_id: original.run_id,
    });
    const db = new Database(sessionIndexPath, { readonly: true, strict: true });
    expect(
      db.query("SELECT run_id, from_offset FROM runs ORDER BY run_id").all(),
    ).toEqual([{ run_id: original.run_id, from_offset: original.from_offset }]);
    db.close(false);
  });

  test("rejects divergent bytes from a fresh Run ID at an indexed source cursor", async () => {
    const original = emptyRunData();
    await executeRun(original);
    const divergentJsonl = '{"type":"session","version":99}\n';

    await expect(
      executeRun({
        ...original,
        run_id: "run-fresh-divergent",
        jsonl_bytes: Buffer.byteLength(divergentJsonl),
        jsonl_sha256: createHash("sha256").update(divergentJsonl).digest("hex"),
        to_offset: original.from_offset! + Buffer.byteLength(divergentJsonl),
        jsonl_inline: divergentJsonl,
      }),
    ).rejects.toThrow(`session index Run ${original.run_id} already exists`);
  });

  test("survives a real Inngest replay after the SQLite side effect committed", async () => {
    const event = { name: "memory/run.captured" as const, data: emptyRunData() };

    const first = await new InngestTestEngine({
      function: memoryRunCaptured,
      events: [event],
    }).execute();
    expect(first.result).toMatchObject({ run_id: "run-empty", chunks_indexed: 0 });

    const replay = await new InngestTestEngine({
      function: memoryRunCaptured,
      events: [event],
    }).execute();
    expect(replay.result).toMatchObject({ run_id: "run-empty", chunks_indexed: 0 });

    const db = new Database(sessionIndexPath, { readonly: true, strict: true });
    expect(db.query("SELECT count(*) AS count FROM runs WHERE run_id = ?").get("run-empty")).toEqual({
      count: 1,
    });
    db.close(false);
  });

  test("fails hard when a replay reuses a Run ID at a different source cursor", async () => {
    const original = emptyRunData();
    await executeRun(original);

    await expect(
      executeRun({
        ...original,
        from_offset: original.from_offset! + 1,
        to_offset: original.to_offset! + 1,
      }),
    ).rejects.toThrow("already exists with different JSONL bytes");
  });

  test("fails hard when a replay reuses a Run ID for different bytes", async () => {
    const original = emptyRunData();
    await executeRun(original);
    const changedJsonl = '{"type":"session","version":4}\n';

    await expect(
      executeRun({
        ...original,
        jsonl_bytes: Buffer.byteLength(changedJsonl),
        jsonl_sha256: createHash("sha256").update(changedJsonl).digest("hex"),
        jsonl_inline: changedJsonl,
      }),
    ).rejects.toThrow("already exists with different JSONL bytes");
  });

  test("indexes a large inline capture with no checkpoint and a small persisted result", async () => {
    const marker = "large-payload-content-must-not-enter-step-output";
    const messageText = `${marker}:${"x".repeat(1024)}`;
    const messages = Array.from({ length: 128 }, (_, index) =>
      JSON.stringify({
        type: "message",
        timestamp: new Date(1_721_238_660_000 + index * 1000).toISOString(),
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${messageText}:${index}`,
        },
      })
    );
    const jsonlInline = [
      '{"type":"session","version":3}',
      ...messages,
      "",
    ].join("\n");

    const spoolsBefore = spooledFiles().length;
    const { result, stepIds } = await executeRun({
      run_id: "run-large-inline",
      user_id: "joel",
      machine_id: "flagg",
      agent_runtime: "pi",
      jsonl_path: "/captures/run-large-inline.jsonl",
      jsonl_bytes: Buffer.byteLength(jsonlInline),
      jsonl_sha256: createHash("sha256").update(jsonlInline).digest("hex"),
      started_at: 1_721_238_660_000,
      conversation_id: "conversation-large-inline",
      tags: ["capture-outbox"],
      jsonl_inline: jsonlInline,
    });

    expect(result).toMatchObject({
      run_id: "run-large-inline",
      chunks_indexed: 128,
      turn_count: 128,
      session_index_status: "appended",
    });
    expect(stepIds).toEqual([]);
    expect(spooledFiles().length).toBe(spoolsBefore);

    // The return value is the only state Inngest persists for the run.
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(1024);
    expect(serialized).not.toContain(marker);

    expect(indexedEvents).toEqual([
      {
        id: runIndexedEventId("run-large-inline"),
        name: "memory/run.indexed",
        data: {
          run_id: "run-large-inline",
          user_id: "joel",
          chunk_count: 128,
          index_duration_ms: expect.any(Number),
        },
      },
    ]);
  });

  test("rejects a different-start overlapping segment loudly", async () => {
    // Verifier fixture (keying-verification.svx §5): [0, first+repeated) then
    // [first, repeated+final) under a new run_id must not double-index the
    // repeated bytes — any non-exact-start intersection is a hard conflict.
    const bodyA = '{"type":"session","version":3}\n{"role":"user","text":"first part repeated"}\n';
    const source = `sha256:${"b".repeat(64)}`;
    const first = emptyRunData();
    first.run_id = "run-overlap-a";
    first.conversation_id = "conversation-overlap";
    first.source_identity = source;
    first.jsonl_inline = bodyA;
    first.jsonl_bytes = Buffer.byteLength(bodyA);
    first.jsonl_sha256 = createHash("sha256").update(bodyA).digest("hex");
    first.from_offset = 0;
    first.to_offset = Buffer.byteLength(bodyA);
    await executeRun(first);

    const bodyB = '{"role":"user","text":"repeated tail plus new bytes"}\n';
    const second = emptyRunData();
    second.run_id = "run-overlap-b";
    second.conversation_id = "conversation-overlap";
    second.source_identity = source;
    second.jsonl_inline = bodyB;
    second.jsonl_bytes = Buffer.byteLength(bodyB);
    second.jsonl_sha256 = createHash("sha256").update(bodyB).digest("hex");
    second.from_offset = 10;
    second.to_offset = 10 + Buffer.byteLength(bodyB);

    await expect(executeRun(second)).rejects.toThrow(/conflict|run-overlap-a/i);

    const db = new Database(sessionIndexPath, { readonly: true });
    const count = db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    db.close(false);
    expect(count.n).toBe(1);
  });
  test("indexes today's path-based event shape in one invocation", async () => {
    const jsonl = conversationJsonl(4);
    const path = join(testDirectory, "run-path.jsonl");
    writeFileSync(path, jsonl);
    const sourceIdentity = `sha256:${"d".repeat(64)}`;

    const { result, stepIds } = await executeRun({
      run_id: "run-path",
      user_id: "joel",
      machine_id: "test-machine",
      agent_runtime: "pi",
      jsonl_path: path,
      jsonl_bytes: Buffer.byteLength(jsonl),
      jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
      started_at: 1_721_238_660_000,
      tags: [],
      from_offset: 0,
      to_offset: Buffer.byteLength(jsonl),
      source_identity: sourceIdentity,
    });

    expect(stepIds).toEqual([]);
    expect(result).toMatchObject({
      run_id: "run-path",
      chunks_indexed: 4,
      turn_count: 4,
      session_index_status: "appended",
    });
    expect(indexedEvents.map((event) => event.id)).toEqual([runIndexedEventId("run-path")]);
    expect(growthChecks).toEqual([
      expect.objectContaining({ run_id: "run-path", source_identity: sourceIdentity }),
    ]);
  });

  test("still indexes a legacy event with no source cursor or tags", async () => {
    const jsonl = conversationJsonl(2);
    const path = join(testDirectory, "run-legacy.jsonl");
    writeFileSync(path, jsonl);

    const { result } = await executeRun({
      run_id: "run-legacy",
      user_id: "joel",
      machine_id: "test-machine",
      agent_runtime: "claude",
      jsonl_path: path,
      jsonl_bytes: Buffer.byteLength(jsonl),
      jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
      started_at: 1_721_238_660_000,
    });

    expect(result).toMatchObject({ chunks_indexed: 2, session_index_status: "appended" });
    const db = new Database(sessionIndexPath, { readonly: true, strict: true });
    expect(
      db.query("SELECT source_identity, from_offset, tags_json FROM runs WHERE run_id = ?")
        .get("run-legacy"),
    ).toEqual({ source_identity: "legacy-run:run-legacy", from_offset: null, tags_json: "[]" });
    db.close(false);
  });

  test("a retry after a failed run.indexed send does not double-index", async () => {
    const jsonl = conversationJsonl(3);
    const data: CaptureEventData = {
      run_id: "run-retry",
      user_id: "joel",
      machine_id: "test-machine",
      agent_runtime: "pi",
      jsonl_path: "/captures/run-retry.jsonl",
      jsonl_bytes: Buffer.byteLength(jsonl),
      jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
      started_at: 1_721_238_660_000,
      from_offset: 0,
      to_offset: Buffer.byteLength(jsonl),
      source_identity: `sha256:${"e".repeat(64)}`,
      jsonl_inline: jsonl,
    };
    const spoolsBefore = spooledFiles().length;

    // The append commits, then the event send fails, so Inngest retries the
    // whole handler.
    sendIndexedFailures = 1;
    await expect(executeRun(data)).rejects.toThrow("event API unavailable");
    expect(spooledFiles().length).toBe(spoolsBefore);

    const retry = await executeRun(data);
    const redelivery = await executeRun(data);
    expect(retry.result).toMatchObject({ session_index_status: "already_indexed", chunks_indexed: 3 });
    expect(redelivery.result).toMatchObject({ session_index_status: "already_indexed" });

    // Both sends share one event id, which Inngest dedupes to one event.
    expect(new Set(indexedEvents.map((event) => event.id))).toEqual(
      new Set([runIndexedEventId("run-retry")]),
    );

    const db = new Database(sessionIndexPath, { readonly: true, strict: true });
    expect(db.query("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM chunks").get()).toEqual({ count: 3 });
    expect(db.query("SELECT count(*) AS count FROM chunk_fts").get()).toEqual({ count: 3 });
    db.close(false);
  });

  test("runs the growth check for a conflicting capture and stays non-retriable", async () => {
    const original = emptyRunData();
    await executeRun(original);

    await expect(
      executeRun({ ...original, from_offset: 1, to_offset: original.to_offset! + 1 }),
    ).rejects.toThrow("already exists with different JSONL bytes");
    expect(growthChecks.map((data) => data.run_id)).toEqual(["run-empty", "run-empty"]);
  });

  test("indexes the Run even when the growth check reports a failure", async () => {
    __runCapturedTestUtils.setDependencies({
      checkCaptureGrowth: async () => ({
        checked: false,
        finding: null,
        alerted: false,
        error: "capture growth check timed out after 2000ms",
      }),
      sendIndexed: async (event) => {
        indexedEvents.push(event);
      },
    });
    const jsonl = conversationJsonl(1);

    const { result } = await executeRun({
      ...emptyRunData(),
      run_id: "run-growth-down",
      jsonl_bytes: Buffer.byteLength(jsonl),
      jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
      to_offset: Buffer.byteLength(jsonl),
      jsonl_inline: jsonl,
    });

    expect(result).toMatchObject({ chunks_indexed: 1, session_index_status: "appended" });
    expect(indexedEvents).toHaveLength(1);
  });

  test("keeps the queued function id and moves the prefix alert inline", async () => {
    const alerts = await import("../typesense-recovery-alerts");
    const captureConsumers = Object.values(alerts).filter((value: any) =>
      (value?.opts?.triggers ?? []).some(
        (trigger: { event?: string }) => trigger.event === "memory/run.captured",
      ),
    );

    expect(captureConsumers).toEqual([]);
    expect((memoryRunCaptured as any).opts.id).toBe("memory-run-captured-v3");
    expect((memoryRunCaptured as any).opts.triggers).toEqual([{ event: "memory/run.captured" }]);
    expect((memoryRunCaptured as any).opts.concurrency).toEqual({ limit: 8 });
  });
});
