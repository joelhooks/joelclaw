import { describe, expect, test } from "bun:test"
import { __subscribeTestUtils } from "./subscribe"

describe("subscribe check next actions", () => {
  test("uses event action (not run action) for check response ids", () => {
    const nextActions = __subscribeTestUtils.buildSubscribeCheckNextActions(
      {
        event: "subscription/check.requested",
        response: { ids: ["01KTESTEVENTID"] },
      },
      true,
    )

    expect(nextActions.some((action) => action.command === "joelclaw run <run-id>")).toBe(false)
    const eventAction = nextActions.find((action) => action.command === "joelclaw event <event-id>")
    expect(eventAction).toBeDefined()
    expect(eventAction?.params?.["event-id"]?.value).toBe("01KTESTEVENTID")
  })

  test("only suggests run action when explicit run ids exist", () => {
    const nextActions = __subscribeTestUtils.buildSubscribeCheckNextActions(
      {
        event: "subscription/check.requested",
        runIds: ["01KTESTRUNID"],
        response: { ids: ["01KTESTEVENTID"] },
      },
      true,
    )

    const runAction = nextActions.find((action) => action.command === "joelclaw run <run-id>")
    expect(runAction).toBeDefined()
    expect(runAction?.params?.["run-id"]?.value).toBe("01KTESTRUNID")

    const eventAction = nextActions.find((action) => action.command === "joelclaw event <event-id>")
    expect(eventAction?.params?.["event-id"]?.value).toBe("01KTESTEVENTID")
  })

  test("all-subscriptions check keeps aggregate runs action", () => {
    const nextActions = __subscribeTestUtils.buildSubscribeCheckNextActions(
      {
        event: "subscription/check-feeds.requested",
        response: { ids: ["01KTESTEVENTID"] },
      },
      false,
    )

    expect(nextActions[0]?.command).toBe("joelclaw runs [--count <count>]")
    expect(nextActions.some((action) => action.command === "joelclaw run <run-id>")).toBe(false)
  })
})
