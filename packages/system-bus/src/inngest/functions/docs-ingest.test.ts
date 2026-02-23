import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { chunkBookText } from "../../lib/book-chunk";
import { resolveConcepts } from "../../taxonomy/resolve";
import {
  buildBackfillClassification,
  buildExtractedTextPath,
  buildChunkRecords,
  mergeDocumentPathAliases,
  resetManifestInferenceCache,
  resolveBackfillConcepts,
  resolveManifestInference,
} from "./docs-ingest";

function buildSampleChunkRecords() {
  const docId = "doc-test-1";
  const text = `
Chapter 1 Foundations

Distributed systems fail in subtle ways. Observability has to make those failures visible.

Section 1.1 Event Contracts

Event schemas must be explicit, versioned, and validated at boundaries.

Section 1.2 Durable Steps

Durable workflow steps isolate side-effects so retries stay safe.

Chapter 2 Retrieval

Hierarchical chunks let retrieval move from precise snippets to broader evidence context.
`;

  const chunking = chunkBookText(docId, text, {
    sectionTargetTokens: 180,
    sectionMaxTokens: 260,
    snippetTargetTokens: 80,
    snippetMaxTokens: 120,
    sectionOverlapTokens: 20,
    snippetOverlapTokens: 12,
  });

  return buildChunkRecords({
    docId,
    title: "Distributed Systems Notes",
    chunking,
    primaryConceptId: "jc:docs:programming",
    conceptIds: ["jc:docs:programming", "jc:docs:operations"],
    conceptSource: "rules",
    taxonomyVersion: "v1",
    addedAt: Date.now(),
  });
}

test("docs-ingest chunk records preserve parent and neighbor links", () => {
  const records = buildSampleChunkRecords();
  const sections = records.filter((record) => record.chunk_type === "section");
  const snippets = records.filter((record) => record.chunk_type === "snippet");

  expect(sections.length).toBeGreaterThan(0);
  expect(snippets.length).toBeGreaterThan(0);

  const byId = new Map(records.map((record) => [record.id, record]));
  const sectionIds = new Set(sections.map((section) => section.id));

  for (const snippet of snippets) {
    expect(typeof snippet.parent_chunk_id).toBe("string");
    expect(sectionIds.has(snippet.parent_chunk_id!)).toBe(true);
  }

  for (const record of records) {
    if (record.prev_chunk_id) {
      const prev = byId.get(record.prev_chunk_id);
      expect(prev).toBeDefined();
      expect(prev?.next_chunk_id).toBe(record.id);
    }
    if (record.next_chunk_id) {
      const next = byId.get(record.next_chunk_id);
      expect(next).toBeDefined();
      expect(next?.prev_chunk_id).toBe(record.id);
    }
  }
});

test("docs-ingest chunk records include concept and evidence metadata", () => {
  const records = buildSampleChunkRecords();
  expect(records.length).toBeGreaterThan(0);

  for (const record of records) {
    expect(record.primary_concept_id).toBeTruthy();
    expect(record.concept_ids.length).toBeGreaterThan(0);
    expect(record.concept_source).toBeTruthy();
    expect(record.taxonomy_version).toBe("v1");
    expect(record.source_entity_id).toBe("doc-test-1");
    expect(record.context_prefix.length).toBeGreaterThan(0);
    expect(record.retrieval_text.length).toBeGreaterThan(0);
    expect(record.evidence_tier === "section" || record.evidence_tier === "snippet").toBe(true);

    if (record.chunk_type === "snippet") {
      expect(record.parent_chunk_id).toBeTruthy();
      expect(record.parent_evidence_id).toBe(record.parent_chunk_id);
    }
  }
});

test("docs-ingest temp text artifacts use run-unique paths", () => {
  const first = buildExtractedTextPath("doc-test-1");
  const second = buildExtractedTextPath("doc-test-1");

  expect(first).not.toBe(second);
  expect(first.startsWith("/tmp/docs-ingest/doc-test-1-")).toBe(true);
  expect(second.startsWith("/tmp/docs-ingest/doc-test-1-")).toBe(true);
  expect(first.endsWith(".txt")).toBe(true);
  expect(second.endsWith(".txt")).toBe(true);
});

test("docs-ingest path alias merge preserves canonical path and dedupes variants", () => {
  const merged = mergeDocumentPathAliases({
    currentNasPath: "/Volumes/three-body/books/business/The-Learning-Game.pdf",
    existingNasPath: "/Volumes/three-body/books/programming/The-Learning-Game.pdf",
    existingNasPaths: [
      "/Volumes/three-body/books/programming/The-Learning-Game.pdf",
      "/Volumes/three-body/books/business/The-Learning-Game.pdf",
    ],
  });

  expect(merged.canonicalNasPath).toBe("/Volumes/three-body/books/programming/The-Learning-Game.pdf");
  expect(merged.nasPaths).toEqual([
    "/Volumes/three-body/books/programming/The-Learning-Game.pdf",
    "/Volumes/three-body/books/business/The-Learning-Game.pdf",
  ]);
});

test("docs-ingest taxonomy subprocess guard enforces async timeout instrumentation", async () => {
  const sourcePath = fileURLToPath(new URL("./docs-ingest.ts", import.meta.url));
  const source = await readFile(sourcePath, "utf8");

  expect(source.includes("Bun.spawnSync(")).toBe(false);
  expect(source.includes("runProcess(")).toBe(true);
  expect(source.includes("DOCS_TAXONOMY_TIMEOUT_MS")).toBe(true);
  expect(source.includes("docs.taxonomy.classify.timeout")).toBe(true);
});

test("docs-ingest backfill taxonomy uses inferred storage category as primary concept", () => {
  const resolved = resolveBackfillConcepts({
    inferredCategory: "business",
    resolvedConceptIds: ["jc:docs:marketing", "jc:docs:strategy"],
  });

  expect(resolved.primaryConceptId).toBe("jc:docs:business");
  expect(resolved.conceptIds[0]).toBe("jc:docs:business");
  expect(resolved.conceptIds).toContain("jc:docs:marketing");
  expect(resolved.conceptIds).toContain("jc:docs:strategy");
});

test("docs-ingest backfill taxonomy falls back to resolved concepts when no inferred category", () => {
  const resolved = resolveBackfillConcepts({
    resolvedConceptIds: ["jc:docs:programming", "jc:docs:ai"],
  });

  expect(resolved.primaryConceptId).toBe("jc:docs:programming");
  expect(resolved.conceptIds).toEqual(["jc:docs:programming", "jc:docs:ai"]);
});

test("docs-ingest manifest-backed classification yields backfill strategy", async () => {
  const tmpPath = await mkdtemp(join(tmpdir(), "docs-ingest-manifest-"));
  const manifestPath = join(tmpPath, "manifest.clean.jsonl");
  const previousManifestPath = process.env.MANIFEST_ARCHIVE_MANIFEST_PATH;

  try {
    const manifestLine = {
      id: "fixture-1706",
      filename: "1706.03762.pdf",
      sourcePath: "/Users/joel/Library/Mobile Documents/fixture/1706.03762.pdf",
      enrichmentCategory: "programming",
      enrichmentDocumentType: "paper",
      enrichmentProvider: "anthropic/claude-haiku-4-5",
      tags: ["attention", "transformer"],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifestLine)}\n`, "utf8");

    process.env.MANIFEST_ARCHIVE_MANIFEST_PATH = manifestPath;
    resetManifestInferenceCache();

    const nasPath = "/Volumes/three-body/books/programming/1706.03762.pdf";
    const manifestInference = await resolveManifestInference(nasPath);
    expect(manifestInference).toBeTruthy();
    expect(manifestInference?.id).toBe("fixture-1706");

    const resolved = resolveConcepts({
      labels: [
        "Attention Is All You Need",
        ...(manifestInference?.tags ?? []),
        manifestInference?.enrichmentCategory ?? "",
        manifestInference?.enrichmentDocumentType ?? "",
      ],
    });
    const classification = buildBackfillClassification({
      resolved,
      manifestInference,
      nasPath,
    });

    expect(classification).toBeTruthy();
    expect(classification?.conceptSource).toBe("backfill");
    expect(classification?.strategy).toBe("backfill");
    expect(classification?.primaryConceptId).toBe("jc:docs:programming");
    expect(classification?.backfill?.entryId).toBe("fixture-1706");
    expect(classification?.storageCategory).toBe("programming");
  } finally {
    if (previousManifestPath == null) {
      delete process.env.MANIFEST_ARCHIVE_MANIFEST_PATH;
    } else {
      process.env.MANIFEST_ARCHIVE_MANIFEST_PATH = previousManifestPath;
    }
    resetManifestInferenceCache();
    await rm(tmpPath, { recursive: true, force: true });
  }
});
