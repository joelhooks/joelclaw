import { describe, expect, test } from "bun:test";
import { __usageQueryTestables } from "./clickhouse-usage-query";

const {
  boundedInt,
  buildRollupSql,
  buildTotalsSql,
  buildWhereClause,
  coerceNumber,
  parseJsonEachRow,
  resolveUsageQueryConfig,
  sqlString,
  toRollupRow,
} = __usageQueryTestables;

const testConfig = {
  url: "http://clickhouse.test:8123",
  database: "joelclaw",
  table: "otel_events",
  ttlDays: 180,
};

describe("clickhouse-usage-query", () => {
  describe("resolveUsageQueryConfig", () => {
    test("prefers CLICKHOUSE_QUERY_URL over CLICKHOUSE_URL", () => {
      const config = resolveUsageQueryConfig({
        CLICKHOUSE_QUERY_URL: "http://query.example:8123/",
        CLICKHOUSE_URL: "http://write.example:8123",
      } as NodeJS.ProcessEnv);

      expect(config.url).toBe("http://query.example:8123");
    });

    test("falls back to CLICKHOUSE_URL then hard default", () => {
      const fromUrl = resolveUsageQueryConfig({
        CLICKHOUSE_URL: "http://write.example:8123",
      } as NodeJS.ProcessEnv);
      const fromDefault = resolveUsageQueryConfig({} as NodeJS.ProcessEnv);

      expect(fromUrl.url).toBe("http://write.example:8123");
      expect(fromDefault.url).toBe("http://192.168.1.163:8123");
    });
  });

  describe("boundedInt", () => {
    test("uses fallback for missing or non-finite values", () => {
      expect(boundedInt(undefined, 24, 1, 100)).toBe(24);
      expect(boundedInt(Number.NaN, 24, 1, 100)).toBe(24);
      expect(boundedInt(Number.POSITIVE_INFINITY, 24, 1, 100)).toBe(24);
    });

    test("clamps and floors to bounds", () => {
      expect(boundedInt(0, 24, 1, 100)).toBe(1);
      expect(boundedInt(-5, 24, 1, 100)).toBe(1);
      expect(boundedInt(999, 24, 1, 100)).toBe(100);
      expect(boundedInt(12.9, 24, 1, 100)).toBe(12);
    });
  });

  describe("sqlString escaping", () => {
    test("escapes single quotes and backslashes", () => {
      expect(sqlString("it's")).toBe("'it\\'s'");
      expect(sqlString("a\\b")).toBe("'a\\\\b'");
    });

    test("filter value with quote cannot break out of the literal", () => {
      const where = buildWhereClause({ component: "x' OR 1=1 --" });

      expect(where).toContain("component = 'x\\' OR 1=1 --'");
      expect(where).not.toContain("component = 'x' OR");
    });
  });

  describe("buildRollupSql", () => {
    test("defaults window, limit, and action filter", () => {
      const sql = buildRollupSql({}, testConfig);

      expect(sql).toContain("FROM joelclaw.otel_events");
      expect(sql).toContain("action = 'model_router.result'");
      expect(sql).toContain("INTERVAL 24 HOUR");
      expect(sql).toContain("LIMIT 500");
      expect(sql).toContain("FORMAT JSONEachRow");
      expect(sql).toContain("GROUP BY day, component, action, model, provider, systemId");
      expect(sql).toContain("ORDER BY totalTokens DESC");
    });

    test("coerces hours and caps limit", () => {
      const sql = buildRollupSql({ hours: 48.7, limit: 999_999 }, testConfig);

      expect(sql).toContain("INTERVAL 48 HOUR");
      expect(sql).toContain("LIMIT 5000");
    });

    test("applies optional equality filters with escaping", () => {
      const sql = buildRollupSql(
        { component: "model-router", model: "gpt-5.6-sol", systemId: "fla'gg" },
        testConfig,
      );

      expect(sql).toContain("component = 'model-router'");
      expect(sql).toContain("JSONExtractString(metadata_json, 'model') = 'gpt-5.6-sol'");
      expect(sql).toContain("coalesce(systemId, 'unknown') = 'fla\\'gg'");
    });

    test("is read-only", () => {
      const sql = buildRollupSql({}, testConfig);

      expect(sql).not.toMatch(/CREATE|ALTER|INSERT|DROP/iu);
    });
  });

  describe("buildTotalsSql", () => {
    test("has no grouping or limit and keeps the window filter", () => {
      const sql = buildTotalsSql({ hours: 6 }, testConfig);

      expect(sql).toContain("count() AS calls");
      expect(sql).toContain("INTERVAL 6 HOUR");
      expect(sql).toContain(
        "countIf(action = 'model_router.result' AND JSONExtractBool(metadata_json, 'usageCaptured') != 1) AS usageMissing",
      );
      expect(sql).not.toContain("GROUP BY");
      expect(sql).not.toContain("LIMIT");
    });

    test("source option controls the action filter", () => {
      expect(buildTotalsSql({ source: "router" }, testConfig)).toContain("action = 'model_router.result'");
      expect(buildTotalsSql({ source: "agents" }, testConfig)).toContain("action = 'agent_usage.turn'");
      expect(buildTotalsSql({ source: "all" }, testConfig)).toContain(
        "action IN ('model_router.result', 'agent_usage.turn')",
      );
      // default stays router for backward compatibility
      expect(buildTotalsSql({}, testConfig)).toContain("action = 'model_router.result'");
    });
  });

  describe("parseJsonEachRow", () => {
    test("parses one object per line and skips blanks/malformed lines", () => {
      const rows = parseJsonEachRow('{"a":1}\n\nnot-json\n{"b":"2"}\n');

      expect(rows).toEqual([{ a: 1 }, { b: "2" }]);
    });

    test("skips non-object lines", () => {
      const rows = parseJsonEachRow('[1,2]\n"x"\n{"ok":true}');

      expect(rows).toEqual([{ ok: true }]);
    });
  });

  describe("coerceNumber", () => {
    test("handles JSON numbers, quoted 64-bit integers, and garbage", () => {
      expect(coerceNumber(42)).toBe(42);
      expect(coerceNumber("42")).toBe(42);
      expect(coerceNumber("0.021395")).toBeCloseTo(0.021395);
      expect(coerceNumber("nope")).toBe(0);
      expect(coerceNumber(null)).toBe(0);
      expect(coerceNumber(undefined)).toBe(0);
    });
  });

  describe("toRollupRow", () => {
    test("coerces mixed string/number ClickHouse output", () => {
      const row = toRollupRow({
        day: "2026-07-09",
        component: "model-router",
        action: "model_router.result",
        model: "gpt-5.6-sol",
        provider: "openai-codex",
        systemId: "flagg",
        calls: "12",
        inputTokens: 4249,
        outputTokens: "5",
        totalTokens: "4254",
        cacheReadTokens: 0,
        cacheWriteTokens: "0",
        costTotal: "0.021395",
        usageMissing: "3",
      });

      expect(row).toEqual({
        day: "2026-07-09",
        component: "model-router",
        action: "model_router.result",
        model: "gpt-5.6-sol",
        provider: "openai-codex",
        systemId: "flagg",
        calls: 12,
        inputTokens: 4249,
        outputTokens: 5,
        totalTokens: 4254,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costTotal: 0.021395,
        usageMissing: 3,
      });
    });

    test("defaults missing fields to empty/zero and unknown systemId", () => {
      const row = toRollupRow({});

      expect(row.day).toBe("");
      expect(row.model).toBe("");
      expect(row.systemId).toBe("unknown");
      expect(row.calls).toBe(0);
      expect(row.costTotal).toBe(0);
    });
  });
});
