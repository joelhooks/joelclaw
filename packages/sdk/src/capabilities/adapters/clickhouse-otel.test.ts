import { describe, expect, test } from "bun:test"
import { __clickhouseOtelAdapterTestUtils } from "./clickhouse-otel"

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
    expect(where.debug).toContain("level:=[error,fatal]")
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
