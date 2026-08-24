import { describe, expect, test } from "bun:test";
import {
  createRetainedQueueDrainer,
  type RetainedQueueScheduler,
} from "./retained-queue-drainer";

class QueueHarness {
  readonly rows = new Map<string, string[]>();

  async lrange(key: string): Promise<string[]> {
    return [...(this.rows.get(key) ?? [])];
  }

  async lrem(key: string, _count: number, value: string): Promise<number> {
    const rows = this.rows.get(key) ?? [];
    const index = rows.indexOf(value);
    if (index < 0) return 0;
    rows.splice(index, 1);
    this.rows.set(key, rows);
    return 1;
  }
}

function schedulerHarness() {
  const tasks: Array<{ cancelled: boolean; delayMs: number; task: () => void }> = [];
  const scheduler: RetainedQueueScheduler = {
    schedule(task, delayMs) {
      const entry = { cancelled: false, delayMs, task };
      tasks.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
  };
  return {
    scheduler,
    tasks,
    flushNext() {
      const entry = tasks.find((candidate) => !candidate.cancelled);
      if (!entry) throw new Error("no retry scheduled");
      entry.cancelled = true;
      entry.task();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("retained queue drainer", () => {
  test("retains a failed row and retries without another notification", async () => {
    const queue = new QueueHarness();
    queue.rows.set("events", ["newest", "oldest"]);
    const scheduled = schedulerHarness();
    const processed: string[] = [];
    const failures: Array<{ attempt: number; retryInMs: number }> = [];
    let dependencyReady = false;

    const drainer = createRetainedQueueDrainer({
      client: queue,
      lists: ["events"],
      scheduler: scheduled.scheduler,
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 40,
      processRow: async (_list, raw) => {
        processed.push(raw);
        if (!dependencyReady) throw new Error("dependency unavailable");
      },
      onFailure: ({ attempt, retryInMs }) => {
        failures.push({ attempt, retryInMs });
      },
    });

    const ready = drainer.start();
    await settle();

    expect(queue.rows.get("events")).toEqual(["newest", "oldest"]);
    expect(processed).toEqual(["oldest"]);
    expect(failures).toEqual([{ attempt: 1, retryInMs: 10 }]);
    expect(drainer.state()).toEqual({
      phase: "backoff",
      attempt: 1,
      retryInMs: 10,
      failureStage: "row",
    });

    dependencyReady = true;
    scheduled.flushNext();
    await ready;

    expect(processed).toEqual(["oldest", "oldest", "newest"]);
    expect(queue.rows.get("events")).toEqual([]);
    expect(drainer.state()).toEqual({ phase: "idle" });
  });

  test("preserves oldest-first order and leaves concurrent LPUSH rows for the next pass", async () => {
    const queue = new QueueHarness();
    queue.rows.set("events", ["original-newest", "oldest"]);
    const processed: string[] = [];

    const drainer = createRetainedQueueDrainer({
      client: queue,
      lists: ["events"],
      processRow: async (_list, raw) => {
        processed.push(raw);
        if (raw === "oldest") {
          queue.rows.get("events")?.unshift("concurrent-newest");
        }
      },
    });

    await drainer.start();
    expect(processed).toEqual(["oldest", "original-newest"]);
    expect(queue.rows.get("events")).toEqual(["concurrent-newest"]);

    drainer.request();
    await settle();
    expect(processed).toEqual(["oldest", "original-newest", "concurrent-newest"]);
    expect(queue.rows.get("events")).toEqual([]);
  });

  test("keeps stop sticky while a row is in flight", async () => {
    const queue = new QueueHarness();
    queue.rows.set("events", ["newest", "oldest"]);
    const processed: string[] = [];
    let releaseRow!: () => void;
    let markRowStarted!: () => void;
    const rowStarted = new Promise<void>((resolve) => {
      markRowStarted = resolve;
    });
    const rowBarrier = new Promise<void>((resolve) => {
      releaseRow = resolve;
    });
    let passCalls = 0;

    const drainer = createRetainedQueueDrainer({
      client: queue,
      lists: ["events"],
      processRow: async (_list, raw) => {
        processed.push(raw);
        markRowStarted();
        await rowBarrier;
      },
      onPass: () => {
        passCalls += 1;
      },
    });

    void drainer.start();
    await rowStarted;
    drainer.stop();
    releaseRow();
    await settle();

    expect(drainer.state()).toEqual({ phase: "stopped" });
    expect(processed).toEqual(["oldest"]);
    expect(queue.rows.get("events")).toEqual(["newest"]);
    expect(passCalls).toBe(0);

    drainer.request();
    await settle();
    expect(processed).toEqual(["oldest"]);
  });

  test("retries pass-stage publication failure without claiming a retained row", async () => {
    const queue = new QueueHarness();
    queue.rows.set("events", []);
    const scheduled = schedulerHarness();
    const failures: Array<{ stage: string; mayHaveRetainedRow: boolean }> = [];
    let passCalls = 0;

    const drainer = createRetainedQueueDrainer({
      client: queue,
      lists: ["events"],
      scheduler: scheduled.scheduler,
      initialRetryDelayMs: 10,
      processRow: async () => {},
      onPass: () => {
        passCalls += 1;
        if (passCalls === 1) throw new Error("readiness write failed");
      },
      onFailure: ({ stage, mayHaveRetainedRow }) => {
        failures.push({ stage, mayHaveRetainedRow });
      },
    });

    const ready = drainer.start();
    await settle();
    expect(drainer.state()).toEqual({
      phase: "backoff",
      attempt: 1,
      retryInMs: 10,
      failureStage: "pass",
    });
    expect(failures).toEqual([{ stage: "pass", mayHaveRetainedRow: false }]);
    expect(queue.rows.get("events")).toEqual([]);

    scheduled.flushNext();
    await ready;
    expect(passCalls).toBe(2);
    expect(drainer.state()).toEqual({ phase: "idle" });
  });

  test("coalesces notifications while a retained row waits for retry", async () => {
    const queue = new QueueHarness();
    queue.rows.set("events", ["row"]);
    const scheduled = schedulerHarness();

    const drainer = createRetainedQueueDrainer({
      client: queue,
      lists: ["events"],
      scheduler: scheduled.scheduler,
      processRow: async () => {
        throw new Error("still unavailable");
      },
    });

    void drainer.start();
    await settle();
    drainer.request();
    drainer.request();
    drainer.request();
    await settle();

    expect(scheduled.tasks).toHaveLength(1);
    expect(queue.rows.get("events")).toEqual(["row"]);
    drainer.stop();
  });

  test("bounds exponential retry delay", async () => {
    const queue = new QueueHarness();
    queue.rows.set("events", ["row"]);
    const scheduled = schedulerHarness();
    const delays: number[] = [];

    const drainer = createRetainedQueueDrainer({
      client: queue,
      lists: ["events"],
      scheduler: scheduled.scheduler,
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 20,
      processRow: async () => {
        throw new Error("unavailable");
      },
      onFailure: ({ retryInMs }) => {
        delays.push(retryInMs);
      },
    });

    void drainer.start();
    await settle();
    scheduled.flushNext();
    await settle();
    scheduled.flushNext();
    await settle();

    expect(delays).toEqual([10, 20, 20]);
    drainer.stop();
  });
});
