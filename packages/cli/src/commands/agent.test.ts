import { describe, expect, test } from "bun:test"
import { buildSuccessEnvelope, validateJoelclawEnvelope } from "../response"
import { __agentTestUtils } from "./agent"

const {
  listNextActions,
  showNextActions,
  runNextActions,
  extractInngestEventIds,
} = __agentTestUtils

describe("agent command envelopes", () => {
  test("list envelope is valid and advertises executable next actions", () => {
    const envelope = buildSuccessEnvelope(
      "agent list",
      {
        agents: [
          {
            name: "coder",
            model: "claude-sonnet-4-6",
            thinking: "medium",
            description: "General-purpose coding agent",
            tools: 4,
            skills: 3,
            source: "builtin",
          },
        ],
        total: 1,
      },
      listNextActions,
    )

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    expect(envelope.command).toBe("joelclaw agent list")
    expect(envelope.next_actions.some((action) => action.command === "joelclaw agent show <name>")).toBe(
      true,
    )
    expect(envelope.next_actions.some((action) => action.command === "joelclaw agent run <name> <task>")).toBe(
      true,
    )
  })

  test("show envelope is valid and run next action keeps selected agent", () => {
    const envelope = buildSuccessEnvelope(
      "agent show",
      {
        name: "designer",
        model: "claude-sonnet-4-6",
        systemPrompt: "Design with taste",
      },
      showNextActions("designer"),
    )

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    expect(envelope.command).toBe("joelclaw agent show")
    expect(envelope.next_actions[0]?.command).toBe("joelclaw agent run designer <task>")
  })

  test("run next actions with event IDs point to event lookup, not synthetic run IDs", () => {
    const nextActions = runNextActions(["01KTESTEVENTID"])

    expect(nextActions.some((action) => action.command.startsWith("joelclaw run "))).toBe(false)

    const eventAction = nextActions.find((action) => action.command === "joelclaw event <event-id>")
    expect(eventAction).toBeDefined()
    expect(eventAction?.params?.["event-id"]?.value).toBe("01KTESTEVENTID")

    const envelope = buildSuccessEnvelope(
      "agent run",
      {
        taskId: "at-123",
        agent: "coder",
        task: "Add tests",
        eventSent: true,
        eventIds: ["01KTESTEVENTID"],
      },
      nextActions,
    )

    const validation = validateJoelclawEnvelope(envelope)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
  })

  test("run next actions fall back to events listing when event ID is unavailable", () => {
    const nextActions = runNextActions([])

    expect(nextActions.some((action) => action.command.startsWith("joelclaw run "))).toBe(false)
    expect(
      nextActions.some(
        (action) => action.command === "joelclaw events --prefix agent/task. --hours 1 --count 20",
      ),
    ).toBe(true)
  })

  test("extractInngestEventIds keeps only non-empty strings", () => {
    expect(extractInngestEventIds({ ids: ["01A", "  ", 42, "01B"] })).toEqual(["01A", "01B"])
    expect(extractInngestEventIds({ ids: null })).toEqual([])
    expect(extractInngestEventIds(null)).toEqual([])
  })
})
