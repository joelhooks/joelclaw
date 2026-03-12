import { describe, expect, test } from "bun:test";
import { decideIdleGatewayMaintenance } from "./maintenance-policy";

describe("decideIdleGatewayMaintenance", () => {
  test("rotates an idle session when session age crossed the threshold", () => {
    const decision = decideIdleGatewayMaintenance({
      waitingForTurnEnd: false,
      maintenanceActive: false,
      queueDepth: 0,
      promptBudgetMaintenanceActive: false,
      sessionPressure: {
        nextAction: "rotate",
        reasons: ["session_age", "compaction_gap"],
      },
    });

    expect(decision).toEqual({
      kind: "rotate",
      reason: "session_age",
    });
  });

  test("compacts an idle session when compaction is overdue", () => {
    const decision = decideIdleGatewayMaintenance({
      waitingForTurnEnd: false,
      maintenanceActive: false,
      queueDepth: 0,
      promptBudgetMaintenanceActive: false,
      sessionPressure: {
        nextAction: "compact",
        reasons: ["compaction_gap"],
      },
    });

    expect(decision).toEqual({
      kind: "compact",
      reason: "compaction_gap",
    });
  });

  test("does not fire while a turn is still active", () => {
    const decision = decideIdleGatewayMaintenance({
      waitingForTurnEnd: true,
      maintenanceActive: false,
      queueDepth: 0,
      promptBudgetMaintenanceActive: false,
      sessionPressure: {
        nextAction: "rotate",
        reasons: ["session_age"],
      },
    });

    expect(decision).toBeNull();
  });

  test("does not fire while queued work is waiting", () => {
    const decision = decideIdleGatewayMaintenance({
      waitingForTurnEnd: false,
      maintenanceActive: false,
      queueDepth: 2,
      promptBudgetMaintenanceActive: false,
      sessionPressure: {
        nextAction: "compact",
        reasons: ["compaction_gap"],
      },
    });

    expect(decision).toBeNull();
  });

  test("ignores non-time-based pressure that should be handled on turn paths", () => {
    const decision = decideIdleGatewayMaintenance({
      waitingForTurnEnd: false,
      maintenanceActive: false,
      queueDepth: 0,
      promptBudgetMaintenanceActive: false,
      sessionPressure: {
        nextAction: "rotate",
        reasons: ["context_ceiling"],
      },
    });

    expect(decision).toBeNull();
  });
});
