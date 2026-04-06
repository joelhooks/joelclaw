export const WATCHDOG_DEAD_SESSION_FAILURE_THRESHOLD = 3;
export const WATCHDOG_FALLBACK_ACTIVATION_GRACE_MS_DEFAULT = 120_000;

type DeadSessionDecisionInput = {
  consecutiveFailures: number;
  fallbackActive: boolean;
  fallbackActiveSince?: number | null;
  now?: number;
  failureThreshold?: number;
  fallbackGraceMs?: number;
};

export function getFallbackWatchdogGraceRemainingMs(
  input: Pick<DeadSessionDecisionInput, "fallbackActive" | "fallbackActiveSince" | "now" | "fallbackGraceMs">,
): number {
  if (!input.fallbackActive) return 0;
  const activeSince = typeof input.fallbackActiveSince === "number" ? input.fallbackActiveSince : 0;
  if (activeSince <= 0) return input.fallbackGraceMs ?? WATCHDOG_FALLBACK_ACTIVATION_GRACE_MS_DEFAULT;

  const now = input.now ?? Date.now();
  const graceMs = input.fallbackGraceMs ?? WATCHDOG_FALLBACK_ACTIVATION_GRACE_MS_DEFAULT;
  return Math.max(0, graceMs - Math.max(0, now - activeSince));
}

export function shouldTreatSessionAsDead(input: DeadSessionDecisionInput): boolean {
  const failureThreshold = input.failureThreshold ?? WATCHDOG_DEAD_SESSION_FAILURE_THRESHOLD;
  if (input.consecutiveFailures < failureThreshold) return false;

  const graceRemainingMs = getFallbackWatchdogGraceRemainingMs(input);
  if (input.fallbackActive && graceRemainingMs > 0) return false;

  return true;
}
