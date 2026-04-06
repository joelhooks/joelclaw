import { describe, expect, test } from "bun:test";
import {
  getFallbackWatchdogGraceRemainingMs,
  shouldTreatSessionAsDead,
  WATCHDOG_DEAD_SESSION_FAILURE_THRESHOLD,
} from "./watchdog";

describe("gateway watchdog dead-session guard", () => {
  test("does not mark a session dead below the failure threshold", () => {
    expect(shouldTreatSessionAsDead({
      consecutiveFailures: WATCHDOG_DEAD_SESSION_FAILURE_THRESHOLD - 1,
      fallbackActive: false,
    })).toBe(false);
  });

  test("marks a session dead at the threshold when fallback is inactive", () => {
    expect(shouldTreatSessionAsDead({
      consecutiveFailures: WATCHDOG_DEAD_SESSION_FAILURE_THRESHOLD,
      fallbackActive: false,
    })).toBe(true);
  });

  test("suppresses dead-session restart while fallback grace is active", () => {
    expect(shouldTreatSessionAsDead({
      consecutiveFailures: WATCHDOG_DEAD_SESSION_FAILURE_THRESHOLD,
      fallbackActive: true,
      fallbackActiveSince: 10_000,
      now: 40_000,
      fallbackGraceMs: 60_000,
    })).toBe(false);
  });

  test("allows dead-session restart after fallback grace expires", () => {
    expect(shouldTreatSessionAsDead({
      consecutiveFailures: WATCHDOG_DEAD_SESSION_FAILURE_THRESHOLD,
      fallbackActive: true,
      fallbackActiveSince: 10_000,
      now: 80_001,
      fallbackGraceMs: 60_000,
    })).toBe(true);
  });

  test("reports remaining fallback grace time", () => {
    expect(getFallbackWatchdogGraceRemainingMs({
      fallbackActive: true,
      fallbackActiveSince: 25_000,
      now: 40_000,
      fallbackGraceMs: 60_000,
    })).toBe(45_000);
  });
});
