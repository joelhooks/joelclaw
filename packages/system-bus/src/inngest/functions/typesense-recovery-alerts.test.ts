import { describe, expect, test } from "bun:test";
import {
  __typesenseRecoveryAlertTestUtils,
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
        engine: "typesense" as const,
        index: "runs_dev",
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

  test("keeps the collection outage clock when process health is 200 but runs_dev is 503", async () => {
    const stateKey = __typesenseRecoveryAlertTestUtils.STARTUP_BUDGET_STATE_KEY;
    const store = memoryStore({
      [stateKey]: JSON.stringify({ unavailableSince: 1_000, alertedAt: null }),
    });
    const alerts: string[] = [];
    const result = await processStartupBudget({
      store,
      probe: async () => ({ healthy: true, status: 200, detail: "HTTP 200 ok" }),
      readProjection: async () => {
        throw new Error("search projection query failed: 503 loading");
      },
      notify: async (assessment) => {
        alerts.push(assessment.target);
      },
      now: () => 61_000,
      budgetMs: 60_000,
    });

    expect(result).toMatchObject({
      collectionHealthy: false,
      availabilityDetail: expect.stringContaining("runs_dev query failed"),
    });
    expect(result.assessment).toMatchObject({
      target: "typesense:runs_dev",
      exceeded: true,
      shouldAlert: true,
      unavailableSince: 1_000,
    });
    expect(alerts).toEqual(["typesense:runs_dev"]);
    expect(JSON.parse(store.values.get(stateKey) ?? "{}")).toMatchObject({
      unavailableSince: 1_000,
      alertedAt: null,
    });
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
          engine: "typesense",
          index: "runs_dev",
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
