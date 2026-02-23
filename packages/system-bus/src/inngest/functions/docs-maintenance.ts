import { NonRetriableError } from "inngest";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname } from "node:path";
import * as typesense from "../../lib/typesense";
import { emitMeasuredOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const DOCS_COLLECTION = "docs";
const THREE_BODY_ROOT = "/Volumes/three-body";
const MANIFEST_FILE_NAME = "manifest.clean.jsonl";
const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const DOCS_BACKLOG_BATCH_SIZE = 75;
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

    const batchSize = 100;
    const batches: number[] = [];
    let queued = 0;

    for (let index = 0; index < docs.length; index += batchSize) {
      const batch = docs.slice(index, index + batchSize);
      const batchIndex = Math.floor(index / batchSize) + 1;
      const sendResult = await step.sendEvent(
        `queue-batch-${batchIndex}`,
        batch.map((doc, docOffset) =>
          ingestEventFromDoc(doc, `reindex:${doc.id}:${batchIndex}:${docOffset}:${Date.now()}`)
        )
      );
      queued += sendResult.ids.length;
      batches.push(sendResult.ids.length);
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
      batchSizes: batches,
    };
  }
);
