import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Priority, type QueueObservationSnapshot } from "@joelclaw/queue";

const inferredPrompts: string[] = [];
const emittedEvents: Array<Record<string, unknown>> = [];
let inferResponse: { text: string; model?: string } | null = null;
let inferError: Error | null = null;

mock.module(new URL("./inference.ts", import.meta.url).pathname, () => ({
  infer: async (prompt: string) => {
    inferredPrompts.push(prompt);
    if (inferError) throw inferError;
    return inferResponse ?? { text: "{}", model: "anthropic/claude-sonnet-4-6" };
  },
}));

mock.module(new URL("../observability/emit.ts", import.meta.url).pathname, () => ({
  emitOtelEvent: async (event: Record<string, unknown>) => {
    emittedEvents.push(event);
  },
}));

async function buildSnapshot(): Promise<QueueObservationSnapshot> {
  const { buildQueueObservationSnapshot } = await import("./queue-observe");
  return buildQueueObservationSnapshot({
    snapshotId: "snap-queue-observe",
    now: 1_000_000,
    stats: {
      total: 3,
      byPriority: { P0: 0, P1: 1, P2: 2, P3: 0 },
      oldestTimestamp: 970_000,
      newestTimestamp: 995_000,
    },
    messages: [
      {
        payload: { name: "content/updated" },
        priority: Priority.P2,
        timestamp: 970_000,
      },
      {
        payload: { name: "content/updated" },
        priority: Priority.P2,
        timestamp: 980_000,
      },
      {
        payload: { name: "github/workflow_run.completed" },
        priority: Priority.P1,
        timestamp: 995_000,
      },
    ],
    triage: {
      attempts: 4,
      completed: 3,
      failed: 1,
      fallbacks: 1,
      fallbackByReason: { timeout: 1 },
      routeMismatches: 1,
      latencyMs: { p50: 120, p95: 800 },
    },
    drainer: {
      state: "degraded",
      recentDispatches: 7,
      recentFailures: 1,
      throughputPerMinute: 3.5,
    },
    gateway: {
      sleepMode: false,
      quietHours: null,
      mutedChannels: ["telegram", "telegram"],
    },
    control: {
      activePauses: [
        {
          family: "subscription/check-feeds.requested",
          reason: "Let subscription checks cool off for a tick.",
          source: "manual",
          mode: "manual",
          appliedAt: "2026-03-07T11:55:00.000Z",
          expiresAt: "2026-03-07T12:05:00.000Z",
          expiresAtMs: 1_300_000,
        },
      ],
    },
  });
}

describe("queue observer contract", () => {
  beforeEach(() => {
    inferredPrompts.length = 0;
    emittedEvents.length = 0;
    inferResponse = {
      model: "anthropic/claude-sonnet-4-6",
      text: JSON.stringify({
        findings: {
          queuePressure: "degraded",
          downstreamState: "degraded",
          summary: "content/updated is stacking up while the drainer is a bit crook.",
        },
        actions: [
          {
            kind: "pause_family",
            family: "content/updated",
            ttlMs: 300_000,
            reason: "Give the drainer a breather while the content backlog settles.",
          },
          {
            kind: "reprioritize_family",
            family: "github/workflow_run.completed",
            priority: "P0",
            reason: "Workflow completions should stay near the front.",
          },
          {
            kind: "escalate",
            channel: "telegram",
            severity: "warn",
            message: "Queue observer saw a content backlog building.",
          },
        ],
      }),
    };
    inferError = null;
  });

  test("builds a canonical queue observation snapshot from deterministic inputs", async () => {
    const snapshot = await buildSnapshot();

    expect(snapshot.snapshotId).toBe("snap-queue-observe");
    expect(snapshot.totals).toMatchObject({
      depth: 3,
      byPriority: { P0: 0, P1: 1, P2: 2, P3: 0 },
      oldestAgeMs: 30_000,
      newestAgeMs: 5_000,
    });
    expect(snapshot.families).toEqual([
      {
        family: "content/updated",
        total: 2,
        byPriority: { P0: 0, P1: 0, P2: 2, P3: 0 },
        oldestAgeMs: 30_000,
        newestAgeMs: 20_000,
      },
      {
        family: "github/workflow_run.completed",
        total: 1,
        byPriority: { P0: 0, P1: 1, P2: 0, P3: 0 },
        oldestAgeMs: 5_000,
        newestAgeMs: 5_000,
      },
    ]);
    expect(snapshot.triage.fallbackByReason).toEqual({ timeout: 1 });
    expect(snapshot.gateway.mutedChannels).toEqual(["telegram"]);
    expect(snapshot.control.activePauses).toEqual([
      {
        family: "subscription/check-feeds.requested",
        reason: "Let subscription checks cool off for a tick.",
        source: "manual",
        mode: "manual",
        appliedAt: "2026-03-07T11:55:00.000Z",
        expiresAt: "2026-03-07T12:05:00.000Z",
        expiresInMs: 300_000,
      },
    ]);
  });

  test("parses valid bounded observer output and rejects non-snapshot families", async () => {
    const { __queueObserveTestUtils } = await import("./queue-observe");
    const snapshot = await buildSnapshot();

    const parsed = __queueObserveTestUtils.parseQueueObservationOutput(JSON.stringify({
      findings: {
        queuePressure: "healthy",
        downstreamState: "healthy",
        summary: "Nothing worth doing.",
      },
      actions: [{ kind: "noop", reason: "Queue is fine." }],
    }), snapshot);

    expect(parsed.ok).toBe(true);

    const validResume = __queueObserveTestUtils.parseQueueObservationOutput(JSON.stringify({
      findings: {
        queuePressure: "degraded",
        downstreamState: "healthy",
        summary: "Resume the paused subscriptions family now that nothing is queued there.",
      },
      actions: [{
        kind: "resume_family",
        family: "subscription/check-feeds.requested",
        reason: "The manual pause can come off.",
      }],
    }), snapshot);

    expect(validResume.ok).toBe(true);

    const invalid = __queueObserveTestUtils.parseQueueObservationOutput(JSON.stringify({
      findings: {
        queuePressure: "degraded",
        downstreamState: "healthy",
        summary: "Try pausing a family that is not in the snapshot.",
      },
      actions: [{
        kind: "pause_family",
        family: "discovery/noted",
        ttlMs: 60_000,
        reason: "This family was not present.",
      }],
    }), snapshot);

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.reason).toBe("unsafe_action");
      expect(invalid.error).toContain("discovery/noted");
    }

    const invalidResume = __queueObserveTestUtils.parseQueueObservationOutput(JSON.stringify({
      findings: {
        queuePressure: "healthy",
        downstreamState: "healthy",
        summary: "Try to resume a family that is not paused.",
      },
      actions: [{
        kind: "resume_family",
        family: "github/workflow_run.completed",
        reason: "This family was never paused.",
      }],
    }), snapshot);

    expect(invalidResume.ok).toBe(false);
    if (!invalidResume.ok) {
      expect(invalidResume.reason).toBe("unsafe_action");
      expect(invalidResume.error).toContain("github/workflow_run.completed");
    }
  });

  test("trims overlong summary output instead of falling back on schema length alone", async () => {
    const { __queueObserveTestUtils } = await import("./queue-observe");
    const snapshot = await buildSnapshot();
    const longSummary = "x".repeat(700);

    const parsed = __queueObserveTestUtils.parseQueueObservationOutput(JSON.stringify({
      findings: {
        queuePressure: "healthy",
        downstreamState: "healthy",
        summary: longSummary,
      },
      actions: [{ kind: "noop", reason: "Nothing to do." }],
    }), snapshot);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.findings.summary).toHaveLength(500);
    }
  });

  test("dry-run records suggested actions but does not produce final auto-apply actions", async () => {
    const { observeQueueSnapshot } = await import("./queue-observe");
    const snapshot = await buildSnapshot();

    const decision = await observeQueueSnapshot({
      mode: "dry-run",
      snapshot,
      autoApplyFamilies: ["content/updated"],
    });

    expect(inferredPrompts).toHaveLength(1);
    expect(inferredPrompts[0]).toContain("Snapshot id: snap-queue-observe");
    expect(decision.mode).toBe("dry-run");
    expect(decision.findings.queuePressure).toBe("degraded");
    expect(decision.suggestedActions).toHaveLength(3);
    expect(decision.finalActions).toEqual([]);
    expect(decision.appliedCount).toBe(0);

    const actions = emittedEvents.map((event) => event.action);
    expect(actions).toEqual(["queue.observe.started", "queue.observe.completed"]);
  });

  test("skips model inference and returns deterministic noop when the queue snapshot is empty", async () => {
    const { buildQueueObservationSnapshot, observeQueueSnapshot } = await import("./queue-observe");
    const snapshot = buildQueueObservationSnapshot({
      snapshotId: "snap-empty-queue-observe",
      now: 1_000_000,
      stats: {
        total: 0,
        byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
        oldestTimestamp: null,
        newestTimestamp: null,
      },
      messages: [],
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
        throughputPerMinute: 0,
      },
      gateway: {
        sleepMode: false,
        quietHours: false,
        mutedChannels: [],
      },
    });

    const decision = await observeQueueSnapshot({
      mode: "dry-run",
      snapshot,
    });

    expect(inferredPrompts).toHaveLength(0);
    expect(decision.fallbackReason).toBeUndefined();
    expect(decision.suggestedActions).toEqual([
      { kind: "noop", reason: "Queue is empty; no queue control action is warranted." },
    ]);
    expect(decision.finalActions).toEqual([]);

    const actions = emittedEvents.map((event) => event.action);
    expect(actions).toEqual(["queue.observe.started", "queue.observe.completed"]);
  });

  test("enforce mode narrows final actions to the bounded auto-apply subset", async () => {
    const { observeQueueSnapshot } = await import("./queue-observe");
    const snapshot = await buildSnapshot();

    const decision = await observeQueueSnapshot({
      mode: "enforce",
      snapshot,
      autoApplyFamilies: ["content/updated"],
    });

    expect(decision.suggestedActions).toHaveLength(3);
    expect(decision.finalActions).toEqual([
      {
        kind: "pause_family",
        family: "content/updated",
        ttlMs: 300_000,
        reason: "Give the drainer a breather while the content backlog settles.",
      },
      {
        kind: "escalate",
        channel: "telegram",
        severity: "warn",
        message: "Queue observer saw a content backlog building.",
      },
    ]);
    expect(decision.appliedCount).toBe(0);

    const completed = emittedEvents.find((event) => event.action === "queue.observe.completed");
    expect(completed?.metadata).toMatchObject({
      snapshotId: "snap-queue-observe",
      summary: "content/updated is stacking up while the drainer is a bit crook.",
      suggestedCount: 3,
      finalCount: 2,
      appliedCount: 0,
    });
  });

  test("returns schema fallback and emits failed plus fallback OTEL when the shape is bad", async () => {
    inferResponse = {
      model: "anthropic/claude-sonnet-4-6",
      text: JSON.stringify({
        findings: {
          queuePressure: "P9",
          downstreamState: "healthy",
          summary: "bad pressure value",
        },
        actions: [],
      }),
    };

    const { observeQueueSnapshot } = await import("./queue-observe");
    const snapshot = await buildSnapshot();
    const decision = await observeQueueSnapshot({
      mode: "enforce",
      snapshot,
      autoApplyFamilies: ["content/updated"],
    });

    expect(decision.fallbackReason).toBe("schema_error");
    expect(decision.suggestedActions).toEqual([]);
    expect(decision.finalActions).toEqual([]);

    const actions = emittedEvents.map((event) => event.action);
    expect(actions).toEqual(["queue.observe.started", "queue.observe.failed", "queue.observe.fallback"]);

    const fallback = emittedEvents.find((event) => event.action === "queue.observe.fallback");
    expect(fallback?.metadata).toMatchObject({
      fallbackReason: "schema_error",
      summary: "Queue depth 3; pressure degraded; downstream degraded; 2 active families; 1 active pauses; observer fallback schema_error",
    });
  });

  test("maps timeout-looking errors to timeout fallback and exposes queue.control OTEL helpers", async () => {
    const {
      __queueObserveTestUtils,
      emitQueueControlApplied,
      emitQueueControlExpired,
      emitQueueControlRejected,
      observeQueueSnapshot,
    } = await import("./queue-observe");
    const snapshot = await buildSnapshot();

    expect(__queueObserveTestUtils.fallbackReasonFromError(new Error("pi timed out after 60000ms"))).toBe("timeout");
    expect(__queueObserveTestUtils.fallbackReasonFromError(new Error("some other drama"))).toBe("model_error");

    inferError = new Error("pi timed out after 60000ms");
    const decision = await observeQueueSnapshot({
      mode: "enforce",
      snapshot,
      autoApplyFamilies: ["content/updated"],
    });
    expect(decision.fallbackReason).toBe("timeout");

    await emitQueueControlApplied({
      snapshotId: snapshot.snapshotId,
      mode: "enforce",
      model: "anthropic/claude-sonnet-4-6",
      expiresAt: "2026-03-07T12:00:00.000Z",
      action: {
        kind: "pause_family",
        family: "content/updated",
        ttlMs: 300_000,
        reason: "Pause content while the queue drains.",
      },
    });
    await emitQueueControlExpired({
      snapshotId: snapshot.snapshotId,
      expiredAt: "2026-03-07T12:05:00.000Z",
      action: {
        kind: "pause_family",
        family: "content/updated",
        ttlMs: 300_000,
        reason: "Pause content while the queue drains.",
      },
    });
    await emitQueueControlRejected({
      snapshotId: snapshot.snapshotId,
      mode: "enforce",
      model: "anthropic/claude-sonnet-4-6",
      reason: "family not whitelisted",
      action: {
        kind: "pause_family",
        family: "github/workflow_run.completed",
        ttlMs: 300_000,
        reason: "This should not auto-apply here.",
      },
    });

    expect(emittedEvents.map((event) => event.action)).toEqual([
      "queue.observe.started",
      "queue.observe.failed",
      "queue.observe.fallback",
      "queue.control.applied",
      "queue.control.expired",
      "queue.control.rejected",
    ]);
  });
});
