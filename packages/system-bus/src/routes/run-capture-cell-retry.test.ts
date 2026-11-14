import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";
// Test-only cross-package imports approved by the desk: exercise the actual
// transactional run_id dedupe, without a runtime dependency or manifest change.
import { openOutbox } from "../../../capture-cell/src/outbox";
import { createCellHandler } from "../../../capture-cell/src/server";
import * as telemetry from "../observability/emit";
import {
  type CaptureCellExhausted,
  type CaptureCellFailure,
  captureCellBackoffMs,
  captureCellFromEnv,
  createCaptureCellShadow,
  DEFAULT_CAPTURE_CELL_TIMEOUT_MS,
  DEFAULT_CAPTURE_CELL_TOTAL_BUDGET_MS,
} from "./run-capture-cell";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(overrides: Partial<Parameters<typeof createCaptureCellShadow>[0]> = {}) {
  const failures: CaptureCellFailure[] = [];
  const exhausted: CaptureCellExhausted[] = [];
  const shadow = createCaptureCellShadow({
    url: "http://cell.invalid/capture",
    token: "fixture-token",
    timeoutMs: 100,
    totalBudgetMs: 2_000,
    random: () => 0,
    onFailure: (failure) => failures.push(failure),
    onExhausted: (failure) => exhausted.push(failure),
    ...overrides,
  });
  return { shadow, failures, exhausted };
}

function fakeFetch(
  handler: (input: unknown, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return handler as typeof fetch;
}

const payload = {
  run_id: "late-run",
  user_id: "fixture-user",
  machine_id: "fixture-machine",
  agent_runtime: "pi",
  jsonl_path: "fixture.jsonl",
  jsonl_bytes: 0,
  jsonl_sha256: "b".repeat(64),
  started_at: 1,
};

describe("capture-cell shadow retry", () => {
  test("defaults cover the measured 2,633ms tail and three full attempts", () => {
    expect(DEFAULT_CAPTURE_CELL_TIMEOUT_MS).toBe(4_000);
    expect(DEFAULT_CAPTURE_CELL_TIMEOUT_MS).toBeGreaterThan(2_633);
    expect(DEFAULT_CAPTURE_CELL_TOTAL_BUDGET_MS).toBe(13_000);
    expect(DEFAULT_CAPTURE_CELL_TIMEOUT_MS * 3 + 250 + 500).toBeLessThan(
      DEFAULT_CAPTURE_CELL_TOTAL_BUDGET_MS,
    );
    expect(captureCellBackoffMs(1, () => 0)).toBe(125);
    expect(captureCellBackoffMs(1, () => 1)).toBe(250);
    expect(captureCellBackoffMs(2, () => 0)).toBe(250);
    expect(captureCellBackoffMs(2, () => 1)).toBe(500);
  });

  test("5xx retries preserve exact serialized bytes and run_id, then succeed", async () => {
    const bodies: string[] = [];
    const statuses = [500, 503, 202];
    const f = fixture({
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response(null, { status: statuses[bodies.length - 1] });
      }),
    });
    await f.shadow(payload);
    expect(bodies).toEqual(Array(3).fill(JSON.stringify(payload)));
    expect(f.failures.map((failure) => failure.attempt)).toEqual([1, 2]);
    expect(f.exhausted).toEqual([]);
  });

  test.each([400, 401, 403, 404, 408, 409, 413, 422, 429, 200, 204, 302])(
    "HTTP %i is terminal, not retried",
    async (status) => {
      let attempts = 0;
      const f = fixture({
        fetch: fakeFetch(async () => {
          attempts += 1;
          return new Response(null, { status });
        }),
      });
      await f.shadow(payload);
      expect(attempts).toBe(1);
      expect(f.failures).toHaveLength(1);
      expect(f.exhausted).toHaveLength(1);
      expect(f.exhausted[0]?.attempts).toBe(1);
    },
  );

  test("a dropped socket before an answer is retried successfully", async () => {
    let requests = 0;
    const server = createServer((socket) => {
      socket.once("data", () => {
        requests += 1;
        if (requests === 1) socket.destroy();
        else socket.end("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      });
    });
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    const f = fixture({ url: `http://127.0.0.1:${address.port}/capture`, timeoutMs: 500 });
    await f.shadow(payload);
    expect(requests).toBe(2);
    expect(f.failures).toHaveLength(1);
    expect(f.failures[0]?.reason).toContain("capture cell request failed");
    expect(f.exhausted).toEqual([]);
  });

  test("three failed attempts produce one exhausted notification and never throw", async () => {
    let attempts = 0;
    const f = fixture({
      fetch: fakeFetch(async () => {
        attempts += 1;
        throw new TypeError("connection reset");
      }),
    });
    await expect(f.shadow(payload)).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(f.failures.map((failure) => failure.attempt)).toEqual([1, 2, 3]);
    expect(f.exhausted).toHaveLength(1);
    expect(f.exhausted[0]).toMatchObject({ run_id: payload.run_id, attempts: 3 });
  });

  test("the default exhausted hook emits exactly one OTEL alarm", async () => {
    const emitted = Promise.withResolvers<void>();
    const events: Array<Parameters<typeof telemetry.emitOtelEvent>[0]> = [];
    const spy = spyOn(telemetry, "emitOtelEvent").mockImplementation(async (event) => {
      events.push(event);
      emitted.resolve();
      return { stored: true } as Awaited<ReturnType<typeof telemetry.emitOtelEvent>>;
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    cleanups.push(
      () => spy.mockRestore(),
      () => warn.mockRestore(),
    );
    const f = fixture({
      onExhausted: undefined,
      fetch: fakeFetch(async () => new Response(null, { status: 503 })),
    });
    await f.shadow(payload);
    await emitted.promise;
    expect(f.failures).toHaveLength(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "capture.cell.shadow.post_exhausted",
      level: "error",
      success: false,
      metadata: { run_id: payload.run_id, attempts: 3 },
    });
  });

  test("the total budget bounds an abort-ignoring fetch and cancels its late body", async () => {
    const late = Promise.withResolvers<Response>();
    const cancelled = Promise.withResolvers<void>();
    let signal: AbortSignal | null | undefined;
    const f = fixture({
      timeoutMs: 1_000,
      totalBudgetMs: 40,
      fetch: fakeFetch(async (_url, init) => {
        signal = init?.signal;
        return late.promise;
      }),
    });
    const started = performance.now();
    await f.shadow(payload);
    expect(performance.now() - started).toBeLessThan(500);
    expect(signal?.aborted).toBe(true);
    expect(f.failures).toHaveLength(1);
    expect(f.exhausted).toHaveLength(1);
    late.resolve(
      new Response(new ReadableStream({ cancel: () => cancelled.resolve() }), { status: 202 }),
    );
    await cancelled.promise;
    expect(f.exhausted).toHaveLength(1);
  });

  test("backoff spends the same budget rather than starting a fresh timeout", async () => {
    let attempts = 0;
    const f = fixture({
      totalBudgetMs: 40,
      fetch: fakeFetch(async () => {
        attempts += 1;
        return new Response(null, { status: 503 });
      }),
    });
    const started = performance.now();
    await f.shadow(payload);
    expect(performance.now() - started).toBeLessThan(500);
    expect(attempts).toBe(1);
    expect(f.failures).toHaveLength(1);
    expect(f.exhausted).toHaveLength(1);
  });

  test("throwing failure observers cannot interrupt retries or reject delivery", async () => {
    let attempts = 0;
    const f = fixture({
      fetch: fakeFetch(async () => {
        attempts += 1;
        throw new TypeError("connection reset");
      }),
      onFailure: () => {
        throw new Error("broken observer");
      },
      onExhausted: () => {
        throw new Error("broken alarm");
      },
    });
    await expect(f.shadow(payload)).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  test("missing configuration is terminal and fails closed without a network request", async () => {
    const failures: CaptureCellFailure[] = [];
    const exhausted: CaptureCellExhausted[] = [];
    const routing = captureCellFromEnv(
      { CAPTURE_CELL_MODE: "both" },
      (failure) => failures.push(failure),
      (failure) => exhausted.push(failure),
    );
    await routing.shadow(payload);
    expect(failures).toHaveLength(1);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.attempts).toBe(0);
  });

  test.each(["original commits first", "retry commits first"])(
    "planted late 202: exactly one cell row when %s",
    async (ordering) => {
      const db = openOutbox(":memory:");
      cleanups.push(() => db.close());
      const handle = createCellHandler({
        db,
        token: "fixture-token",
        now: () => 1,
        drain: { kick: () => undefined, settle: async () => undefined, stop: () => undefined },
      });
      const releaseOriginal = Promise.withResolvers<void>();
      const originalAnswered = Promise.withResolvers<void>();
      const duplicates: boolean[] = [];
      const bodies: string[] = [];
      const cell = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const text = await request.text();
          bodies.push(text);
          const original = bodies.length === 1;
          // Buffer before abort, so the late server-side commit survives the
          // client's timeout just as an already-admitted POST would.
          const copy = new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: text,
          });
          if (original && ordering === "retry commits first") await releaseOriginal.promise;
          const response = await handle(copy);
          const result = await response.json();
          duplicates.push(result.duplicate);
          if (original) {
            await releaseOriginal.promise;
            originalAnswered.resolve();
          } else releaseOriginal.resolve();
          return Response.json(result, { status: response.status });
        },
      });
      cleanups.push(() => cell.stop(true));
      const f = fixture({ url: `http://127.0.0.1:${cell.port}/capture`, timeoutMs: 80 });
      await f.shadow(payload);
      await originalAnswered.promise;
      expect(bodies).toEqual(Array(2).fill(JSON.stringify(payload)));
      expect(duplicates).toEqual([false, true]);
      expect(f.failures).toHaveLength(1);
      expect(f.failures[0]?.reason).toContain("did not answer within");
      expect(f.exhausted).toEqual([]);
      expect(
        db.query("SELECT COUNT(*) AS n FROM captured WHERE run_id = ?").get(payload.run_id),
      ).toEqual({ n: 1 });
      expect(
        db.query("SELECT COUNT(*) AS n FROM owed WHERE run_id = ?").get(payload.run_id),
      ).toEqual({ n: 2 });
    },
  );
});
