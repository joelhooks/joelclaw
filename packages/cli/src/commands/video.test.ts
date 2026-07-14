import { describe, expect, test } from "bun:test"
import { __videoTestUtils } from "./video"

const event = (runId?: string) => ({
  timestamp: "2026-07-14 00:00:00",
  level: "info",
  component: "video-pipeline",
  action: "video.step.test.completed",
  success: true,
  metadata: runId ? { runId } : {},
  ...(runId ? { runId } : {}),
})

describe("video trace helpers", () => {
  test("normalizes resource IDs and bare slugs", () => {
    expect(__videoTestUtils.normalizeLookup("olPVU1y6iI")).toEqual({
      input: "olPVU1y6iI",
      resourceId: "video:olPVU1y6iI",
      shareSlug: "olPVU1y6iI",
    })
    expect(__videoTestUtils.normalizeLookup("video:olPVU1y6iI")).toEqual({
      input: "video:olPVU1y6iI",
      resourceId: "video:olPVU1y6iI",
      shareSlug: "olPVU1y6iI",
    })
    expect(() => __videoTestUtils.normalizeLookup("video:")).toThrow()
  })

  test("escapes ClickHouse string literals", () => {
    expect(__videoTestUtils.sqlString("a'b\\c")).toBe("'a\\'b\\\\c'")
    expect(__videoTestUtils.shellQuote("a'b")).toBe("'a'\\''b'")
  })

  test("classifies missing and partial run correlation", () => {
    expect(__videoTestUtils.classifyMismatch([], []).kind).toBe("no_events")
    expect(__videoTestUtils.classifyMismatch([event()], []).kind).toBe("events_missing_run_id")
    expect(
      __videoTestUtils.classifyMismatch(
        [event("01KXFG357BZQDPASHCNQTZXEXP"), event()],
        [{ runId: "01KXFG357BZQDPASHCNQTZXEXP", statusDisagreement: false }],
      ).kind,
    ).toBe("partial_run_correlation")
  })

  test("recovers pre-resource events through run ID", async () => {
    const runId = "01KXFG357BZQDPASHCNQTZXEXP"
    const realFetch = globalThis.fetch
    const previousUrl = process.env.CLICKHOUSE_QUERY_URL
    process.env.CLICKHOUSE_QUERY_URL = "http://clickhouse.test"
    let request = 0
    globalThis.fetch = (async () => {
      request += 1
      const row = request === 1
        ? {
            timestampText: "2026-07-14 00:00:02",
            level: "info",
            component: "video-pipeline",
            action: "video.step.create-video-record.completed",
            success: 1,
            metadataJson: JSON.stringify({ resourceId: "video:olPVU1y6iI", runId }),
            sessionId: runId,
          }
        : {
            timestampText: "2026-07-14 00:00:01",
            level: "info",
            component: "video-pipeline",
            action: "video.step.validate-and-checksum.completed",
            success: 1,
            metadataJson: JSON.stringify({ checksum: "sha256", runId }),
            sessionId: runId,
          }
      return new Response(`${JSON.stringify(row)}\n`, { status: 200 })
    }) as typeof fetch
    try {
      const events = await __videoTestUtils.queryVideoEvents("olPVU1y6iI", 72, 500)
      expect(events.map((item) => item.action)).toEqual([
        "video.step.validate-and-checksum.completed",
        "video.step.create-video-record.completed",
      ])
      expect(request).toBe(2)
    } finally {
      globalThis.fetch = realFetch
      if (previousUrl === undefined) delete process.env.CLICKHOUSE_QUERY_URL
      else process.env.CLICKHOUSE_QUERY_URL = previousUrl
    }
  })

  test("preserves failed trace lookup as mismatch", () => {
    expect(
      __videoTestUtils.classifyMismatch(
        [event("01KXFG357BZQDPASHCNQTZXEXP")],
        [{ runId: "01KXFG357BZQDPASHCNQTZXEXP", statusDisagreement: false, error: "offline" }],
      ).kind,
    ).toBe("run_trace_lookup_failed")
  })
})
