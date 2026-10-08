import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __typesenseRecoveryAlertTestUtils,
  captureGrowthNotify,
  checkCaptureGrowthForRun,
  processCaptureGrowth,
  processStartupBudget,
  readTypesenseRecoveryHealth,
  type SearchMaintenanceStateStore,
} from "./typesense-recovery-alerts";

function memoryStore(initial: Record<string, string> = {}): SearchMaintenanceStateStore & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
}

function capture(runId: string, fromOffset: number, toOffset: number) {
  return {
    run_id: runId,
    source_identity: `sha256:${"c".repeat(64)}`,
    from_offset: fromOffset,
    to_offset: toOffset,
    jsonl_sha256: `hash-${runId}`,
  };
}

describe("capture prefix growth alert", () => {
  test("alerts once for a distinct growing Run on the same source and cursor", async () => {
    const store = memoryStore();
    const alerts: string[] = [];
    let latched = false;
    const dependencies = {
      store,
      notify: async (finding: { current: { runId: string } }) => {
        if (latched) return false;
        latched = true;
        alerts.push(finding.current.runId);
        return true;
      },
      resolve: async () => {
        latched = false;
      },
      now: () => 100,
    };

    expect(await processCaptureGrowth(capture("run-a", 0, 100), dependencies)).toMatchObject({
      checked: true,
      finding: null,
      alerted: false,
    });
    expect(await processCaptureGrowth(capture("run-b", 0, 200), dependencies)).toMatchObject({
      checked: true,
      alerted: true,
      finding: { overlapBytes: 100 },
    });
    expect(await processCaptureGrowth(capture("run-b", 0, 200), dependencies)).toMatchObject({
      alerted: false,
    });
    expect(alerts).toEqual(["run-b"]);
  });

  test("delegates dedupe to the shared latch and resolves on recovery", async () => {
    const store = memoryStore();
    const alerts: string[] = [];
    let latched = false;
    let now = 100;
    const dependencies = {
      store,
      notify: async (_finding: unknown, eventId: string) => {
        if (latched) return false;
        latched = true;
        alerts.push(eventId);
        return true;
      },
      resolve: async () => {
        latched = false;
      },
      now: () => now,
    };

    await processCaptureGrowth(capture("run-a", 0, 100), dependencies);
    await processCaptureGrowth(capture("run-b", 0, 200), dependencies);
    await processCaptureGrowth(capture("run-c", 0, 300), dependencies);
    expect(alerts).toHaveLength(1);

    await processCaptureGrowth(capture("run-d", 300, 400), dependencies);
    await processCaptureGrowth(capture("run-e", 0, 500), dependencies);
    expect(alerts).toHaveLength(2);

    await processCaptureGrowth(capture("run-g", 500, 600), dependencies);
    now += 1;
    await processCaptureGrowth(capture("run-e", 0, 500), dependencies);
    expect(alerts).toHaveLength(3);

    now += __typesenseRecoveryAlertTestUtils.CAPTURE_INCIDENT_QUIET_MS + 1;
    await processCaptureGrowth(capture("run-f", 0, 600), dependencies);
    expect(alerts).toHaveLength(3);
    expect(new Set(alerts).size).toBe(3);
  });

  test("retries delivery after a notifier failure without leaving a false claim", async () => {
    const store = memoryStore();
    await processCaptureGrowth(capture("run-a", 0, 100), {
      store,
      notify: async () => {},
      now: () => 100,
    });
    let attempts = 0;
    const eventIds: string[] = [];
    let now = 200;
    const dependencies = {
      store,
      notify: async (_finding: unknown, eventId: string) => {
        attempts += 1;
        eventIds.push(eventId);
        if (attempts === 1) throw new Error("worker died before confirmation");
      },
      now: () => now,
    };

    await expect(processCaptureGrowth(capture("run-b", 0, 200), dependencies)).rejects.toThrow();
    now += __typesenseRecoveryAlertTestUtils.CAPTURE_INCIDENT_QUIET_MS + 1;
    expect((await processCaptureGrowth(capture("run-b", 0, 200), dependencies)).alerted).toBe(true);
    expect(attempts).toBe(2);
    expect(new Set(eventIds).size).toBe(2);
  });

  test("does not alert for adjacent ranges or incomplete provenance", async () => {
    const store = memoryStore();
    let alerts = 0;
    const dependencies = {
      store,
      notify: async () => {
        alerts += 1;
      },
      now: () => 100,
    };

    await processCaptureGrowth(capture("run-a", 0, 100), dependencies);
    expect(await processCaptureGrowth(capture("run-b", 100, 200), dependencies)).toMatchObject({
      finding: null,
    });
    expect(await processCaptureGrowth({ run_id: "legacy" }, dependencies)).toMatchObject({
      checked: false,
    });
    expect(alerts).toBe(0);
  });
});

describe("inline capture growth check", () => {
  const originalOtel = process.env.OTEL_EVENTS_ENABLED;
  beforeEach(() => {
    process.env.OTEL_EVENTS_ENABLED = "0";
  });
  afterEach(() => {
    if (originalOtel === undefined) delete process.env.OTEL_EVENTS_ENABLED;
    else process.env.OTEL_EVENTS_ENABLED = originalOtel;
  });

  function slowStore() {
    const store = memoryStore();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    return {
      ...store,
      get: async (key: string) => {
        await pause();
        return store.get(key);
      },
      set: async (key: string, value: string) => {
        await pause();
        await store.set(key, value);
      },
    };
  }

  test("serializes concurrent captures for one source so no ledger entry is lost", async () => {
    const store = slowStore();
    const dependencies = {
      store,
      notify: async () => true,
      resolve: async () => {},
      now: () => 100,
    };

    const receipts = await Promise.all([
      checkCaptureGrowthForRun(capture("run-a", 0, 100), dependencies),
      checkCaptureGrowthForRun(capture("run-b", 100, 200), dependencies),
      checkCaptureGrowthForRun(capture("run-c", 50, 150), dependencies),
    ]);

    expect(receipts.map((receipt) => receipt.checked)).toEqual([true, true, true]);
    expect(receipts[2].finding).toMatchObject({ overlapBytes: 50 });
    const [ledger] = [...store.values.values()];
    expect(JSON.parse(ledger ?? "[]").map((segment: { runId: string }) => segment.runId)).toEqual([
      "run-a",
      "run-b",
      "run-c",
    ]);
  });

  test("gives up on a hung state store without throwing", async () => {
    const started = Date.now();
    const receipt = await checkCaptureGrowthForRun(capture("run-a", 0, 100), {
      store: {
        get: () => new Promise<string | null>(() => {}),
        set: async () => {},
        delete: async () => {},
      },
      notify: async () => true,
      now: () => 100,
      resolve: async () => {},
      timeoutMs: 20,
    });

    expect(receipt).toMatchObject({ checked: false, finding: null, alerted: false });
    expect(receipt.error).toContain("timed out after 20ms");
    expect(Date.now() - started).toBeLessThan(1_000);

    // The hung call must not hold the source's queue for later captures.
    const next = await checkCaptureGrowthForRun(capture("run-b", 100, 200), {
      store: memoryStore(),
      notify: async () => true,
      resolve: async () => {},
      now: () => 100,
      timeoutMs: 20,
    });
    expect(next).toMatchObject({ checked: true, finding: null });
  });

  test("reports a notifier failure instead of failing the capture", async () => {
    const store = memoryStore();
    await checkCaptureGrowthForRun(capture("run-a", 0, 100), {
      store,
      notify: async () => true,
      now: () => 100,
      resolve: async () => {},
    });

    const receipt = await checkCaptureGrowthForRun(capture("run-b", 0, 200), {
      store,
      notify: async () => {
        throw new Error("gateway down");
      },
      now: () => 100,
      resolve: async () => {},
    });
    expect(receipt).toMatchObject({ checked: false, error: expect.stringContaining("gateway down") });
  });

  test("hands findings to a retrying notify function on its own event", () => {
    const fn = captureGrowthNotify as any;
    expect(fn.opts.id).toBe("search/capture-growth-notify");
    expect(fn.opts.retries).toBe(3);
    expect(fn.opts.triggers).toEqual([{ event: "search/capture-growth.detected" }]);
  });

  test("skips events without source provenance and never touches the store", async () => {
    let reads = 0;
    const receipt = await checkCaptureGrowthForRun(
      { run_id: "legacy", jsonl_sha256: "x" },
      {
        store: {
          get: async () => {
            reads += 1;
            return null;
          },
          set: async () => {},
          delete: async () => {},
        },
      },
    );
    expect(receipt).toEqual({ checked: false, finding: null, alerted: false });
    expect(reads).toBe(0);
  });
});

describe("Typesense startup budget monitor", () => {
  test("alerts once after the 503 duration exceeds budget, then clears on recovery", async () => {
    const store = memoryStore();
    const alerts: number[] = [];
    let now = 1_000;
    let healthy = false;
    const projection = {
      ok: true,
      detail: "fixture",
      freshness: { observedAt: "2026-07-20T00:00:00.000Z", latestSourceAt: null, ageMs: null },
      provenance: {
        engine: "sqlite" as const,
        index: "sessions.db",
        sourceOfTruth: "raw-run-jsonl" as const,
        runId: "run-1",
        sourceIdentity: null,
        fromOffset: null,
        toOffset: null,
        jsonlSha256: "hash",
        jsonlPath: "/fixture/run-1.jsonl",
      },
    };
    const dependencies = {
      store,
      probe: async () => ({ healthy, status: healthy ? 200 : 503, detail: healthy ? "ok" : "HTTP 503" }),
      readProjection: async () => projection,
      notify: async (assessment: { unavailableForMs: number }) => {
        alerts.push(assessment.unavailableForMs);
      },
      now: () => now,
      budgetMs: 60_000,
    };

    expect((await processStartupBudget(dependencies)).assessment.exceeded).toBe(false);
    now = 61_000;
    expect((await processStartupBudget(dependencies)).assessment.shouldAlert).toBe(true);
    now = 121_000;
    expect((await processStartupBudget(dependencies)).assessment.shouldAlert).toBe(true);
    expect(alerts).toEqual([60_000, 120_000]);

    healthy = true;
    const recovered = await processStartupBudget(dependencies);
    expect(recovered.assessment.nextState).toBeNull();
    expect(recovered.projection).toEqual(projection);
    expect(store.values.has(__typesenseRecoveryAlertTestUtils.STARTUP_BUDGET_STATE_KEY)).toBe(false);
    expect(store.values.has(__typesenseRecoveryAlertTestUtils.SEARCH_HEALTH_KEY)).toBe(true);
  });

  test("does not call a sessions.db failure a Typesense process outage", async () => {
    const stateKey = __typesenseRecoveryAlertTestUtils.STARTUP_BUDGET_STATE_KEY;
    const store = memoryStore({
      [stateKey]: JSON.stringify({ unavailableSince: 1_000, alertedAt: null }),
    });
    const alerts: string[] = [];
    const result = await processStartupBudget({
      store,
      probe: async () => ({ healthy: true, status: 200, detail: "HTTP 200 ok" }),
      readProjection: async () => {
        throw new Error("sessions.db is unreadable");
      },
      notify: async (assessment) => {
        alerts.push(assessment.target);
      },
      now: () => 61_000,
      budgetMs: 60_000,
    });

    expect(result).toMatchObject({
      targetHealthy: true,
      availabilityDetail: expect.stringContaining("sessions.db health failed independently"),
    });
    expect(result.assessment).toMatchObject({
      target: "typesense:process",
      exceeded: false,
      shouldAlert: false,
      unavailableSince: null,
    });
    expect(alerts).toEqual([]);
    expect(store.values.has(stateKey)).toBe(false);
  });

  test("keeps startup alert pending when delivery fails, then retries", async () => {
    const stateKey = __typesenseRecoveryAlertTestUtils.STARTUP_BUDGET_STATE_KEY;
    const store = memoryStore({
      [stateKey]: JSON.stringify({ unavailableSince: 1_000, alertedAt: null }),
    });
    let attempts = 0;
    const dependencies = {
      store,
      probe: async () => ({ healthy: false, status: 503, detail: "HTTP 503" }),
      readProjection: async () => {
        throw new Error("must not query while unavailable");
      },
      notify: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("delivery interrupted");
      },
      now: () => 61_000,
      budgetMs: 60_000,
    };

    await expect(processStartupBudget(dependencies)).rejects.toThrow("delivery interrupted");
    expect(JSON.parse(store.values.get(stateKey) ?? "{}")).toMatchObject({ alertedAt: null });
    expect((await processStartupBudget(dependencies)).assessment.shouldAlert).toBe(true);
    expect(attempts).toBe(2);
  });

  test("marks persisted search health stale during an outage", async () => {
    const observedAt = Date.parse("2026-07-20T00:00:00.000Z");
    const store = memoryStore({
      [__typesenseRecoveryAlertTestUtils.STARTUP_BUDGET_STATE_KEY]: JSON.stringify({
        unavailableSince: observedAt + 1_000,
        alertedAt: null,
      }),
      [__typesenseRecoveryAlertTestUtils.SEARCH_HEALTH_KEY]: JSON.stringify({
        ok: true,
        detail: "last successful projection",
        freshness: {
          observedAt: new Date(observedAt).toISOString(),
          latestSourceAt: new Date(observedAt - 5_000).toISOString(),
          ageMs: 5_000,
        },
        provenance: {
          engine: "sqlite",
          index: "sessions.db",
          sourceOfTruth: "raw-run-jsonl",
          runId: "run-1",
          sourceIdentity: null,
          fromOffset: null,
          toOffset: null,
          jsonlSha256: "hash",
          jsonlPath: "/fixture/run-1.jsonl",
        },
      }),
    });

    const health = await readTypesenseRecoveryHealth(store, observedAt + 30_000);
    expect(health.search).toMatchObject({
      ok: false,
      freshness: { stale: true, observationAgeMs: 30_000 },
    });
  });
});
