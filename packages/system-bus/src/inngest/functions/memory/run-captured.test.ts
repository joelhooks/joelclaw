import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { runsSchema } from "@joelclaw/memory";
import { memoryRunCaptured } from "./run-captured";

const originalFetch = globalThis.fetch;
const originalOtelEnabled = process.env.OTEL_EVENTS_ENABLED;

let upsertedRun: Record<string, unknown> | null = null;
let requestedPaths: string[] = [];
let runUpsertStatus = 200;
let runUpsertBody = '{"id":"run-empty"}';
const spooledPaths = new Set<string>();

beforeEach(() => {
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

  for (const path of spooledPaths) {
    try {
      unlinkSync(path);
    } catch {
      // A failed test may not have created its spool yet.
    }
  }
  spooledPaths.clear();
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
  return {
    run_id: "run-empty",
    user_id: "joel",
    machine_id: "flagg",
    agent_runtime: "pi",
    jsonl_path: "/captures/run-empty.jsonl",
    jsonl_bytes: 31,
    jsonl_sha256: "sha256-empty",
    started_at: 1_721_238_660_000,
    parent_run_id: "run-parent",
    conversation_id: "conversation-empty",
    tags: ["capture-outbox"],
    jsonl_inline: '{"type":"session","version":3}\n',
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
      jsonl_bytes: 31,
      jsonl_sha256: "sha256-empty",
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
      jsonl_sha256: "sha256-large-inline",
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
