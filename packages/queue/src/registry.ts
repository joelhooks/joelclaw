import { Priority } from "./types"

export interface QueueHandlerTarget {
  kind: "inngest-function" | "webhook-provider"
  target: string
  component: string
}

export interface QueueEventRegistration {
  event: string
  priority: Priority
  dedupWindowMs?: number
  handler: QueueHandlerTarget
  meta?: Record<string, unknown>
}

export const QUEUE_EVENT_REGISTRY = [
  {
    event: "discovery/noted",
    priority: Priority.P2,
    dedupWindowMs: 5 * 60 * 1000,
    handler: {
      kind: "inngest-function",
      target: "discovery-capture",
      component: "system-bus",
    },
    meta: {
      description: "Inbound discovery note awaiting capture/enrichment handoff",
      owner: "adr-0217-pilot",
    },
  },
  {
    event: "discovery/captured",
    priority: Priority.P3,
    dedupWindowMs: 15 * 60 * 1000,
    handler: {
      kind: "inngest-function",
      target: "discovery-capture",
      component: "system-bus",
    },
    meta: {
      description: "Captured discovery ready for slower downstream enrichment",
      owner: "adr-0217-pilot",
    },
  },
  {
    event: "content/updated",
    priority: Priority.P1,
    dedupWindowMs: 30 * 1000,
    handler: {
      kind: "inngest-function",
      target: "content-review-apply",
      component: "system-bus",
    },
    meta: {
      description: "Content mutation requiring prompt review/revalidation",
      owner: "adr-0217-pilot",
    },
  },
  {
    event: "subscription/check-feeds.requested",
    priority: Priority.P3,
    dedupWindowMs: 60 * 1000,
    handler: {
      kind: "inngest-function",
      target: "subscription/check-feeds",
      component: "system-bus",
    },
    meta: {
      description: "Manual or scheduled feed-check request",
      owner: "adr-0217-pilot",
    },
  },
  {
    event: "github/workflow_run.completed",
    priority: Priority.P2,
    dedupWindowMs: 60 * 1000,
    handler: {
      kind: "webhook-provider",
      target: "github-webhook",
      component: "webhook-gateway",
    },
    meta: {
      description: "GitHub workflow completion notification awaiting routing",
      owner: "adr-0217-pilot",
    },
  },
] as const satisfies readonly QueueEventRegistration[]

const registryByEvent = new Map<string, QueueEventRegistration>(
  QUEUE_EVENT_REGISTRY.map((registration) => [registration.event, registration]),
)

export function getEventRegistration(eventName: string): QueueEventRegistration | undefined {
  return registryByEvent.get(eventName)
}

export function isRegisteredEvent(eventName: string): boolean {
  return registryByEvent.has(eventName)
}

export function listRegisteredEvents(): readonly QueueEventRegistration[] {
  return QUEUE_EVENT_REGISTRY
}
