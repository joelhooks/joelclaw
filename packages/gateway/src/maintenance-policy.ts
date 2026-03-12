export type IdleGatewayMaintenanceKind = "compact" | "rotate";
export type IdleGatewayMaintenanceReason = "compaction_gap" | "session_age";

export type IdleGatewayMaintenanceDecision = {
  kind: IdleGatewayMaintenanceKind;
  reason: IdleGatewayMaintenanceReason;
};

type IdleGatewayMaintenanceInput = {
  waitingForTurnEnd: boolean;
  maintenanceActive: boolean;
  queueDepth: number;
  promptBudgetMaintenanceActive: boolean;
  sessionPressure: {
    nextAction: string;
    reasons: string[];
  };
};

export function decideIdleGatewayMaintenance(
  input: IdleGatewayMaintenanceInput,
): IdleGatewayMaintenanceDecision | null {
  if (input.waitingForTurnEnd) return null;
  if (input.maintenanceActive) return null;
  if (input.queueDepth > 0) return null;
  if (input.promptBudgetMaintenanceActive) return null;

  const reasons = new Set(input.sessionPressure.reasons);

  if (reasons.has("session_age") && input.sessionPressure.nextAction === "rotate") {
    return {
      kind: "rotate",
      reason: "session_age",
    };
  }

  if (reasons.has("compaction_gap")) {
    return {
      kind: "compact",
      reason: "compaction_gap",
    };
  }

  return null;
}
