import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { __clickhouseOtelAdapterTestUtils, clickhouseOtelAdapter } from "./clickhouse-otel"

describe("clickhouse otel adapter helpers", () => {
  test("builds ClickHouse WHERE filters with escaped strings", () => {
    const where = __clickhouseOtelAdapterTestUtils.buildWhere({
      level: "error,fatal",
      source: "gateway",
      component: "redis-channel",
      session: "abc'123",
      success: "false",
      query: "boom'o",
      hours: 1,
    })

    expect(where.sql).toContain("timestamp >= fromUnixTimestamp64Milli")
    expect(where.sql).toContain("level IN ('error','fatal')")
    expect(where.sql).toContain("source IN ('gateway')")
    expect(where.sql).toContain("component IN ('redis-channel')")
    expect(where.sql).toContain("sessionId = 'abc\\'123'")
    expect(where.sql).toContain("success = 0")
    expect(where.sql).toContain("positionCaseInsensitive(search_text, 'boom\\'o')")
    expect(where.sql).not.toContain("positionCaseInsensitive(metadata_json")
    expect(where.sql).not.toContain("positionCaseInsensitive(action")
    expect(where.sql).not.toContain("positionCaseInsensitive(error")
    expect(where.sql).not.toContain("positionCaseInsensitive(component")
    expect(where.sql).not.toContain("positionCaseInsensitive(source")
    expect(where.debug).toContain("level:=[error,fatal]")
  })

  test("runs bounded search queries serially", async () => {
    const previousFetch = globalThis.fetch
    const queries: string[] = []
    let active = 0
    let maxActive = 0

    globalThis.fetch = (async (_input, init) => {
      const sql = String(init?.body ?? "")
      queries.push(sql)
      active += 1
      maxActive = Math.max(maxActive, active)
      await Bun.sleep(5)
      active -= 1

      const data = sql.includes("FROM system.tables")
        ? [{ engine: "MergeTree" }]
        : sql.startsWith("SELECT count() AS count")
          ? [{ count: 0 }]
          : []
      return new Response(JSON.stringify({ data }), { status: 200 })
    }) as typeof fetch

    try {
      const result = await Effect.runPromise(clickhouseOtelAdapter.execute("search", {
        query: "needle",
        hours: 1,
        limit: 30,
        page: 1,
      }, {
        cwd: "/tmp",
        now: new Date(0),
        config: {
          capabilities: {
            otel: {
              enabled: true,
              adapter: "clickhouse-otel",
              adapters: { "clickhouse-otel": { url: "http://serial-search.test:8123" } },
              source: { enabled: "default", adapter: "default" },
            },
          },
          paths: { projectConfig: "", userConfig: "" },
        },
      }))

      expect(result.found).toBe(0)
      expect(queries).toHaveLength(7)
      expect(maxActive).toBe(1)
      for (const sql of queries.filter((query) => query.includes("joelclaw.otel_events"))) {
        expect(sql).not.toContain("SETTINGS max_threads")
      }
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("resolves ClickHouse config from capability adapter settings before env", () => {
    process.env.CLICKHOUSE_URL = "http://env-clickhouse:8123"
    const config = __clickhouseOtelAdapterTestUtils.resolveClickHouseConfig({
      cwd: "/tmp",
      now: new Date(0),
      config: {
        capabilities: {
          otel: {
            enabled: true,
            adapter: "clickhouse-otel",
            adapters: {
              "clickhouse-otel": {
                url: "http://configured:8123",
                database: "logs",
                table: "events",
              },
            },
            source: { enabled: "default", adapter: "default" },
          },
        },
        paths: { projectConfig: "", userConfig: "" },
      },
    })

    expect(config.url).toBe("http://configured:8123")
    expect(config.database).toBe("logs")
    expect(config.table).toBe("events")
    delete process.env.CLICKHOUSE_URL
  })
})
