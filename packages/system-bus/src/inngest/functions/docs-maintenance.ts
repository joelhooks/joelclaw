import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname } from "node:path";
import { NonRetriableError } from "inngest";
import * as typesense from "../../lib/typesense";
import { emitMeasuredOtelEvent, emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const DOCS_COLLECTION = "docs";
const THREE_BODY_ROOT = "/Volumes/three-body";
const MANIFEST_FILE_NAME = "manifest.clean.jsonl";
const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const DOCS_BACKLOG_BATCH_SIZE = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_BACKLOG_BATCH_SIZE ?? "12", 10)
);
const DOCS_BACKLOG_BATCH_SLEEP_SECONDS = Math.max(
  0,
  Number.parseInt(process.env.JOELCLAW_DOCS_BACKLOG_BATCH_SLEEP_SECONDS ?? "2", 10)
);
const DOCS_REINDEX_BATCH_SIZE = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_REINDEX_BATCH_SIZE ?? "12", 10)
);
const DOCS_REINDEX_BATCH_SLEEP_SECONDS = Math.max(
  0,
  Number.parseInt(process.env.JOELCLAW_DOCS_REINDEX_BATCH_SLEEP_SECONDS ?? "2", 10)
);
const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const INNGEST_GQL_URL = `${INNGEST_URL}/v0/gql`;
const INNGEST_GQL_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.JOELCLAW_INNGEST_GQL_TIMEOUT_MS ?? "20000", 10)
);
const DOCS_BACKLOG_DRIVER_CRON =
  process.env.JOELCLAW_DOCS_BACKLOG_DRIVER_CRON?.trim() || "*/4 * * * *";
const DOCS_BACKLOG_DRIVER_LOOKBACK_HOURS = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_BACKLOG_DRIVER_LOOKBACK_HOURS ?? "8", 10)
);
const DOCS_BACKLOG_DRIVER_MAX_ENTRIES = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_BACKLOG_DRIVER_MAX_ENTRIES ?? "24", 10)
);
const DOCS_BACKLOG_DRIVER_MAX_RUNNING = Math.max(
  0,
  Number.parseInt(process.env.JOELCLAW_DOCS_BACKLOG_DRIVER_MAX_RUNNING ?? "2", 10)
);
const DOCS_BACKLOG_DRIVER_MAX_QUEUED = Math.max(
  0,
  Number.parseInt(process.env.JOELCLAW_DOCS_BACKLOG_DRIVER_MAX_QUEUED ?? "24", 10)
);
const DOCS_BACKLOG_DRIVER_IDEMPOTENCY_PREFIX =
  process.env.JOELCLAW_DOCS_BACKLOG_DRIVER_IDEMPOTENCY_PREFIX?.trim() || "driver";
const DOCS_INGEST_JANITOR_CRON =
  process.env.JOELCLAW_DOCS_INGEST_JANITOR_CRON?.trim() || "*/6 * * * *";
const DOCS_INGEST_JANITOR_LOOKBACK_HOURS = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_INGEST_JANITOR_LOOKBACK_HOURS ?? "24", 10)
);
const DOCS_INGEST_JANITOR_SCAN_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_INGEST_JANITOR_SCAN_LIMIT ?? "120", 10)
);
const DOCS_INGEST_JANITOR_STALE_MINUTES = Math.max(
  5,
  Number.parseInt(process.env.JOELCLAW_DOCS_INGEST_JANITOR_STALE_MINUTES ?? "15", 10)
);
const DOCS_INGEST_JANITOR_MAX_RECOVERIES = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_INGEST_JANITOR_MAX_RECOVERIES ?? "8", 10)
);
const DOCS_INGEST_JANITOR_ALERT_SDK_UNREACHABLE_THRESHOLD = Math.max(
  1,
  Number.parseInt(
    process.env.JOELCLAW_DOCS_INGEST_JANITOR_ALERT_SDK_UNREACHABLE_THRESHOLD ?? "3",
    10
  )
);
const DOCS_INGEST_JANITOR_ALERT_STALE_THRESHOLD = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_INGEST_JANITOR_ALERT_STALE_THRESHOLD ?? "3", 10)
);
const DOCS_INGEST_JANITOR_ALERT_FINALIZATION_THRESHOLD = Math.max(
  1,
  Number.parseInt(
    process.env.JOELCLAW_DOCS_INGEST_JANITOR_ALERT_FINALIZATION_THRESHOLD ?? "2",
    10
  )
);
const SUPPORTED_DOCS_EXTENSIONS = new Set([".pdf", ".md", ".txt"]);

type DocsRecord = {
  id: string;
  title: string;
  nasPath: string;
  tags: string[];
  storageCategory?: string;
  sourceHost?: string;
};

type TypesenseHit = {
  document?: Record<string, unknown>;
};

type TypesenseSearchResponse = {
  found?: number;
  page?: number;
  hits?: TypesenseHit[];
};

type ManifestBacklogEntry = {
  id: string;
  filename: string;
  sourcePath: string;
  sourceExists: boolean;
  enrichmentCategory: string | null;
  enrichmentDocumentType: string | null;
};

type DocsBacklogCandidate = {
  entryId: string;
  nasPath: string;
  title: string;
  tags: string[];
  storageCategory: string;
  sourceHost: string;
};

type InngestFunctionRecord = {
  id: string;
  name?: string | null;
  slug?: string | null;
};

type InngestRunRecord = {
  id: string;
  status: string;
  functionID?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
};

type InngestRunTraceSpan = {
  name?: string | null;
  status?: string | null;
  outputID?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  childrenSpans?: InngestRunTraceSpan[];
};

type InngestRunTrigger = {
  eventName?: string | null;
  IDs?: string[] | null;
  timestamp?: string | null;
};

type DocsIngestQueueDepth = {
  running: number;
  queued: number;
  sampleRunIds: string[];
};

type RecoverableDocsRun = {
  runId: string;
  startedAt: string | null;
  ageMinutes: number;
  failureClass: DocsFinalizationFailureClass;
  failureMessage?: string;
  payload?: {
    nasPath: string;
    title?: string;
    tags?: string[];
    storageCategory?: string;
    sourceHost?: string;
    idempotencyKey?: string;
  };
};

export type DocsFinalizationFailureClass =
  | "sdk_unreachable"
  | "context_canceled"
  | "finalization_failed_other"
  | "stale_running";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - Math.max(1, hours) * 60 * 60 * 1000).toISOString();
}

function parseIsoToMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageMinutesFromIso(value: string | null | undefined): number {
  const startedAtMs = parseIsoToMs(value);
  if (startedAtMs <= 0) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAtMs) / 60_000));
}

export function shouldDispatchBacklogDriver(input: {
  docsRunning: number;
  docsQueued: number;
  maxRunning: number;
  maxQueued: number;
  force?: boolean;
}): boolean {
  if (input.force) return true;
  if (input.docsRunning >= input.maxRunning) return false;
  if (input.docsQueued >= input.maxQueued) return false;
  return true;
}

export function classifyFinalizationFailure(
  message: string | null | undefined
): Exclude<DocsFinalizationFailureClass, "stale_running"> {
  const normalized = (message ?? "").toLowerCase();
  if (normalized.includes("unable to reach sdk url")) return "sdk_unreachable";
  if (normalized.includes("context canceled")) return "context_canceled";
  return "finalization_failed_other";
}

export function shouldRequeueAfterCancelAttempt(input: {
  cancelStatus: string | null;
  cancelError?: string | null;
}): boolean {
  if (input.cancelError) return false;
  const normalized = input.cancelStatus?.trim().toUpperCase();
  return normalized === "CANCELLED" || normalized === "CANCELED";
}

function formatHourlyIdempotencyPrefix(base: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  return `${base}:${year}${month}${day}${hour}`;
}

async function inngestGql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(INNGEST_GQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      ...(variables ? { variables } : {}),
    }),
    signal: AbortSignal.timeout(INNGEST_GQL_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Inngest GQL request failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) {
    const message = payload.errors
      .map((error) => error.message ?? "unknown_error")
      .join("; ");
    throw new Error(`Inngest GQL error: ${message}`);
  }
  if (!payload.data) {
    throw new Error("Inngest GQL response missing data");
  }

  return payload.data;
}

async function resolveDocsIngestFunctionId(): Promise<string> {
  const data = await inngestGql<{
    functions?: InngestFunctionRecord[];
  }>(`query { functions { id name slug } }`);

  const match = (data.functions ?? []).find((fn) => {
    const name = fn.name?.trim();
    const slug = fn.slug?.trim();
    return name === "docs-ingest" || slug === "system-bus-host-docs-ingest";
  });

  if (!match?.id) {
    throw new Error("Unable to resolve docs-ingest function ID from Inngest");
  }

  return match.id;
}

async function loadDocsIngestQueueDepth(
  docsIngestFunctionId: string,
  lookbackHours: number
): Promise<DocsIngestQueueDepth> {
  const data = await inngestGql<{
    runs?: {
      edges?: Array<{
        node?: InngestRunRecord | null;
      }>;
    };
  }>(
    `
      query DocsIngestQueueDepth($from: Time!, $functionIDs: [UUID!]) {
        runs(
          filter: { from: $from, status: [RUNNING, QUEUED], functionIDs: $functionIDs }
          orderBy: [{ field: STARTED_AT, direction: DESC }]
          first: 400
        ) {
          edges {
            node {
              id
              status
              functionID
              startedAt
            }
          }
        }
      }
    `,
    {
      from: hoursAgoIso(lookbackHours),
      functionIDs: [docsIngestFunctionId],
    }
  );

  const runs = (data.runs?.edges ?? [])
    .map((edge) => edge.node)
    .filter((node): node is InngestRunRecord => Boolean(node));
  const running = runs.filter((run) => run.status === "RUNNING").length;
  const queued = runs.filter((run) => run.status === "QUEUED").length;

  return {
    running,
    queued,
    sampleRunIds: runs.slice(0, 8).map((run) => run.id),
  };
}

async function listRunningDocsIngestRuns(
  docsIngestFunctionId: string,
  lookbackHours: number,
  scanLimit: number
): Promise<InngestRunRecord[]> {
  const data = await inngestGql<{
    runs?: {
      edges?: Array<{
        node?: InngestRunRecord | null;
      }>;
    };
  }>(
    `
      query DocsIngestRunning($from: Time!, $functionIDs: [UUID!], $first: Int!) {
        runs(
          filter: { from: $from, status: [RUNNING], functionIDs: $functionIDs }
          orderBy: [{ field: STARTED_AT, direction: ASC }]
          first: $first
        ) {
          edges {
            node {
              id
              status
              functionID
              startedAt
              endedAt
            }
          }
        }
      }
    `,
    {
      from: hoursAgoIso(lookbackHours),
      functionIDs: [docsIngestFunctionId],
      first: Math.max(1, scanLimit),
    }
  );

  return (data.runs?.edges ?? [])
    .map((edge) => edge.node)
    .filter((node): node is InngestRunRecord => Boolean(node));
}

function flattenRunTraceSpans(
  span: InngestRunTraceSpan | null | undefined
): InngestRunTraceSpan[] {
  if (!span) return [];
  const children = span.childrenSpans ?? [];
  return [span, ...children.flatMap((child) => flattenRunTraceSpans(child))];
}

function findSpanOutputId(span: InngestRunTraceSpan | null | undefined): string | null {
  if (!span) return null;
  if (span.outputID && span.outputID.length > 0) return span.outputID;
  const children = span.childrenSpans ?? [];
  for (const child of children) {
    const outputId = findSpanOutputId(child);
    if (outputId) return outputId;
  }
  return null;
}

function parseEventRawPayload(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function loadRunTriggerEventData(runId: string): Promise<Record<string, unknown> | null> {
  const triggerData = await inngestGql<{
    runTrigger?: InngestRunTrigger | null;
  }>(
    `
      query RunTrigger($runID: String!) {
        runTrigger(runID: $runID) {
          eventName
          IDs
          timestamp
        }
      }
    `,
    { runID: runId }
  );

  const trigger = triggerData.runTrigger;
  if (!trigger || trigger.eventName !== "docs/ingest.requested") return null;
  const triggerEventId = trigger.IDs?.[0];
  if (!triggerEventId) return null;

  const eventData = await inngestGql<{
    event?: {
      id?: string | null;
      name?: string | null;
      raw?: string | null;
    } | null;
  }>(
    `
      query EventByID($eventID: ID!) {
        event(query: { eventId: $eventID }) {
          id
          name
          raw
        }
      }
    `,
    { eventID: triggerEventId }
  );

  const event = eventData.event;
  if (!event || event.name !== "docs/ingest.requested") return null;
  const payload = parseEventRawPayload(event.raw);
  const data = payload.data;
  if (!data || typeof data !== "object") return null;
  return data as Record<string, unknown>;
}

function buildJanitorRecoveryPayload(
  runId: string,
  eventData: Record<string, unknown> | null
): RecoverableDocsRun["payload"] {
  if (!eventData) return undefined;
  const nasPath = asString(eventData.nasPath);
  if (!nasPath) return undefined;
  const title = asString(eventData.title) ?? undefined;
  const storageCategory = asString(eventData.storageCategory) ?? undefined;
  const sourceHost = asString(eventData.sourceHost) ?? undefined;
  const tags = asStringArray(eventData.tags);
  if (!tags.includes("janitor-recover")) tags.push("janitor-recover");
  const idempotencyPrefix = asString(eventData.idempotencyKey) ?? `janitor:${runId}`;
  return {
    nasPath,
    ...(title ? { title } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(storageCategory ? { storageCategory } : {}),
    ...(sourceHost ? { sourceHost } : {}),
    idempotencyKey: `${idempotencyPrefix}:recover:${runId}`,
  };
}

async function inspectRunForRecovery(
  run: InngestRunRecord,
  staleAfterMinutes: number
): Promise<RecoverableDocsRun | null> {
  const runData = await inngestGql<{
    runTrace?: InngestRunTraceSpan | null;
  }>(
    `
      query RunTrace($runID: String!) {
        runTrace(runID: $runID) {
          name
          status
          outputID
          startedAt
          endedAt
          childrenSpans {
            name
            status
            outputID
            startedAt
            endedAt
            childrenSpans {
              name
              status
              outputID
              startedAt
              endedAt
              childrenSpans {
                name
                status
                outputID
                startedAt
                endedAt
              }
            }
          }
        }
      }
    `,
    { runID: run.id }
  );

  const allSpans = flattenRunTraceSpans(runData.runTrace);
  const failedFinalizationSpan = allSpans.find(
    (span) => span.name === "Finalization" && span.status === "FAILED"
  );

  let failureClass: DocsFinalizationFailureClass | null = null;
  let failureMessage: string | undefined;

  if (failedFinalizationSpan) {
    const outputId = findSpanOutputId(failedFinalizationSpan);
    if (outputId) {
      const outputData = await inngestGql<{
        runTraceSpanOutputByID?: {
          error?: {
            message?: string | null;
            name?: string | null;
            stack?: string | null;
          } | null;
        } | null;
      }>(
        `
          query SpanOutput($outputID: String!) {
            runTraceSpanOutputByID(outputID: $outputID) {
              error {
                message
                name
                stack
              }
            }
          }
        `,
        { outputID: outputId }
      );

      const error = outputData.runTraceSpanOutputByID?.error;
      const errorText = [error?.message, error?.name, error?.stack]
        .filter((value): value is string => Boolean(value && value.length > 0))
        .join(" ");
      failureClass = classifyFinalizationFailure(errorText);
      failureMessage = errorText;
    } else {
      failureClass = "finalization_failed_other";
      failureMessage = "finalization_failed_no_output_id";
    }
  } else {
    const ageMinutes = ageMinutesFromIso(run.startedAt);
    if (ageMinutes >= staleAfterMinutes) {
      failureClass = "stale_running";
      failureMessage = `running_for_${ageMinutes}m`;
    }
  }

  if (!failureClass) return null;
  const triggerEventData = await loadRunTriggerEventData(run.id);

  return {
    runId: run.id,
    startedAt: run.startedAt ?? null,
    ageMinutes: ageMinutesFromIso(run.startedAt),
    failureClass,
    ...(failureMessage ? { failureMessage } : {}),
    payload: buildJanitorRecoveryPayload(run.id, triggerEventData),
  };
}

async function cancelRun(runId: string): Promise<string | null> {
  const data = await inngestGql<{
    cancelRun?: {
      id?: string | null;
      status?: string | null;
    } | null;
  }>(
    `
      mutation CancelRun($runID: ULID!) {
        cancelRun(runID: $runID) {
          id
          status
        }
      }
    `,
    { runID: runId }
  );
  return data.cancelRun?.status ?? null;
}

function normalizePathKey(value: string): string {
  return value.replace(/\\/g, "/").trim().toLowerCase();
}

function sanitizeManifestFilename(raw: string): string {
  const extension = extname(raw).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 20);
  const maxBaseLength = Math.max(1, 200 - extension.length);

  let base = raw
    .replace(/^.*[\\/]/, "")
    .replace(extname(raw), "")
    .replace(/[^a-zA-Z0-9.\s_-]/g, " ")
    .replace(/[\s-]+/g, "-")
    .replace(/_+/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^[-_.]+|[-_.]+$/g, "");

  if (!base) base = "document";
  if (base.length > maxBaseLength) {
    base = base.slice(0, maxBaseLength).replace(/^[-_.]+|[-_.]+$/g, "");
  }
  if (!base) base = "document";

  return `${base}${extension}`;
}

function manifestCategoryDir(category: string | null): string {
  const normalized = category?.trim().toLowerCase();
  switch (normalized) {
    case "programming":
    case "business":
    case "education":
    case "design":
    case "other":
      return normalized;
    default:
      return "uncategorized";
  }
}

function buildManifestDestination(entry: ManifestBacklogEntry): string {
  const filename = sanitizeManifestFilename(entry.filename);
  if (entry.sourcePath.includes("/clawd/podcasts/")) {
    return `${THREE_BODY_ROOT}/podcasts/${filename}`;
  }
  return `${THREE_BODY_ROOT}/books/${manifestCategoryDir(entry.enrichmentCategory)}/${filename}`;
}

function deriveStorageCategory(entry: ManifestBacklogEntry): string {
  if (entry.sourcePath.includes("/clawd/podcasts/")) return "podcasts";
  return manifestCategoryDir(entry.enrichmentCategory);
}

function isSupportedDocsFile(filename: string): boolean {
  return SUPPORTED_DOCS_EXTENSIONS.has(extname(filename).toLowerCase());
}

function titleFromFilename(filename: string): string {
  const stripped = filename.replace(extname(filename), "").trim();
  if (!stripped) return filename;
  return stripped.replace(/[_-]+/g, " ").trim();
}

function tagsFromManifestEntry(entry: ManifestBacklogEntry): string[] {
  const tags = new Set<string>(["manifest", `manifest-entry:${entry.id}`]);
  if (entry.enrichmentDocumentType) {
    const typeTag = entry.enrichmentDocumentType
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (typeTag.length > 0) {
      tags.add(`document-type:${typeTag}`);
    }
  }
  return [...tags];
}

function resolveSourceHost(entry: ManifestBacklogEntry): string {
  return entry.sourceExists ? "dark-wizard" : "clanker";
}

async function resolveManifestPath(requestedPath: unknown): Promise<string> {
  const requested = typeof requestedPath === "string" ? requestedPath.trim() : "";
  const candidatePaths = [
    requested.length > 0 ? requested : null,
    process.env.MANIFEST_ARCHIVE_MANIFEST_PATH?.trim() || null,
    `/tmp/${MANIFEST_FILE_NAME}`,
    `/Volumes/three-body/.ingest-staging/${MANIFEST_FILE_NAME}`,
    process.env.HOME ? `${process.env.HOME}/Documents/${MANIFEST_FILE_NAME}` : null,
    `${homedir()}/Documents/${MANIFEST_FILE_NAME}`,
  ].filter((value): value is string => Boolean(value && value.length > 0));

  const seen = new Set<string>();
  for (const candidate of candidatePaths) {
    const key = normalizePathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new NonRetriableError(
    `Manifest file not found. Checked: ${candidatePaths.join(", ")}`
  );
}

async function loadManifestEntries(manifestPath: string): Promise<ManifestBacklogEntry[]> {
  const text = await readFile(manifestPath, "utf8");
  const entries: ManifestBacklogEntry[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    const id = asString(record.id);
    const filename = asString(record.filename);
    const sourcePath = asString(record.sourcePath);
    if (!id || !filename || !sourcePath) continue;

    entries.push({
      id,
      filename,
      sourcePath,
      sourceExists: Boolean(record.sourceExists),
      enrichmentCategory: asString(record.enrichmentCategory),
      enrichmentDocumentType: asString(record.enrichmentDocumentType),
    });
  }

  return entries;
}

function mapDocsRecord(document: Record<string, unknown>): DocsRecord | null {
  const id = asString(document.id);
  const title = asString(document.title);
  const nasPath = asString(document.nas_path);
  if (!id || !title || !nasPath) return null;

  return {
    id,
    title,
    nasPath,
    tags: asStringArray(document.tags),
    storageCategory: asString(document.storage_category) ?? undefined,
    sourceHost: asString(document.source_host) ?? undefined,
  };
}

async function fetchDocById(docId: string): Promise<DocsRecord> {
  const response = await typesense.typesenseRequest(
    `/collections/${DOCS_COLLECTION}/documents/${encodeURIComponent(docId)}`,
    { method: "GET" }
  );

  if (response.status === 404) {
    throw new NonRetriableError(`docs record not found: ${docId}`);
  }
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch docs record ${docId}: ${errorText}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const mapped = mapDocsRecord(payload);
  if (!mapped) {
    throw new NonRetriableError(`docs record missing required fields: ${docId}`);
  }
  return mapped;
}

async function listDocsRecords(): Promise<DocsRecord[]> {
  const docs: DocsRecord[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      q: "*",
      query_by: "title",
      per_page: String(PAGE_SIZE),
      page: String(page),
      include_fields: "id,title,nas_path,tags,storage_category,source_host",
    });

    const response = await typesense.typesenseRequest(
      `/collections/${DOCS_COLLECTION}/documents/search?${params.toString()}`,
      { method: "GET" }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list docs records (page ${page}): ${errorText}`);
    }

    const payload = (await response.json()) as TypesenseSearchResponse;
    const hits = payload.hits ?? [];
    if (hits.length === 0) break;

    for (const hit of hits) {
      const mapped = hit.document ? mapDocsRecord(hit.document) : null;
      if (mapped) docs.push(mapped);
    }

    if (hits.length < PAGE_SIZE) break;
  }

  return docs;
}

function ingestEventFromDoc(
  doc: DocsRecord,
  idempotencyKey?: string
): {
  name: "docs/ingest.requested";
  data: {
    nasPath: string;
    title: string;
    tags: string[];
    storageCategory?: string;
    sourceHost?: string;
    idempotencyKey?: string;
  };
} {
  return {
    name: "docs/ingest.requested",
    data: {
      nasPath: doc.nasPath,
      title: doc.title,
      tags: doc.tags,
      ...(doc.storageCategory ? { storageCategory: doc.storageCategory } : {}),
      ...(doc.sourceHost ? { sourceHost: doc.sourceHost } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

export const docsEnrich = inngest.createFunction(
  {
    id: "docs-enrich",
    concurrency: { limit: 2 },
    retries: 2,
    idempotency: "event.data.docId",
  },
  { event: "docs/enrich.requested" },
  async ({ event, step }) => {
    const doc = await step.run("load-doc", async () => {
      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-enrich",
          action: "docs.enrich.requested",
          metadata: {
            docId: event.data.docId,
          },
        },
        async () => fetchDocById(event.data.docId)
      );
    });

    const enqueue = await step.sendEvent(
      "requeue-ingest",
      ingestEventFromDoc(doc, `enrich:${doc.id}:${Date.now()}`)
    );

    await step.run("emit-otel", async () => {
      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-enrich",
          action: "docs.enrich.requeued",
          metadata: {
            docId: doc.id,
            nasPath: doc.nasPath,
            eventIds: enqueue.ids,
          },
        },
        async () => ({ queued: true })
      );
    });

    return {
      docId: doc.id,
      nasPath: doc.nasPath,
      queuedEventIds: enqueue.ids,
    };
  }
);

export const docsBacklog = inngest.createFunction(
  {
    id: "docs-backlog",
    singleton: { key: '"global"', mode: "skip" },
    concurrency: { limit: 1 },
    retries: 2,
  },
  { event: "docs/backlog.requested" },
  async ({ event, step }) => {
    const eventData = (event.data ?? {}) as {
      manifestPath?: unknown;
      maxEntries?: unknown;
      booksOnly?: unknown;
      onlyMissing?: unknown;
      includePodcasts?: unknown;
      idempotencyPrefix?: unknown;
    };

    const manifestPath = await step.run("resolve-manifest-path", async () =>
      resolveManifestPath(eventData.manifestPath)
    );
    const maxEntries = asPositiveInt(eventData.maxEntries);
    const booksOnly = asBoolean(eventData.booksOnly, true);
    const onlyMissing = asBoolean(eventData.onlyMissing, true);
    const includePodcasts = asBoolean(eventData.includePodcasts, !booksOnly);
    const idempotencyPrefix = asString(eventData.idempotencyPrefix) ?? "backfill";

    const manifestEntries = await step.run("load-manifest", async () => {
      return loadManifestEntries(manifestPath);
    });

    const existingDocs = onlyMissing
      ? await step.run("load-existing-docs", async () => listDocsRecords())
      : [];
    const existingNasPaths = new Set(existingDocs.map((doc) => normalizePathKey(doc.nasPath)));

    const planning = await step.run("plan-backlog-events", async () => {
      const candidates: DocsBacklogCandidate[] = [];
      let skippedUnsupported = 0;
      let skippedMissingFile = 0;
      let skippedAlreadyIndexed = 0;
      let skippedByCategory = 0;

      for (const entry of manifestEntries) {
        const nasPath = buildManifestDestination(entry);
        const isPodcast = nasPath.includes(`${THREE_BODY_ROOT}/podcasts/`);
        if ((booksOnly && isPodcast) || (!includePodcasts && isPodcast)) {
          skippedByCategory += 1;
          continue;
        }

        if (!isSupportedDocsFile(entry.filename)) {
          skippedUnsupported += 1;
          continue;
        }

        if (onlyMissing && existingNasPaths.has(normalizePathKey(nasPath))) {
          skippedAlreadyIndexed += 1;
          continue;
        }

        try {
          await access(nasPath);
        } catch {
          skippedMissingFile += 1;
          continue;
        }

        candidates.push({
          entryId: entry.id,
          nasPath,
          title: titleFromFilename(entry.filename),
          tags: tagsFromManifestEntry(entry),
          storageCategory: deriveStorageCategory(entry),
          sourceHost: resolveSourceHost(entry),
        });

        if (maxEntries && candidates.length >= maxEntries) {
          break;
        }
      }

      return {
        candidates,
        skippedUnsupported,
        skippedMissingFile,
        skippedAlreadyIndexed,
        skippedByCategory,
      };
    });

    if (planning.candidates.length === 0) {
      await step.run("emit-backlog-empty-otel", async () => {
        return emitMeasuredOtelEvent(
          {
            level: "warn",
            source: "worker",
            component: "docs-backlog",
            action: "docs.backlog.empty",
            metadata: {
              manifestPath,
              manifestEntries: manifestEntries.length,
              maxEntries,
              booksOnly,
              onlyMissing,
              includePodcasts,
              skippedUnsupported: planning.skippedUnsupported,
              skippedMissingFile: planning.skippedMissingFile,
              skippedAlreadyIndexed: planning.skippedAlreadyIndexed,
              skippedByCategory: planning.skippedByCategory,
            },
          },
          async () => ({ queued: 0 })
        );
      });

      return {
        manifestPath,
        manifestEntries: manifestEntries.length,
        queueable: 0,
        queued: 0,
        batches: 0,
        skippedUnsupported: planning.skippedUnsupported,
        skippedMissingFile: planning.skippedMissingFile,
        skippedAlreadyIndexed: planning.skippedAlreadyIndexed,
        skippedByCategory: planning.skippedByCategory,
      };
    }

    const batchSizes: number[] = [];
    let queued = 0;

    for (let offset = 0; offset < planning.candidates.length; offset += DOCS_BACKLOG_BATCH_SIZE) {
      const batch = planning.candidates.slice(offset, offset + DOCS_BACKLOG_BATCH_SIZE);
      const batchNumber = Math.floor(offset / DOCS_BACKLOG_BATCH_SIZE) + 1;
      const sendResult = await step.sendEvent(
        `queue-backlog-batch-${batchNumber}`,
        batch.map((candidate) => ({
          name: "docs/ingest.requested" as const,
          data: {
            nasPath: candidate.nasPath,
            title: candidate.title,
            tags: candidate.tags,
            storageCategory: candidate.storageCategory,
            sourceHost: candidate.sourceHost,
            idempotencyKey: `${idempotencyPrefix}:${candidate.entryId}`,
          },
        }))
      );
      queued += sendResult.ids.length;
      batchSizes.push(sendResult.ids.length);

      const isLastBatch = offset + DOCS_BACKLOG_BATCH_SIZE >= planning.candidates.length;
      if (!isLastBatch && DOCS_BACKLOG_BATCH_SLEEP_SECONDS > 0) {
        await step.sleep(
          `pace-backlog-batch-${batchNumber}`,
          `${DOCS_BACKLOG_BATCH_SLEEP_SECONDS}s`
        );
      }
    }

    await step.run("emit-backlog-otel", async () => {
      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-backlog",
          action: "docs.backlog.queued",
          metadata: {
            manifestPath,
            manifestEntries: manifestEntries.length,
            queueable: planning.candidates.length,
            queued,
            batches: batchSizes.length,
            batchSize: DOCS_BACKLOG_BATCH_SIZE,
            batchSleepSeconds: DOCS_BACKLOG_BATCH_SLEEP_SECONDS,
            batchSizes,
            maxEntries,
            booksOnly,
            onlyMissing,
            includePodcasts,
            skippedUnsupported: planning.skippedUnsupported,
            skippedMissingFile: planning.skippedMissingFile,
            skippedAlreadyIndexed: planning.skippedAlreadyIndexed,
            skippedByCategory: planning.skippedByCategory,
          },
        },
        async () => ({ queued })
      );
    });

    return {
      manifestPath,
      manifestEntries: manifestEntries.length,
      queueable: planning.candidates.length,
      queued,
      batches: batchSizes.length,
      batchSize: DOCS_BACKLOG_BATCH_SIZE,
      batchSleepSeconds: DOCS_BACKLOG_BATCH_SLEEP_SECONDS,
      batchSizes,
      maxEntries,
      booksOnly,
      onlyMissing,
      includePodcasts,
      skippedUnsupported: planning.skippedUnsupported,
      skippedMissingFile: planning.skippedMissingFile,
      skippedAlreadyIndexed: planning.skippedAlreadyIndexed,
      skippedByCategory: planning.skippedByCategory,
    };
  }
);

export const docsReindex = inngest.createFunction(
  {
    id: "docs-reindex",
    singleton: { key: '"global"', mode: "skip" },
    concurrency: { limit: 1 },
    retries: 2,
  },
  { event: "docs/reindex.requested" },
  async ({ event, step }) => {
    const docs = await step.run("resolve-docs", async () => {
      const requestedDocId = event.data.docId?.trim();
      if (requestedDocId) {
        const doc = await fetchDocById(requestedDocId);
        return [doc];
      }
      return listDocsRecords();
    });

    if (docs.length === 0) {
      await step.run("emit-empty-otel", async () => {
        return emitMeasuredOtelEvent(
          {
            level: "warn",
            source: "worker",
            component: "docs-reindex",
            action: "docs.reindex.empty",
            metadata: {
              requestedDocId: event.data.docId ?? null,
            },
          },
          async () => ({ queued: 0 })
        );
      });
      return {
        requestedDocId: event.data.docId ?? null,
        queued: 0,
        batches: 0,
      };
    }

    const batches: number[] = [];
    let queued = 0;

    for (let index = 0; index < docs.length; index += DOCS_REINDEX_BATCH_SIZE) {
      const batch = docs.slice(index, index + DOCS_REINDEX_BATCH_SIZE);
      const batchIndex = Math.floor(index / DOCS_REINDEX_BATCH_SIZE) + 1;
      const sendResult = await step.sendEvent(
        `queue-batch-${batchIndex}`,
        batch.map((doc, docOffset) =>
          ingestEventFromDoc(doc, `reindex:${doc.id}:${batchIndex}:${docOffset}:${Date.now()}`)
        )
      );
      queued += sendResult.ids.length;
      batches.push(sendResult.ids.length);

      const isLastBatch = index + DOCS_REINDEX_BATCH_SIZE >= docs.length;
      if (!isLastBatch && DOCS_REINDEX_BATCH_SLEEP_SECONDS > 0) {
        await step.sleep(
          `pace-reindex-batch-${batchIndex}`,
          `${DOCS_REINDEX_BATCH_SLEEP_SECONDS}s`
        );
      }
    }

    await step.run("emit-reindex-otel", async () => {
      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-reindex",
          action: "docs.reindex.queued",
          metadata: {
            requestedDocId: event.data.docId ?? null,
            docsResolved: docs.length,
            queued,
            batches: batches.length,
            batchSize: DOCS_REINDEX_BATCH_SIZE,
            batchSleepSeconds: DOCS_REINDEX_BATCH_SLEEP_SECONDS,
            batchSizes: batches,
          },
        },
        async () => ({ queued })
      );
    });

    return {
      requestedDocId: event.data.docId ?? null,
      docsResolved: docs.length,
      queued,
      batches: batches.length,
      batchSize: DOCS_REINDEX_BATCH_SIZE,
      batchSleepSeconds: DOCS_REINDEX_BATCH_SLEEP_SECONDS,
      batchSizes: batches,
    };
  }
);

export const docsBacklogDriver = inngest.createFunction(
  {
    id: "docs-backlog-driver",
    singleton: { key: '"global"', mode: "skip" },
    concurrency: { limit: 1 },
    retries: 1,
  },
  [{ cron: DOCS_BACKLOG_DRIVER_CRON }, { event: "docs/backlog.drive.requested" }],
  async ({ event, step }) => {
    const eventData = (event.data ?? {}) as {
      force?: unknown;
      reason?: unknown;
      maxEntries?: unknown;
      maxRunning?: unknown;
      maxQueued?: unknown;
      lookbackHours?: unknown;
      booksOnly?: unknown;
      onlyMissing?: unknown;
      includePodcasts?: unknown;
      idempotencyPrefix?: unknown;
    };

    const force = asBoolean(eventData.force, false);
    const reason = asString(eventData.reason) ?? null;
    const maxEntries =
      asPositiveInt(eventData.maxEntries) ?? DOCS_BACKLOG_DRIVER_MAX_ENTRIES;
    const maxRunning =
      asNonNegativeInt(eventData.maxRunning) ?? DOCS_BACKLOG_DRIVER_MAX_RUNNING;
    const maxQueued =
      asNonNegativeInt(eventData.maxQueued) ?? DOCS_BACKLOG_DRIVER_MAX_QUEUED;
    const lookbackHours =
      asPositiveInt(eventData.lookbackHours) ?? DOCS_BACKLOG_DRIVER_LOOKBACK_HOURS;
    const booksOnly = asBoolean(eventData.booksOnly, true);
    const onlyMissing = asBoolean(eventData.onlyMissing, true);
    const includePodcasts = asBoolean(eventData.includePodcasts, false);
    const idempotencyPrefix =
      asString(eventData.idempotencyPrefix)
      ?? formatHourlyIdempotencyPrefix(DOCS_BACKLOG_DRIVER_IDEMPOTENCY_PREFIX);

    const docsIngestFunctionId = await step.run("resolve-docs-ingest-function-id", async () => {
      return resolveDocsIngestFunctionId();
    });

    const queueDepth = await step.run("load-docs-ingest-queue-depth", async () => {
      return loadDocsIngestQueueDepth(docsIngestFunctionId, lookbackHours);
    });

    const shouldDispatch = shouldDispatchBacklogDriver({
      docsRunning: queueDepth.running,
      docsQueued: queueDepth.queued,
      maxRunning,
      maxQueued,
      force,
    });

    if (!shouldDispatch) {
      await step.run("emit-backlog-driver-skipped-otel", async () => {
        return emitMeasuredOtelEvent(
          {
            level: "info",
            source: "worker",
            component: "docs-backlog-driver",
            action: "docs.backlog.driver.skipped",
            metadata: {
              reason: reason ?? "queue-depth-gate",
              force,
              docsRunning: queueDepth.running,
              docsQueued: queueDepth.queued,
              maxRunning,
              maxQueued,
              lookbackHours,
              sampleRunIds: queueDepth.sampleRunIds,
            },
          },
          async () => ({ dispatched: false })
        );
      });

      return {
        dispatched: false,
        reason: "queue-depth-gate",
        force,
        docsRunning: queueDepth.running,
        docsQueued: queueDepth.queued,
        maxRunning,
        maxQueued,
        lookbackHours,
        sampleRunIds: queueDepth.sampleRunIds,
      };
    }

    const queued = await step.sendEvent("dispatch-docs-backlog", {
      name: "docs/backlog.requested",
      data: {
        maxEntries,
        booksOnly,
        onlyMissing,
        includePodcasts,
        idempotencyPrefix,
      },
    });

    await step.run("emit-backlog-driver-dispatched-otel", async () => {
      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-backlog-driver",
          action: "docs.backlog.driver.dispatched",
          metadata: {
            reason: reason ?? "schedule",
            force,
            maxEntries,
            booksOnly,
            onlyMissing,
            includePodcasts,
            idempotencyPrefix,
            docsRunning: queueDepth.running,
            docsQueued: queueDepth.queued,
            maxRunning,
            maxQueued,
            lookbackHours,
            sampleRunIds: queueDepth.sampleRunIds,
            eventIds: queued.ids,
          },
        },
        async () => ({ dispatched: true, queuedEvents: queued.ids.length })
      );
    });

    return {
      dispatched: true,
      force,
      reason: reason ?? "schedule",
      maxEntries,
      booksOnly,
      onlyMissing,
      includePodcasts,
      idempotencyPrefix,
      docsRunning: queueDepth.running,
      docsQueued: queueDepth.queued,
      maxRunning,
      maxQueued,
      lookbackHours,
      sampleRunIds: queueDepth.sampleRunIds,
      queuedEventIds: queued.ids,
    };
  }
);

type DocsJanitorClassCounts = Record<DocsFinalizationFailureClass, number>;

function buildJanitorClassCounts(): DocsJanitorClassCounts {
  return {
    sdk_unreachable: 0,
    context_canceled: 0,
    finalization_failed_other: 0,
    stale_running: 0,
  };
}

export const docsIngestJanitor = inngest.createFunction(
  {
    id: "docs-ingest-janitor",
    singleton: { key: '"global"', mode: "skip" },
    concurrency: { limit: 1 },
    retries: 1,
  },
  [{ cron: DOCS_INGEST_JANITOR_CRON }, { event: "docs/ingest.janitor.requested" }],
  async ({ event, step }) => {
    const eventData = (event.data ?? {}) as {
      reason?: unknown;
      lookbackHours?: unknown;
      scanLimit?: unknown;
      staleMinutes?: unknown;
      maxRecoveries?: unknown;
    };

    const reason = asString(eventData.reason) ?? null;
    const lookbackHours =
      asPositiveInt(eventData.lookbackHours) ?? DOCS_INGEST_JANITOR_LOOKBACK_HOURS;
    const scanLimit = asPositiveInt(eventData.scanLimit) ?? DOCS_INGEST_JANITOR_SCAN_LIMIT;
    const staleMinutes =
      asPositiveInt(eventData.staleMinutes) ?? DOCS_INGEST_JANITOR_STALE_MINUTES;
    const maxRecoveries =
      asPositiveInt(eventData.maxRecoveries) ?? DOCS_INGEST_JANITOR_MAX_RECOVERIES;

    const docsIngestFunctionId = await step.run("resolve-docs-ingest-function-id", async () => {
      return resolveDocsIngestFunctionId();
    });

    const runs = await step.run("list-running-docs-ingest-runs", async () => {
      return listRunningDocsIngestRuns(docsIngestFunctionId, lookbackHours, scanLimit);
    });

    const recoverable: RecoverableDocsRun[] = [];
    const inspectErrors: Record<string, string> = {};
    for (const run of runs) {
      const inspected = await step.run(`inspect-run-${run.id}`, async () => {
        try {
          return {
            candidate: await inspectRunForRecovery(run, staleMinutes),
            error: null as string | null,
          };
        } catch (error) {
          return {
            candidate: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
      if (inspected.error) {
        inspectErrors[run.id] = inspected.error;
        continue;
      }
      if (inspected.candidate) recoverable.push(inspected.candidate);
    }

    const classCounts = buildJanitorClassCounts();
    for (const candidate of recoverable) {
      classCounts[candidate.failureClass] += 1;
    }

    const prioritized = [...recoverable].sort((a, b) => b.ageMinutes - a.ageMinutes);
    const selected = prioritized.slice(0, maxRecoveries);
    const selectedIds = new Set(selected.map((item) => item.runId));

    const canceledRunIds: string[] = [];
    const cancelStatuses: Record<string, string | null> = {};
    const cancelErrors: Record<string, string> = {};
    const requeueSkipped: Record<string, string> = {};
    const requeueEvents: Array<{
      name: "docs/ingest.requested";
      data: NonNullable<RecoverableDocsRun["payload"]>;
    }> = [];
    const requeueCandidateRunIds: string[] = [];

    for (const candidate of selected) {
      const cancelResult = await step.run(`cancel-run-${candidate.runId}`, async () => {
        try {
          return {
            status: await cancelRun(candidate.runId),
            error: null as string | null,
          };
        } catch (error) {
          return {
            status: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
      const cancelStatus = cancelResult.status;
      cancelStatuses[candidate.runId] = cancelStatus;
      if (cancelResult.error) {
        cancelErrors[candidate.runId] = cancelResult.error;
      }
      const allowRequeue = shouldRequeueAfterCancelAttempt({
        cancelStatus,
        cancelError: cancelResult.error,
      });
      if (allowRequeue) {
        canceledRunIds.push(candidate.runId);
      } else if (cancelResult.error) {
        requeueSkipped[candidate.runId] = "cancel_failed";
      } else {
        requeueSkipped[candidate.runId] = `cancel_status_${(cancelStatus ?? "null").toLowerCase()}`;
      }

      if (!candidate.payload) {
        requeueSkipped[candidate.runId] = "missing_payload";
        continue;
      }
      if (!allowRequeue) continue;
      requeueEvents.push({
        name: "docs/ingest.requested",
        data: candidate.payload,
      });
      requeueCandidateRunIds.push(candidate.runId);
    }

    const requeuedRunIds: string[] = [];
    let requeueEventIds: string[] = [];
    if (requeueEvents.length > 0) {
      const sendResult = await step.sendEvent("requeue-recoverable-docs-runs", requeueEvents);
      requeueEventIds = sendResult.ids;
      requeuedRunIds.push(...requeueCandidateRunIds);
    }

    await step.run("emit-docs-ingest-janitor-otel", async () => {
      return emitMeasuredOtelEvent(
        {
          level: selected.length > 0 ? "warn" : "info",
          source: "worker",
          component: "docs-ingest-janitor",
          action: "docs.ingest.janitor.scanned",
          metadata: {
            reason: reason ?? "schedule",
            lookbackHours,
            scanLimit,
            staleMinutes,
            maxRecoveries,
            runsScanned: runs.length,
            inspectErrorCount: Object.keys(inspectErrors).length,
            recoverable: recoverable.length,
            selected: selected.length,
            canceled: canceledRunIds.length,
            requeued: requeuedRunIds.length,
            requeueEvents: requeueEventIds.length,
            requeueSkipped: Object.keys(requeueSkipped).length,
            classCounts,
            canceledRunIds,
            requeuedRunIds,
            requeueSkippedRunIds: Object.keys(requeueSkipped),
            recoverableRunIds: recoverable.map((item) => item.runId),
            selectedRunIds: selected.map((item) => item.runId),
            inspectErrorRunIds: Object.keys(inspectErrors),
            inspectErrors,
            requeueSkippedByRunId: requeueSkipped,
            selectedFailureClasses: selected.map((item) => ({
              runId: item.runId,
              failureClass: item.failureClass,
              ageMinutes: item.ageMinutes,
              failureMessage: item.failureMessage ?? null,
              selected: selectedIds.has(item.runId),
            })),
            cancelStatuses,
            cancelErrors,
          },
        },
        async () => ({
          recovered: requeuedRunIds.length,
          canceled: canceledRunIds.length,
          requeueSkipped: Object.keys(requeueSkipped).length,
        })
      );
    });

    const alertTriggers = [
      {
        className: "sdk_unreachable" as const,
        threshold: DOCS_INGEST_JANITOR_ALERT_SDK_UNREACHABLE_THRESHOLD,
      },
      {
        className: "stale_running" as const,
        threshold: DOCS_INGEST_JANITOR_ALERT_STALE_THRESHOLD,
      },
      {
        className: "finalization_failed_other" as const,
        threshold: DOCS_INGEST_JANITOR_ALERT_FINALIZATION_THRESHOLD,
      },
    ];

    for (const alert of alertTriggers) {
      if (classCounts[alert.className] < alert.threshold) continue;
      await step.run(`emit-alert-${alert.className}`, async () => {
        return emitOtelEvent({
          level: "warn",
          source: "worker",
          component: "docs-ingest-janitor",
          action: "docs.ingest.janitor.alert",
          success: false,
          metadata: {
            reason: reason ?? "schedule",
            failureClass: alert.className,
            observedCount: classCounts[alert.className],
            threshold: alert.threshold,
            lookbackHours,
            scanLimit,
            staleMinutes,
            maxRecoveries,
            inspectErrors: Object.keys(inspectErrors).length,
            recoverable: recoverable.length,
            selected: selected.length,
            canceled: canceledRunIds.length,
            requeued: requeuedRunIds.length,
            affectedRunIds: recoverable
              .filter((item) => item.failureClass === alert.className)
              .map((item) => item.runId)
              .slice(0, 20),
          },
        });
      });
    }

    return {
      reason: reason ?? "schedule",
      lookbackHours,
      scanLimit,
      staleMinutes,
      maxRecoveries,
      runsScanned: runs.length,
      inspectErrors,
      recoverable: recoverable.length,
      selected: selected.length,
      canceled: canceledRunIds.length,
      requeued: requeuedRunIds.length,
      classCounts,
      canceledRunIds,
      cancelErrors,
      requeuedRunIds,
      recoverableRunIds: recoverable.map((item) => item.runId),
      selectedRunIds: selected.map((item) => item.runId),
      requeueEventIds,
    };
  }
);
