import { infer } from "../lib/inference";
import { MODEL } from "../lib/models";
import * as typesense from "../lib/typesense";
import { emitOtelEvent } from "./emit";
import { createOtelEvent, type OtelEvent } from "./otel-event";
import { classifyEvent, dedupKey, type TriagePattern } from "./triage-patterns";

const OTEL_COLLECTION = "otel_events";
const OTEL_QUERY_BY = "action,error,component,source,metadata_json,search_text";
const OTEL_PER_PAGE = 200;
const TRIAGE_COMPONENT = "o11y-triage";
const DEFAULT_DEDUP_HOURS = 24;
const CLASSIFIER_TIMEOUT_MS = 30_000;
const UNKNOWN_REASONING = "Unknown failure; defaulting to tier 2.";
const CLASSIFIER_OUTPUT_PREVIEW_CHARS = 500;
const CLASSIFIER_SYSTEM_PROMPT = `You are an observability triage classifier for a personal infrastructure system (JoelClaw).
Given failed OTEL events, classify each event into a severity tier.

Tier 1 (ignore/auto-fix): transient failures, known race conditions, test probes, self-healing issues.
Tier 2 (note for later): novel but non-urgent issues, intermittent failures, performance degradation.
Tier 3 (escalate immediately): sustained failures, data loss risk, pipeline stalls, crashes.

You are in JSON mode. Return ONE bare JSON array and nothing else.
Do not use markdown fences. Do not add preamble or commentary.
Return exactly one array item per input event, in the same order.

Each array item must match this schema:
{"tier":1|2|3,"reasoning":"one sentence","proposed_pattern":{"match":{"component":"...","action":"...","error":"regex"},"tier":1|2|3,"dedup_hours":N}|null}`;

type TriageTier = 1 | 2 | 3;

export type ProposedPattern = {
  match: {
    component?: string;
    action?: string;
    error?: string;
  };
  tier: TriageTier;
  dedup_hours: number;
};

export type ClassifiedEvent = {
  event: OtelEvent;
  tier: TriageTier;
  reasoning: string;
  proposed_pattern: ProposedPattern | null;
};

export type TriageResult = {
  tier1: OtelEvent[];
  tier2: OtelEvent[];
  tier3: OtelEvent[];
  unmatchedTier2: OtelEvent[];
};

type ParsedClassifierOutput = {
  items: unknown[];
  debug: Record<string, unknown>;
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

function escapeTypesenseValue(value: string): string {
  return `\`${value.replace(/[`\\]/gu, "\\$&")}\``;
}

function asTier(value: unknown): TriageTier | null {
  if (value === 1 || value === 2 || value === 3) return value;
  if (typeof value === "string") {
    if (value === "1") return 1;
    if (value === "2") return 2;
    if (value === "3") return 3;
  }
  return null;
}

function normalizeProposedPattern(value: unknown): ProposedPattern | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const tier = asTier(record.tier);
  if (!tier) return null;

  const matchRaw = record.match;
  if (!matchRaw || typeof matchRaw !== "object") return null;
  const matchRecord = matchRaw as Record<string, unknown>;

  const component = typeof matchRecord.component === "string" && matchRecord.component.trim().length > 0
    ? matchRecord.component.trim()
    : undefined;
  const action = typeof matchRecord.action === "string" && matchRecord.action.trim().length > 0
    ? matchRecord.action.trim()
    : undefined;
  const error = typeof matchRecord.error === "string" && matchRecord.error.trim().length > 0
    ? matchRecord.error.trim()
    : undefined;

  if (!component && !action && !error) return null;

  const dedup = asFiniteNumber(record.dedup_hours, DEFAULT_DEDUP_HOURS);
  const dedupHours = Math.max(1, Math.round(dedup));

  return {
    match: {
      component,
      action,
      error,
    },
    tier,
    dedup_hours: dedupHours,
  };
}

function normalizeLLMClassification(
  event: OtelEvent,
  value: unknown
): ClassifiedEvent {
  if (!value || typeof value !== "object") {
    return {
      event,
      tier: 2,
      reasoning: UNKNOWN_REASONING,
      proposed_pattern: null,
    };
  }

  const record = value as Record<string, unknown>;
  const tier = asTier(record.tier) ?? 2;
  const reasoning = typeof record.reasoning === "string" && record.reasoning.trim().length > 0
    ? record.reasoning.trim()
    : UNKNOWN_REASONING;

  return {
    event,
    tier,
    reasoning,
    proposed_pattern: normalizeProposedPattern(record.proposed_pattern),
  };
}

function trimmedPreview(value: string, max = CLASSIFIER_OUTPUT_PREVIEW_CHARS): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

function findBalancedJsonSegment(raw: string, openingChar: "[" | "{"): string | null {
  const closingChar = openingChar === "[" ? "]" : "}";

  for (let start = raw.indexOf(openingChar); start >= 0; start = raw.indexOf(openingChar, start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (!char) continue;

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === openingChar) {
        depth += 1;
        continue;
      }

      if (char === closingChar) {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(start, index + 1);
        }
      }
    }
  }

  return null;
}

function parseJsonCandidate(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function normalizeClassifierItems(parsed: unknown, expectedCount: number): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed.length === expectedCount ? parsed : null;
  }

  if (expectedCount === 1 && parsed && typeof parsed === "object") {
    return [parsed];
  }

  return null;
}

function parseClassificationArray(raw: string, expectedCount: number): ParsedClassifierOutput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const candidates: Array<{ source: string; text: string }> = [
    { source: "raw", text: trimmed },
  ];

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/giu)) {
    const fenced = match[1]?.trim();
    if (fenced) {
      candidates.push({ source: "fence", text: fenced });
    }
  }

  const balancedArray = findBalancedJsonSegment(trimmed, "[");
  if (balancedArray) {
    candidates.push({ source: "balanced_array", text: balancedArray });
  }

  const balancedObject = findBalancedJsonSegment(trimmed, "{");
  if (balancedObject) {
    candidates.push({ source: "balanced_object", text: balancedObject });
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const parsed = parseJsonCandidate(candidate.text);
    if (parsed == null) continue;

    const items = normalizeClassifierItems(parsed, expectedCount);
    if (!items) continue;

    return {
      items,
      debug: {
        parseSource: candidate.source,
        rawLength: trimmed.length,
        expectedCount,
        parsedCount: items.length,
      },
    };
  }

  return null;
}

function classifierDebugMetadata(raw: string, data: unknown, expectedCount: number): Record<string, unknown> {
  const trimmed = raw.trim();
  const dataType = Array.isArray(data) ? "array" : data == null ? "nullish" : typeof data;
  const parsedCount = Array.isArray(data)
    ? data.length
    : expectedCount === 1 && data && typeof data === "object"
      ? 1
      : null;

  return {
    expectedCount,
    rawLength: trimmed.length,
    rawPreview: trimmedPreview(trimmed),
    hasFence: /```/u.test(trimmed),
    hasJsonArray: trimmed.includes("["),
    hasJsonObject: trimmed.includes("{"),
    dataType,
    dataParsedCount: parsedCount,
  };
}

type ComponentContextEvent = {
  timestamp: number;
  level: OtelEvent["level"];
  action: string;
  success: boolean;
  error: string | null;
};

async function recentComponentEvents(
  component: string,
  limit = 5
): Promise<ComponentContextEvent[]> {
  try {
    const response = await typesense.search({
      collection: OTEL_COLLECTION,
      q: "*",
      query_by: OTEL_QUERY_BY,
      per_page: Math.max(limit, 1),
      sort_by: "timestamp:desc",
      include_fields: "timestamp,level,action,success,error",
      filter_by: `component:=${escapeTypesenseValue(component)}`,
    });

    const hits = Array.isArray(response.hits) ? response.hits : [];
    const context: ComponentContextEvent[] = [];
    for (const hit of hits) {
      const document = (hit.document ?? {}) as Record<string, unknown>;
      const successRaw = document.success;
      const success = typeof successRaw === "boolean"
        ? successRaw
        : typeof successRaw === "string"
          ? ["1", "true", "yes"].includes(successRaw.trim().toLowerCase())
          : Boolean(successRaw);

      context.push({
        timestamp: asFiniteNumber(document.timestamp, Date.now()),
        level: typeof document.level === "string" ? document.level as OtelEvent["level"] : "info",
        action: typeof document.action === "string" ? document.action : "unknown",
        success,
        error: typeof document.error === "string" && document.error.trim().length > 0
          ? document.error.trim()
          : null,
      });
    }

    return context.slice(0, limit);
  } catch {
    return [];
  }
}

function fallbackClassifications(
  events: OtelEvent[],
  reasoning: string
): ClassifiedEvent[] {
  return events.map((event) => ({
    event,
    tier: 2,
    reasoning,
    proposed_pattern: null,
  }));
}

function escalateTier(tier: TriageTier): TriageTier {
  if (tier === 1) return 2;
  if (tier === 2) return 3;
  return 3;
}

function tierToLevel(tier: TriageTier): "info" | "warn" | "error" {
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

export async function classifyWithLLM(
  events: OtelEvent[],
  memoryContext = ""
): Promise<ClassifiedEvent[]> {
  if (events.length === 0) return [];

  const fallback = (reason: string) => fallbackClassifications(events, reason);

  try {
    const components = [...new Set(events.map((event) => event.component))];
    const contextEntries = await Promise.all(
      components.map(async (component) => [
        component,
        await recentComponentEvents(component, 5),
      ] as const)
    );
    const contextByComponent = new Map<string, ComponentContextEvent[]>(contextEntries);

    const payload = events.map((event, index) => ({
      index,
      event: {
        id: event.id,
        component: event.component,
        action: event.action,
        error: event.error ?? "operation_failed",
        level: event.level,
        timestamp: new Date(event.timestamp).toISOString(),
      },
      recent_component_events: (contextByComponent.get(event.component) ?? []).map((item) => ({
        timestamp: new Date(item.timestamp).toISOString(),
        action: item.action,
        level: item.level,
        success: item.success,
        error: item.error,
      })),
    }));

    const userPrompt = [
      `Classify ${events.length} failed OTEL events.`,
      `Return one bare JSON array with exactly ${events.length} items, same order as input.`,
      "No markdown fences. No prose. No explanations outside the JSON array.",
      "Each item must match schema: {\"tier\":1|2|3,\"reasoning\":\"one sentence\",\"proposed_pattern\":{\"match\":{\"component\":\"...\",\"action\":\"...\",\"error\":\"regex\"},\"tier\":1|2|3,\"dedup_hours\":N}|null}.",
      memoryContext.trim().length > 0 ? `\n${memoryContext.trim()}` : "",
      "",
      JSON.stringify(payload, null, 2),
    ].join("\n");

    const classifyResult = await infer(userPrompt, {
      task: "classification",
      model: MODEL.HAIKU,
      system: CLASSIFIER_SYSTEM_PROMPT,
      component: TRIAGE_COMPONENT,
      action: "triage.llm_classification",
      print: true,
      noTools: true,
      json: true,
      requireJson: true,
      timeout: CLASSIFIER_TIMEOUT_MS,
      env: { ...process.env, TERM: "dumb" },
      metadata: {
        expectedCount: events.length,
      },
    });

    const directItems = normalizeClassifierItems(classifyResult.data, events.length);
    const parsed = directItems
      ? {
          items: directItems,
          debug: {
            parseSource: "infer.data",
            rawLength: classifyResult.text.length,
            expectedCount: events.length,
            parsedCount: directItems.length,
          },
        }
      : parseClassificationArray(classifyResult.text || "", events.length);

    if (!parsed) {
      const debug = classifierDebugMetadata(
        classifyResult.text || "",
        classifyResult.data,
        events.length,
      );
      const error = new Error("unparseable classifier output");
      (error as Error & { debug?: Record<string, unknown> }).debug = debug;
      throw error;
    }

    const normalized = events.map((event, index) => normalizeLLMClassification(event, parsed.items[index]));

    const tier1Count = normalized.filter((item) => item.tier === 1).length;
    const tier2Count = normalized.filter((item) => item.tier === 2).length;
    const tier3Count = normalized.filter((item) => item.tier === 3).length;
    const proposedPatternCount = normalized.filter((item) => item.proposed_pattern != null).length;

    await emitOtelEvent({
      level: "info",
      source: "worker",
      component: TRIAGE_COMPONENT,
      action: "triage.llm_classified",
      success: true,
      metadata: {
        count: normalized.length,
        tier1: tier1Count,
        tier2: tier2Count,
        tier3: tier3Count,
        proposedPatternCount,
        eventIds: normalized.map((item) => item.event.id),
        parseSource: parsed.debug.parseSource,
      },
    });

    return normalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const debug = error instanceof Error && "debug" in error
      ? (error as Error & { debug?: Record<string, unknown> }).debug
      : undefined;

    await emitOtelEvent({
      level: "warn",
      source: "worker",
      component: TRIAGE_COMPONENT,
      action: "triage.llm_classification_failed",
      success: false,
      error: message,
      metadata: {
        eventCount: events.length,
        fallbackTier: 2,
        eventIds: events.map((event) => event.id),
        ...(debug ? { classifierDebug: debug } : {}),
      },
    });
    return fallback(`LLM classification unavailable; defaulted to tier 2 (${message}).`);
  }
}

export async function triageFailures(events: OtelEvent[]): Promise<TriageResult> {
  const grouped: TriageResult = { tier1: [], tier2: [], tier3: [], unmatchedTier2: [] };
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
    let tier: TriageTier = classified.tier;
    const unmatchedTier2 = classified.tier === 2 && !classified.pattern;

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
    if (tier === 2) {
      grouped.tier2.push(event);
      if (unmatchedTier2) {
        grouped.unmatchedTier2.push(event);
      }
    }
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
        matchedPattern: Boolean(classified.pattern),
        llmCandidate: unmatchedTier2,
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

export const __triageTestUtils = {
  parseClassificationArray,
  normalizeLLMClassification,
};
