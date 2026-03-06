import { describe, expect, test } from "bun:test";
import {
  buildSessionPressureSnapshot,
  evaluateSessionPressureAlert,
  getInitialSessionPressureAlertState,
} from "./session-pressure";

describe("buildSessionPressureSnapshot", () => {
  test("returns ok while under thresholds", () => {
    const snapshot = buildSessionPressureSnapshot({
      entries: 12,
      estimatedTokens: 40_000,
      maxTokens: 200_000,
      lastCompactionAtMs: 1_000,
      sessionCreatedAtMs: 1_000,
      compactAtPercent: 65,
      rotateAtPercent: 75,
      maxCompactionGapMs: 4 * 60 * 60 * 1000,
      maxSessionAgeMs: 8 * 60 * 60 * 1000,
      queueDepth: 0,
      activeThreads: 2,
      warmThreads: 1,
      totalThreads: 3,
      consecutivePromptFailures: 0,
      fallbackActive: false,
      fallbackActivationCount: 0,
      nowMs: 2_000,
    });

    expect(snapshot.health).toBe("ok");
    expect(snapshot.nextAction).toBe("observe");
    expect(snapshot.nextThresholdAction).toBe("compact");
    expect(snapshot.nextThresholdSummary).toBe("compact at 65% context or 4h since last compaction");
    expect(snapshot.contextHeadroomToCompactPercent).toBe(45);
    expect(snapshot.contextHeadroomToRotatePercent).toBe(55);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.totalThreads).toBe(3);
  });

  test("elevates when compaction is overdue", () => {
    const snapshot = buildSessionPressureSnapshot({
      entries: 20,
      estimatedTokens: 50_000,
      maxTokens: 200_000,
      lastCompactionAtMs: 0,
      sessionCreatedAtMs: 0,
      compactAtPercent: 65,
      rotateAtPercent: 75,
      maxCompactionGapMs: 1_000,
      maxSessionAgeMs: 10_000,
      queueDepth: 4,
      activeThreads: 1,
      warmThreads: 0,
      totalThreads: 1,
      consecutivePromptFailures: 1,
      fallbackActive: false,
      fallbackActivationCount: 0,
      nowMs: 5_000,
    });

    expect(snapshot.health).toBe("elevated");
    expect(snapshot.nextAction).toBe("compact");
    expect(snapshot.nextThresholdAction).toBe("rotate");
    expect(snapshot.nextThresholdSummary).toBe("rotate at 75% context or 1m session age");
    expect(snapshot.compactionGapRemainingMs).toBe(0);
    expect(snapshot.reasons).toContain("compaction_gap");
  });

  test("goes critical when session age exceeds rotation threshold", () => {
    const snapshot = buildSessionPressureSnapshot({
      entries: 40,
      estimatedTokens: 80_000,
      maxTokens: 200_000,
      lastCompactionAtMs: 0,
      sessionCreatedAtMs: 0,
      compactAtPercent: 65,
      rotateAtPercent: 75,
      maxCompactionGapMs: 10_000,
      maxSessionAgeMs: 5_000,
      queueDepth: 1,
      activeThreads: 3,
      warmThreads: 1,
      totalThreads: 4,
      consecutivePromptFailures: 2,
      fallbackActive: true,
      fallbackActivationCount: 3,
      nowMs: 6_000,
    });

    expect(snapshot.health).toBe("critical");
    expect(snapshot.nextAction).toBe("rotate");
    expect(snapshot.nextThresholdAction).toBe("rotate");
    expect(snapshot.nextThresholdSummary).toBe("rotate immediately");
    expect(snapshot.sessionAgeRemainingMs).toBe(0);
    expect(snapshot.reasons).toContain("session_age");
    expect(snapshot.fallbackActive).toBe(true);
    expect(snapshot.fallbackActivationCount).toBe(3);
  });
});

describe("evaluateSessionPressureAlert", () => {
  test("alerts on first elevated transition", () => {
    const decision = evaluateSessionPressureAlert(
      { health: "elevated" },
      getInitialSessionPressureAlertState(),
      10_000,
      60_000,
    );

    expect(decision.shouldNotify).toBe(true);
    expect(decision.kind).toBe("elevated");
    expect(decision.nextState.lastNotifiedHealth).toBe("elevated");
    expect(decision.nextState.lastNotifiedAt).toBe(10_000);
  });

  test("suppresses repeated elevated alerts inside cooldown", () => {
    const decision = evaluateSessionPressureAlert(
      { health: "elevated" },
      {
        lastNotifiedHealth: "elevated",
        lastNotifiedAt: 10_000,
        lastRecoveredAt: 0,
      },
      20_000,
      60_000,
    );

    expect(decision.shouldNotify).toBe(false);
    expect(decision.kind).toBe("none");
  });

  test("alerts when severity escalates to critical", () => {
    const decision = evaluateSessionPressureAlert(
      { health: "critical" },
      {
        lastNotifiedHealth: "elevated",
        lastNotifiedAt: 10_000,
        lastRecoveredAt: 0,
      },
      20_000,
      60_000,
    );

    expect(decision.shouldNotify).toBe(true);
    expect(decision.kind).toBe("critical");
    expect(decision.nextState.lastNotifiedHealth).toBe("critical");
  });

  test("alerts on recovery back to ok", () => {
    const decision = evaluateSessionPressureAlert(
      { health: "ok" },
      {
        lastNotifiedHealth: "critical",
        lastNotifiedAt: 10_000,
        lastRecoveredAt: 0,
      },
      30_000,
      60_000,
    );

    expect(decision.shouldNotify).toBe(true);
    expect(decision.kind).toBe("recovered");
    expect(decision.nextState.lastNotifiedHealth).toBe("ok");
    expect(decision.nextState.lastRecoveredAt).toBe(30_000);
  });
});
