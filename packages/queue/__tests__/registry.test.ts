import { describe, expect, it } from "bun:test";
import { getRegisteredEventNames, lookupQueueEvent, QUEUE_EVENT_REGISTRY } from "../src/registry";
import { Priority } from "../src/types";

describe("Queue Event Registry", () => {
  it("should have pilot events", () => {
    expect(QUEUE_EVENT_REGISTRY.length).toBeGreaterThan(0);
    
    const eventNames = getRegisteredEventNames();
    expect(eventNames).toContain("discovery/noted");
    expect(eventNames).toContain("discovery/captured");
    expect(eventNames).toContain("content/updated");
    expect(eventNames).toContain("subscription/check-feeds.requested");
    expect(eventNames).toContain("github/workflow_run.completed");
  });

  it("should look up event by name", () => {
    const entry = lookupQueueEvent("discovery/noted");
    expect(entry).toBeDefined();
    expect(entry?.name).toBe("discovery/noted");
    expect(entry?.priority).toBe(Priority.P2);
    expect(entry?.dedupWindowMs).toBe(60_000);
    expect(entry?.handler?.type).toBe("inngest");
    expect(entry?.handler?.target).toBe("discovery/noted");
  });

  it("should return undefined for unknown event", () => {
    const entry = lookupQueueEvent("unknown/event");
    expect(entry).toBeUndefined();
  });

  it("should have valid priority for all events", () => {
    for (const entry of QUEUE_EVENT_REGISTRY) {
      expect(entry.priority).toBeGreaterThanOrEqual(Priority.P0);
      expect(entry.priority).toBeLessThanOrEqual(Priority.P3);
    }
  });

  it("should have handler metadata for all events", () => {
    for (const entry of QUEUE_EVENT_REGISTRY) {
      expect(entry.handler).toBeDefined();
      expect(entry.handler?.type).toBeDefined();
      expect(entry.handler?.target).toBeDefined();
    }
  });

  it("should have unique event names", () => {
    const names = getRegisteredEventNames();
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });
});
