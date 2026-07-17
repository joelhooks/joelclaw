import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runsSchema } from "@joelclaw/memory";
import { memoryRunCaptured } from "./run-captured";

const originalFetch = globalThis.fetch;
const originalOtelEnabled = process.env.OTEL_EVENTS_ENABLED;

let upsertedRun: Record<string, unknown> | null = null;
let requestedPaths: string[] = [];
let runUpsertStatus = 200;
let runUpsertBody = '{"id":"run-empty"}';

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
});

async function executeEmptyRun() {
  const stepIds: string[] = [];
  const step = {
    run: async <T>(stepId: string, fn: () => T | Promise<T>): Promise<T> => {
      stepIds.push(stepId);
      return fn();
    },
  };

  const result = await (memoryRunCaptured as any).fn({
    event: {
      id: "evt-empty-run",
      name: "memory/run.captured",
      data: {
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
      },
    },
    step,
  });

  return { result, stepIds };
}

describe("memory/run.captured empty payload", () => {
  test("indexes the Run metadata row with zero turns and no chunks", async () => {
    const { result, stepIds } = await executeEmptyRun();

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

    await expect(executeEmptyRun()).rejects.toThrow(
      "run upsert failed: 400"
    );
  });
});
