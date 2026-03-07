import { describe, expect, it } from "bun:test";
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

  it("computes nearest-rank percentiles for queue latency output", () => {
    expect(__queueTestUtils.percentile([100, 200, 300, 400], 0.5)).toBe(200);
    expect(__queueTestUtils.percentile([100, 200, 300, 400], 0.95)).toBe(400);
    expect(__queueTestUtils.percentile([], 0.95)).toBeNull();
  });

  // Integration tests would require Redis + Typesense and are better suited for E2E.
  // These tests verify the command tree and Story 5 summary math.
});
