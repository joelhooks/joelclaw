import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __queueTestUtils, enqueueRegisteredQueueEvent } from "./queue";

const persisted: Array<Record<string, unknown>> = [];
const triageCalls: Array<Record<string, unknown>> = [];
let triageDecision: Record<string, unknown> | undefined;

const originalDeps = {
  ...__queueTestUtils.deps,
};

describe("queue admission helper", () => {
  beforeEach(() => {
    delete process.env.QUEUE_TRIAGE_MODE;
    delete process.env.QUEUE_TRIAGE_FAMILIES;
    persisted.length = 0;
    triageCalls.length = 0;
    triageDecision = undefined;
    __queueTestUtils.resetInitPromise();

    __queueTestUtils.deps.getRedisClient = (() => ({}) as never) as typeof __queueTestUtils.deps.getRedisClient;
    __queueTestUtils.deps.init = (async () => {}) as typeof __queueTestUtils.deps.init;
    __queueTestUtils.deps.lookupQueueEvent = ((name: string) => {
      if (name === "discovery/noted") {
        return {
          name,
          priority: 2,
          handler: { type: "inngest-event", target: name },
        };
      }

      if (name === "github/workflow_run.completed") {
        return {
          name,
          priority: 1,
          handler: { type: "inngest-event", target: name },
        };
      }

      return null;
    }) as typeof __queueTestUtils.deps.lookupQueueEvent;
    __queueTestUtils.deps.persist = (async (input: Record<string, unknown>) => {
      persisted.push(input);
      return {
        streamId: "1740000000000-0",
        priority: input.priority,
      };
    }) as typeof __queueTestUtils.deps.persist;
    __queueTestUtils.deps.triageQueueEvent = (async (input: Record<string, unknown>) => {
      triageCalls.push(input);
      return triageDecision ?? {
        mode: "shadow",
        family: "discovery/noted",
        suggested: { priority: "P1", routeCheck: "confirm" },
        final: { priority: "P2", routeCheck: "confirm" },
        applied: false,
        latencyMs: 12,
      };
    }) as typeof __queueTestUtils.deps.triageQueueEvent;
  });

  afterEach(() => {
    __queueTestUtils.deps.getRedisClient = originalDeps.getRedisClient;
    __queueTestUtils.deps.init = originalDeps.init;
    __queueTestUtils.deps.lookupQueueEvent = originalDeps.lookupQueueEvent;
    __queueTestUtils.deps.persist = originalDeps.persist;
    __queueTestUtils.deps.triageQueueEvent = originalDeps.triageQueueEvent;
    __queueTestUtils.resetInitPromise();
  });

  test("expands configured family aliases and keeps non-target families off", () => {
    process.env.QUEUE_TRIAGE_MODE = "shadow";
    process.env.QUEUE_TRIAGE_FAMILIES = "github";

    expect(__queueTestUtils.resolveQueueTriageMode("github/workflow_run.completed")).toBe("shadow");
    expect(__queueTestUtils.resolveQueueTriageMode("discovery/noted")).toBe("off");
    expect([...__queueTestUtils.expandQueueTriageFamilies("discovery,github")]).toEqual([
      "discovery/noted",
      "discovery/captured",
      "github/workflow_run.completed",
    ]);
  });

  test("persists triage metadata for eligible shadow families through the canonical helper", async () => {
    process.env.QUEUE_TRIAGE_MODE = "shadow";
    process.env.QUEUE_TRIAGE_FAMILIES = "discovery";
    triageDecision = {
      mode: "shadow",
      family: "discovery/noted",
      suggested: { priority: "P1", routeCheck: "confirm" },
      final: { priority: "P2", routeCheck: "confirm" },
      applied: false,
      latencyMs: 17,
      fallbackReason: "timeout",
    };

    const result = await enqueueRegisteredQueueEvent({
      name: "discovery/noted",
      data: { url: "https://example.com" },
      source: "cli/discover",
    });

    expect(result.triageMode).toBe("shadow");
    expect(result.triage?.fallbackReason).toBe("timeout");
    expect(triageCalls).toHaveLength(1);

    const persistedEntry = persisted[0] as {
      payload: {
        trace?: { correlationId?: string };
        triage?: { family?: string };
      };
      metadata?: Record<string, unknown>;
    };

    expect(persistedEntry.payload.trace?.correlationId).toBe(result.eventId);
    expect(persistedEntry.payload.triage?.family).toBe("discovery/noted");
    expect(persistedEntry.metadata).toMatchObject({
      source: "cli/discover",
      triageMode: "shadow",
      triageFallbackReason: "timeout",
      triageFinalPriority: "P2",
    });
  });

  test("skips triage cleanly when the admission shadow path is disabled", async () => {
    const result = await enqueueRegisteredQueueEvent({
      name: "discovery/noted",
      data: { url: "https://example.com/off" },
      source: "cli/discover",
    });

    expect(result.triageMode).toBe("off");
    expect(result.triage).toBeUndefined();
    expect(triageCalls).toHaveLength(0);

    const persistedEntry = persisted[0] as {
      payload: { triage?: unknown };
      metadata?: Record<string, unknown>;
    };

    expect(persistedEntry.payload.triage).toBeUndefined();
    expect(persistedEntry.metadata).toMatchObject({
      triageMode: "off",
      triageApplied: false,
    });
  });
});
