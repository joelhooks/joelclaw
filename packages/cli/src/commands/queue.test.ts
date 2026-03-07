import { describe, expect, it } from "bun:test";
import { __queueAdmissionTestUtils } from "../lib/queue-admission";
import { __queueTestUtils, queueCmd } from "./queue";

describe("Queue CLI Command", () => {
  it("wires the queue command with the expected subcommands", () => {
    expect(queueCmd).toBeDefined();
    expect(queueCmd.descriptor._tag).toBe("Subcommands");

    const subcommandNames = queueCmd.descriptor.children.map((child) => child.command.command.name);
    expect(subcommandNames).toEqual(["emit", "depth", "stats", "list", "inspect"]);
  });

  it("summarizes dispatch latency, failures, and depth for Story 5 soak output", () => {
    const summary = __queueTestUtils.summarizeQueueStats(
      [
        {
          id: "started-1",
          timestamp: 1_000,
          action: "queue.dispatch.started",
          success: true,
          metadata: {
            streamId: "1000-0",
            eventName: "discovery/noted",
            waitTimeMs: 1_200,
          },
        },
        {
          id: "completed-1",
          timestamp: 1_120,
          action: "queue.dispatch.completed",
          success: true,
          metadata: {
            streamId: "1000-0",
            eventName: "discovery/noted",
          },
        },
        {
          id: "started-2",
          timestamp: 2_000,
          action: "queue.dispatch.started",
          success: true,
          metadata: {
            streamId: "2000-0",
            eventName: "content/updated",
            waitTimeMs: 6_100,
            promotedFrom: 3,
          },
        },
        {
          id: "failed-2",
          timestamp: 2_180,
          action: "queue.dispatch.failed",
          success: false,
          error: "boom",
          metadata: {
            streamId: "2000-0",
            eventName: "content/updated",
          },
        },
      ],
      {
        total: 0,
        byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
        oldestTimestamp: null,
        newestTimestamp: null,
      },
      {
        hours: 24,
        found: 4,
        sampled: 4,
        truncated: false,
        filterBy: "timestamp:>=123 && action:=[queue.dispatch.started,queue.dispatch.completed,queue.dispatch.failed]",
      },
    );

    expect(summary.dispatches).toEqual({
      started: 2,
      completed: 1,
      failed: 1,
      terminal: 2,
      successRate: 0.5,
    });
    expect(summary.queueLatencyMs.p50).toBe(1_200);
    expect(summary.queueLatencyMs.p95).toBe(6_100);
    expect(summary.queueLatencyMs.withinTarget).toBe(false);
    expect(summary.dispatchDurationMs.p95).toBe(180);
    expect(summary.promotions).toBe(1);
    expect(summary.eventFamilies).toEqual([
      { name: "content/updated", count: 1 },
      { name: "discovery/noted", count: 1 },
    ]);
    expect(summary.recentFailures).toEqual([
      {
        at: new Date(2_180).toISOString(),
        streamId: "2000-0",
        eventName: "content/updated",
        error: "boom",
      },
    ]);
  });

  it("summarizes triage fallbacks, disagreement counts, and mismatch samples for Story 3", () => {
    const summary = __queueTestUtils.summarizeQueueTriageStats(
      [
        {
          id: "triage-started-1",
          timestamp: 10_000,
          action: "queue.triage.started",
          success: true,
          metadata: {
            family: "discovery/noted",
            mode: "shadow",
          },
        },
        {
          id: "triage-completed-1",
          timestamp: 10_030,
          action: "queue.triage.completed",
          success: true,
          metadata: {
            family: "discovery/noted",
            mode: "shadow",
            suggestedPriority: "P1",
            finalPriority: "P2",
            suggestedDedupKey: "discovery:https://example.com",
            finalDedupKey: null,
            routeCheck: "mismatch",
            applied: false,
            latencyMs: 30,
          },
        },
        {
          id: "triage-started-2",
          timestamp: 11_000,
          action: "queue.triage.started",
          success: true,
          metadata: {
            family: "github/workflow_run.completed",
            mode: "shadow",
          },
        },
        {
          id: "triage-failed-2",
          timestamp: 11_020,
          action: "queue.triage.failed",
          success: false,
          error: "schema broke",
          metadata: {
            family: "github/workflow_run.completed",
            mode: "shadow",
            latencyMs: 20,
          },
        },
        {
          id: "triage-fallback-2",
          timestamp: 11_021,
          action: "queue.triage.fallback",
          success: false,
          error: "schema_error",
          metadata: {
            family: "github/workflow_run.completed",
            mode: "shadow",
            fallbackReason: "schema_error",
            finalPriority: "P1",
            routeCheck: "confirm",
            latencyMs: 21,
          },
        },
      ],
      {
        hours: 24,
        found: 5,
        sampled: 5,
        truncated: false,
        filterBy: "timestamp:>=123 && action:=[queue.triage.started,queue.triage.completed,queue.triage.failed,queue.triage.fallback]",
      },
    );

    expect(summary.attempts).toBe(2);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.fallbacks).toBe(1);
    expect(summary.disagreements).toBe(1);
    expect(summary.appliedChanges).toBe(0);
    expect(summary.suggestedNotApplied).toBe(1);
    expect(summary.routeMismatches).toBe(1);
    expect(summary.fallbackByReason).toEqual([{ reason: "schema_error", count: 1 }]);
    expect(summary.latencyMs.p95).toBe(30);
    expect(summary.families).toEqual([
      {
        name: "discovery/noted",
        attempts: 1,
        completed: 1,
        failed: 0,
        fallbacks: 0,
        disagreements: 1,
        appliedChanges: 0,
        suggestedNotApplied: 1,
        routeMismatches: 1,
      },
      {
        name: "github/workflow_run.completed",
        attempts: 1,
        completed: 0,
        failed: 1,
        fallbacks: 1,
        disagreements: 0,
        appliedChanges: 0,
        suggestedNotApplied: 0,
        routeMismatches: 0,
      },
    ]);
    expect(summary.recentMismatchSamples).toEqual([
      {
        at: new Date(10_030).toISOString(),
        family: "discovery/noted",
        mode: "shadow",
        suggestedPriority: "P1",
        finalPriority: "P2",
        suggestedDedupKey: "discovery:https://example.com",
        finalDedupKey: null,
        routeCheck: "mismatch",
        applied: false,
      },
    ]);
  });

  it("computes nearest-rank percentiles for queue latency output", () => {
    expect(__queueTestUtils.percentile([100, 200, 300, 400], 0.5)).toBe(200);
    expect(__queueTestUtils.percentile([100, 200, 300, 400], 0.95)).toBe(400);
    expect(__queueTestUtils.percentile([], 0.95)).toBeNull();
  });

  it("parses --since values as ISO or epoch timestamps", () => {
    expect(__queueTestUtils.parseSinceTimestamp("2026-03-07T19:33:05Z")).toBe(1772911985000);
    expect(__queueTestUtils.parseSinceTimestamp("1772911985000")).toBe(1772911985000);
    expect(__queueTestUtils.parseSinceTimestamp("1772911985")).toBe(1772911985000);
    expect(() => __queueTestUtils.parseSinceTimestamp("not-a-time")).toThrow();
  });

  it("normalizes manual priority overrides before posting to the worker admission endpoint", () => {
    expect(__queueAdmissionTestUtils.normalizePriority("p1")).toBe("P1");
    expect(__queueAdmissionTestUtils.normalizePriority(0)).toBe("P0");
    expect(__queueAdmissionTestUtils.normalizePriority("bogus")).toBeUndefined();
  });

  // Integration tests would require Redis + Typesense and are better suited for E2E.
  // These tests verify the command tree and Story 5 summary math.
});
