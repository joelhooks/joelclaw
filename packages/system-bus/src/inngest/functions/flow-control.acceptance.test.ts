import { describe, expect, test } from "bun:test";

describe("FLOW-1 acceptance tests", () => {
  test("plan.ts has concurrency keyed by loopId with limit 1", async () => {
    const mod = await import("./agent-loop/plan.ts");
    const opts = (mod.agentLoopPlan as unknown as { opts?: Record<string, unknown> }).opts ?? {};

    expect(opts).toMatchObject({
      concurrency: [{ key: "event.data.loopId", limit: 1 }],
    });
  });

  test("implement.ts has concurrency keyed by loopId with limit 1", async () => {
    const mod = await import("./agent-loop/implement.ts");
    const opts = (mod.agentLoopImplement as unknown as { opts?: Record<string, unknown> }).opts ?? {};

    expect(opts).toMatchObject({
      concurrency: [{ key: "event.data.loopId", limit: 1 }],
    });
  });

  test("observe.ts has throttle limit 4 per 60s", async () => {
    const mod = await import("./observe.ts");
    const opts = (mod.observeSessionFunction as unknown as { opts?: Record<string, unknown> }).opts ?? {};

    expect(opts).toMatchObject({
      throttle: { limit: 4, period: "60s" },
    });
  });

  test("backfill-observe.ts has singleton config for one backfill at a time", async () => {
    const mod = await import("./backfill-observe.ts");
    const opts = (mod.backfillObserve as unknown as { opts?: Record<string, unknown> }).opts ?? {};

    expect(opts).toMatchObject({
      singleton: { key: '"backfill"', mode: "skip" },
    });
  });

  test("content-sync.ts has debounce config for vault sync bursts", async () => {
    const mod = await import("./content-sync.ts");
    const opts = (mod.contentSync as unknown as { opts?: Record<string, unknown> }).opts ?? {};

    expect(opts).toMatchObject({
      debounce: { period: "5s", key: '"vault-sync"' },
    });
  });

  test("agent-dispatch.ts has throttle limit 3 per 60s", async () => {
    const mod = await import("./agent-dispatch.ts");
    const opts = (mod.agentDispatch as unknown as { opts?: Record<string, unknown> }).opts ?? {};

    expect(opts).toMatchObject({
      throttle: { limit: 3, period: "60s" },
    });
  });

  test("TypeScript compiles (bunx tsc --noEmit)", async () => {
    const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    expect({ exitCode }).toMatchObject({ exitCode: 0 });
  }, 30_000);
});
