import { describe, expect, test } from "bun:test"
import {
  getEventRegistration,
  isRegisteredEvent,
  listRegisteredEvents,
  QUEUE_EVENT_REGISTRY,
} from "../src/registry"
import { Priority } from "../src/types"

describe("Queue Event Registry", () => {
  test("contains the expected deterministic pilot events", () => {
    const eventNames = QUEUE_EVENT_REGISTRY.map((registration) => registration.event)

    expect(eventNames).toEqual([
      "discovery/noted",
      "discovery/captured",
      "content/updated",
      "subscription/check-feeds.requested",
      "github/workflow_run.completed",
    ])
  })

  test("returns registration for known events", () => {
    const discoveryNoted = getEventRegistration("discovery/noted")

    expect(discoveryNoted).toBeDefined()
    expect(discoveryNoted?.priority).toBe(Priority.P2)
    expect(discoveryNoted?.dedupWindowMs).toBe(5 * 60 * 1000)
    expect(discoveryNoted?.handler).toEqual({
      kind: "inngest-function",
      target: "discovery-capture",
      component: "system-bus",
    })
  })

  test("returns undefined for unknown events", () => {
    expect(getEventRegistration("unknown/event")).toBeUndefined()
    expect(isRegisteredEvent("unknown/event")).toBe(false)
  })

  test("listRegisteredEvents returns the full static registry", () => {
    const registrations = listRegisteredEvents()

    expect(registrations).toEqual(QUEUE_EVENT_REGISTRY)
    expect(registrations).toHaveLength(5)
  })

  test("content/updated is the highest-priority pilot event", () => {
    expect(getEventRegistration("content/updated")?.priority).toBe(Priority.P1)
  })

  test("github/workflow_run.completed resolves to the webhook gateway", () => {
    expect(getEventRegistration("github/workflow_run.completed")?.handler).toEqual({
      kind: "webhook-provider",
      target: "github-webhook",
      component: "webhook-gateway",
    })
  })
})
