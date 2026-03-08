import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const controlAppliedEvents: Array<Record<string, unknown>> = [];
const controlRejectedEvents: Array<Record<string, unknown>> = [];

function buildObservedDecisionMock() {
  return {
    autoApplyFamilies: new Set<string>(),
    decision: {
      mode: "dry-run" as const,
      snapshotId: "snap-test",
      findings: {
        queuePressure: "healthy" as const,
        downstreamState: "healthy" as const,
        summary: "stubbed",
      },
      suggestedActions: [],
      finalActions: [],
      appliedCount: 0,
      latencyMs: 1,
    },
    failedError: undefined,
  };
}

let mockObservedDecision = buildObservedDecisionMock();

mock.module(new URL("../../lib/queue-observe.ts", import.meta.url).pathname, () => ({
  QUEUE_OBSERVE_MODEL: "anthropic/claude-sonnet-4-6",
  buildQueueObservationSnapshot: () => ({
    snapshotId: "snap-test",
    capturedAt: "2026-03-08T00:00:00.000Z",
    totals: {
      depth: 0,
      byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
      oldestAgeMs: null,
      newestAgeMs: null,
    },
    families: [],
    triage: {
      attempts: 0,
      completed: 0,
      failed: 0,
      fallbacks: 0,
      fallbackByReason: {},
      routeMismatches: 0,
      latencyMs: { p50: null, p95: null },
    },
    drainer: {
      state: "healthy",
      recentDispatches: 0,
      recentFailures: 0,
      throughputPerMinute: null,
    },
    gateway: {
      sleepMode: false,
      quietHours: false,
      mutedChannels: [],
    },
    control: {
      activePauses: [],
    },
  }),
  emitQueueControlApplied: async (event: Record<string, unknown>) => {
    controlAppliedEvents.push(event);
  },
  emitQueueControlRejected: async (event: Record<string, unknown>) => {
    controlRejectedEvents.push(event);
  },
  emitQueueObserveCompleted: async () => {},
  emitQueueObserveFailed: async () => {},
  emitQueueObserveFallback: async () => {},
  emitQueueObserveStarted: async () => {},
  observeQueueSnapshotDetailed: async () => mockObservedDecision,
}));

describe("queue observer config and control adapter", () => {
  let testUtils: Awaited<ReturnType<typeof import("./queue-observer")>>["__queueObserverTestUtils"];
  let originalDeps: typeof testUtils.deps;

  beforeEach(async () => {
    delete process.env.QUEUE_OBSERVER_MODE;
    delete process.env.QUEUE_OBSERVER_FAMILIES;
    delete process.env.QUEUE_OBSERVER_AUTO_FAMILIES;
    delete process.env.QUEUE_OBSERVER_INTERVAL_SECONDS;
    controlAppliedEvents.length = 0;
    controlRejectedEvents.length = 0;
    mockObservedDecision = buildObservedDecisionMock();

    ({ __queueObserverTestUtils: testUtils } = await import("./queue-observer"));
    originalDeps = { ...testUtils.deps };
  });

  afterEach(() => {
    testUtils.deps.ensureQueueInitialized = originalDeps.ensureQueueInitialized;
    testUtils.deps.getQueueStats = originalDeps.getQueueStats;
    testUtils.deps.listMessages = originalDeps.listMessages;
    testUtils.deps.listActiveQueueFamilyPauses = originalDeps.listActiveQueueFamilyPauses;
    testUtils.deps.pauseQueueFamily = originalDeps.pauseQueueFamily;
    testUtils.deps.resumeQueueFamily = originalDeps.resumeQueueFamily;
    testUtils.deps.search = originalDeps.search;
    testUtils.deps.getRedisClient = originalDeps.getRedisClient;
  });

  test("expands observer family aliases and clamps auto-apply to content only", () => {
    process.env.QUEUE_OBSERVER_MODE = "enforce";
    process.env.QUEUE_OBSERVER_FAMILIES = "discovery,content,github";
    process.env.QUEUE_OBSERVER_AUTO_FAMILIES = "content,github";
    process.env.QUEUE_OBSERVER_INTERVAL_SECONDS = "30";

    const config = testUtils.resolveQueueObserverConfig();

    expect(config.mode).toBe("enforce");
    expect([...config.observeFamilies]).toEqual([
      "discovery/noted",
      "discovery/captured",
      "content/updated",
      "github/workflow_run.completed",
    ]);
    expect([...config.autoApplyFamilies]).toEqual(["content/updated"]);
    expect(config.intervalSeconds).toBe(60);
  });

  test("cadence gate skips runs that arrive before the configured interval", async () => {
    const writes: string[] = [];
    const redis = {
      get: async () => String(1_000),
      set: async (_key: string, value: string) => {
        writes.push(value);
        return "OK";
      },
    };

    const skipped = await testUtils.gateQueueObserverCadence(redis as never, 120, 61_000);
    expect(skipped.shouldRun).toBe(false);
    expect(skipped.lastRunAt).toBe(new Date(1_000).toISOString());
    expect(skipped.nextRunAt).toBe(new Date(121_000).toISOString());
    expect(writes).toEqual([]);

    const allowed = await testUtils.gateQueueObserverCadence(redis as never, 120, 122_000);
    expect(allowed.shouldRun).toBe(true);
    expect(writes).toEqual(["122000"]);
  });

  test("registers cron controller and manual probe as separate functions", async () => {
    const { queueObserver, queueObserverRequested } = await import("./queue-observer");

    expect((queueObserver as any).opts?.triggers).toEqual([{ cron: "TZ=America/Los_Angeles */1 * * * *" }]);
    expect((queueObserverRequested as any).opts?.triggers).toEqual([{ event: "queue/observer.requested" }]);
    expect((queueObserverRequested as any).opts?.singleton).toEqual({ key: '"manual"', mode: "skip" });
  });

  test("manual probe stays read-only even when enforce mode would auto-apply", async () => {
    process.env.QUEUE_OBSERVER_MODE = "enforce";
    process.env.QUEUE_OBSERVER_FAMILIES = "content";
    process.env.QUEUE_OBSERVER_AUTO_FAMILIES = "content";

    let pauseCalls = 0;

    testUtils.deps.getRedisClient = (() => ({
      get: async () => null,
      set: async () => "OK",
      mget: async () => [null, null],
    })) as typeof testUtils.deps.getRedisClient;
    testUtils.deps.ensureQueueInitialized = (async () => {}) as typeof testUtils.deps.ensureQueueInitialized;
    testUtils.deps.getQueueStats = (async () => ({
      total: 0,
      byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
      oldestTimestamp: null,
      newestTimestamp: null,
    })) as typeof testUtils.deps.getQueueStats;
    testUtils.deps.listMessages = (async () => []) as typeof testUtils.deps.listMessages;
    testUtils.deps.listActiveQueueFamilyPauses = (async () => []) as typeof testUtils.deps.listActiveQueueFamilyPauses;
    testUtils.deps.pauseQueueFamily = (async () => {
      pauseCalls += 1;
      throw new Error("manual probe must not mutate queue control state");
    }) as typeof testUtils.deps.pauseQueueFamily;

    mockObservedDecision = {
      autoApplyFamilies: new Set(["content/updated"]),
      decision: {
        mode: "enforce",
        model: "anthropic/claude-sonnet-4-6",
        snapshotId: "snap-test",
        findings: {
          queuePressure: "backlogged",
          downstreamState: "degraded",
          summary: "content/updated would normally be paused here.",
        },
        suggestedActions: [
          {
            kind: "pause_family",
            family: "content/updated",
            ttlMs: 300_000,
            reason: "Pause content while the drainer catches up.",
          },
        ],
        finalActions: [
          {
            kind: "pause_family",
            family: "content/updated",
            ttlMs: 300_000,
            reason: "Pause content while the drainer catches up.",
          },
        ],
        appliedCount: 0,
        latencyMs: 1,
      },
      failedError: undefined,
    };

    const sendEvents: Array<Record<string, unknown>> = [];
    const result = await testUtils.runQueueObserverPass({
      step: {
        run: async (_id, fn) => await fn(),
        sendEvent: async (_id, payload) => {
          sendEvents.push(payload);
          return { ids: ["mock-event-id"] };
        },
      },
      eventName: "queue/observer.requested",
      eventData: {},
      allowAutoApply: false,
    });

    expect(result.trigger).toBe("manual");
    expect(result.mode).toBe("enforce");
    expect(result.autoApplyEnabled).toBe(false);
    expect(result.finalActions).toEqual([
      {
        kind: "pause_family",
        family: "content/updated",
        ttlMs: 300_000,
        reason: "Pause content while the drainer catches up.",
      },
    ]);
    expect(result.appliedCount).toBe(0);
    expect(result.reportQueued).toBe(false);
    expect(pauseCalls).toBe(0);
    expect(sendEvents).toEqual([]);
  });

  test("applies bounded pause and resume actions and builds one operator report", async () => {
    testUtils.deps.pauseQueueFamily = (async () => ({
      kind: "pause_family",
      family: "content/updated",
      ttlMs: 300_000,
      reason: "Pause content while the queue drains.",
      source: "observer",
      mode: "enforce",
      appliedAt: "2026-03-08T02:00:00.000Z",
      appliedAtMs: 1,
      expiresAt: "2026-03-08T02:05:00.000Z",
      expiresAtMs: 300_001,
      snapshotId: "snap-queue-observer",
      model: "anthropic/claude-sonnet-4-6",
      actor: "queue-observer",
    })) as typeof testUtils.deps.pauseQueueFamily;
    testUtils.deps.resumeQueueFamily = (async () => ({
      removed: true,
      pause: {
        kind: "pause_family",
        family: "content/updated",
        ttlMs: 300_000,
        reason: "Pause content while the queue drains.",
        source: "observer",
        mode: "enforce",
        appliedAt: "2026-03-08T02:00:00.000Z",
        appliedAtMs: 1,
        expiresAt: "2026-03-08T02:05:00.000Z",
        expiresAtMs: 300_001,
        snapshotId: "snap-queue-observer",
        model: "anthropic/claude-sonnet-4-6",
        actor: "queue-observer",
      },
    })) as typeof testUtils.deps.resumeQueueFamily;

    const result = await testUtils.applyQueueObserverActions({
      redis: {} as never,
      actor: "queue-observer",
      config: {
        mode: "enforce",
        observeFamilies: new Set(["content/updated"]),
        autoApplyFamilies: new Set(["content/updated"]),
        intervalSeconds: 60,
      },
      decision: {
        mode: "enforce",
        model: "anthropic/claude-sonnet-4-6",
        snapshotId: "snap-queue-observer",
        findings: {
          queuePressure: "backlogged",
          downstreamState: "degraded",
          summary: "content/updated is stacking up while the drainer is under pressure.",
        },
        suggestedActions: [],
        finalActions: [
          {
            kind: "pause_family",
            family: "content/updated",
            ttlMs: 300_000,
            reason: "Pause content while the queue drains.",
          },
          {
            kind: "resume_family",
            family: "content/updated",
            reason: "The backlog has cleared.",
          },
          {
            kind: "escalate",
            channel: "telegram",
            severity: "warn",
            message: "Queue observer saw a content backlog building.",
          },
        ],
        appliedCount: 0,
        latencyMs: 42,
      },
    });

    expect(result.appliedActions).toEqual([
      {
        kind: "pause_family",
        family: "content/updated",
        ttlMs: 300_000,
        reason: "Pause content while the queue drains.",
      },
      {
        kind: "resume_family",
        family: "content/updated",
        reason: "The backlog has cleared.",
      },
    ]);
    expect(result.rejectedActions).toEqual([]);
    expect(result.report?.escalationCount).toBe(1);
    expect(result.report?.text).toContain("Queue observer enforce");
    expect(result.report?.text).toContain("pause content/updated for 5m");
    expect(result.report?.text).toContain("resume content/updated");
    expect(result.report?.text).toContain("Queue observer saw a content backlog building.");
    expect(controlAppliedEvents).toHaveLength(2);
    expect(controlRejectedEvents).toHaveLength(0);
  });

  test("rejects resume when no active pause exists", async () => {
    testUtils.deps.resumeQueueFamily = (async () => ({ removed: false })) as typeof testUtils.deps.resumeQueueFamily;

    const result = await testUtils.applyQueueObserverActions({
      redis: {} as never,
      actor: "queue-observer",
      config: {
        mode: "enforce",
        observeFamilies: new Set(["content/updated"]),
        autoApplyFamilies: new Set(["content/updated"]),
        intervalSeconds: 60,
      },
      decision: {
        mode: "enforce",
        model: "anthropic/claude-sonnet-4-6",
        snapshotId: "snap-queue-observer",
        findings: {
          queuePressure: "healthy",
          downstreamState: "healthy",
          summary: "Resume was suggested without an active pause.",
        },
        suggestedActions: [],
        finalActions: [
          {
            kind: "resume_family",
            family: "content/updated",
            reason: "There is nothing left to hold.",
          },
        ],
        appliedCount: 0,
        latencyMs: 9,
      },
    });

    expect(result.appliedActions).toEqual([]);
    expect(result.rejectedActions).toEqual([
      {
        action: {
          kind: "resume_family",
          family: "content/updated",
          reason: "There is nothing left to hold.",
        },
        reason: "No active pause existed for content/updated",
      },
    ]);
    expect(controlAppliedEvents).toHaveLength(0);
    expect(controlRejectedEvents).toHaveLength(1);
    expect(result.report?.text).toContain("Rejected actions:");
  });
});
