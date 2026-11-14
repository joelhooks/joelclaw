import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createIntakeHandler } from "@joelclaw/capture-cell/intake/server";
import { blobPath, openIntake, owedPage } from "@joelclaw/capture-cell/intake/store";
import { writeRunBlob } from "@joelclaw/memory";
import { Hono } from "hono";
import { registerRunCaptureRoute } from "./run-capture";
import { captureCellFromEnv, createCaptureCellShadow } from "./run-capture-cell";
import { RunCaptureOutbox } from "./run-capture-outbox";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test("stream body preparation shares the retry deadline and cancels late streams", async () => {
  const prepared = Promise.withResolvers<RequestInit["body"]>();
  const cancelled = Promise.withResolvers<void>();
  let calls = 0;
  let exhausted = 0;
  const shadow = createCaptureCellShadow({
    url: "http://unused.invalid/api/runs",
    token: "synthetic",
    timeoutMs: 10,
    totalBudgetMs: 30,
    makeBody: () => prepared.promise,
    onFailure() {},
    onExhausted: () => {
      exhausted++;
    },
    fetch: (async () => {
      calls++;
      throw new Error("must not fetch after preparation times out");
    }) as unknown as typeof fetch,
  });
  await shadow({ run_id: "r1" });
  expect(exhausted).toBe(1);
  prepared.resolve(
    new ReadableStream({
      cancel: () => {
        cancelled.resolve();
      },
    }),
  );
  await cancelled.promise;
  expect(calls).toBe(0);
}, 1000);

test("detached intake tee streams all three accepted send sites even while Inngest is retry-queued", async () => {
  const root = mkdtempSync(join(homedir(), ".cache", "capture-tee-test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.MEMORY_RUN_STORE;
  process.env.MEMORY_RUN_STORE = join(root, "runs");
  cleanups.push(() => {
    if (previous === undefined) delete process.env.MEMORY_RUN_STORE;
    else process.env.MEMORY_RUN_STORE = previous;
  });
  const store = openIntake(join(root, "intake"));
  cleanups.push(() => store.close());
  const handler = createIntakeHandler({
    store,
    ingestToken: "ingest",
    pullToken: "pull",
    principal: { user_id: "user" },
  });
  const finished = Promise.withResolvers<void>();
  let intakePosts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const response = await handler(request);
      expect(response.status).toBe(202);
      intakePosts++;
      if (intakePosts === 3) finished.resolve();
      return response;
    },
  });
  cleanups.push(() => {
    void server.stop(true);
  });
  const routing = captureCellFromEnv(
    {
      CAPTURE_CELL_MODE: "off",
      CAPTURE_INTAKE_URL: `http://127.0.0.1:${server.port}`,
      CAPTURE_INTAKE_TOKEN: "ingest",
    },
    () => {},
    () => {},
  );
  const retry = new RunCaptureOutbox({
    path: join(root, "retry.db"),
    send: async () => {
      throw new Error("Inngest unavailable");
    },
    telemetry: { emit() {} },
  });
  cleanups.push(() => retry.close());
  const app = new Hono();
  registerRunCaptureRoute(app, {
    authenticate: async () => ({ user_id: "user", machine_id: "payload-machine", did: null }),
    sourceCursorClaimDir: join(root, "claims"),
    captureCell: routing,
    outbox: retry,
    writeRunBlob,
    sendCaptured: async () => {
      throw new Error("outbox owns delivery");
    },
  });
  const first = `${JSON.stringify({ type: "user", message: { role: "user", content: "first" } })}\n`;
  const extra = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "second" } })}\n`;
  const statuses: string[] = [];
  for (const [index, jsonl] of [first, first, first + extra].entries()) {
    const response = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: `r${index + 1}`,
        agent_runtime: "pi",
        jsonl,
        source_identity: `sha256:${"a".repeat(64)}`,
        from_offset: 0,
        to_offset: Buffer.byteLength(jsonl),
        jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
      }),
    });
    expect(response.status).toBe(202);
    statuses.push(((await response.json()) as { status: string }).status);
  }
  expect(statuses).toEqual(["accepted", "accepted_prefix", "accepted_prefix"]);
  expect(intakePosts).toBe(0); // not even the first POST holds up the route
  await finished.promise;
  const rows = owedPage(store);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.metadata.machine_id).toBe("payload-machine");
  expect(readFileSync(blobPath(store, rows[0]!.id), "utf8")).toBe(first);
});
