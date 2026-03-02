import { describe, expect, test } from "bun:test"
import { __mailAdapterTestUtils } from "./mcp-agent-mail"

const {
  filterProjectMessagesByQuery,
  messageIdOf,
  normalizeProjectSlug,
  searchResultLooksDegraded,
} = __mailAdapterTestUtils

describe("mcp-agent-mail search fallback helpers", () => {
  test("normalizes project paths into stable slugs", () => {
    expect(normalizeProjectSlug("/Users/joel/Code/joelhooks/joelclaw")).toBe("users-joel-code-joelhooks-joelclaw")
  })

  test("filters messages by project and query against unified inbox fields", () => {
    const messages = [
      {
        id: 1,
        subject: "Starting: stabilize agent mail search",
        body_md: "Task details",
        project_name: "/Users/joel/Code/joelhooks/joelclaw",
      },
      {
        id: 2,
        subject: "Starting: unrelated",
        body_md: "Task details",
        project_name: "/Users/joel/Code/joelhooks/other-repo",
      },
      {
        id: 3,
        subject: "Status: clue",
        body_md: "No match",
        project_slug: "users-joel-code-joelhooks-joelclaw",
      },
    ]

    const starting = filterProjectMessagesByQuery(
      messages,
      "/Users/joel/Code/joelhooks/joelclaw",
      "Starting:",
    )
    expect(starting.map((row) => row.id)).toEqual([1])

    const status = filterProjectMessagesByQuery(
      messages,
      "/Users/joel/Code/joelhooks/joelclaw",
      "Status:",
    )
    expect(status.map((row) => row.id)).toEqual([3])
  })

  test("detects degraded search diagnostic payloads", () => {
    expect(searchResultLooksDegraded("Error calling tool 'search_messages': A database error occurred."))
      .toBe(true)

    expect(searchResultLooksDegraded({ result: "database error" })).toBe(true)
    expect(searchResultLooksDegraded({ messages: [{ id: 1, subject: "Starting" }] })).toBe(false)
  })

  test("supports numeric message ids", () => {
    expect(messageIdOf({ id: 42 })).toBe("42")
    expect(messageIdOf({ message_id: 101 })).toBe("101")
  })
})
