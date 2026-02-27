import { anyApi, type FunctionReference } from "convex/server";
import { getConvexClient, pushContentResource } from "../lib/convex";
import * as typesense from "../lib/typesense";
import { isHighSeverity, type OtelEvent } from "./otel-event";

const OTEL_COLLECTION = "otel_events";
const OTEL_EVENTS_ENABLED_DEFAULT = true;
const OTEL_CONVEX_WINDOW_HOURS_DEFAULT = 0.5; // 30 minutes for live dashboard watch window
const DEBUG_WINDOW_MS = 60_000;
const DEBUG_MAX_EVENTS_PER_KEY = 12;
const CONVEX_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const MEMORY_OBSERVATIONS_COLLECTION = "memory_observations";
const MEMORY_OBSERVATIONS_VECTOR_FIELD = "embedding";
const MEMORY_OBSERVATIONS_VECTOR_MODEL = "ts/all-MiniLM-L12-v2";
const MEMORY_OBSERVATIONS_VECTOR_DIMENSION = 384;
const VECTOR_MODEL_DIMENSIONS: Record<string, number> = {
  [MEMORY_OBSERVATIONS_VECTOR_MODEL]: MEMORY_OBSERVATIONS_VECTOR_DIMENSION,
};

type ConvexResourceDoc = {
  resourceId: string;
  fields?: Record<string, unknown>;
  updatedAt?: number;
};

export type OtelStoreResult = {
  stored: boolean;
  eventId: string;
  dropped?: boolean;
  dropReason?: string;
  typesense: {
    written: boolean;
    error?: string;
  };
  convex: {
    written: boolean;
    pruned: number;
    skipped?: boolean;
    error?: string;
  };
  sentry: {
    written: boolean;
    skipped: boolean;
    error?: string;
  };
};

type OtelStoreDeps = {
  ensureCollection: (collection: string, schema: Record<string, unknown>) => Promise<void>;
  upsert: (collection: string, doc: Record<string, unknown>) => Promise<void>;
  pushContentResource: (
    resourceId: string,
    type: string,
    fields: Record<string, unknown>,
    searchText?: string
  ) => Promise<void>;
  listContentResourcesByType: (type: string, limit: number) => Promise<ConvexResourceDoc[]>;
  removeContentResource: (resourceId: string) => Promise<void>;
  postSentry: (event: OtelEvent) => Promise<{ written: boolean; skipped: boolean; error?: string }>;
};

const defaultDeps: OtelStoreDeps = {
  ensureCollection: (collection, schema) => typesense.ensureCollection(collection, schema),
  upsert: (collection, doc) => typesense.upsert(collection, doc),
  pushContentResource: (resourceId, type, fields, searchText) =>
    pushContentResource(resourceId, type, fields, searchText),
  listContentResourcesByType: async (type, limit) => {
    const client = getConvexClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = (anyApi as any).contentResources.listByType as FunctionReference<"query">;
    const docs = await client.query(ref, { type, limit });
    return Array.isArray(docs) ? (docs as ConvexResourceDoc[]) : [];
  },
  removeContentResource: async (resourceId) => {
    const client = getConvexClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = (anyApi as any).contentResources.remove as FunctionReference<"mutation">;
    await client.mutation(ref, { resourceId });
  },
  postSentry: (event) => postSentryStoreEvent(event),
};

type DebugBudgetState = { windowStartMs: number; count: number; dropped: number };
type TypesenseCollectionField = {
  name?: unknown;
  type?: unknown;
  num_dim?: unknown;
  embed?: {
    model_config?: {
      model_name?: unknown;
    };
  };
};
type TypesenseCollectionSchema = {
  fields?: unknown;
};

const debugBudgetByKey = new Map<string, DebugBudgetState>();
let collectionReady = false;
let collectionReadyPromise: Promise<void> | null = null;
let memoryObservationSchemaChecked = false;
let memoryObservationSchemaPromise: Promise<void> | null = null;
let lastConvexPruneAt = 0;

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getOtelEventsEnabled(): boolean {
  return parseBooleanFlag(process.env.OTEL_EVENTS_ENABLED, OTEL_EVENTS_ENABLED_DEFAULT);
}

function getConvexWindowHours(): number {
  return parsePositiveNumber(process.env.OTEL_EVENTS_CONVEX_WINDOW_HOURS, OTEL_CONVEX_WINDOW_HOURS_DEFAULT);
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function inferVectorDimension(field: TypesenseCollectionField): number | undefined {
  const explicitDimension = asFiniteNumber(field.num_dim);
  if (typeof explicitDimension === "number") return explicitDimension;

  const modelName = asTrimmedString(field.embed?.model_config?.model_name);
  if (!modelName) return undefined;
  return VECTOR_MODEL_DIMENSIONS[modelName];
}

function formatVectorFieldSummary(field: TypesenseCollectionField): {
  name: string;
  type: string;
  dimension: number | "unknown";
  model: string;
} {
  return {
    name: asTrimmedString(field.name) ?? "unknown",
    type: asTrimmedString(field.type) ?? "unknown",
    dimension: inferVectorDimension(field) ?? "unknown",
    model: asTrimmedString(field.embed?.model_config?.model_name) ?? "unknown",
  };
}

async function validateMemoryObservationSchema(): Promise<void> {
  const response = await typesense.typesenseRequest(`/collections/${MEMORY_OBSERVATIONS_COLLECTION}`, {
    method: "GET",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Typesense collection schema check failed (${response.status}) for ${MEMORY_OBSERVATIONS_COLLECTION}: ${body}`
    );
  }

  const schema = (await response.json()) as TypesenseCollectionSchema;
  const fields = Array.isArray(schema.fields) ? (schema.fields as TypesenseCollectionField[]) : [];
  const expectedField = fields.find(
    (field) => asTrimmedString(field.name) === MEMORY_OBSERVATIONS_VECTOR_FIELD
  );
  const availableVectorFields = fields
    .filter((field) => asTrimmedString(field.type) === "float[]")
    .map((field) => formatVectorFieldSummary(field));

  const actualFieldSummary = expectedField
    ? formatVectorFieldSummary(expectedField)
    : {
      name: availableVectorFields[0]?.name ?? "missing",
      type: availableVectorFields[0]?.type ?? "missing",
      dimension: availableVectorFields[0]?.dimension ?? "unknown",
      model: availableVectorFields[0]?.model ?? "unknown",
    };

  const hasField = !!expectedField;
  const hasVectorType = expectedField && asTrimmedString(expectedField.type) === "float[]";
  const actualDimension = expectedField ? inferVectorDimension(expectedField) : undefined;
  const hasExpectedDimension = typeof actualDimension === "number" &&
    actualDimension === MEMORY_OBSERVATIONS_VECTOR_DIMENSION;

  if (!hasField || !hasVectorType || !hasExpectedDimension) {
    const mismatchReasons: string[] = [];
    if (!hasField) mismatchReasons.push("expected_vector_field_missing");
    if (hasField && !hasVectorType) mismatchReasons.push("expected_vector_field_wrong_type");
    if (hasField && !hasExpectedDimension) mismatchReasons.push("expected_vector_dimension_mismatch");

    console.error("[observe] memory_observations Typesense vector schema mismatch", {
      collection: MEMORY_OBSERVATIONS_COLLECTION,
      expectedVectorField: MEMORY_OBSERVATIONS_VECTOR_FIELD,
      expectedVectorDimension: MEMORY_OBSERVATIONS_VECTOR_DIMENSION,
      expectedModel: MEMORY_OBSERVATIONS_VECTOR_MODEL,
      actualVectorField: actualFieldSummary.name,
      actualVectorType: actualFieldSummary.type,
      actualVectorDimension: actualFieldSummary.dimension,
      actualModel: actualFieldSummary.model,
      availableVectorFields,
      mismatchReasons,
    });

    throw new Error(
      `memory_observations vector schema mismatch (expected ${MEMORY_OBSERVATIONS_VECTOR_FIELD}/${MEMORY_OBSERVATIONS_VECTOR_DIMENSION}, actual ${actualFieldSummary.name}/${actualFieldSummary.dimension})`
    );
  }
}

async function ensureMemoryObservationSchemaChecked(): Promise<void> {
  if (memoryObservationSchemaChecked) return;
  if (memoryObservationSchemaPromise) return memoryObservationSchemaPromise;

  memoryObservationSchemaPromise = validateMemoryObservationSchema()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[observe] memory_observations schema validation failed at worker startup", {
        error: message,
        collection: MEMORY_OBSERVATIONS_COLLECTION,
      });
    })
    .finally(() => {
      memoryObservationSchemaChecked = true;
      memoryObservationSchemaPromise = null;
    });

  return memoryObservationSchemaPromise;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function shouldDropDebugEvent(event: OtelEvent): { dropped: boolean; reason?: string } {
  if (event.level !== "debug") return { dropped: false };

  const now = Date.now();
  const key = `${event.source}:${event.component}:${event.action}`;
  const prev = debugBudgetByKey.get(key);
  if (!prev || now - prev.windowStartMs >= DEBUG_WINDOW_MS) {
    debugBudgetByKey.set(key, { windowStartMs: now, count: 1, dropped: 0 });
    return { dropped: false };
  }

  if (prev.count < DEBUG_MAX_EVENTS_PER_KEY) {
    prev.count += 1;
    return { dropped: false };
  }

  prev.dropped += 1;
  if (prev.dropped === 1 || prev.dropped % 25 === 0) {
    console.warn("[otel] debug event dropped by backpressure guard", {
      source: event.source,
      component: event.component,
      action: event.action,
      droppedInWindow: prev.dropped,
      windowMs: DEBUG_WINDOW_MS,
    });
  }
  return { dropped: true, reason: "debug_backpressure_guard" };
}

function buildOtelCollectionSchema(): Record<string, unknown> {
  return {
    name: OTEL_COLLECTION,
    fields: [
      { name: "id", type: "string" },
      { name: "timestamp", type: "int64" },
      { name: "date", type: "string" },
      { name: "level", type: "string", facet: true },
      { name: "source", type: "string", facet: true },
      { name: "component", type: "string", facet: true },
      { name: "action", type: "string" },
      { name: "success", type: "bool", facet: true },
      { name: "duration_ms", type: "int32", optional: true },
      { name: "error", type: "string", optional: true },
      { name: "metadata_json", type: "string", optional: true },
      { name: "metadata_keys", type: "string[]", facet: true, optional: true },
      { name: "search_text", type: "string" },
    ],
    default_sorting_field: "timestamp",
  };
}

async function ensureOtelCollection(deps: OtelStoreDeps): Promise<void> {
  if (collectionReady) return;
  if (collectionReadyPromise) return collectionReadyPromise;

  collectionReadyPromise = deps
    .ensureCollection(OTEL_COLLECTION, buildOtelCollectionSchema())
    .then(() => {
      collectionReady = true;
    })
    .finally(() => {
      collectionReadyPromise = null;
    });

  return collectionReadyPromise;
}

function toTypesenseDoc(event: OtelEvent): Record<string, unknown> {
  const metadataJson = safeJson(event.metadata);
  const searchText = [event.source, event.component, event.action, event.error, metadataJson]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ");

  return {
    id: event.id,
    timestamp: event.timestamp,
    date: new Date(event.timestamp).toISOString(),
    level: event.level,
    source: event.source,
    component: event.component,
    action: event.action,
    success: event.success,
    duration_ms: event.duration_ms,
    error: event.error,
    metadata_json: metadataJson,
    metadata_keys: Object.keys(event.metadata),
    search_text: searchText,
  };
}

async function pruneConvexOtelWindow(deps: OtelStoreDeps, cutoffMs: number): Promise<number> {
  const now = Date.now();
  if (now - lastConvexPruneAt < CONVEX_PRUNE_INTERVAL_MS) {
    return 0;
  }
  lastConvexPruneAt = now;

  const docs = await deps.listContentResourcesByType("otel_event", 600);
  if (docs.length === 0) return 0;

  const stale = docs.filter((doc) => {
    const nestedEvent =
      doc.fields && typeof doc.fields === "object"
        ? (doc.fields.event as Record<string, unknown> | undefined)
        : undefined;
    const nestedTimestamp =
      nestedEvent && typeof nestedEvent.timestamp === "number"
        ? nestedEvent.timestamp
        : undefined;
    const timestamp =
      typeof doc.fields?.timestamp === "number"
        ? doc.fields.timestamp
        : typeof nestedTimestamp === "number"
          ? nestedTimestamp
          : doc.updatedAt;
    return typeof timestamp === "number" && timestamp < cutoffMs;
  });

  if (stale.length === 0) return 0;

  await Promise.allSettled(stale.map((doc) => deps.removeContentResource(doc.resourceId)));
  return stale.length;
}

function toConvexSearchText(event: OtelEvent): string {
  return [event.level, event.source, event.component, event.action, event.error, safeJson(event.metadata)]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ");
}

function isConvexEventInWindow(event: OtelEvent, windowHours: number): boolean {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  return event.timestamp >= cutoff;
}

function sanitizeSentryId(id: string): string {
  return id.replace(/-/g, "").slice(0, 32);
}

function parseSentryDsn(dsn: string): { endpoint: string; key: string } | null {
  try {
    const parsed = new URL(dsn);
    const key = parsed.username;
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const projectId = pathParts.pop();
    if (!key || !projectId) return null;
    const prefix = pathParts.length > 0 ? `/${pathParts.join("/")}` : "";
    return {
      endpoint: `${parsed.protocol}//${parsed.host}${prefix}/api/${projectId}/store/`,
      key,
    };
  } catch {
    return null;
  }
}

async function postSentryStoreEvent(
  event: OtelEvent
): Promise<{ written: boolean; skipped: boolean; error?: string }> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return { written: false, skipped: true };

  // Sentry is secondary; keep volume low by forwarding warn/error/fatal only.
  if (!isHighSeverity(event.level)) {
    return { written: false, skipped: true };
  }

  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    return { written: false, skipped: true, error: "invalid_sentry_dsn" };
  }

  const body = {
    event_id: sanitizeSentryId(event.id),
    timestamp: event.timestamp / 1000,
    level: event.level === "fatal" ? "fatal" : event.level,
    message: `${event.component}.${event.action}`,
    logger: "joelclaw.otel",
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    tags: {
      source: event.source,
      component: event.component,
      action: event.action,
      success: String(event.success),
    },
    extra: {
      error: event.error,
      duration_ms: event.duration_ms,
      metadata: event.metadata,
    },
  };

  try {
    const resp = await fetch(parsed.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=joelclaw-otel/1.0, sentry_key=${parsed.key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_500),
    });
    if (!resp.ok) {
      return { written: false, skipped: false, error: `sentry_http_${resp.status}` };
    }
    return { written: true, skipped: false };
  } catch (error) {
    return { written: false, skipped: false, error: String(error) };
  }
}

export async function storeOtelEvent(
  event: OtelEvent,
  deps: OtelStoreDeps = defaultDeps
): Promise<OtelStoreResult> {
  if (!getOtelEventsEnabled()) {
    return {
      stored: false,
      eventId: event.id,
      dropped: true,
      dropReason: "otel_events_disabled",
      typesense: { written: false },
      convex: { written: false, pruned: 0, skipped: true },
      sentry: { written: false, skipped: true },
    };
  }

  const dropState = shouldDropDebugEvent(event);
  if (dropState.dropped) {
    return {
      stored: false,
      eventId: event.id,
      dropped: true,
      dropReason: dropState.reason,
      typesense: { written: false },
      convex: { written: false, pruned: 0, skipped: true },
      sentry: { written: false, skipped: true },
    };
  }

  await ensureMemoryObservationSchemaChecked();

  let typesenseError: string | undefined;
  try {
    await ensureOtelCollection(deps);
    await deps.upsert(OTEL_COLLECTION, toTypesenseDoc(event));
  } catch (error) {
    typesenseError = String(error);
  }

  const convexWindowHours = getConvexWindowHours();
  const shouldWriteToConvex = isHighSeverity(event.level) && isConvexEventInWindow(event, convexWindowHours);
  let convexError: string | undefined;
  let convexPruned = 0;

  if (shouldWriteToConvex) {
    try {
      await deps.pushContentResource(
        `otel:${event.id}`,
        "otel_event",
        {
          ...event,
          receivedAt: Date.now(),
        },
        toConvexSearchText(event)
      );
      const cutoff = Date.now() - convexWindowHours * 60 * 60 * 1000;
      convexPruned = await pruneConvexOtelWindow(deps, cutoff);
    } catch (error) {
      convexError = String(error);
    }
  }

  const sentryResult = await deps.postSentry(event);

  return {
    stored: !typesenseError,
    eventId: event.id,
    typesense: {
      written: !typesenseError,
      ...(typesenseError ? { error: typesenseError } : {}),
    },
    convex: {
      written: shouldWriteToConvex ? !convexError : false,
      pruned: convexPruned,
      ...(shouldWriteToConvex ? {} : { skipped: true }),
      ...(convexError ? { error: convexError } : {}),
    },
    sentry: sentryResult,
  };
}
