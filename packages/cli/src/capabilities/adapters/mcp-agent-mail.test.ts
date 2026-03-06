import { describe, expect, test } from "bun:test"
import { __mailAdapterTestUtils } from "./mcp-agent-mail"

const {
  filterProjectMessagesByQuery,
  messageIdOf,
  normalizeProjectSlug,
  searchResultLooksDegraded,
  summarizeArtifactLocks,
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

  test("summarizes artifact-backed file reservations when locks API under-reports", () => {
    const nowMs = Date.parse("2026-03-06T21:25:30.000Z")
    const summary = summarizeArtifactLocks(
      [
        {
          id: 978,
          agent: "MaroonReef",
          path_pattern: "/Users/joel/Code/joelhooks/joelclaw/.tmp/clawmail-smoke.txt",
          exclusive: true,
          expires_ts: "2026-03-06T21:27:04.494201+00:00",
          __artifact_path: "/tmp/id-978.json",
        },
        {
          id: 978,
          agent: "MaroonReef",
          path_pattern: "/Users/joel/Code/joelhooks/joelclaw/.tmp/clawmail-smoke.txt",
          exclusive: true,
          expires_ts: "2026-03-06T21:27:04.494201+00:00",
          __artifact_path: "/tmp/hash-978.json",
        },
        {
          id: 977,
          agent: "GrayLantern",
          path_pattern: "packages/queue/src/types.ts",
          exclusive: true,
          expires_ts: "2026-03-06T21:24:04.494201+00:00",
          __artifact_path: "/tmp/id-977.json",
        },
        {
          id: 976,
          agent: "CopperSparrow",
          path_pattern: "packages/queue/src/registry.ts",
          exclusive: true,
          __artifact_path: "/tmp/id-976.json",
        },
        {
          id: 975,
          agent: "BronzeSpring",
          path_pattern: "packages/queue/src/store.ts",
          exclusive: true,
          expires_ts: "2026-03-06T21:29:04.494201+00:00",
          released_ts: "2026-03-06T21:25:10.000Z",
          __artifact_path: "/tmp/id-975.json",
        },
      ],
      { nowMs, directory: "/tmp/file_reservations" },
    )

    expect(summary.summary).toEqual({
      total: 3,
      active: 1,
      stale: 1,
      metadata_missing: 1,
    })
    expect(summary.locks.map((lock) => [lock.id, lock.state])).toEqual([
      [978, "active"],
      [977, "stale"],
      [976, "metadata_missing"],
    ])
  })
})
