export const CRITICAL_DB_REQUIRED_SOURCES = [
  "files:observations",
  "files:brain",
  "files:vault",
  "files:knowledge",
  "archive:memory_observations",
] as const;

export const CRITICAL_DB_SOURCE_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;

export type CriticalDbRequiredSource = (typeof CRITICAL_DB_REQUIRED_SOURCES)[number];

export type CriticalDbSourceMetadata = {
  status: string;
  highWaterAt?: string | null;
};

export type EvaluatedCriticalDbSource<T extends CriticalDbSourceMetadata> = T & {
  ageMs: number | null;
  freshness: string;
};

export type CriticalDbPortStatus = "ok" | "stale" | "degraded";

export function evaluateCriticalDbFreshness<T extends CriticalDbSourceMetadata>(input: {
  sources: Record<string, T>;
  degradedOverride: boolean;
  nowMs: number;
  sourceStaleAfterMs?: number;
  ageResolutionMs?: number;
  zeroTimestampIsMissing?: boolean;
}): {
  sources: Record<string, EvaluatedCriticalDbSource<T>>;
  status: CriticalDbPortStatus;
} {
  const sourceStaleAfterMs = input.sourceStaleAfterMs ?? CRITICAL_DB_SOURCE_STALE_AFTER_MS;
  const ageResolutionMs = input.ageResolutionMs ?? 1;
  const now = Math.floor(input.nowMs / ageResolutionMs) * ageResolutionMs;
  const sources = Object.fromEntries(
    Object.entries(input.sources).map(([key, source]) => {
      const parsed = source.highWaterAt ? Date.parse(source.highWaterAt) : Number.NaN;
      const highWater = Number.isFinite(parsed) && !(input.zeroTimestampIsMissing && parsed === 0)
        ? Math.floor(parsed / ageResolutionMs) * ageResolutionMs
        : null;
      const ageMs = highWater === null ? null : Math.max(0, now - highWater);
      const freshness = source.status !== "ok"
        ? source.status
        : ageMs !== null && ageMs > sourceStaleAfterMs
          ? "stale"
          : "fresh";
      return [key, { ...source, ageMs, freshness }];
    }),
  ) as Record<string, EvaluatedCriticalDbSource<T>>;
  const required = CRITICAL_DB_REQUIRED_SOURCES.map((source) => sources[source]);
  const status = input.degradedOverride || required.some((source) => !source || source.status !== "ok")
    ? "degraded"
    : required.some((source) => source.freshness === "stale")
      ? "stale"
      : "ok";
  return { sources, status };
}
