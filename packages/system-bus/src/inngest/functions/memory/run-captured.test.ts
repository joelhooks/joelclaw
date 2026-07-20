import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import { runsSchema } from "@joelclaw/memory";
import { memoryRunCaptured } from "./run-captured";

const originalFetch = globalThis.fetch;
const originalOtelEnabled = process.env.OTEL_EVENTS_ENABLED;
const originalSessionIndexPath = process.env.SESSION_INDEX_PATH;

let testDirectory = "";
let sessionIndexPath = "";
let upsertedRun: Record<string, unknown> | null = null;
let requestedPaths: string[] = [];
let runUpsertStatus = 200;
let runUpsertBody = '{"id":"run-empty"}';
const spooledPaths = new Set<string>();

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

  upsertedRun = null;
  requestedPaths = [];
  runUpsertStatus = 200;
  runUpsertBody = '{"id":"run-empty"}';
  process.env.OTEL_EVENTS_ENABLED = "0";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestedPaths.push(url);

    if (url.includes("/runs_dev/documents?action=upsert")) {
      upsertedRun = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(runUpsertBody, { status: runUpsertStatus });
    }

    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOtelEnabled === undefined) delete process.env.OTEL_EVENTS_ENABLED;
  else process.env.OTEL_EVENTS_ENABLED = originalOtelEnabled;
  if (originalSessionIndexPath === undefined) delete process.env.SESSION_INDEX_PATH;
  else process.env.SESSION_INDEX_PATH = originalSessionIndexPath;

  for (const path of spooledPaths) {
    try {
      unlinkSync(path);
    } catch {
      // A failed test may not have created its spool yet.
    }
  }
  spooledPaths.clear();
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

async function executeRun(data: CaptureEventData) {
  const stepIds: string[] = [];
  const stepOutputs = new Map<string, unknown>();
  const sentEvents: Array<{ stepId: string; event: unknown }> = [];
  const step = {
    run: async <T>(stepId: string, fn: () => T | Promise<T>): Promise<T> => {
      stepIds.push(stepId);
      const output = await fn();
      stepOutputs.set(stepId, output);
      if (
        typeof output === "object" &&
        output !== null &&
        "path" in output &&
        typeof output.path === "string"
      ) {
        spooledPaths.add(output.path);
      }
      return output;
    },
    sendEvent: async (stepId: string, event: unknown) => {
      sentEvents.push({ stepId, event });
    },
  };

  const result = await (memoryRunCaptured as any).fn({
    event: {
      id: `evt-${data.run_id}`,
      name: "memory/run.captured",
      data,
    },
    step,
  });

  return { result, sentEvents, stepIds, stepOutputs };
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
  test("indexes the Run metadata row with zero turns and no chunks", async () => {
    const { result, stepIds } = await executeRun(emptyRunData());

    expect(result).toEqual({
      run_id: "run-empty",
      chunks_indexed: 0,
      reason: "empty",
    });
    expect(stepIds).toContain("index-run");
    expect(upsertedRun).toMatchObject({
      id: "run-empty",
      user_id: "joel",
      machine_id: "flagg",
      agent_runtime: "pi",
      parent_run_id: "run-parent",
      root_run_id: "run-parent",
      conversation_id: "conversation-empty",
      tags: ["capture-outbox"],
      readable_by: ["joel"],
      started_at: 1_721_238_660_000,
      ended_at: 1_721_238_660_000,
      duration_ms: 0,
      turn_count: 0,
      user_turn_count: 0,
      assistant_turn_count: 0,
      tool_turn_count: 0,
      token_total: 0,
      tool_call_count: 0,
      status: "active",
      full_text: "",
      jsonl_path: "/captures/run-empty.jsonl",
      jsonl_bytes: Buffer.byteLength('{"type":"session","version":3}\n'),
      jsonl_sha256: createHash("sha256")
        .update('{"type":"session","version":3}\n')
        .digest("hex"),
    });

    const requiredFields = runsSchema().fields
      .filter((field) => !field.optional)
      .map((field) => field.name);
    for (const field of requiredFields) {
      expect(upsertedRun).toHaveProperty(field);
    }

    expect(
      requestedPaths.some((path) =>
        path.includes("/run_chunks_dev/documents/import?action=upsert")
      )
    ).toBe(false);
  });

  test("is idempotent across Inngest event redelivery and step retry", async () => {
    const data = emptyRunData();

    const first = await executeRun(data);
    const replay = await executeRun(data);

    expect(first.stepOutputs.get("append-session-index")).toMatchObject({
      status: "appended",
      run_id: "run-empty",
      chunk_count: 0,
    });
    expect(replay.stepOutputs.get("append-session-index")).toMatchObject({
      status: "already_indexed",
      run_id: "run-empty",
      chunk_count: 0,
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

  test("survives a real Inngest step retry after the SQLite side effect committed", async () => {
    const event = { name: "memory/run.captured" as const, data: emptyRunData() };
    runUpsertStatus = 503;
    runUpsertBody = '{"message":"retry me"}';

    const failed = await new InngestTestEngine({
      function: memoryRunCaptured,
      events: [event],
    }).execute();
    expect(failed.error).toBeDefined();
    expect(String((failed.error as { message?: string })?.message ?? failed.error)).toContain(
      "run upsert failed: 503",
    );

    runUpsertStatus = 200;
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

  test("fails the run when Typesense rejects the metadata document", async () => {
    runUpsertStatus = 400;
    runUpsertBody = '{"message":"Field turn_count must be an int32"}';

    await expect(executeRun(emptyRunData())).rejects.toThrow(
      "run upsert failed: 400"
    );
  });

  test("keeps every durable step output small for a large inline capture", async () => {
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

    const { result, sentEvents, stepIds, stepOutputs } = await executeRun({
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
      chunk_errors: 0,
      turn_count: 128,
    });
    expect(stepOutputs.get("spool-inline-jsonl")).toEqual({
      run_id: "run-large-inline",
      path: expect.stringContaining("joelclaw-memory-run-capture"),
      bytes: Buffer.byteLength(jsonlInline),
      sha256: expect.any(String),
    });
    expect(stepOutputs.get("chunk")).toEqual({
      turn_count: 128,
      candidate_count: 128,
    });
    expect(stepOutputs.get("index-chunks")).toEqual({
      imported: 128,
      errors: 0,
      chunk_count: 128,
    });
    expect(stepOutputs.get("index-run")).toEqual({
      run_id: "run-large-inline",
      turn_count: 128,
    });
    expect(stepOutputs.get("cleanup-inline-jsonl")).toEqual({
      run_id: "run-large-inline",
    });
    expect(stepIds).not.toContain("load-jsonl");
    expect(stepIds).not.toContain("prepare-chunks");

    for (const output of stepOutputs.values()) {
      if (output === undefined) continue;
      const serialized = JSON.stringify(output);
      expect(serialized.length).toBeLessThan(1024);
      expect(serialized).not.toContain(marker);
    }

    expect(upsertedRun).toMatchObject({
      id: "run-large-inline",
      turn_count: 128,
    });
    expect(String(upsertedRun?.full_text)).toContain(marker);
    expect(sentEvents).toEqual([
      {
        stepId: "emit-indexed",
        event: {
          name: "memory/run.indexed",
          data: {
            run_id: "run-large-inline",
            user_id: "joel",
            chunk_count: 128,
            index_duration_ms: expect.any(Number),
          },
        },
      },
    ]);
  });
});
