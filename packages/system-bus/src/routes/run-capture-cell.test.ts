import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunBlob } from "@joelclaw/memory";
import { Hono } from "hono";
// Test-only cross-package integration: the real cell owns its own database.
import { createSessionsDb } from "../../../capture-cell/__tests__/fixtures";
import { startCell } from "../../../capture-cell/src/cell";
import { loadConfig } from "../../../capture-cell/src/config";
import {
  type CapturedRunEvent,
  type RunCaptureRouteDependencies,
  registerRunCaptureRoute,
} from "./run-capture";
import {
  type CaptureCellExhausted,
  type CaptureCellFailure,
  type CaptureCellMode,
  captureCellFromEnv,
  parseCaptureCellMode,
} from "./run-capture-cell";

const roots: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.MEMORY_RUN_STORE;
});

const SOURCE = `sha256:${"b".repeat(64)}`;
const FIRST = '{"type":"user","message":{"role":"user","content":"first"}}\n';
const MORE = '{"type":"assistant","message":{"role":"assistant","content":"more"}}\n';

function body(runId: string, jsonl: string) {
  return {
    run_id: runId,
    agent_runtime: "pi" as const,
    started_at: Date.UTC(2026, 0, 1),
    source_identity: SOURCE,
    from_offset: 0,
    to_offset: Buffer.byteLength(jsonl),
    jsonl_sha256: createHash("sha256").update(jsonl).digest("hex"),
    jsonl,
  };
}

function app(
  mode: CaptureCellMode,
  cellUrl: string | undefined,
  timeoutMs = 150,
  outbox?: RunCaptureRouteDependencies["outbox"],
) {
  const root = mkdtempSync(join(tmpdir(), "run-capture-cell-"));
  roots.push(root);
  process.env.MEMORY_RUN_STORE = join(root, "runs");
  const events: CapturedRunEvent[] = [];
  const failures: CaptureCellFailure[] = [];
  const exhausted: CaptureCellExhausted[] = [];
  const completions: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  let nextShadow = 0;
  const routing = captureCellFromEnv(
    {
      CAPTURE_CELL_MODE: mode,
      CAPTURE_CELL_URL: cellUrl,
      CAPTURE_CELL_TOKEN: "cell-token",
      CAPTURE_CELL_TIMEOUT_MS: String(timeoutMs),
      CAPTURE_CELL_TOTAL_BUDGET_MS: "1500",
    },
    (failure) => failures.push(failure),
    (failure) => exhausted.push(failure),
  );
  const hono = new Hono();
  registerRunCaptureRoute(hono, {
    authenticate: async () => ({ user_id: "user", machine_id: "machine", did: null }),
    sourceCursorClaimDir: join(root, "cursors"),
    writeRunBlob,
    outbox,
    sendCaptured: async (event) => {
      events.push(event);
      completions.push(Promise.withResolvers<void>());
    },
    captureCell: {
      mode,
      commit: routing.commit,
      shadow: async (data, serializedBody) => {
        const completion = completions[nextShadow++];
        try {
          await routing.shadow(data, serializedBody);
        } finally {
          completion?.resolve();
        }
      },
    },
    now: () => Date.UTC(2026, 0, 2),
  });
  return {
    hono,
    root,
    events,
    failures,
    exhausted,
    startedShadows: () => nextShadow,
    settle: () => Promise.all(completions.map((completion) => completion.promise)),
  };
}

/**
 * Three posts that reach all three send sites: a new run (accepted), a
 * resend under another run id (accepted_prefix from the claim), and a
 * longer body at the same cursor (accepted_prefix from the blob conflict).
 */
async function postSequence(fixture: ReturnType<typeof app>) {
  const results: Array<{ status: number; json: unknown; ms: number }> = [];
  for (const request of [body("r1", FIRST), body("r2", FIRST), body("r3", FIRST + MORE)]) {
    const started = performance.now();
    const response = await fixture.hono.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const text = (await response.text()).replaceAll(fixture.root, "<root>");
    results.push({
      status: response.status,
      json: JSON.parse(text),
      ms: performance.now() - started,
    });
  }
  return results;
}

function stripTiming(results: Array<{ status: number; json: unknown }>) {
  return results.map(({ status, json }) => ({ status, json }));
}

function deadCellUrl(): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return url;
}

describe("run-capture with CAPTURE_CELL_MODE", () => {
  test("the sequence reaches all three send sites", async () => {
    const off = app("off", undefined);
    const results = await postSequence(off);
    expect(results.map((result) => (result.json as { status: string }).status)).toEqual([
      "accepted",
      "accepted_prefix",
      "accepted_prefix",
    ]);
    expect(off.events).toHaveLength(3);
  });

  test("both, with the cell down: responses and Inngest sends are unchanged", async () => {
    const off = app("off", undefined);
    const offResults = await postSequence(off);
    const down = app("both", deadCellUrl());
    const downResults = await postSequence(down);
    expect(stripTiming(downResults)).toEqual(stripTiming(offResults));
    expect(down.events.map((event) => event.data.run_id)).toEqual(
      off.events.map((event) => event.data.run_id),
    );
    await down.settle();
    expect(down.failures).toHaveLength(9);
    expect(down.exhausted).toHaveLength(3);
    expect(down.failures[0]?.reason).toContain("capture cell request failed");
  });

  test("both, with the cell hanging: responses precede all shadow attempts", async () => {
    const hanging = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => undefined),
    });
    servers.push(hanging);
    const off = app("off", undefined);
    const offResults = await postSequence(off);
    const slow = app("both", `http://127.0.0.1:${hanging.port}`, 100);
    const slowResults = await postSequence(slow);
    expect(stripTiming(slowResults)).toEqual(stripTiming(offResults));
    expect(slow.failures).toEqual([]);
    expect(slow.exhausted).toEqual([]);
    expect(slow.startedShadows()).toBe(0);
    await slow.settle();
    expect(slow.failures.map((failure) => failure.reason)).toEqual(
      Array(9).fill("capture cell did not answer within 100ms"),
    );
    expect(slow.exhausted).toHaveLength(3);
  });

  test("both, with the cell up: the cell gets the same payload after each send", async () => {
    const received: Array<{ auth: string | null; body: { run_id: string; jsonl_path: string } }> =
      [];
    const cell = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        received.push({ auth: request.headers.get("authorization"), body: await request.json() });
        return Response.json({ ok: true }, { status: 202 });
      },
    });
    servers.push(cell);
    const up = app("both", `http://127.0.0.1:${cell.port}`);
    await postSequence(up);
    await up.settle();
    expect(up.failures).toEqual([]);
    expect(received.map((entry) => entry.body)).toEqual(
      up.events.map((event) => JSON.parse(JSON.stringify(event.data))),
    );
    expect(received[0]?.auth).toBe("Bearer cell-token");
  });

  test("cell mode waits for the commit and never sends or stages for Inngest", async () => {
    let posts = 0;
    const cell = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        posts += 1;
        return new Response(null, { status: 202 });
      },
    });
    servers.push(cell);
    const forbidden = () => {
      throw new Error("cell mode must not touch the Inngest outbox");
    };
    const writer = app("cell", `http://127.0.0.1:${cell.port}`, 150, {
      stage: forbidden,
      enqueue: forbidden,
      deliver: forbidden,
    } as unknown as NonNullable<RunCaptureRouteDependencies["outbox"]>);
    const results = await postSequence(writer);
    expect(results.every((result) => result.status === 202)).toBe(true);
    expect(posts).toBe(3);
    expect(writer.events).toHaveLength(0);
    expect(writer.failures).toEqual([]);
  });

  test("route -> real cell -> real index round-trip stays idempotent without Inngest", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-writer-e2e-"));
    roots.push(root);
    const sessions = join(root, "sessions.db");
    createSessionsDb(sessions);
    const config = loadConfig({
      CAPTURE_CELL_MODE: "cell",
      CAPTURE_CELL_DB: join(root, "outbox.db"),
      SESSION_INDEX_PATH: sessions,
    });
    const cell = startCell({ ...config, port: 0, token: "cell-token" });
    servers.push(cell);
    const writer = app("cell", `http://127.0.0.1:${cell.port}`);
    const results = await postSequence(writer);
    expect(results.map((result) => result.status)).toEqual([202, 202, 202]);
    await cell.drain.settle();
    expect(writer.events).toHaveLength(0);
    expect(cell.db.query("SELECT COUNT(*) AS n FROM captured WHERE writer = 1").get()).toEqual({
      n: 1,
    });
    const index = new Database(sessions, { readonly: true });
    try {
      expect(index.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 });
      expect(index.query("SELECT chunk_count FROM runs").get()).toEqual({ chunk_count: 1 });
    } finally {
      index.close(false);
    }
  });

  test("detached shadow pins bytes and run metadata before the timer fires", async () => {
    const received: string[] = [];
    const cell = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        received.push(await request.text());
        return new Response(null, { status: received.length === 1 ? 503 : 202 });
      },
    });
    servers.push(cell);
    const up = app("both", `http://127.0.0.1:${cell.port}`);
    const response = await up.hono.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body("r1", FIRST)),
    });
    expect(response.status).toBe(202);
    expect(up.startedShadows()).toBe(0);
    const sent = up.events[0]!;
    const original = JSON.stringify(sent.data);
    sent.data.run_id = "mutated-after-response";
    sent.data.tags.push("mutated-after-response");
    await up.settle();
    expect(received).toEqual([original, original]);
    expect(up.failures[0]?.run_id).toBe("r1");
  });

  test.each([undefined, null, "", "  ", 42])(
    "cell mode rejects unstable non-cursor run_id %p before writing",
    async (runId) => {
      const writer = app("cell", deadCellUrl());
      const response = await writer.hono.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_runtime: "pi", jsonl: FIRST, run_id: runId }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: {
          code: "run_id_required",
          message: expect.stringContaining("reuse it on every retry"),
        },
      });
      expect(existsSync(join(writer.root, "runs"))).toBe(false);
      expect(writer.events).toHaveLength(0);
    },
  );

  test.each([{ source_identity: SOURCE }])(
    "cell mode rejects identity without offset or run_id before writing: %p",
    async (cursor) => {
      const writer = app("cell", deadCellUrl());
      const response = await writer.hono.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_runtime: "pi", jsonl: FIRST, ...cursor }),
      });
      expect(response.status).toBe(400);
      // Malformed cursors fail parsing before the defensive run_id guard.
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "invalid_run_capture" },
      });
      expect(existsSync(join(writer.root, "runs"))).toBe(false);
      expect(writer.events).toHaveLength(0);
    },
  );

  test.each(["off", "both"] as const)(
    "%s still accepts non-cursor clients without run_id",
    async (mode) => {
      const legacy = app(mode, undefined);
      const response = await legacy.hono.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_runtime: "pi", jsonl: FIRST }),
      });
      expect(response.status).toBe(202);
      expect(legacy.events).toHaveLength(1);
      if (mode === "both") await legacy.settle();
    },
  );

  test("cell mode accepts a non-cursor client with a stable run_id", async () => {
    const cell = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 202 }),
    });
    servers.push(cell);
    const writer = app("cell", `http://127.0.0.1:${cell.port}`);
    const response = await writer.hono.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_runtime: "pi", jsonl: FIRST, run_id: "stable" }),
    });
    expect(response.status).toBe(202);
    expect(writer.events).toHaveLength(0);
  });

  test("a cursor client without run_id reuses its claimed ID after a lost acknowledgement", async () => {
    const ids: string[] = [];
    const cell = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        ids.push(((await request.json()) as { run_id: string }).run_id);
        return new Response(null, { status: ids.length === 1 ? 503 : 202 });
      },
    });
    servers.push(cell);
    const writer = app("cell", `http://127.0.0.1:${cell.port}`);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      statuses.push(
        (
          await writer.hono.request("/api/runs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body("ignored", FIRST), run_id: undefined }),
          })
        ).status,
      );
    }
    expect(statuses).toEqual([503, 202]);
    expect(ids).toHaveLength(2);
    expect(ids[0]?.length).toBeGreaterThan(0);
    expect(ids[1]).toBe(ids[0]);
    expect(writer.events).toHaveLength(0);
  });

  test("cell down returns 503, keeps the blob for retry, and sends nothing to Inngest", async () => {
    const down = app("cell", deadCellUrl());
    const results = await postSequence(down);
    expect(results.map((result) => result.status)).toEqual([503, 503, 503]);
    expect(results.map((result) => result.json)).toEqual(
      Array(3).fill({
        ok: false,
        error: { code: "capture_cell_unavailable", message: "Retry this run" },
      }),
    );
    expect(down.events).toHaveLength(0);
  });

  test("cell mode cannot acknowledge before the cell commits, including prefix resends", async () => {
    let release!: () => void;
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cell = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async () => {
        entered();
        await committed;
        return new Response(null, { status: 202 });
      },
    });
    servers.push(cell);
    const writer = app("cell", `http://127.0.0.1:${cell.port}`, 1_000);
    let answered = false;
    const pending = postSequence(writer).then((result) => {
      answered = true;
      return result;
    });
    await arrived;
    await Bun.sleep(10);
    expect(answered).toBe(false);
    release();
    expect((await pending).map((result) => result.status)).toEqual([202, 202, 202]);
    expect(writer.events).toHaveLength(0);
  });

  test("cell mode bounds an unresponsive cell and fails closed", async () => {
    const cell = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => undefined),
    });
    servers.push(cell);
    const writer = app("cell", `http://127.0.0.1:${cell.port}`, 15);
    const results = await postSequence(writer);
    expect(results.map((result) => result.status)).toEqual([503, 503, 503]);
    for (const result of results) expect(result.ms).toBeLessThan(1_000);
    expect(writer.events).toHaveLength(0);
  });

  test("the mode defaults to off", () => {
    expect(parseCaptureCellMode(undefined)).toBe("off");
    expect(parseCaptureCellMode("BOTH")).toBe("both");
    expect(parseCaptureCellMode("cell")).toBe("cell");
  });
});
