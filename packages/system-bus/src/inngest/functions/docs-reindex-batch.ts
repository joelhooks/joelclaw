import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as typesense from "../../lib/typesense";
import { emitMeasuredOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { DOCS_COLLECTION } from "./docs-ingest";

const BOOKS_ROOT = "/Volumes/three-body/books";
const TYPESENSE_PAGE_SIZE = 250;
const REINDEX_BATCH_SIZE = 10;

type CollectionPdfDoc = {
  docId?: string;
  title?: string;
  path: string;
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").trim().toLowerCase();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkPdfFiles(root: string): Promise<string[]> {
  const paths: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("._")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        paths.push(fullPath);
      }
    }
  }

  await visit(root);
  return paths;
}

async function listCollectionPdfDocs(): Promise<CollectionPdfDoc[]> {
  const docs: CollectionPdfDoc[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= 100; page += 1) {
    const result = await typesense.search({
      collection: DOCS_COLLECTION,
      q: "*",
      query_by: "title",
      per_page: TYPESENSE_PAGE_SIZE,
      page,
      filter_by: "file_type:=pdf",
      include_fields: "id,title,nas_path,nas_paths",
    });

    if (!result.hits?.length) break;

    for (const hit of result.hits) {
      const document = hit.document ?? {};
      const candidates = [];
      const canonicalPath = asString(document.nas_path);
      if (canonicalPath) candidates.push(canonicalPath);
      for (const path of asStringArray(document.nas_paths)) {
        if (!candidates.includes(path)) candidates.push(path);
      }

      let selectedPath: string | undefined;
      for (const candidate of candidates) {
        if (await pathExists(candidate)) {
          selectedPath = candidate;
          break;
        }
      }

      if (!selectedPath) continue;
      const key = normalizePathKey(selectedPath);
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push({
        docId: asString(document.id),
        title: asString(document.title),
        path: selectedPath,
      });
    }

    if (result.hits.length < TYPESENSE_PAGE_SIZE) break;
  }

  return docs;
}

export const docsReindexBatch = inngest.createFunction(
  {
    id: "docs-reindex-batch",
    singleton: { key: '"global"', mode: "skip" },
    concurrency: { limit: 1, key: "docs-reindex-batch" },
    retries: 4,
  },
  { event: "docs/reindex-batch.requested" },
  async ({ event, step, gateway }) => {
    const skipExistingArtifacts = event.data.skipExistingArtifacts === true;

    const targets = await step.run("resolve-targets", async () => {
      const metadata: Record<string, unknown> = {
        fromCollection: event.data.fromCollection === true,
        requestedPaths: Array.isArray(event.data.paths) ? event.data.paths.length : 0,
        skipExistingArtifacts,
      };

      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-reindex-batch",
          action: "docs.reindex.batch.resolve",
          metadata,
        },
        async () => {
          let resolved: CollectionPdfDoc[];

          if (event.data.fromCollection === true) {
            resolved = await listCollectionPdfDocs();
          } else if (Array.isArray(event.data.paths) && event.data.paths.length > 0) {
            const seen = new Set<string>();
            resolved = event.data.paths
              .map((path: unknown) => asString(path))
              .filter((path: string | undefined): path is string => Boolean(path))
              .filter(
                (path: string) =>
                  path.toLowerCase().endsWith(".pdf") && !path.split("/").pop()?.startsWith("._")
              )
              .filter((path: string) => {
                const key = normalizePathKey(path);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              })
              .map((path: string) => ({ path }));
          } else {
            const seen = new Set<string>();
            resolved = (await walkPdfFiles(BOOKS_ROOT))
              .filter((path) => {
                const key = normalizePathKey(path);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              })
              .map((path) => ({ path }));
          }

          metadata.resolved = resolved.length;
          return resolved;
        }
      );
    });

    const queued = await step.run("queue-events", async () => {
      const metadata: Record<string, unknown> = {
        resolved: targets.length,
        batchSize: REINDEX_BATCH_SIZE,
      };

      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-reindex-batch",
          action: "docs.reindex.batch.queued",
          metadata,
        },
        async () => {
          if (gateway?.progress) {
            await gateway.progress(`📚 Batch reindex: ${targets.length} PDFs queued`);
          }

          let queuedCount = 0;
          const batchSizes: number[] = [];

          for (let index = 0; index < targets.length; index += REINDEX_BATCH_SIZE) {
            const batch = targets.slice(index, index + REINDEX_BATCH_SIZE);
            const batchNumber = Math.floor(index / REINDEX_BATCH_SIZE) + 1;
            const sendResult = await step.sendEvent(
              `queue-docs-reindex-v2-batch-${batchNumber}`,
              batch.map((target) => ({
                name: "docs/reindex-v2.requested" as const,
                data: {
                  nasPath: target.path,
                  ...(target.docId ? { docId: target.docId } : {}),
                  ...(target.title ? { title: target.title } : {}),
                  ...(skipExistingArtifacts ? { skipExistingArtifacts: true } : {}),
                },
              }))
            );

            queuedCount += sendResult.ids.length;
            batchSizes.push(sendResult.ids.length);

            if (gateway?.progress && queuedCount % 50 === 0) {
              await gateway.progress(`📚 Batch reindex: ${queuedCount}/${targets.length} PDFs dispatched`);
            }
          }

          metadata.queued = queuedCount;
          metadata.batches = batchSizes.length;
          metadata.batchSizes = batchSizes;
          return {
            queued: queuedCount,
            batches: batchSizes.length,
            batchSizes,
          };
        }
      );
    });

    return {
      resolved: targets.length,
      queued: queued.queued,
      batches: queued.batches,
      batchSizes: queued.batchSizes,
    };
  }
);
