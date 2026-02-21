import * as typesense from "../lib/typesense";
import { emitOtelEvent } from "./emit";
import { createOtelEvent, type OtelEvent } from "./otel-event";
import { classifyEvent, dedupKey, type TriagePattern } from "./triage-patterns";

const OTEL_COLLECTION = "otel_events";
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const OTEL_PER_PAGE = 200;
const TRIAGE_COMPONENT = "o11y-triage";
const DEFAULT_DEDUP_HOURS = 24;

export type TriageResult = {
  tier1: OtelEvent[];
  tier2: OtelEvent[];
  tier3: OtelEvent[];
};

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseMetadataJson(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string" || input.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asOtelEvent(document: Record<string, unknown>): OtelEvent | null {
  const successRaw = document.success;
  const success = typeof successRaw === "boolean"
    ? successRaw
    : typeof successRaw === "string"
      ? ["1", "true", "yes"].includes(successRaw.trim().toLowerCase())
      : Boolean(successRaw);
  const duration = asFiniteNumber(document.duration_ms, Number.NaN);

  try {
    return createOtelEvent({
      id: typeof document.id === "string" ? document.id : undefined,
      timestamp: asFiniteNumber(document.timestamp, Date.now()),
      level: typeof document.level === "string" ? document.level as OtelEvent["level"] : "info",
      source: typeof document.source === "string" ? document.source : "unknown",
      component: typeof document.component === "string" ? document.component : "unknown",
      action: typeof document.action === "string" ? document.action : "unknown",
      success,
      error: typeof document.error === "string" ? document.error : undefined,
      duration_ms: Number.isFinite(duration) ? duration : undefined,
      metadata: parseMetadataJson(document.metadata_json),
    });
  } catch {
    return null;
  }
}

function serializePattern(pattern?: TriagePattern): Record<string, unknown> | null {
  if (!pattern) return null;
  return {
    tier: pattern.tier,
    handler: pattern.handler ?? null,
    dedup_hours: pattern.dedup_hours,
    escalate_after: pattern.escalate_after ?? null,
    match: {
      component: pattern.match.component ?? null,
      action: pattern.match.action ?? null,
      level: pattern.match.level ?? null,
      error: pattern.match.error ? String(pattern.match.error) : null,
    },
  };
}

function escalateTier(tier: 1 | 2 | 3): 1 | 2 | 3 {
  if (tier === 1) return 2;
  if (tier === 2) return 3;
  return 3;
}

function tierToLevel(tier: 1 | 2 | 3): "info" | "warn" | "error" {
  if (tier === 1) return "info";
  if (tier === 2) return "warn";
  return "error";
}

async function hasRecentTriageEvent(key: string, dedupHours: number): Promise<boolean> {
  const cutoff = Date.now() - dedupHours * 60 * 60 * 1000;
  const result = await typesense.search({
    collection: OTEL_COLLECTION,
    q: key,
    query_by: OTEL_QUERY_BY,
    per_page: 1,
    include_fields: "id",
    filter_by: `timestamp:>=${Math.floor(cutoff)} && component:=${TRIAGE_COMPONENT} && action:=triage.classified`,
  });
  return (result.found ?? 0) > 0;
}

export async function scanRecentFailures(windowMinutes: number): Promise<OtelEvent[]> {
  const cutoff = Date.now() - Math.max(windowMinutes, 1) * 60 * 1000;
  const events: OtelEvent[] = [];
  let page = 1;

  for (;;) {
    const response = await typesense.search({
      collection: OTEL_COLLECTION,
      q: "*",
      query_by: OTEL_QUERY_BY,
      per_page: OTEL_PER_PAGE,
      page,
      sort_by: "timestamp:desc",
      include_fields: "id,timestamp,level,source,component,action,success,error,duration_ms,metadata_json",
      filter_by: `timestamp:>=${Math.floor(cutoff)} && success:=false`,
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];
    for (const hit of hits) {
      const document = (hit.document ?? {}) as Record<string, unknown>;
      const event = asOtelEvent(document);
      if (event && event.success === false) {
        events.push(event);
      }
    }

    if (hits.length < OTEL_PER_PAGE) break;
    page += 1;
  }

  return events;
}

export async function triageFailures(events: OtelEvent[]): Promise<TriageResult> {
  const grouped: TriageResult = { tier1: [], tier2: [], tier3: [] };
  if (events.length === 0) {
    return grouped;
  }

  const occurrenceCountByKey = new Map<string, number>();
  for (const event of events) {
    const key = dedupKey(event);
    occurrenceCountByKey.set(key, (occurrenceCountByKey.get(key) ?? 0) + 1);
  }

  const seenThisRun = new Set<string>();
  const dedupHistory = new Map<string, boolean>();

  for (const event of events) {
    const key = dedupKey(event);
    const classified = classifyEvent(event);
    let tier: 1 | 2 | 3 = classified.tier;

    if (
      classified.pattern?.escalate_after &&
      (occurrenceCountByKey.get(key) ?? 0) >= classified.pattern.escalate_after
    ) {
      tier = escalateTier(tier);
    }

    const dedupHours = classified.pattern?.dedup_hours ?? DEFAULT_DEDUP_HOURS;
    const dedupCacheKey = `${key}:${dedupHours}`;
    let alreadyTriaged = dedupHistory.get(dedupCacheKey);
    if (alreadyTriaged == null) {
      try {
        alreadyTriaged = await hasRecentTriageEvent(key, dedupHours);
      } catch {
        alreadyTriaged = false;
      }
      dedupHistory.set(dedupCacheKey, alreadyTriaged);
    }

    if (alreadyTriaged || seenThisRun.has(key)) {
      continue;
    }
    seenThisRun.add(key);

    if (tier === 1) grouped.tier1.push(event);
    if (tier === 2) grouped.tier2.push(event);
    if (tier === 3) grouped.tier3.push(event);

    await emitOtelEvent({
      level: tierToLevel(tier),
      source: "worker",
      component: TRIAGE_COMPONENT,
      action: "triage.classified",
      success: true,
      metadata: {
        dedupKey: key,
        tier,
        dedupHours,
        occurrenceCount: occurrenceCountByKey.get(key) ?? 1,
        pattern: serializePattern(classified.pattern),
        event: {
          id: event.id,
          timestamp: event.timestamp,
          source: event.source,
          component: event.component,
          action: event.action,
          level: event.level,
          error: event.error ?? null,
        },
      },
    });
  }

  return grouped;
}
