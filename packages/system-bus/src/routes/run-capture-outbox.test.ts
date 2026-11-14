import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunBlob } from "@joelclaw/memory";
import { Hono } from "hono";
import {
  type CapturedRunEvent,
  type RunCaptureRouteDependencies,
  registerRunCaptureRoute,
} from "./run-capture";
import { RunCaptureOutbox } from "./run-capture-outbox";

const roots: string[] = [];
const boxes: RunCaptureOutbox[] = [];
const previousStore = process.env.MEMORY_RUN_STORE;
afterEach(() => {
  for (const box of boxes.splice(0)) {
    try {
      box.close();
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousStore === undefined) delete process.env.MEMORY_RUN_STORE;
  else process.env.MEMORY_RUN_STORE = previousStore;
});

function fixture(options: { maxAttempts?: number; sendTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "capture-retry-"));
  roots.push(root);
  process.env.MEMORY_RUN_STORE = join(root, "runs");
  let now = Date.now();
  let fails = true;
  const sent: Array<CapturedRunEvent & { id: string }> = [];
  const telemetry: string[] = [];
  const create = () => {
    const box = new RunCaptureOutbox({
      path: join(root, "retry.db"),
      now: () => now,
      ...options,
      telemetry: {
        emit: (action) => {
          telemetry.push(action);
        },
      },
      send: async (event) => {
        if (fails) throw new Error("offline");
        sent.push(event);
      },
    });
    boxes.push(box);
    return box;
  };
  const box = create();
  const jsonl = '{"type":"user","message":"fixture"}\n';
  const body = {
    run_id: "a".repeat(26),
    agent_runtime: "pi",
    started_at: now,
    source_identity: `sha256:${"b".repeat(64)}`,
    from_offset: 0,
    to_offset: Buffer.byteLength(jsonl),
    jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
    jsonl,
  };
  const app = (
    outbox = box,
    write: RunCaptureRouteDependencies["writeRunBlob"] = writeRunBlob,
    captureCell?: RunCaptureRouteDependencies["captureCell"],
  ) => {
    const hono = new Hono();
    hono.onError(() => new Response("failed", { status: 500 }));
    registerRunCaptureRoute(hono, {
      authenticate: async () => ({ user_id: "user", machine_id: "machine", did: null }),
      outbox,
      captureCell,
      writeRunBlob: write,
      sendCaptured: async () => {
        throw new Error("must use outbox");
      },
      sourceCursorClaimDir: join(root, "cursors"),
    });
    return hono;
  };
  const post = (hono: Hono, value: unknown = body) =>
    hono.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  return {
    root,
    box,
    create,
    body,
    app,
    post,
    sent,
    telemetry,
    advance: (ms = 1000) => {
      now += ms;
    },
    online: () => {
      fails = false;
    },
  };
}

describe("durable Run capture retry outbox", () => {
  test("send failure returns accepted + retry; restart and later send succeeds once", async () => {
    const f = fixture();
    const response = await f.post(f.app());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "accepted",
      queued: "retry",
      to_offset: f.body.to_offset,
    });
    expect(f.telemetry).toContain("capture.retry.enqueued");
    f.online();
    f.box.close();
    const reopened = f.create();
    await reopened.drain();
    expect(f.sent).toHaveLength(0); // backoff survives restart
    f.advance();
    await reopened.drain();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.id).toMatch(/^run-capture:[a-f0-9]{64}$/);
    expect(f.sent[0]?.data.jsonl_sha256).toBe(f.body.jsonl_sha256);
    const duplicate = await f.post(f.app(reopened));
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).not.toHaveProperty("queued");
    await reopened.drain();
    expect(f.sent).toHaveLength(1);
    expect(f.telemetry).toContain("capture.retry.sent");
  });

  test("send failure still shadows the accepted run exactly once in both mode", async () => {
    const f = fixture();
    const shadows: Array<{ run_id: string }> = [];
    const response = await f.post(
      f.app(f.box, writeRunBlob, {
        mode: "both",
        shadow: async (data) => {
          shadows.push(data);
        },
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "accepted",
      queued: "retry",
      to_offset: f.body.to_offset,
    });
    expect(f.sent).toHaveLength(0);
    expect(shadows).toHaveLength(0);
    await Bun.sleep(10);
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toMatchObject({ run_id: f.body.run_id });
    f.online();
    f.advance();
    await f.box.drain();
    expect(f.sent).toHaveLength(1);
    expect(shadows).toHaveLength(1);
  });

  test("process exits after blob write, before event enqueue; fresh process recovers intent", async () => {
    const f = fixture();
    const code = `
      import { Hono } from 'hono';
      import { writeRunBlob } from '@joelclaw/memory';
      import { registerRunCaptureRoute } from ${JSON.stringify(join(import.meta.dir, "run-capture.ts"))};
      import { RunCaptureOutbox } from ${JSON.stringify(join(import.meta.dir, "run-capture-outbox.ts"))};
      const outbox = new RunCaptureOutbox({path: ${JSON.stringify(join(f.root, "retry.db"))}, send: async () => { throw new Error('must not send'); }, telemetry: {emit(){}}});
      const app = new Hono();
      registerRunCaptureRoute(app, {
        authenticate: async () => ({user_id:'user', machine_id:'machine', did:null}), outbox,
        sourceCursorClaimDir: ${JSON.stringify(join(f.root, "cursors"))},
        writeRunBlob(...args) { writeRunBlob(...args); process.exit(42); }, sendCaptured: async () => {},
      });
      await app.request('/api/runs', {method:'POST', headers:{'Content-Type':'application/json'}, body:${JSON.stringify(JSON.stringify(f.body))}});
      process.exit(1);
    `;
    const child = Bun.spawn([process.execPath, "--eval", code], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(42);
    f.online();
    f.advance();
    await f.box.drain();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.data.to_offset).toBe(f.body.to_offset);
  });

  test("a crash before blob write never sends an uncommitted run; give-up retains the intent", async () => {
    const f = fixture({ maxAttempts: 2 });
    const response = await f.post(
      f.app(f.box, () => {
        throw new Error("write interrupted");
      }),
    );
    expect(response.status).toBe(500);
    f.online();
    await f.box.drain();
    f.advance();
    await f.box.drain();
    f.advance(100_000);
    await f.box.drain();
    expect(f.sent).toHaveLength(0);
    expect(f.telemetry).toContain("capture.retry.give_up");
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(f.root, "retry.db"), { readonly: true });
    expect(db.query("SELECT state,event_json FROM run_capture_retry").get()).toMatchObject({
      state: "gave_up",
      event_json: expect.stringContaining(f.body.run_id),
    });
    db.close();
  });

  test("outbox commit failure never acknowledges or writes a blob", async () => {
    const f = fixture();
    f.box.close();
    let writes = 0;
    const response = await f.post(
      f.app(f.box, (...args) => {
        writes++;
        return writeRunBlob(...args);
      }),
    );
    expect(response.status).toBe(500);
    expect(writes).toBe(0);
  });

  test("same-cursor prefix queues only the authoritative existing offset", async () => {
    const f = fixture();
    f.online();
    await f.post(f.app());
    // A separate outbox models older blobs written before this outbox existed.
    const box = new RunCaptureOutbox({
      path: join(f.root, "new-retry.db"),
      telemetry: { emit() {} },
      send: async () => {
        throw new Error("offline");
      },
    });
    boxes.push(box);
    const jsonl = f.body.jsonl + '{"type":"assistant","message":"more"}\n';
    const response = await f.post(f.app(box), {
      ...f.body,
      run_id: "c".repeat(26),
      jsonl,
      to_offset: Buffer.byteLength(jsonl),
      jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "accepted_prefix",
      queued: "retry",
      to_offset: f.body.to_offset,
    });
  });

  test("overlapping drain passes send a row only once", async () => {
    const f = fixture();
    await f.post(f.app());
    f.online();
    f.advance();
    await Promise.all([f.box.drain(), f.box.drain(), f.create().drain()]);
    expect(f.sent).toHaveLength(1);
  });

  test("a send give-up retains the event and an explicit ingress retry revives it", async () => {
    const f = fixture({ maxAttempts: 2 });
    await f.post(f.app());
    f.advance();
    await f.box.drain();
    expect(f.telemetry).toContain("capture.retry.give_up");
    f.online();
    f.advance(60_000);
    await f.box.drain();
    expect(f.sent).toHaveLength(0);
    const retry = await f.post(f.app());
    expect(retry.status).toBe(202);
    expect(await retry.json()).not.toHaveProperty("queued");
    expect(f.sent).toHaveLength(1);
  });

  test("an abandoned sending lease is retried after expiry with the same event id", async () => {
    const f = fixture();
    await f.post(f.app());
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(f.root, "retry.db"));
    db.query(
      "UPDATE run_capture_retry SET state='sending', lease='abandoned', due_at=due_at+1000",
    ).run();
    db.close();
    f.online();
    f.advance();
    await f.create().drain();
    expect(f.sent).toHaveLength(0);
    f.advance();
    await f.box.drain();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.id).toMatch(/^run-capture:[a-f0-9]{64}$/);
  });

  test("a bounded send timeout leaves the event retryable", async () => {
    const f = fixture();
    const box = new RunCaptureOutbox({
      path: join(f.root, "timeout.db"),
      telemetry: { emit() {} },
      sendTimeoutMs: 5,
      send: async () => new Promise(() => {}),
    });
    boxes.push(box);
    const response = await f.post(f.app(box));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ queued: "retry" });
  });
});
