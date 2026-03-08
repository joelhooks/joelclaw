import { Priority } from "./types";

/**
 * Registry entry for a queue event type.
 * 
 * Provides routing metadata, default priority, deduplication window,
 * and handler target for queue-aware dispatchers.
 */
export interface QueueEventRegistryEntry {
  /**
   * Event name (namespaced, e.g., "discovery/noted").
   */
  name: string;

  /**
   * Default priority for this event type.
   */
  priority: Priority;

  /**
   * Deduplication window in milliseconds.
   * If set, only one event with the same dedupKey will be enqueued within this window.
   */
  dedupWindowMs?: number;

  /**
   * Handler target metadata.
   *
   * For `type: "inngest"`, `target` must be the concrete Inngest event name
   * posted by the queue drainer — not a function id or a display label.
   */
  handler?: {
    type: "inngest" | "http" | "local";
    target: string;
  };

  /**
   * Optional description for operator visibility.
   */
  description?: string;
}

/**
 * Static registry of queue event types.
 * 
 * Phase 1 pilot events — deterministic routing metadata for initial acceptance.
 * Later phases will add dynamic registration and per-tenant overrides.
 */
export const QUEUE_EVENT_REGISTRY: QueueEventRegistryEntry[] = [
  {
    name: "discovery/noted",
    priority: Priority.P2,
    dedupWindowMs: 60_000, // 1 minute
    handler: {
      type: "inngest",
      target: "discovery/noted",
    },
    description: "Discovery item captured from URL or repo",
  },
  {
    name: "discovery/captured",
    priority: Priority.P2,
    dedupWindowMs: 60_000, // 1 minute
    handler: {
      type: "inngest",
      target: "discovery/captured",
    },
    description: "Discovery item fully captured with metadata",
  },
  {
    name: "content/updated",
    priority: Priority.P1,
    handler: {
      type: "inngest",
      target: "content/updated",
    },
    description: "Content item updated in Convex",
  },
  {
    name: "subscription/check-feeds.requested",
    priority: Priority.P2,
    dedupWindowMs: 5 * 60_000, // 5 minutes
    handler: {
      type: "inngest",
      target: "subscription/check-feeds.requested",
    },
    description: "Feed subscription check requested",
  },
  {
    name: "github/workflow_run.completed",
    priority: Priority.P1,
    handler: {
      type: "inngest",
      target: "github/workflow_run.completed",
    },
    description: "GitHub workflow run completed webhook",
  },
  {
    name: "workload/requested",
    priority: Priority.P1,
    handler: {
      type: "inngest",
      target: "system/agent.requested",
    },
    description:
      "Canonical workload runtime bridge that normalizes saved workload artifacts into background agent requests",
  },
];

/**
 * Look up a registry entry by event name.
 * 
 * Returns undefined if the event is not registered.
 */
export function lookupQueueEvent(name: string): QueueEventRegistryEntry | undefined {
  return QUEUE_EVENT_REGISTRY.find((entry) => entry.name === name);
}

/**
 * Get all registered event names.
 */
export function getRegisteredEventNames(): string[] {
  return QUEUE_EVENT_REGISTRY.map((entry) => entry.name);
}
