import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunBlob } from "@joelclaw/memory";
import { Hono } from "hono";
import { registerRunCaptureRoute } from "./run-capture";

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
  delete process.env.MEMORY_RUN_STORE;
});

function captureBody(runId: string, jsonl: string) {
  return {
    run_id: runId,
    agent_runtime: "pi" as const,
    started_at: Date.UTC(2026, 0, 1),
    conversation_id: "fixture-session",
    source_identity: `sha256:${"b".repeat(64)}`,
    from_offset: 0,
    to_offset: Buffer.byteLength(jsonl),
    jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
    jsonl,
  };
}

function fixtureApp() {
  fixtureRoot = mkdtempSync(join(tmpdir(), "run-capture-route-"));
  process.env.MEMORY_RUN_STORE = fixtureRoot;
  const events: unknown[] = [];
  const app = new Hono();
  registerRunCaptureRoute(app, {
    authenticate: async () => ({ user_id: "user", machine_id: "machine", did: null }),
    writeRunBlob,
    sendCaptured: async (event) => {
      events.push(event);
    },
    now: () => Date.UTC(2026, 0, 2),
  });
  return { app, events };
}

async function post(app: Hono, body: ReturnType<typeof captureBody>) {
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
});
