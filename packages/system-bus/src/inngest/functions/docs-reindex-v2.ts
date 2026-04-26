import { join } from "node:path";
import { NonRetriableError } from "inngest";
import { chunkBookText } from "../../lib/book-chunk";
import {
  DOCS_ARTIFACTS_DIR,
  type DocsMetadata,
  hasArtifact,
  loadChunksArtifact,
  loadMarkdownArtifact,
  loadMetadataArtifact,
  saveChunksArtifact,
  saveMarkdownArtifact,
  saveMetadataArtifact,
} from "../../lib/docs-artifacts";
import { embedTexts } from "../../lib/embed-ollama";
import { infer } from "../../lib/inference";
import * as typesense from "../../lib/typesense";
import { emitMeasuredOtelEvent, emitOtelEvent } from "../../observability/emit";
import {
  type ConceptId,
  getConceptById,
  type StorageCategory,
} from "../../taxonomy/core-v1";
import type { ConceptSource } from "../../taxonomy/resolve";
import { inngest } from "../client";
import {
  buildChunkRecords,
  buildDocumentRecord,
  classifyDocsTaxonomy,
  DOCS_CHUNKS_V2_COLLECTION,
  DOCS_COLLECTION,
  type DocsChunkRecord,
  type DocsExtractedTextArtifact,
  deleteDocChunks,
  ensureDocsCollections,
  extractPdfText,
  inferDocumentType,
  mergeDocumentPathAliases,
  type ValidatedDocsFile,
  validateFile,
} from "./docs-ingest";

type ExistingDocState = {
  addedAt?: number;
  canonicalNasPath: string | null;
  nasPaths: string[];
  sourceHost?: string;
  storageCategory?: string;
  tags: string[];
  title?: string;
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSummary(value: string): string {
  const sentences = normalizeWhitespace(value)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 3);
  return sentences.join(" ").slice(0, 800);
}

function renderConceptLabels(conceptIds: string[]): string {
  const labels = conceptIds
    .map((conceptId) => getConceptById(conceptId as ConceptId)?.prefLabel ?? conceptId)
    .map((label) => normalizeWhitespace(label))
    .filter(Boolean);
  return labels.length > 0 ? labels.join(", ") : "General";
}

function buildRetrievalText(input: {
  title: string;
  summary: string;
  headingPath: string[];
  conceptIds: string[];
  content: string;
}): string {
  const heading = input.headingPath.length > 0 ? input.headingPath.join(" > ") : "Document";
  const conceptLabels = renderConceptLabels(input.conceptIds);
  const summary = normalizeWhitespace(input.summary) || "No summary";
  const content = normalizeWhitespace(input.content);
  return `[DOC: ${input.title}] [SUMMARY: ${summary}] [PATH: ${heading}] [CONCEPTS: ${conceptLabels}]\n\n${content}`;
}

async function loadExistingDocState(docId: string): Promise<ExistingDocState> {
  const response = await typesense.typesenseRequest(
    `/collections/${DOCS_COLLECTION}/documents/${encodeURIComponent(docId)}?include_fields=added_at,nas_path,nas_paths,source_host,storage_category,tags,title`,
    { method: "GET" }
  );

  if (response.status === 404) {
    return {
      canonicalNasPath: null,
      nasPaths: [],
      tags: [],
    };
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to load existing docs state for ${docId}: ${errorText}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const canonicalNasPath = asString(payload.nas_path) ?? null;
  const nasPaths: string[] = [];
  const seen = new Set<string>();
  const addPath = (value: string | null | undefined) => {
    const cleaned = value?.trim();
    if (!cleaned) return;
    const key = normalizePathKey(cleaned);
    if (seen.has(key)) return;
    seen.add(key);
    nasPaths.push(cleaned);
  };

  addPath(canonicalNasPath);
  for (const path of asStringArray(payload.nas_paths)) addPath(path);

  return {
    addedAt: typeof payload.added_at === "number" && Number.isFinite(payload.added_at)
      ? Math.floor(payload.added_at)
      : undefined,
    canonicalNasPath,
    nasPaths,
    sourceHost: asString(payload.source_host),
    storageCategory: asString(payload.storage_category),
    tags: asStringArray(payload.tags),
    title: asString(payload.title),
  };
}

function markdownArtifactPath(docId: string): string {
  return join(DOCS_ARTIFACTS_DIR, docId, `${docId}.md`);
}

function metadataArtifactPath(docId: string): string {
  return join(DOCS_ARTIFACTS_DIR, docId, `${docId}.meta.json`);
}

function chunksArtifactPath(docId: string): string {
  return join(DOCS_ARTIFACTS_DIR, docId, `${docId}.chunks.jsonl`);
}

async function requireMarkdown(docId: string): Promise<string> {
  const markdown = await loadMarkdownArtifact(docId);
  if (markdown == null) {
    throw new NonRetriableError(`Missing markdown artifact for ${docId}`);
  }
  return markdown;
}

async function requireMetadata(docId: string): Promise<DocsMetadata> {
  const metadata = await loadMetadataArtifact(docId);
  if (metadata == null) {
    throw new NonRetriableError(`Missing metadata artifact for ${docId}`);
  }
  return metadata;
}

async function requireChunks(docId: string): Promise<DocsChunkRecord[]> {
  const chunks = await loadChunksArtifact(docId);
  if (chunks == null) {
    throw new NonRetriableError(`Missing chunks artifact for ${docId}`);
  }
  return chunks;
}

export const docsReindexV2 = inngest.createFunction(
  {
    id: "docs-reindex-v2",
    concurrency: { limit: 3, key: "docs-reindex-v2" },
    retries: 4,
  },
  { event: "docs/reindex-v2.requested" },
  async ({ event, step, gateway }) => {
    const requestedTitle = asString(event.data.title);
    const requestedDocId = asString(event.data.docId);
    const skipExistingArtifacts = event.data.skipExistingArtifacts === true;

    const convert = await step.run("convert-pdf", async () => {
      const metadata: Record<string, unknown> = {
        nasPath: event.data.nasPath,
        requestedDocId: requestedDocId ?? null,
        skipExistingArtifacts,
      };

      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-reindex-v2",
          action: "docs.reindex.convert",
          metadata,
        },
        async () => {
          const file = await validateFile({
            nasPath: event.data.nasPath,
            title: requestedTitle,
            docId: requestedDocId,
          });

          if (file.fileType !== "pdf") {
            throw new NonRetriableError(`docs-reindex-v2 only supports PDFs: ${file.nasPath}`);
          }

          metadata.docId = file.docId;
          metadata.title = file.title;

          if (skipExistingArtifacts && await hasArtifact(file.docId, "md")) {
            const existingMeta = await loadMetadataArtifact(file.docId);
            metadata.skipped = true;
            metadata.mdPath = markdownArtifactPath(file.docId);
            metadata.pageCount = existingMeta?.page_count ?? null;
            if (gateway?.progress) {
              await gateway.progress(`📚 ${file.title}: Step 1/4 complete (convert-pdf)`);
            }
            return {
              docId: file.docId,
              mdPath: markdownArtifactPath(file.docId),
              pageCount: existingMeta?.page_count ?? null,
              file,
            };
          }

          const extracted = await extractPdfText(file.nasPath);
          const markdown = extracted.text.replace(/\r\n?/g, "\n").trim();
          if (!markdown) {
            throw new NonRetriableError(`docs-reindex-v2 extracted empty markdown for ${file.nasPath}`);
          }

          const mdPath = await saveMarkdownArtifact(file.docId, markdown);
          metadata.skipped = false;
          metadata.mdPath = mdPath;
          metadata.pageCount = extracted.pageCount;

          if (gateway?.progress) {
            await gateway.progress(`📚 ${file.title}: Step 1/4 complete (convert-pdf)`);
          }

          return {
            docId: file.docId,
            mdPath,
            pageCount: extracted.pageCount,
            file,
          };
        }
      );
    });

    const classifySummarize = await step.run("classify-summarize", async () => {
      const metadata: Record<string, unknown> = {
        docId: convert.docId,
        title: convert.file.title,
        skipExistingArtifacts,
      };

      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-reindex-v2",
          action: "docs.reindex.classify_summarize",
          metadata,
        },
        async () => {
          if (skipExistingArtifacts && await hasArtifact(convert.docId, "meta")) {
            metadata.skipped = true;
            metadata.metaPath = metadataArtifactPath(convert.docId);
            if (gateway?.progress) {
              await gateway.progress(`📚 ${convert.file.title}: Step 2/4 complete (classify-summarize)`);
            }
            return {
              docId: convert.docId,
              metaPath: metadataArtifactPath(convert.docId),
            };
          }

          const markdown = await requireMarkdown(convert.docId);
          const existingDoc = await loadExistingDocState(convert.docId);
          const resolvedTitle = requestedTitle ?? existingDoc.title ?? convert.file.title;
          const classificationResult = await classifyDocsTaxonomy({
            file: { ...convert.file, title: resolvedTitle },
            requestedTags: existingDoc.tags,
            explicitStorageCategory: existingDoc.storageCategory,
            sourceHost: existingDoc.sourceHost,
            title: resolvedTitle,
            textSample: markdown.slice(0, 8_000),
            eventId: event.id,
            component: "docs-reindex-v2",
          });

          const summaryPrompt = markdown.slice(0, 8_000);
          const summaryResult = await infer(summaryPrompt, {
            task: "summary",
            system: "You are a librarian. Summarize this book in 2-3 sentences for a retrieval index.",
            component: "docs-reindex-v2",
            action: "docs.summary.generate",
            noTools: true,
            requireTextOutput: true,
            timeout: 300_000,
            env: { ...process.env, TERM: "dumb" },
            metadata: {
              docId: convert.docId,
              eventId: event.id,
            },
          });

          const pathAliases = mergeDocumentPathAliases({
            currentNasPath: convert.file.nasPath,
            existingNasPath: existingDoc.canonicalNasPath,
            existingNasPaths: existingDoc.nasPaths,
          });
          const summary = normalizeSummary(summaryResult.text);
          const docsMetadata: DocsMetadata = {
            title: resolvedTitle,
            filename: convert.file.fileName,
            file_type: convert.file.fileType,
            page_count: convert.pageCount ?? null,
            sha256: convert.file.sha256,
            primaryConceptId: classificationResult.classification.primaryConceptId,
            conceptIds: classificationResult.classification.conceptIds,
            conceptSource: classificationResult.classification.conceptSource,
            taxonomyVersion: classificationResult.classification.taxonomyVersion,
            storageCategory: classificationResult.classification.storageCategory,
            documentType: inferDocumentType(
              { ...convert.file, title: resolvedTitle },
              classificationResult.classification.storageCategory
            ),
            tags: classificationResult.tags,
            summary,
            ...(existingDoc.sourceHost ? { source_host: existingDoc.sourceHost } : {}),
            nas_path: pathAliases.canonicalNasPath,
            nas_paths: pathAliases.nasPaths,
          };

          const metaPath = await saveMetadataArtifact(convert.docId, docsMetadata);
          metadata.skipped = false;
          metadata.metaPath = metaPath;
          metadata.storageCategory = docsMetadata.storageCategory;
          metadata.primaryConceptId = docsMetadata.primaryConceptId;

          if (gateway?.progress) {
            await gateway.progress(`📚 ${resolvedTitle}: Step 2/4 complete (classify-summarize)`);
          }

          return {
            docId: convert.docId,
            metaPath,
          };
        }
      );
    });

    const chunked = await step.run("chunk", async () => {
      const metadata: Record<string, unknown> = {
        docId: convert.docId,
        title: convert.file.title,
        skipExistingArtifacts,
      };

      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-reindex-v2",
          action: "docs.reindex.chunk",
          metadata,
        },
        async () => {
          if (skipExistingArtifacts && await hasArtifact(convert.docId, "chunks")) {
            const existingChunks = await requireChunks(convert.docId);
            metadata.skipped = true;
            metadata.chunksPath = chunksArtifactPath(convert.docId);
            metadata.sectionCount = existingChunks.filter((chunk) => chunk.chunk_type === "section").length;
            metadata.snippetCount = existingChunks.filter((chunk) => chunk.chunk_type === "snippet").length;
            if (gateway?.progress) {
              await gateway.progress(`📚 ${convert.file.title}: Step 3/4 complete (chunk)`);
            }
            return {
              docId: convert.docId,
              chunksPath: chunksArtifactPath(convert.docId),
              sectionCount: metadata.sectionCount as number,
              snippetCount: metadata.snippetCount as number,
            };
          }

          const markdown = await requireMarkdown(convert.docId);
          const docsMetadata = await requireMetadata(convert.docId);
          const chunking = chunkBookText(convert.docId, markdown);
          const chunkRecords = buildChunkRecords({
            docId: convert.docId,
            title: docsMetadata.title,
            chunking,
            primaryConceptId: docsMetadata.primaryConceptId as ConceptId,
            conceptIds: docsMetadata.conceptIds as ConceptId[],
            conceptSource: docsMetadata.conceptSource as ConceptSource,
            taxonomyVersion: docsMetadata.taxonomyVersion,
            addedAt: Date.now(),
          });

          const chunksPath = await saveChunksArtifact(convert.docId, chunkRecords);
          metadata.skipped = false;
          metadata.chunksPath = chunksPath;
          metadata.sectionCount = chunking.stats.section_chunks;
          metadata.snippetCount = chunking.stats.snippet_chunks;
          metadata.profileVersion = "book-chunk.v2.markdown";

          if (gateway?.progress) {
            await gateway.progress(`📚 ${docsMetadata.title}: Step 3/4 complete (chunk)`);
          }

          return {
            docId: convert.docId,
            chunksPath,
            sectionCount: chunking.stats.section_chunks,
            snippetCount: chunking.stats.snippet_chunks,
          };
        }
      );
    });

    const indexed = await step.run("index-typesense", async () => {
      const metadata: Record<string, unknown> = {
        docId: convert.docId,
        title: convert.file.title,
      };

      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-reindex-v2",
          action: "docs.reindex.index",
          metadata,
        },
        async () => {
          const docsMetadata = await requireMetadata(convert.docId);
          const chunks = await requireChunks(convert.docId);
          const existingDoc = await loadExistingDocState(convert.docId);
          const addedAt = existingDoc.addedAt ?? Date.now();
          const pathAliases = mergeDocumentPathAliases({
            currentNasPath: convert.file.nasPath,
            existingNasPath: docsMetadata.nas_path,
            existingNasPaths: docsMetadata.nas_paths,
          });

          await ensureDocsCollections();

          const document = buildDocumentRecord({
            file: { ...convert.file, title: docsMetadata.title } as ValidatedDocsFile,
            extracted: {
              textPath: convert.mdPath,
              characterCount: 0,
              pageCount: docsMetadata.page_count,
            } as DocsExtractedTextArtifact,
            storageCategory: docsMetadata.storageCategory as StorageCategory,
            documentType: docsMetadata.documentType,
            tags: docsMetadata.tags,
            primaryConceptId: docsMetadata.primaryConceptId as ConceptId,
            conceptIds: docsMetadata.conceptIds as ConceptId[],
            conceptSource: docsMetadata.conceptSource as ConceptSource,
            taxonomyVersion: docsMetadata.taxonomyVersion,
            summary: docsMetadata.summary,
            pathAliases,
            sourceHost: docsMetadata.source_host,
            addedAt,
          });

          await typesense.upsert(DOCS_COLLECTION, document as unknown as Record<string, unknown>);
          await deleteDocChunks(convert.docId, DOCS_CHUNKS_V2_COLLECTION);

          const chunkRecords = chunks.map((chunk) => ({
            ...chunk,
            title: docsMetadata.title,
            concept_ids: docsMetadata.conceptIds as ConceptId[],
            primary_concept_id: docsMetadata.primaryConceptId as ConceptId,
            concept_source: docsMetadata.conceptSource as ConceptSource,
            taxonomy_version: docsMetadata.taxonomyVersion,
            added_at: addedAt,
            retrieval_text: buildRetrievalText({
              title: docsMetadata.title,
              summary: docsMetadata.summary,
              headingPath: chunk.heading_path,
              conceptIds: docsMetadata.conceptIds,
              content: chunk.content,
            }),
          }));

          // ADR-0234: pre-compute embeddings via ollama (GPU, ~150x faster than Typesense CPU)
          // Then store raw float[] vectors — no auto-embed overhead
          const IMPORT_BATCH_SIZE = 100;
          let totalSuccess = 0;
          let totalErrors = 0;
          const totalBatches = Math.ceil(chunkRecords.length / IMPORT_BATCH_SIZE);

          await emitOtelEvent({
            level: "info",
            source: "worker",
            component: "docs-reindex-v2",
            action: "docs.reindex.embed.batches.started",
            success: true,
            metadata: {
              docId: convert.docId,
              totalChunks: chunkRecords.length,
              totalBatches,
              batchSize: IMPORT_BATCH_SIZE,
              collection: DOCS_CHUNKS_V2_COLLECTION,
            },
          });

          for (let i = 0; i < chunkRecords.length; i += IMPORT_BATCH_SIZE) {
            const batchIndex = Math.floor(i / IMPORT_BATCH_SIZE);
            const batch = chunkRecords.slice(i, i + IMPORT_BATCH_SIZE);
            const texts = batch.map((r) => (r as Record<string, unknown>).retrieval_text as string);

            // Embed batch via ollama GPU
            const embedStart = Date.now();
            const embeddings = await embedTexts(texts);
            const embedElapsedMs = Date.now() - embedStart;

            // Attach embeddings to records
            const withEmbeddings = batch.map((record, idx) => ({
              ...(record as Record<string, unknown>),
              embedding: embeddings[idx],
            }));

            const upsertStart = Date.now();
            const batchResult = await typesense.bulkImport(
              DOCS_CHUNKS_V2_COLLECTION,
              withEmbeddings,
              "upsert"
            );
            totalSuccess += batchResult.success;
            totalErrors += batchResult.errors;

            await emitOtelEvent({
              level: batchResult.errors > 0 ? "warn" : "info",
              source: "worker",
              component: "docs-reindex-v2",
              action: "docs.reindex.embed.batch.completed",
              success: batchResult.errors === 0,
              metadata: {
                docId: convert.docId,
                batchIndex,
                totalBatches,
                batchChunkCount: batch.length,
                embedElapsedMs,
                upsertElapsedMs: Date.now() - upsertStart,
                batchSuccess: batchResult.success,
                batchErrors: batchResult.errors,
                cumulativeSuccess: totalSuccess,
              },
            });
          }

          metadata.indexed = totalSuccess;
          metadata.errors = totalErrors;
          metadata.collection = DOCS_CHUNKS_V2_COLLECTION;

          if (gateway?.progress) {
            await gateway.progress(`📚 ${docsMetadata.title}: Step 4/4 complete (index-typesense)`);
          }

          return {
            docId: convert.docId,
            indexed: totalSuccess,
            errors: totalErrors,
          };
        }
      );
    });

    return {
      docId: convert.docId,
      title: convert.file.title,
      mdPath: convert.mdPath,
      metaPath: classifySummarize.metaPath,
      chunksPath: chunked.chunksPath,
      sectionCount: chunked.sectionCount,
      snippetCount: chunked.snippetCount,
      indexed: indexed.indexed,
      errors: indexed.errors,
    };
  }
);
