import { describe, expect, test } from "vitest";
import {
  CRITICAL_DB_SOURCE_STALE_AFTER_MS,
  evaluateCriticalDbFreshness,
} from "../src/critical-db-freshness";

const NOW = Date.parse("2026-07-30T00:00:00.000Z");

function source(highWaterAt: string) {
  return { status: "ok", highWaterAt };
}

describe("evaluateCriticalDbFreshness", () => {
  test("requires the retired memory archive but does not age-gate it", () => {
    const result = evaluateCriticalDbFreshness({
      sources: {
        "files:observations": source("2026-07-29T23:59:00.000Z"),
        "files:brain": source("2026-07-29T23:59:00.000Z"),
        "files:vault": source("2026-07-29T23:59:00.000Z"),
        "files:knowledge": source("2026-07-29T23:59:00.000Z"),
        "archive:memory_observations": source("2026-05-31T00:00:00.000Z"),
      },
      degradedOverride: false,
      nowMs: NOW,
    });

    expect(result.sources["archive:memory_observations"]?.freshness).toBe("stale");
    expect(result.status).toBe("ok");
  });

  test("still degrades when the retired archive is unavailable", () => {
    const result = evaluateCriticalDbFreshness({
      sources: {
        "files:observations": source("2026-07-29T23:59:00.000Z"),
        "files:brain": source("2026-07-29T23:59:00.000Z"),
        "files:vault": source("2026-07-29T23:59:00.000Z"),
        "files:knowledge": source("2026-07-29T23:59:00.000Z"),
        "archive:memory_observations": { status: "unavailable" },
      },
      degradedOverride: false,
      nowMs: NOW,
    });

    expect(result.status).toBe("degraded");
  });

  test("reports stale when a live source exceeds the age budget", () => {
    const staleAt = new Date(NOW - CRITICAL_DB_SOURCE_STALE_AFTER_MS - 1).toISOString();
    const result = evaluateCriticalDbFreshness({
      sources: {
        "files:observations": source(staleAt),
        "files:brain": source("2026-07-29T23:59:00.000Z"),
        "files:vault": source("2026-07-29T23:59:00.000Z"),
        "files:knowledge": source("2026-07-29T23:59:00.000Z"),
        "archive:memory_observations": source("2026-05-31T00:00:00.000Z"),
      },
      degradedOverride: false,
      nowMs: NOW,
    });

    expect(result.status).toBe("stale");
  });
});
