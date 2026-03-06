export type SessionPressureHealth = "ok" | "elevated" | "critical";
export type SessionPressureAction = "observe" | "compact" | "rotate";
export type SessionPressureThresholdAction = "compact" | "rotate";
export type SessionPressureReason = "context_usage" | "context_ceiling" | "compaction_gap" | "session_age";

export type SessionPressureAlertState = {
  lastNotifiedHealth: SessionPressureHealth;
  lastNotifiedAt: number;
  lastRecoveredAt: number;
};

export type SessionPressureAlertDecision = {
  shouldNotify: boolean;
  kind: SessionPressureHealth | "recovered" | "none";
  nextState: SessionPressureAlertState;
};

export type SessionPressureSnapshot = {
  entries: number;
  estimatedTokens: number;
  usagePercent: number;
  maxTokens: number;
  lastCompactionAt: string;
  lastCompactionAgeMs: number;
  sessionAgeMs: number;
  compactAtPercent: number;
  rotateAtPercent: number;
  maxCompactionGapMs: number;
  maxSessionAgeMs: number;
  contextHeadroomToCompactPercent: number;
  contextHeadroomToRotatePercent: number;
  compactionGapRemainingMs: number;
  sessionAgeRemainingMs: number;
  health: SessionPressureHealth;
  nextAction: SessionPressureAction;
  nextThresholdAction: SessionPressureThresholdAction;
  nextThresholdSummary: string;
  reasons: SessionPressureReason[];
  queueDepth: number;
  activeThreads: number;
  warmThreads: number;
  totalThreads: number;
  consecutivePromptFailures: number;
  fallbackActive: boolean;
  fallbackActivationCount: number;
};

function formatThresholdDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round((minutes / 60) * 10) / 10}h`;
}

export function getInitialSessionPressureAlertState(): SessionPressureAlertState {
  return {
    lastNotifiedHealth: "ok",
    lastNotifiedAt: 0,
    lastRecoveredAt: 0,
  };
}

export function buildSessionPressureSnapshot(input: {
  entries: number;
  estimatedTokens: number;
  maxTokens: number;
  lastCompactionAtMs: number;
  sessionCreatedAtMs: number;
  compactAtPercent: number;
  rotateAtPercent: number;
  maxCompactionGapMs: number;
  maxSessionAgeMs: number;
  queueDepth: number;
  activeThreads: number;
  warmThreads: number;
  totalThreads: number;
  consecutivePromptFailures: number;
  fallbackActive: boolean;
  fallbackActivationCount: number;
  nowMs?: number;
}): SessionPressureSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const usagePercent = input.maxTokens > 0
    ? Math.round((input.estimatedTokens / input.maxTokens) * 100)
    : 0;
  const lastCompactionAgeMs = Math.max(0, nowMs - input.lastCompactionAtMs);
  const sessionAgeMs = Math.max(0, nowMs - input.sessionCreatedAtMs);
  const contextHeadroomToCompactPercent = Math.max(0, input.compactAtPercent - usagePercent);
  const contextHeadroomToRotatePercent = Math.max(0, input.rotateAtPercent - usagePercent);
  const compactionGapRemainingMs = Math.max(0, input.maxCompactionGapMs - lastCompactionAgeMs);
  const sessionAgeRemainingMs = Math.max(0, input.maxSessionAgeMs - sessionAgeMs);

  const reasons: SessionPressureReason[] = [];
  if (usagePercent >= input.rotateAtPercent) {
    reasons.push("context_ceiling");
  } else if (usagePercent >= input.compactAtPercent) {
    reasons.push("context_usage");
  }
  if (lastCompactionAgeMs > input.maxCompactionGapMs) {
    reasons.push("compaction_gap");
  }
  if (sessionAgeMs > input.maxSessionAgeMs) {
    reasons.push("session_age");
  }

  const nextAction = usagePercent >= input.rotateAtPercent || sessionAgeMs > input.maxSessionAgeMs
    ? "rotate"
    : usagePercent >= input.compactAtPercent || lastCompactionAgeMs > input.maxCompactionGapMs
      ? "compact"
      : "observe";

  const health: SessionPressureHealth = nextAction === "rotate"
    ? "critical"
    : nextAction === "compact"
      ? "elevated"
      : "ok";

  const nextThresholdAction: SessionPressureThresholdAction = health === "ok" ? "compact" : "rotate";
  const nextThresholdSummary = nextAction === "rotate"
    ? "rotate immediately"
    : health === "elevated"
      ? `rotate at ${input.rotateAtPercent}% context or ${formatThresholdDuration(input.maxSessionAgeMs)} session age`
      : `compact at ${input.compactAtPercent}% context or ${formatThresholdDuration(input.maxCompactionGapMs)} since last compaction`;

  return {
    entries: input.entries,
    estimatedTokens: input.estimatedTokens,
    usagePercent,
    maxTokens: input.maxTokens,
    lastCompactionAt: new Date(input.lastCompactionAtMs).toISOString(),
    lastCompactionAgeMs,
    sessionAgeMs,
    compactAtPercent: input.compactAtPercent,
    rotateAtPercent: input.rotateAtPercent,
    maxCompactionGapMs: input.maxCompactionGapMs,
    maxSessionAgeMs: input.maxSessionAgeMs,
    contextHeadroomToCompactPercent,
    contextHeadroomToRotatePercent,
    compactionGapRemainingMs,
    sessionAgeRemainingMs,
    health,
    nextAction,
    nextThresholdAction,
    nextThresholdSummary,
    reasons,
    queueDepth: input.queueDepth,
    activeThreads: input.activeThreads,
    warmThreads: input.warmThreads,
    totalThreads: input.totalThreads,
    consecutivePromptFailures: input.consecutivePromptFailures,
    fallbackActive: input.fallbackActive,
    fallbackActivationCount: input.fallbackActivationCount,
  };
}

export function evaluateSessionPressureAlert(
  snapshot: Pick<SessionPressureSnapshot, "health">,
  state: SessionPressureAlertState,
  nowMs: number,
  cooldownMs: number,
): SessionPressureAlertDecision {
  const severity = (health: SessionPressureHealth): number => {
    switch (health) {
      case "critical":
        return 2;
      case "elevated":
        return 1;
      default:
        return 0;
    }
  };

  if (snapshot.health === "ok") {
    if (state.lastNotifiedHealth !== "ok") {
      return {
        shouldNotify: true,
        kind: "recovered",
        nextState: {
          ...state,
          lastNotifiedHealth: "ok",
          lastRecoveredAt: nowMs,
        },
      };
    }

    return {
      shouldNotify: false,
      kind: "none",
      nextState: state,
    };
  }

  const firstNonOk = state.lastNotifiedHealth === "ok";
  const escalated = severity(snapshot.health) > severity(state.lastNotifiedHealth);
  const cooledDown = nowMs - state.lastNotifiedAt >= cooldownMs;

  if (firstNonOk || escalated || cooledDown) {
    return {
      shouldNotify: true,
      kind: snapshot.health,
      nextState: {
        ...state,
        lastNotifiedHealth: snapshot.health,
        lastNotifiedAt: nowMs,
      },
    };
  }

  return {
    shouldNotify: false,
    kind: "none",
    nextState: state,
  };
}
