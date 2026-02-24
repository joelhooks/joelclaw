export const ACCENT = {
  healthy: 0x22c55e,
  warning: 0xeab308,
  error: 0xef4444,
  info: 0x3b82f6,
  neutral: 0x6b7280,
} as const;

export type AccentToken = keyof typeof ACCENT;

export function accentColor(token: AccentToken): number {
  return ACCENT[token] ?? ACCENT.neutral;
}

export function accentFromScore(score: number): number {
  if (score >= 0.8) return ACCENT.healthy;
  if (score >= 0.5) return ACCENT.warning;
  return ACCENT.error;
}

export function accentFromRunStatus(statuses: readonly string[]): number {
  const lowered = statuses.map((status) => status.toLowerCase());
  if (lowered.some((status) => status.includes("error") || status.includes("fail") || status.includes("down"))) {
    return ACCENT.error;
  }
  if (lowered.some((status) => status.includes("slow") || status.includes("warn") || status.includes("degraded"))) {
    return ACCENT.warning;
  }
  if (lowered.some((status) => status.includes("ok") || status.includes("success") || status.includes("healthy"))) {
    return ACCENT.healthy;
  }
  return ACCENT.neutral;
}
